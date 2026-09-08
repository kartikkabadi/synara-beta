// FILE: diagnostics.ts
// Purpose: Opt-in beta diagnostics contract: the sanitized event schema, the
//          desktop bridge surface, and the transparency payload types.
// Layer: Contracts
//
// Privacy contract: diagnostics events are allowlist-only. Every field is a
// closed enum, a validated identifier, or a coarse bucket. Free text (prompts,
// paths, emails, tokens, model names, error messages) can never cross the
// sanitizer. See apps/desktop/src/diagnosticsSanitizer.ts and
// docs/diagnostics.md.

export const DIAGNOSTICS_SCHEMA_VERSION = 1;

export const DIAGNOSTICS_EVENT_KINDS = [
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
] as const;

export type DiagnosticsEventKind = (typeof DIAGNOSTICS_EVENT_KINDS)[number];

export const DIAGNOSTICS_PLATFORMS = ["darwin", "linux", "win32"] as const;
export type DiagnosticsPlatform = (typeof DIAGNOSTICS_PLATFORMS)[number];

export const DIAGNOSTICS_ARCHES = ["arm64", "x64"] as const;
export type DiagnosticsArch = (typeof DIAGNOSTICS_ARCHES)[number];

export const DIAGNOSTICS_FLAVORS = ["production", "beta", "canary"] as const;
export type DiagnosticsFlavor = (typeof DIAGNOSTICS_FLAVORS)[number];

export const DIAGNOSTICS_PROVIDERS = [
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
] as const;
export type DiagnosticsProvider = (typeof DIAGNOSTICS_PROVIDERS)[number];

export const DIAGNOSTICS_DURATION_BUCKETS = ["under_1m", "1m_5m", "5m_30m", "over_30m"] as const;
export type DiagnosticsDurationBucket = (typeof DIAGNOSTICS_DURATION_BUCKETS)[number];

export const DIAGNOSTICS_OUTCOMES = ["ok", "error", "cancelled"] as const;
export type DiagnosticsOutcome = (typeof DIAGNOSTICS_OUTCOMES)[number];

export const DIAGNOSTICS_ERROR_SURFACES = ["desktop", "backend", "updater"] as const;
export type DiagnosticsErrorSurface = (typeof DIAGNOSTICS_ERROR_SURFACES)[number];

/** A single sanitized diagnostics event. Every field is validated or bucketed. */
export interface DiagnosticsEvent {
  readonly schemaVersion: 1;
  readonly kind: DiagnosticsEventKind;
  readonly eventId: string;
  /** Minute-precision UTC timestamp; seconds and below are truncated away. */
  readonly occurredAt: string;
  readonly appVersion: string;
  readonly platform: DiagnosticsPlatform;
  readonly arch: DiagnosticsArch;
  readonly flavor: DiagnosticsFlavor;
  /** Random per-install UUID generated on first run. Not derived from hardware or accounts. */
  readonly installId: string;
  readonly provider?: DiagnosticsProvider;
  readonly durationBucket?: DiagnosticsDurationBucket;
  readonly outcome?: DiagnosticsOutcome;
  readonly feature?: string;
  readonly errorCode?: string;
  readonly errorSurface?: DiagnosticsErrorSurface;
}

export interface DiagnosticsState {
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly installId: string;
  readonly endpointUrl: string;
  readonly queuedEventCount: number;
  readonly lastSentAt: string | null;
  readonly lastError: string | null;
}

export interface DiagnosticsSamplePayload {
  readonly endpointUrl: string;
  readonly events: readonly DiagnosticsEvent[];
}

export interface DiagnosticsEventInput {
  readonly kind: DiagnosticsEventKind;
  readonly provider?: string;
  readonly durationBucket?: string;
  readonly outcome?: string;
  readonly feature?: string;
  readonly errorCode?: string;
  readonly errorSurface?: string;
}

export interface DiagnosticsBridge {
  getState: () => Promise<DiagnosticsState>;
  setEnabled: (enabled: boolean) => Promise<DiagnosticsState>;
  /** Returns exactly what a flush would POST right now, without sending. */
  getSamplePayload: () => Promise<DiagnosticsSamplePayload>;
  /** Records one event through the sanitizer; drops it when consent is off. */
  recordEvent: (input: DiagnosticsEventInput) => Promise<boolean>;
  /** Sends a single marked test event immediately (used by the settings panel). */
  sendTestEvent: () => Promise<boolean>;
}
