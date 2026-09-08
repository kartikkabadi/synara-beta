// FILE: index.ts
// Purpose: Synara Beta diagnostics collector. Ingests only schema-valid,
//          allowlisted events into D1 and serves aggregate counts.
// Layer: Cloudflare Worker (standalone deploy; see README.md)
//
// The validation contract lives in ./contract.ts so the desktop test suite
// can prove the sanitizer and this collector stay in sync.

import { MAX_BATCH, UUID_PATTERN, validateEvent, type DiagnosticsEvent } from "./contract";

// Minimal structural stand-ins for the Cloudflare D1 API. These keep the
// worker dependency-free while the desktop/scripts test suite imports it.
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

export interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/v1/events") {
      return handleIngest(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
  // Enforces the documented 90-day retention without an operator-run job.
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("DELETE FROM events WHERE received_at < ?").bind(cutoff).run();
  },
};

const RETENTION_DAYS = 90;
const MAX_BODY_BYTES = 1024 * 1024;

async function handleIngest(request: Request, env: Env): Promise<Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return Response.json({ error: "body too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { events?: unknown }).events) ||
    (body as { events: unknown[] }).events.length === 0
  ) {
    return Response.json({ error: "expected { events: [...] }" }, { status: 400 });
  }
  const events = (body as { events: unknown[] }).events;
  if (events.length > MAX_BATCH) {
    return Response.json({ error: "batch too large" }, { status: 413 });
  }
  for (const event of events) {
    if (!validateEvent(event)) {
      return Response.json({ error: "invalid event" }, { status: 422 });
    }
  }
  const validEvents = events as DiagnosticsEvent[];
  const installId = validEvents[0]?.installId ?? "";
  if (!UUID_PATTERN.test(installId)) {
    return Response.json({ error: "invalid install id" }, { status: 422 });
  }
  // A batch may only carry one install's events; otherwise a caller could
  // smuggle another install's events past that install's hourly quota.
  if (validEvents.some((event) => event.installId !== installId)) {
    return Response.json({ error: "mixed install ids" }, { status: 422 });
  }
  if (!(await withinRateLimit(env, installId, validEvents.length))) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }
  // Best-effort sender-level limit (per isolate; no IP is ever stored). It
  // blunts floods of fresh-UUID batches that would otherwise bypass the
  // per-install quota; the D1 per-install check stays the durable limit.
  const senderIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!withinSenderRateLimit(senderIp, validEvents.length)) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }
  const receivedAt = new Date().toISOString();
  const statements = validEvents.map((event) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO events (
         event_id, install_id, kind, app_version, platform, arch, flavor,
         occurred_at, provider, duration_bucket, outcome, feature, error_code, error_surface, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      event.eventId,
      event.installId,
      event.kind,
      event.appVersion,
      event.platform,
      event.arch,
      event.flavor,
      event.occurredAt,
      event.provider ?? null,
      event.durationBucket ?? null,
      event.outcome ?? null,
      event.feature ?? null,
      event.errorCode ?? null,
      event.errorSurface ?? null,
      receivedAt,
    ),
  );
  await env.DB.batch(statements);
  return Response.json({ accepted: validEvents.length }, { status: 202 });
}

const PER_INSTALL_HOURLY_LIMIT = 600;
const PER_SENDER_HOURLY_LIMIT = 2400;
const SENDER_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_SENDERS = 10_000;
const senderHits = new Map<string, { count: number; resetAt: number }>();

function withinSenderRateLimit(senderIp: string, incoming: number): boolean {
  const now = Date.now();
  if (senderIp === "unknown") return true;
  if (senderHits.size > MAX_TRACKED_SENDERS) {
    for (const [key, entry] of senderHits) {
      if (entry.resetAt <= now) senderHits.delete(key);
    }
    if (senderHits.size > MAX_TRACKED_SENDERS) senderHits.clear();
  }
  const entry = senderHits.get(senderIp);
  if (!entry || entry.resetAt <= now) {
    senderHits.set(senderIp, { count: incoming, resetAt: now + SENDER_WINDOW_MS });
    return true;
  }
  entry.count += incoming;
  return entry.count <= PER_SENDER_HOURLY_LIMIT;
}

async function withinRateLimit(env: Env, installId: string, incoming: number): Promise<boolean> {
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE install_id = ? AND received_at >= ?",
  )
    .bind(installId, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 0) + incoming <= PER_INSTALL_HOURLY_LIMIT;
}
