// FILE: contract.ts
// Purpose: The diagnostics ingestion contract, kept dependency-free so the
//          desktop test suite can import it and prove the desktop sanitizer
//          and this collector accept exactly the same events.
// Layer: Cloudflare Worker (standalone deploy; see README.md)
//
// Privacy contract (mirrors apps/desktop/src/diagnosticsSanitizer.ts — keep in
// sync): every field is a closed enum, a validated identifier, or a coarse
// bucket. Batches containing any invalid event are rejected whole (fail
// closed). The worker never stores IP addresses, user agents, or free text.

export interface DiagnosticsEvent {
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

export const KINDS: ReadonlySet<string> = new Set([
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
const PROVIDERS: ReadonlySet<string> = new Set([
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

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const EVENT_ID_PATTERN = /^[0-9a-f]{32}$/u;
const APP_VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-beta\.\d{1,3})?$/u;
const MINUTE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/u;
const FEATURE_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
export const MAX_BATCH = 50;

const OPTIONAL_FIELDS = [
  "provider",
  "durationBucket",
  "outcome",
  "feature",
  "errorCode",
  "errorSurface",
] as const;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
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
