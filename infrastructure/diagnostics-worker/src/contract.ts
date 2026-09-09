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

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

// Deliberately closed: no index signature. The validator checks every key
// against ALLOWED_KEYS and every value against its own rule, so a validated
// event is fully described by these fields — a loose index signature would
// let out-of-contract fields typecheck their way past this module.
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
const APP_VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-(?:beta|canary)\.\d{1,3})?$/u;
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
const OPTIONAL_FIELD_RULES = {
  provider: (value: string) => PROVIDERS.has(value),
  durationBucket: (value: string) => DURATION_BUCKETS.has(value),
  outcome: (value: string) => OUTCOMES.has(value),
  feature: (value: string) => FEATURE_PATTERN.test(value),
  errorCode: (value: string) => ERROR_CODE_PATTERN.test(value),
  errorSurface: (value: string) => ERROR_SURFACES.has(value),
} as const satisfies Record<string, (value: string) => boolean>;

// Fields each kind requires. An optional field is only allowed on kinds that
// require it — the same rule the desktop sanitizer enforces via excess-property
// rejection, so both sides accept exactly the same events. A Map keeps the
// lookup safe for any runtime string: no prototype member can masquerade as a
// kind, and a miss is an explicit undefined, not an inherited value.
const REQUIRED_FIELDS_BY_KIND: ReadonlyMap<string, readonly string[]> = new Map([
  ["session_started", ["provider"]],
  ["session_ended", ["provider", "durationBucket", "outcome"]],
  ["feature_used", ["feature"]],
  ["error", ["errorCode", "errorSurface"]],
]);

const ALLOWED_KEYS: Set<string> = new Set([
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
]);

// External input arrives as `unknown` (JSON.parse output, or any caller
// object); these guards are the only way a value reaches a typed field.
function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumber(value: unknown): value is number {
  return (
    Object.prototype.toString.call(value) === "[object Number]" && Number.isFinite(Number(value))
  );
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * Structural mirror of the desktop sanitizer. Rejects any event with a field
 * outside the contract or a value outside its enum/pattern. The batch is
 * rejected whole when any event fails — no partial writes, no silent repair.
 */
export function validateEvent(value: unknown): value is DiagnosticsEvent {
  if (!isPlainObject(value)) return false;
  if (!Object.keys(value).every((key) => ALLOWED_KEYS.has(key))) return false;
  if (!isNumber(value.schemaVersion) || value.schemaVersion !== 1) return false;
  if (!isString(value.kind) || !KINDS.has(value.kind)) return false;
  if (!isString(value.eventId) || !EVENT_ID_PATTERN.test(value.eventId)) return false;
  if (!isString(value.occurredAt) || !MINUTE_PATTERN.test(value.occurredAt)) return false;
  if (!isString(value.appVersion) || !APP_VERSION_PATTERN.test(value.appVersion)) {
    return false;
  }
  if (
    !isString(value.platform) ||
    !PLATFORMS.has(value.platform) ||
    !isString(value.arch) ||
    !ARCHES.has(value.arch) ||
    !isString(value.flavor) ||
    !FLAVORS.has(value.flavor) ||
    !isString(value.installId) ||
    !UUID_PATTERN.test(value.installId)
  ) {
    return false;
  }
  const required = REQUIRED_FIELDS_BY_KIND.get(value.kind) ?? [];
  for (const [field, isValidValue] of Object.entries(OPTIONAL_FIELD_RULES)) {
    const present = value[field];
    if (present === undefined) {
      if (required.includes(field)) return false;
      continue;
    }
    if (!isString(present) || !isValidValue(present)) return false;
    if (!required.includes(field)) return false;
  }
  return true;
}
