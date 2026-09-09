// FILE: index.ts
// Purpose: Synara Beta diagnostics collector. Ingests only schema-valid,
//          allowlisted events into D1 and serves aggregate counts.
// Layer: Cloudflare Worker (standalone deploy; see README.md)
//
// The validation contract lives in ./contract.ts so the desktop test suite
// can prove the sanitizer and this collector stay in sync.

import { MAX_BATCH, UUID_PATTERN, isPlainObject, validateEvent } from "./contract";

// Minimal structural stand-ins for the Cloudflare D1 API. These keep the
// worker dependency-free while the desktop/scripts test suite imports it.
export type D1Value = string | number | boolean | null;

export interface D1RunResult {
  readonly changes?: number;
  readonly duration?: number;
}

export interface D1BatchResult {
  readonly duration?: number;
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1RunResult>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<ReadonlyArray<D1BatchResult>>;
}

export interface Env {
  DB: D1Database;
}

export interface ScheduledController {
  readonly scheduledAt: number;
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
  // Enforces the documented 90-day retention without an operator-run job, and
  // reclaims dead rate-limit counter rows from past hourly windows.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const counterCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM events WHERE received_at < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM rate_counters WHERE window_start < ?").bind(counterCutoff),
    ]);
  },
};

const RETENTION_DAYS = 90;
const MAX_BODY_BYTES = 1024 * 1024;

// Reads the request body as text and stops as soon as it exceeds maxBytes.
// The Content-Length header is only a fast path: a missing or forged header
// cannot make the worker buffer an unbounded body before validation.
async function readBodyText(request: Request, maxBytes: number): Promise<string | null> {
  const body = request.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return Response.json({ error: "body too large" }, { status: 413 });
  }

  const bodyText = await readBodyText(request, MAX_BODY_BYTES);
  if (bodyText === null) {
    return Response.json({ error: "body too large" }, { status: 413 });
  }
  // External input is parsed from `unknown`: JSON.parse output is untrusted,
  // and isPlainObject/validateEvent are the narrowers that give it a type.
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!isPlainObject(body)) {
    return Response.json({ error: "expected { events: [...] }" }, { status: 400 });
  }
  const eventsValue = body.events;
  if (!Array.isArray(eventsValue) || eventsValue.length === 0) {
    return Response.json({ error: "expected { events: [...] }" }, { status: 400 });
  }
  if (eventsValue.length > MAX_BATCH) {
    return Response.json({ error: "batch too large" }, { status: 413 });
  }
  const validEvents = eventsValue.filter(validateEvent);
  if (validEvents.length !== eventsValue.length) {
    return Response.json({ error: "invalid event" }, { status: 422 });
  }
  const installId = validEvents[0]?.installId;
  if (installId === undefined || !UUID_PATTERN.test(installId)) {
    return Response.json({ error: "invalid install id" }, { status: 422 });
  }
  // A batch may only carry one install's events; otherwise a caller could
  // smuggle another install's events past that install's hourly quota.
  if (validEvents.some((event) => event.installId !== installId)) {
    return Response.json({ error: "mixed install ids" }, { status: 422 });
  }
  // Best-effort sender-level limit (per isolate; no IP is ever stored). It
  // blunts floods inside one isolate and runs before the durable reservation
  // so a rejected batch cannot spend quota it never used. The returned
  // reservation carries the exact window the spend was charged to, so a later
  // refund can only hand budget back to that same window.
  const senderIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  const senderReservation = withinSenderRateLimit(senderIp, validEvents.length);
  if (senderReservation === null) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }
  // Durable quota: atomic D1 counter reservations. A single upsert statement
  // serializes concurrent batches on the (scope, window_start) row, so two
  // requests cannot both pass on a stale pre-insert count. The global scope
  // bounds total ingest even when a caller rotates fresh install ids. The two
  // scopes are reserved sequentially so a failure of the second can be
  // compensated: a batch that would push a scope past its limit is rejected
  // whole with every reservation handed back, so neither an oversized batch
  // nor a partial reservation can lock a scope out for the rest of the hour.
  // A lost release only tightens the limit.
  const windowStart = hourlyWindowStart();
  const installScope = `install:${installId}`;
  let installCount: number;
  try {
    installCount = await reserveHourlyQuota(env, installScope, windowStart, validEvents.length);
  } catch {
    // A missing rate_counters table (schema not re-applied) must not surface
    // as an opaque worker exception.
    refundSenderRateLimit(senderReservation);
    return Response.json({ error: "quota store unavailable" }, { status: 503 });
  }
  let globalCount: number;
  try {
    globalCount = await reserveHourlyQuota(env, "global", windowStart, validEvents.length);
  } catch {
    // The install reservation landed but the global one threw: hand the first
    // back, or a partial failure would inflate the install scope for an hour.
    await releaseHourlyQuota(env, installScope, windowStart, validEvents.length).catch(() => {});
    refundSenderRateLimit(senderReservation);
    return Response.json({ error: "quota store unavailable" }, { status: 503 });
  }
  if (installCount > PER_INSTALL_HOURLY_LIMIT || globalCount > GLOBAL_HOURLY_LIMIT) {
    // The batch never lands, so neither reservation was used: return both.
    // Release is best effort — a failed release only tightens the limit.
    await Promise.all([
      releaseHourlyQuota(env, installScope, windowStart, validEvents.length),
      releaseHourlyQuota(env, "global", windowStart, validEvents.length),
    ]).catch(() => {});
    refundSenderRateLimit(senderReservation);
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
  try {
    await env.DB.batch(statements);
  } catch {
    // The write failed after the reservation landed: hand the quota back so a
    // transient D1 error does not burn the install's hourly budget. Release is
    // best effort — a lost decrement only tightens the limit, never loosens it.
    await Promise.all([
      releaseHourlyQuota(env, installScope, windowStart, validEvents.length),
      releaseHourlyQuota(env, "global", windowStart, validEvents.length),
    ]).catch(() => {});
    refundSenderRateLimit(senderReservation);
    return Response.json({ error: "event store unavailable" }, { status: 503 });
  }
  return Response.json({ accepted: validEvents.length }, { status: 202 });
}

const PER_INSTALL_HOURLY_LIMIT = 600;
const GLOBAL_HOURLY_LIMIT = 20_000;
const PER_SENDER_HOURLY_LIMIT = 2400;
const SENDER_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_SENDERS = 10_000;
const senderHits = new Map<string, { count: number; resetAt: number }>();

// The exact sender-window spend a request was charged: the sender identity
// plus the resetAt of the window that absorbed it. A refund may only hand
// budget back to that same window.
interface SenderRateReservation {
  readonly senderIp: string;
  readonly count: number;
  readonly resetAt: number;
}

// Returns the reservation for the spend, or null when the batch is refused.
// An "unknown" sender is never tracked: its reservation carries resetAt 0, so
// a refund finds no window and is a no-op.
function withinSenderRateLimit(senderIp: string, incoming: number): SenderRateReservation | null {
  const now = Date.now();
  if (senderIp === "unknown") {
    return { senderIp, count: incoming, resetAt: 0 };
  }
  if (senderHits.size > MAX_TRACKED_SENDERS) {
    for (const [key, entry] of senderHits) {
      if (entry.resetAt <= now) senderHits.delete(key);
    }
    if (senderHits.size > MAX_TRACKED_SENDERS) senderHits.clear();
  }
  const entry = senderHits.get(senderIp);
  if (!entry || entry.resetAt <= now) {
    const resetAt = now + SENDER_WINDOW_MS;
    senderHits.set(senderIp, { count: incoming, resetAt });
    return { senderIp, count: incoming, resetAt };
  }
  entry.count += incoming;
  if (entry.count > PER_SENDER_HOURLY_LIMIT) return null;
  return { senderIp, count: incoming, resetAt: entry.resetAt };
}

// Hands a rejected batch's spend back to the sender's in-memory window, so a
// request refused after the sender check (over-limit rejection, failed D1
// write) never costs sender budget: only events that actually land spend it,
// and a transient D1 outage cannot lock an honest sender out. The refund
// matches the reservation's resetAt, so it can only debit the very window
// that was charged — a window that rolled over while the request was in
// flight already forgot the spend, and debiting the new window instead would
// hand it free budget. Best effort — a lost refund only tightens the limit.
function refundSenderRateLimit(reservation: SenderRateReservation): void {
  if (reservation.resetAt === 0) return; // untracked sender
  const entry = senderHits.get(reservation.senderIp);
  // A rolled-over or evicted window no longer holds the spend; only the
  // exact charged window may be decremented.
  if (!entry || entry.resetAt !== reservation.resetAt) return;
  entry.count = Math.max(0, entry.count - reservation.count);
}

// Fixed hourly buckets keep the counter a single upsertable row per scope.
function hourlyWindowStart(now = Date.now()): string {
  return new Date(now - (now % 3_600_000)).toISOString();
}

// Reserves `count` against the scope's hourly window and returns the
// post-reservation total. The upsert is one statement, so increments serialize
// on the row and cannot interleave with a concurrent check.
async function reserveHourlyQuota(
  env: Env,
  scope: string,
  windowStart: string,
  count: number,
): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO rate_counters (scope, window_start, event_count)
     VALUES (?, ?, ?)
     ON CONFLICT (scope, window_start)
     DO UPDATE SET event_count = event_count + excluded.event_count`,
  )
    .bind(scope, windowStart, count)
    .run();
  const row = await env.DB.prepare(
    "SELECT event_count FROM rate_counters WHERE scope = ? AND window_start = ?",
  )
    .bind(scope, windowStart)
    .first<{ event_count: number }>();
  return row?.event_count ?? count;
}

// Returns `count` to the scope's window after a write that never landed.
// Clamped at zero so a compensating decrement can never push a scope negative.
async function releaseHourlyQuota(
  env: Env,
  scope: string,
  windowStart: string,
  count: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE rate_counters
     SET event_count = MAX(0, event_count - ?)
     WHERE scope = ? AND window_start = ?`,
  )
    .bind(count, scope, windowStart)
    .run();
}
