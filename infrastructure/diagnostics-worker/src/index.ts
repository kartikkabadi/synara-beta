// FILE: index.ts
// Purpose: Synara Beta diagnostics collector. Ingests only schema-valid,
//          allowlisted events into D1 and serves aggregate counts.
// Layer: Cloudflare Worker (standalone deploy; see README.md)
//
// Privacy contract (mirrors apps/desktop/src/diagnosticsSanitizer.ts — keep in
// sync): every field is a closed enum, a validated identifier, or a coarse
// bucket. Batches containing any invalid event are rejected whole (fail
// closed). The worker never stores IP addresses, user agents, or free text.

interface DiagnosticsEvent {
  schemaVersion: number;
  kind: string;
  eventId: string;
  occurredAt: string;
  appVersion: string;
  platform: string;
  arch: string;
  flavor: string;
  installId: string;
  provider?: string;
  durationBucket?: string;
  outcome?: string;
  feature?: string;
  errorCode?: string;
  errorSurface?: string;
}

const KINDS = new Set([
  "app_start",
  "app_quit",
  "session_started",
  "session_ended",
  "update_available",
  "update_installed",
  "update_failed",
  "feature_used",
  "error",
  "test",
]);
const PLATFORMS = new Set(["darwin", "linux", "win32"]);
const ARCHES = new Set(["arm64", "x64"]);
const FLAVORS = new Set(["production", "beta", "canary"]);
const PROVIDERS = new Set([
  "codex",
  "claude",
  "cursor",
  "devin",
  "antigravity",
  "grok",
  "droid",
  "opencode",
  "factory",
  "other",
]);
const DURATION_BUCKETS = new Set(["under_1m", "1m_5m", "5m_30m", "over_30m"]);
const OUTCOMES = new Set(["ok", "error", "cancelled"]);
const ERROR_SURFACES = new Set(["desktop", "backend", "updater"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const EVENT_ID_PATTERN = /^[0-9a-f]{32}$/u;
const APP_VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-beta\.\d{1,3})?$/u;
const MINUTE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/u;
const FEATURE_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const MAX_BATCH = 50;
const PER_INSTALL_HOURLY_LIMIT = 600;

const OPTIONAL_FIELDS = [
  "provider",
  "durationBucket",
  "outcome",
  "feature",
  "errorCode",
  "errorSurface",
] as const;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural mirror of the desktop sanitizer. Rejects any event with a field
 * outside the contract or a value outside its enum/pattern. The batch is
 * rejected whole when any event fails — no partial writes, no silent repair.
 */
export function validateEvent(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const allowed = [
    "schemaVersion",
    "kind",
    "eventId",
    "occurredAt",
    "appVersion",
    "platform",
    "arch",
    "flavor",
    "installId",
    ...OPTIONAL_FIELDS,
  ];
  if (!Object.keys(value).every((key) => allowed.includes(key))) return false;
  if (value.schemaVersion !== 1) return false;
  if (typeof value.kind !== "string" || !KINDS.has(value.kind)) return false;
  if (typeof value.eventId !== "string" || !EVENT_ID_PATTERN.test(value.eventId)) return false;
  if (typeof value.occurredAt !== "string" || !MINUTE_PATTERN.test(value.occurredAt)) return false;
  if (typeof value.appVersion !== "string" || !APP_VERSION_PATTERN.test(value.appVersion)) {
    return false;
  }
  if (
    typeof value.platform !== "string" ||
    !PLATFORMS.has(value.platform) ||
    typeof value.arch !== "string" ||
    !ARCHES.has(value.arch) ||
    typeof value.flavor !== "string" ||
    !FLAVORS.has(value.flavor) ||
    typeof value.installId !== "string" ||
    !UUID_PATTERN.test(value.installId)
  ) {
    return false;
  }
  for (const key of OPTIONAL_FIELDS) {
    const optional = value[key];
    if (optional !== undefined && typeof optional !== "string") return false;
  }
  if (value.kind === "session_started") {
    return typeof value.provider === "string" && PROVIDERS.has(value.provider);
  }
  if (value.kind === "session_ended") {
    return (
      typeof value.provider === "string" &&
      PROVIDERS.has(value.provider) &&
      typeof value.durationBucket === "string" &&
      DURATION_BUCKETS.has(value.durationBucket) &&
      typeof value.outcome === "string" &&
      OUTCOMES.has(value.outcome)
    );
  }
  if (value.kind === "feature_used") {
    return typeof value.feature === "string" && FEATURE_PATTERN.test(value.feature);
  }
  if (value.kind === "error") {
    return (
      typeof value.errorCode === "string" &&
      ERROR_CODE_PATTERN.test(value.errorCode) &&
      typeof value.errorSurface === "string" &&
      ERROR_SURFACES.has(value.errorSurface)
    );
  }
  return OPTIONAL_FIELDS.every((key) => value[key] === undefined);
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!isPlainObject(body) || !Array.isArray(body.events) || body.events.length === 0) {
    return Response.json({ error: "expected { events: [...] }" }, { status: 400 });
  }
  if (body.events.length > MAX_BATCH) {
    return Response.json({ error: "batch too large" }, { status: 413 });
  }
  for (const event of body.events) {
    if (!validateEvent(event)) {
      return Response.json({ error: "invalid event" }, { status: 422 });
    }
  }
  const events = body.events as DiagnosticsEvent[];
  const installId = events[0]?.installId ?? "";
  if (!UUID_PATTERN.test(installId)) {
    return Response.json({ error: "invalid install id" }, { status: 422 });
  }
  if (!(await withinRateLimit(env, installId, events.length))) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }
  const receivedAt = new Date().toISOString();
  const statements = events.map((event) =>
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
  return Response.json({ accepted: events.length }, { status: 202 });
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
