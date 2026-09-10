// FILE: index.ts
// Purpose: Synara Beta bug-report collector. Accepts only schema-valid,
//          sanitized reports from the beta app and stores them in D1 (and
//          screenshots in R2). No read API: the only public surface is
//          POST /v1/reports, POST /v1/reports/:id/attachment, and GET /health.
// Layer: Cloudflare Worker (standalone deploy; see README.md)
//
// The validation contract lives in ./contract.ts so the scripts test suite can
// prove the web payload and this collector stay in sync.

import {
  ATTACHMENT_CONTENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_REPORT,
  isPlainObject,
  validateReport,
  type BugReport,
} from "./contract";

// Minimal structural stand-ins for the Cloudflare D1/R2 APIs. These keep the
// worker dependency-free while the scripts test suite imports it.
export type D1Value = string | number | boolean | null;

export interface D1RunResult {
  readonly changes?: number;
  readonly duration?: number;
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1RunResult>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

export interface R2PutOptions {
  readonly httpMetadata?: { readonly contentType?: string };
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface R2Bucket {
  put(
    key: string,
    value: Uint8Array | ReadableStream<Uint8Array>,
    options?: R2PutOptions,
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface Env {
  DB: D1Database;
  /** `wrangler secret put BUG_REPORT_TOKEN`; unset fails every POST closed. */
  BUG_REPORT_TOKEN?: string | undefined;
  /** Optional R2 binding; the attachment route fails closed without it. */
  BUG_REPORT_ATTACHMENTS?: R2Bucket | undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/v1/")) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/v1/reports") {
      return handleReport(request, env);
    }
    const attachmentMatch = ATTACHMENT_PATH_PATTERN.exec(url.pathname);
    if (request.method === "POST" && attachmentMatch !== null) {
      return handleAttachment(request, env, attachmentMatch[1] as string);
    }
    return withCors(new Response("Not found", { status: 404 }));
  },
};

// The report path plus diagnostics stays well under 32 KB; the cap exists to
// stop buffered-body abuse, not to fit the payload tightly.
const MAX_REPORT_BODY_BYTES = 256 * 1024;
// Bounds total writes per fixed hour per scope — the durable abuse boundary
// on top of the shared secret (which is extractable from the app bundle).
const REPORTS_HOURLY_LIMIT = 240;
const ATTACHMENTS_HOURLY_LIMIT = 480;

const ATTACHMENT_PATH_PATTERN = /^\/v1\/reports\/([0-9a-f-]{36})\/attachment$/u;

// The app posts cross-origin (dev server port or the desktop window), so the
// preflight and every response carry the same allow headers. The shared
// secret is the real boundary; CORS is browser plumbing.
const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

function json(body: unknown, status = 200): Response {
  return withCors(Response.json(body, { status }));
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

// Reads the request body and stops as soon as it exceeds maxBytes. The
// Content-Length header is only a fast path: a missing or forged header cannot
// make the worker buffer an unbounded body before validation.
async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const body = request.body;
  if (body === null) return new Uint8Array(0);
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
  return bytes;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Bearer-token check against the configured shared secret. Both sides are
// hashed first so the comparison has fixed-shape inputs and never reveals the
// secret's length through an early exit. An unconfigured secret fails closed.
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const secret = env.BUG_REPORT_TOKEN;
  if (typeof secret !== "string" || secret.length === 0) return false;
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  if (presented.length === 0) return false;
  const [presentedDigest, expectedDigest] = await Promise.all([
    sha256Hex(presented),
    sha256Hex(secret),
  ]);
  return presentedDigest === expectedDigest;
}

// Fixed hourly buckets keep the counter a single upsertable row per scope.
function hourlyWindowStart(now = Date.now()): string {
  return new Date(now - (now % 3_600_000)).toISOString();
}

// Reserves one unit against the scope's hourly window and returns the
// post-reservation total. The upsert is one statement, so increments serialize
// on the row and cannot interleave with a concurrent check.
async function reserveHourlyQuota(
  env: Env,
  scope: string,
  windowStart: string,
): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO rate_counters (scope, window_start, event_count)
     VALUES (?, ?, 1)
     ON CONFLICT (scope, window_start)
     DO UPDATE SET event_count = event_count + 1`,
  )
    .bind(scope, windowStart)
    .run();
  const row = await env.DB.prepare(
    "SELECT event_count FROM rate_counters WHERE scope = ? AND window_start = ?",
  )
    .bind(scope, windowStart)
    .first<{ event_count: number }>();
  return row?.event_count ?? 1;
}

// Hands the reservation back after a write that never landed. Clamped at zero
// so a compensating decrement can never push a scope negative.
async function releaseHourlyQuota(env: Env, scope: string, windowStart: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE rate_counters
     SET event_count = MAX(0, event_count - 1)
     WHERE scope = ? AND window_start = ?`,
  )
    .bind(scope, windowStart)
    .run();
}

// The lead line of the rendered summary ("I ran into a bug in Synara …") is
// the maintainer-facing triage title.
function deriveTitle(report: BugReport): string {
  const firstLine = report.summary.split("\n", 1)[0]?.trim() ?? "";
  return (firstLine || "Beta bug report").slice(0, 200);
}

// navigator.platform/userAgent are the only OS signal the web client has, so
// the stored value is a deliberately coarse enum. iOS must be checked before
// macOS (iPads report "Macintosh"), Android before Linux.
function deriveOs(report: BugReport): string {
  const haystack = `${report.diagnostics.platform} ${report.diagnostics.userAgent}`.toLowerCase();
  if (haystack.includes("iphone") || haystack.includes("ipad") || haystack.includes("ipod")) {
    return "ios";
  }
  if (haystack.includes("android")) return "android";
  if (haystack.includes("mac")) return "macos";
  if (haystack.includes("win")) return "windows";
  if (haystack.includes("linux")) return "linux";
  return "other";
}

async function handleReport(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return error("unauthorized", 401);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_REPORT_BODY_BYTES) {
    return error("body too large", 413);
  }
  const bodyBytes = await readBodyBytes(request, MAX_REPORT_BODY_BYTES);
  if (bodyBytes === null) {
    return error("body too large", 413);
  }
  // JSON.parse output is untrusted; validateReport is the narrower that gives
  // it a type. Any violation rejects the whole report — no partial writes.
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return error("invalid json", 400);
  }
  if (!isPlainObject(body)) {
    return error("expected a report object", 400);
  }
  if (!validateReport(body)) {
    return error("invalid report", 422);
  }
  const windowStart = hourlyWindowStart();
  let reserved: number;
  try {
    reserved = await reserveHourlyQuota(env, "reports", windowStart);
  } catch {
    // A missing rate_counters table must not surface as an opaque exception.
    return error("quota store unavailable", 503);
  }
  if (reserved > REPORTS_HOURLY_LIMIT) {
    // The report never lands, so the reservation was never used: hand it back.
    // Release is best effort — a lost release only tightens the limit.
    await releaseHourlyQuota(env, "reports", windowStart).catch(() => {});
    return error("rate limited", 429);
  }
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO bug_reports (
         id, received_at, app_version, os, arch, category, title,
         details_sanitized, diagnostics_json, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        new Date().toISOString(),
        body.diagnostics.appVersion,
        deriveOs(body),
        null, // arch: the web client cannot observe it; kept for desktop parity.
        body.category,
        deriveTitle(body),
        body.details,
        JSON.stringify(body.diagnostics),
        "new",
      )
      .run();
  } catch {
    // The write failed after the reservation landed: hand the quota back so a
    // transient D1 error does not burn the hourly budget.
    await releaseHourlyQuota(env, "reports", windowStart).catch(() => {});
    return error("report store unavailable", 503);
  }
  return json({ id }, 202);
}

async function handleAttachment(request: Request, env: Env, reportId: string): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return error("unauthorized", 401);
  }
  const bucket = env.BUG_REPORT_ATTACHMENTS;
  if (bucket === undefined) {
    return error("attachment store unavailable", 503);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
  if (!ATTACHMENT_CONTENT_TYPES.has(contentType)) {
    return error("unsupported content type", 415);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_ATTACHMENT_BYTES) {
    return error("attachment too large", 413);
  }
  try {
    const report = await env.DB.prepare("SELECT id FROM bug_reports WHERE id = ?")
      .bind(reportId)
      .first<{ id: string }>();
    if (report === null) {
      return error("report not found", 404);
    }
    const attachmentCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM bug_report_attachments WHERE report_id = ?",
    )
      .bind(reportId)
      .first<{ n: number }>();
    if ((attachmentCount?.n ?? 0) >= MAX_ATTACHMENTS_PER_REPORT) {
      return error("attachment limit reached", 429);
    }
  } catch {
    return error("report store unavailable", 503);
  }
  // Read before reserving quota so an oversized upload cannot spend it.
  const bytes = await readBodyBytes(request, MAX_ATTACHMENT_BYTES);
  if (bytes === null) {
    return error("attachment too large", 413);
  }
  const windowStart = hourlyWindowStart();
  let reserved: number;
  try {
    reserved = await reserveHourlyQuota(env, "attachments", windowStart);
  } catch {
    return error("quota store unavailable", 503);
  }
  if (reserved > ATTACHMENTS_HOURLY_LIMIT) {
    await releaseHourlyQuota(env, "attachments", windowStart).catch(() => {});
    return error("rate limited", 429);
  }
  const key = `reports/${reportId}/${crypto.randomUUID()}`;
  try {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType },
      customMetadata: { reportId },
    });
  } catch {
    await releaseHourlyQuota(env, "attachments", windowStart).catch(() => {});
    return error("attachment store unavailable", 503);
  }
  try {
    await env.DB.prepare(
      `INSERT INTO bug_report_attachments (
         id, report_id, object_key, content_type, byte_length, received_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), reportId, key, contentType, bytes.byteLength, new Date().toISOString())
      .run();
  } catch {
    // The object landed but the row did not: delete it so R2 never holds an
    // attachment the report row cannot enumerate.
    await bucket.delete(key).catch(() => {});
    await releaseHourlyQuota(env, "attachments", windowStart).catch(() => {});
    return error("report store unavailable", 503);
  }
  return json({ key }, 201);
}
