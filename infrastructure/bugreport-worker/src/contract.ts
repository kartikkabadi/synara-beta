// FILE: contract.ts
// Purpose: The beta bug-report ingestion contract, kept dependency-free so the
//          scripts test suite can import it and prove the web payload and this
//          collector stay in sync.
// Layer: Cloudflare Worker (standalone deploy; see README.md)
//
// Privacy contract (mirrors apps/web/src/feedback.ts — keep in sync): the
// client sanitizes every report before it leaves the app (secrets masked with
// [REDACTED], home paths folded to ~). The worker still treats the payload as
// untrusted: every field is a closed key, a closed enum, a bounded string, or
// a bounded count — a validated report carries nothing outside this schema.
// Any violation rejects the whole report (fail closed); there is no repair.

export type BugReportCategory =
  | "bug"
  | "session"
  | "ui"
  | "performance"
  | "idea"
  | "other";

const CATEGORIES: ReadonlySet<string> = new Set([
  "bug",
  "session",
  "ui",
  "performance",
  "idea",
  "other",
]);

// Mirrors FeedbackThreadContext + the browser fields in apps/web. Every key is
// required — the web client always sends the full object, so a missing key is
// a malformed report, not a sparse one.
export interface BugReportDiagnostics {
  appVersion: string;
  submittedAt: string;
  userAgent: string;
  platform: string;
  language: string;
  viewport: string;
  provider: string | null;
  model: string | null;
  projectKind: string | null;
  environmentMode: string | null;
  runtimeMode: string | null;
  interactionMode: string | null;
  sessionStatus: string | null;
  latestTurnState: string | null;
  messageCount: number;
  activityCount: number;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  hasThreadError: boolean;
}

// Deliberately closed: no index signature. The validator checks every key
// against ALLOWED_KEYS and every value against its own bound, so a validated
// report is fully described by these fields.
export interface BugReport {
  schemaVersion: 1;
  category: BugReportCategory | null;
  /** Sanitized free text written by the reporter. */
  details: string;
  /** Reader-facing rendering of the diagnostics (the maintainer's summary). */
  summary: string;
  /**
   * Allow-listed diagnostics block — the same text the agent-drafted issue
   * flow quotes, stored so the private copy and the public draft match.
   */
  diagnosticsReport: string;
  diagnostics: BugReportDiagnostics;
}

// The dialog caps details at 5,000 characters; sanitization can grow a report
// slightly ([REDACTED] markers), so the bound leaves headroom without opening
// the door to dumped logs.
export const MAX_DETAILS_CHARS = 10_000;
export const MAX_RENDERED_CHARS = 4_000;
const MAX_VERSION_CHARS = 64;
const MAX_PLATFORM_CHARS = 128;
const MAX_LANGUAGE_CHARS = 32;
const MAX_FIELD_TEXT_CHARS = 256;
const MAX_USER_AGENT_CHARS = 512;
const MAX_COUNT = 1_000_000;

// Attachments are screenshots only: a closed image-type allowlist and a hard
// byte cap keep the bucket from becoming a file dump.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REPORT = 5;
export const ATTACHMENT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

// toISOString() output — the only shape the client produces.
const SUBMITTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VIEWPORT_PATTERN = /^\d{1,5}x\d{1,5}$/u;

const REQUIRED_STRING_FIELDS = {
  appVersion: MAX_VERSION_CHARS,
  userAgent: MAX_USER_AGENT_CHARS,
  platform: MAX_PLATFORM_CHARS,
  language: MAX_LANGUAGE_CHARS,
} as const;

const NULLABLE_STRING_FIELDS = [
  "provider",
  "model",
  "projectKind",
  "environmentMode",
  "runtimeMode",
  "interactionMode",
  "sessionStatus",
  "latestTurnState",
] as const;

const COUNT_FIELDS = ["messageCount", "activityCount"] as const;
const FLAG_FIELDS = ["hasPendingApproval", "hasPendingUserInput", "hasThreadError"] as const;

const DIAGNOSTICS_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(REQUIRED_STRING_FIELDS),
  "submittedAt",
  "viewport",
  ...NULLABLE_STRING_FIELDS,
  ...COUNT_FIELDS,
  ...FLAG_FIELDS,
]);

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "category",
  "details",
  "summary",
  "diagnosticsReport",
  "diagnostics",
]);

// External input arrives as `unknown` (JSON.parse output, or any caller
// object); these guards are the only way a value reaches a typed field.
function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isBoolean(value: unknown): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]";
}

function isBoundedCount(value: unknown): value is number {
  return (
    Object.prototype.toString.call(value) === "[object Number]" &&
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_COUNT
  );
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return isString(value) && value.length > 0 && value.length <= maxChars;
}

function isNullableString(value: unknown, maxChars: number): value is string | null {
  return value === null || (isString(value) && value.length <= maxChars);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";
}

function validateDiagnostics(value: unknown): value is BugReportDiagnostics {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== DIAGNOSTICS_KEYS.size || !keys.every((key) => DIAGNOSTICS_KEYS.has(key))) {
    return false;
  }
  for (const [field, maxChars] of Object.entries(REQUIRED_STRING_FIELDS)) {
    if (!isBoundedString(value[field], maxChars)) return false;
  }
  if (!isString(value.submittedAt) || !SUBMITTED_AT_PATTERN.test(value.submittedAt)) {
    return false;
  }
  if (!isString(value.viewport) || !VIEWPORT_PATTERN.test(value.viewport)) return false;
  for (const field of NULLABLE_STRING_FIELDS) {
    if (!isNullableString(value[field], MAX_FIELD_TEXT_CHARS)) return false;
  }
  for (const field of COUNT_FIELDS) {
    if (!isBoundedCount(value[field])) return false;
  }
  for (const field of FLAG_FIELDS) {
    if (!isBoolean(value[field])) return false;
  }
  return true;
}

/**
 * Structural mirror of the web submission. Rejects any report with a key
 * outside the contract or a value outside its enum/bound — the whole report is
 * refused, never partially stored.
 */
export function validateReport(value: unknown): value is BugReport {
  if (!isPlainObject(value)) return false;
  if (!Object.keys(value).every((key) => ALLOWED_KEYS.has(key))) return false;
  if (value.schemaVersion !== 1) return false;
  if (value.category !== null && (!isString(value.category) || !CATEGORIES.has(value.category))) {
    return false;
  }
  if (!isBoundedString(value.details, MAX_DETAILS_CHARS)) return false;
  if (!isBoundedString(value.summary, MAX_RENDERED_CHARS)) return false;
  if (!isBoundedString(value.diagnosticsReport, MAX_RENDERED_CHARS)) return false;
  return validateDiagnostics(value.diagnostics);
}
