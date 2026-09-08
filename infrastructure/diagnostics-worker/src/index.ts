// FILE: index.ts
// Purpose: Synara Beta diagnostics collector. Ingests only schema-valid,
//          allowlisted events into D1 and serves aggregate counts.
// Layer: Cloudflare Worker (standalone deploy; see README.md)
//
// The validation contract lives in ./contract.ts so the desktop test suite
// can prove the sanitizer and this collector stay in sync.

import { MAX_BATCH, UUID_PATTERN, validateEvent, type DiagnosticsEvent } from "./contract";

export interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/v1/stats") {
      return handleStats(env);
    }
    if (request.method === "POST" && url.pathname === "/v1/events") {
      return handleIngest(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleIngest(request: Request, env: Env): Promise<Response> {
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
  if (!(await withinRateLimit(env, installId, validEvents.length))) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }
  const receivedAt = new Date().toISOString();
  const statements = validEvents.map((event) =>
    env.DB.prepare(
      `INSERT INTO events (
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

async function withinRateLimit(env: Env, installId: string, incoming: number): Promise<boolean> {
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE install_id = ? AND received_at >= ?",
  )
    .bind(installId, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 0) + incoming <= PER_INSTALL_HOURLY_LIMIT;
}

async function handleStats(env: Env): Promise<Response> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const byKind = await env.DB.prepare(
    "SELECT kind AS bucket, COUNT(*) AS count FROM events WHERE received_at >= ? GROUP BY kind",
  )
    .bind(since)
    .all<{ bucket: string; count: number }>();
  const byVersion = await env.DB.prepare(
    "SELECT app_version AS bucket, COUNT(*) AS count FROM events WHERE received_at >= ? GROUP BY app_version",
  )
    .bind(since)
    .all<{ bucket: string; count: number }>();
  const byPlatform = await env.DB.prepare(
    "SELECT platform AS bucket, COUNT(*) AS count FROM events WHERE received_at >= ? GROUP BY platform",
  )
    .bind(since)
    .all<{ bucket: string; count: number }>();
  const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM events").first<{
    count: number;
  }>();
  return Response.json({
    window: "30d",
    total: total?.count ?? 0,
    byKind: toCounts(byKind.results),
    byVersion: toCounts(byVersion.results),
    byPlatform: toCounts(byPlatform.results),
  });
}

function toCounts(rows: Array<{ bucket: string; count: number }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.bucket] = Number(row.count ?? 0);
  }
  return counts;
}
