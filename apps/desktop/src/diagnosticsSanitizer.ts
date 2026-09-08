// FILE: diagnosticsSanitizer.ts
// Purpose: The single gate between the app and the diagnostics endpoint.
//          Decodes arbitrary input into a schema-valid DiagnosticsEvent or null.
// Layer: Desktop main process
//
// Privacy contract: the output contains only fields defined by the contract,
// each validated against a closed enum, a bounded identifier pattern, or a
// coarse bucket. Anything else — prompts, file paths, emails, tokens, model
// names, error messages — is dropped here and can never reach the endpoint.

import { Schema } from "effect";

import {
  DIAGNOSTICS_ARCHES,
  DIAGNOSTICS_DURATION_BUCKETS,
  DIAGNOSTICS_ERROR_SURFACES,
  DIAGNOSTICS_EVENT_KINDS,
  DIAGNOSTICS_FLAVORS,
  DIAGNOSTICS_OUTCOMES,
  DIAGNOSTICS_PLATFORMS,
  DIAGNOSTICS_PROVIDERS,
  DIAGNOSTICS_SCHEMA_VERSION,
  type DiagnosticsDurationBucket,
  type DiagnosticsEvent,
  type DiagnosticsEventInput,
} from "@synara/contracts";

const UUID_PATTERN = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const APP_VERSION_PATTERN = Schema.String.check(
  Schema.isPattern(/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-beta\.\d{1,3})?$/u),
);
const EVENT_ID_PATTERN = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
const FEATURE_PATTERN = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/u));
// A known domain prefix keeps caller-supplied free text (tokens, model names,
// raw messages) out of the code field: only internally chosen slugs pass.
const ERROR_CODE_PATTERN = Schema.String.check(
  Schema.isPattern(/^(?:desktop|backend|updater|migration|provider)\.[a-z0-9][a-z0-9.-]{0,58}$/u),
);

const Provider = Schema.Literals([...DIAGNOSTICS_PROVIDERS]);
const DurationBucket = Schema.Literals([...DIAGNOSTICS_DURATION_BUCKETS]);
const Outcome = Schema.Literals([...DIAGNOSTICS_OUTCOMES]);
const ErrorSurface = Schema.Literals([...DIAGNOSTICS_ERROR_SURFACES]);

const CommonFields = {
  schemaVersion: Schema.Literal(DIAGNOSTICS_SCHEMA_VERSION),
  eventId: EVENT_ID_PATTERN,
  occurredAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/u)),
  appVersion: APP_VERSION_PATTERN,
  platform: Schema.Literals([...DIAGNOSTICS_PLATFORMS]),
  arch: Schema.Literals([...DIAGNOSTICS_ARCHES]),
  flavor: Schema.Literals([...DIAGNOSTICS_FLAVORS]),
  installId: UUID_PATTERN,
};

const SessionStartedSchema = Schema.Struct({
  ...CommonFields,
  kind: Schema.Literal("session_started"),
  provider: Provider,
});

const SessionEndedSchema = Schema.Struct({
  ...CommonFields,
  kind: Schema.Literal("session_ended"),
  provider: Provider,
  durationBucket: DurationBucket,
  outcome: Outcome,
});

const FeatureUsedSchema = Schema.Struct({
  ...CommonFields,
  kind: Schema.Literal("feature_used"),
  feature: FEATURE_PATTERN,
});

const ErrorEventSchema = Schema.Struct({
  ...CommonFields,
  kind: Schema.Literal("error"),
  errorCode: ERROR_CODE_PATTERN,
  errorSurface: ErrorSurface,
});

const BareEventSchema = Schema.Struct({
  ...CommonFields,
  kind: Schema.Literals([
    "app_start",
    "app_quit",
    "update_available",
    "update_downloaded",
    "update_installed",
    "update_failed",
    "test",
  ]),
});

const SanitizedEventSchema = Schema.Union([
  SessionStartedSchema,
  SessionEndedSchema,
  FeatureUsedSchema,
  ErrorEventSchema,
  BareEventSchema,
]);

export const DiagnosticsEventInputSchema = Schema.Struct({
  kind: Schema.Literals([...DIAGNOSTICS_EVENT_KINDS]),
  provider: Schema.optional(Schema.String),
  durationBucket: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
  feature: Schema.optional(Schema.String),
  errorCode: Schema.optional(Schema.String),
  errorSurface: Schema.optional(Schema.String),
});

export interface SanitizeContext {
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly flavor: string;
  readonly installId: string;
  readonly now: () => Date;
}

function minuteBucket(date: Date): string {
  return `${date.toISOString().slice(0, 16)}:00Z`;
}

/**
 * Decodes the caller-supplied event against the allowlist schema. Returns null
 * when the event kind is unknown or any field fails validation — the caller
 * must drop the event, never attempt to repair it.
 */
export function sanitizeDiagnosticsEvent(
  input: DiagnosticsEventInput,
  context: SanitizeContext,
): { readonly event: DiagnosticsEvent } | null {
  try {
    const parsedInput = Schema.decodeUnknownSync(DiagnosticsEventInputSchema)(input);
    const candidate = {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      kind: parsedInput.kind,
      eventId: randomEventId(),
      occurredAt: minuteBucket(context.now()),
      appVersion: context.appVersion,
      platform: context.platform,
      arch: context.arch,
      flavor: context.flavor,
      installId: context.installId,
      ...optionalField("provider", parsedInput.provider),
      ...optionalField("durationBucket", parsedInput.durationBucket),
      ...optionalField("outcome", parsedInput.outcome),
      ...optionalField("feature", parsedInput.feature),
      ...optionalField("errorCode", parsedInput.errorCode),
      ...optionalField("errorSurface", parsedInput.errorSurface),
    };
    const event = Schema.decodeUnknownSync(SanitizedEventSchema)(candidate, {
      // A field only makes sense on the kinds that require it; anything else
      // (e.g. an errorCode on app_start) is out of contract, not extra data.
      onExcessProperty: "error",
    });
    return { event };
  } catch {
    return null;
  }
}

function optionalField<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { readonly [K in Key]?: Value } {
  // SAFETY: the computed key is the literal `key` argument, so the object
  // always matches the declared single-key mapping shape.
  return (value === undefined ? {} : { [key]: value }) as { readonly [K in Key]?: Value };
}

function randomEventId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Coarse duration bucket from a millisecond duration; exact durations never leave the app. */
export function diagnosticsDurationBucket(durationMs: number): DiagnosticsDurationBucket {
  const minutes = Math.max(0, durationMs) / 60_000;
  if (minutes < 1) return "under_1m";
  if (minutes < 5) return "1m_5m";
  if (minutes < 30) return "5m_30m";
  return "over_30m";
}
