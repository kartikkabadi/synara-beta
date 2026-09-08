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
  "update_downloaded",
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
// Mirrors the sanitizer: a known domain prefix keeps caller-supplied free text
// (tokens, model names, raw messages) out of the code field.
const ERROR_CODE_PATTERN =
  /^(?:desktop|backend|updater|migration|provider)\.[a-z0-9][a-z0-9.-]{0,58}$/u;
export const MAX_BATCH = 50;

const OPTIONAL_FIELDS = [
  "provider",
  "durationBucket",
  "outcome",
  "feature",
  "errorCode",
  "errorSurface",
] as const;

// Every present optional must match its own allowlist or pattern, whatever the
// kind — a valid-looking kind must never ferry free text in an unused field.
const OPTIONAL_FIELD_RULES: Readonly<Record<string, (value: string) => boolean>> = {
  provider: (value) => PROVIDERS.has(value),
  durationBucket: (value) => DURATION_BUCKETS.has(value),
  outcome: (value) => OUTCOMES.has(value),
  feature: (value) => FEATURE_PATTERN.test(value),
  errorCode: (value) => ERROR_CODE_PATTERN.test(value),
  errorSurface: (value) => ERROR_SURFACES.has(value),
};

// Fields each kind requires. An optional field is only allowed on kinds that
// require it — the same rule the desktop sanitizer enforces via excess-property
// rejection, so both sides accept exactly the same events.
const REQUIRED_FIELDS_BY_KIND: Readonly<Record<string, ReadonlyArray<string>>> = {
  session_started: ["provider"],
  session_ended: ["provider", "durationBucket", "outcome"],
  feature_used: ["feature"],
  error: ["errorCode", "errorSurface"],
};

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
  const required = REQUIRED_FIELDS_BY_KIND[value.kind] ?? [];
  for (const [field, isValidValue] of Object.entries(OPTIONAL_FIELD_RULES)) {
    const present = value[field];
    if (present === undefined) {
      if (required.includes(field)) return false;
      continue;
    }
    if (typeof present !== "string" || !isValidValue(present)) return false;
    if (!required.includes(field)) return false;
  }
  return true;
}
