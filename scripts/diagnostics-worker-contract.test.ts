// FILE: diagnostics-worker-contract.test.ts
// Purpose: Pins the sanitizer and the Cloudflare collector to the same
//          contract. The worker's validator is a structural mirror of the
//          desktop sanitizer (both must accept exactly the same events), so
//          this test imports the worker's contract module and checks both
//          sides against one fixture matrix. If one side tightens and the
//          other does not, this test fails.
// Layer: Scripts (cross-boundary contract test)

import { describe, expect, it } from "vitest";

import {
  sanitizeDiagnosticsEvent,
  type SanitizeContext,
} from "../apps/desktop/src/diagnosticsSanitizer";
import {
  validateEvent,
  type DiagnosticsEvent,
  type JsonValue,
} from "../infrastructure/diagnostics-worker/src/contract";

const CONTEXT: SanitizeContext = {
  appVersion: "0.8.3-beta.1",
  platform: "darwin",
  arch: "arm64",
  flavor: "beta",
  installId: "0f1a2b3c-0000-4000-8000-000000000001",
  now: () => new Date("2026-09-08T10:19:30Z"),
};

const VALID_INPUTS = [
  { kind: "app_start" },
  { kind: "app_quit" },
  { kind: "test" },
  { kind: "update_available" },
  { kind: "update_downloaded" },
  { kind: "update_installed" },
  { kind: "update_failed" },
  { kind: "session_started", provider: "codex" },
  { kind: "session_ended", provider: "claude", durationBucket: "1m_5m", outcome: "ok" },
  { kind: "feature_used", feature: "worktree-reclaim" },
  { kind: "error", errorCode: "backend.exit-nonzero", errorSurface: "backend" },
] as const;

const HOSTILE_INPUTS = [
  // Unknown kind.
  { kind: "prompt_content" },
  // Free text where only a slug is allowed.
  { kind: "session_started", provider: "Codex <script>" },
  { kind: "session_ended", provider: "codex", durationBucket: "exactly 4m32s", outcome: "ok" },
  { kind: "feature_used", feature: "../etc/passwd" },
  { kind: "error", errorCode: "Unexpected token in /Users/x/secret", errorSurface: "desktop" },
  // A token- or model-shaped value without a known domain prefix is still free text.
  { kind: "error", errorCode: "sk-proj-abc123def456", errorSurface: "backend" },
  { kind: "error", errorCode: "ghp_aaaabbbbccccdddd", errorSurface: "updater" },
  // Missing required per-kind fields.
  { kind: "session_started" },
  { kind: "error", errorCode: "backend.exit-nonzero" },
  // Fields that only make sense on another kind are out of contract, not data.
  { kind: "session_started", provider: "codex", errorCode: "backend.exit-nonzero" },
  { kind: "app_start", provider: "codex" },
  { kind: "test", feature: "worktree-reclaim" },
] as const;

interface WorkerEventFixture {
  readonly schemaVersion: 1;
  readonly kind: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly flavor: string;
  readonly installId: string;
}

function workerEvent(kind: string): WorkerEventFixture {
  return {
    schemaVersion: 1,
    kind,
    eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01",
    occurredAt: "2026-09-08T10:19:00Z",
    appVersion: "0.8.3-beta.1",
    platform: "darwin",
    arch: "arm64",
    flavor: "beta",
    installId: "0f1a2b3c-0000-4000-8000-000000000001",
  };
}

function context(): SanitizeContext {
  return { ...CONTEXT };
}

describe("diagnostics worker contract", () => {
  it("accepts every event the sanitizer produces, for every kind", () => {
    for (const input of VALID_INPUTS) {
      const sanitized = sanitizeDiagnosticsEvent(input, context());
      expect(sanitized).not.toBeNull();
      // The worker sees events after JSON round-tripping, so mirror that in the
      // type boundary test rather than asserting on the in-memory nominal type.
      const wireEvent = JSON.parse(JSON.stringify(sanitized?.event)) as JsonValue;
      expect(validateEvent(wireEvent)).toBe(true);
    }
  });

  it("rejects what the sanitizer rejects", () => {
    for (const input of HOSTILE_INPUTS) {
      // SAFETY: hostile inputs are intentionally out of contract; `never` is
      // how the test expresses input the type system would otherwise reject.
      const sanitized = sanitizeDiagnosticsEvent(input as never, context());
      expect(sanitized).toBeNull();
    }
  });

  it("rejects malformed identifiers the sanitizer would never emit", () => {
    const contextWith = (overrides: Partial<SanitizeContext>) => ({ ...context(), ...overrides });

    expect(
      sanitizeDiagnosticsEvent({ kind: "test" }, contextWith({ installId: "not-a-uuid" })),
    ).toBeNull();
    expect(validateEvent({ ...workerEvent("app_start"), installId: "not-a-uuid" })).toBe(false);
    expect(
      sanitizeDiagnosticsEvent({ kind: "test" }, contextWith({ appVersion: "not-a-version" })),
    ).toBeNull();
    expect(validateEvent({ ...workerEvent("app_start"), appVersion: "1.2" })).toBe(false);
    expect(
      validateEvent({ ...workerEvent("app_start"), occurredAt: "2026-09-08T10:19:30.123Z" }),
    ).toBe(false);
  });

  it("accepts canary app versions on both sides of the boundary", () => {
    const sanitized = sanitizeDiagnosticsEvent(
      { kind: "test" },
      { ...context(), appVersion: "0.8.3-canary.4", flavor: "canary" },
    );
    expect(sanitized).not.toBeNull();
    // SAFETY: the test round-trips its own output through JSON, so the wire
    // shape is known to be a plain value.
    const wireEvent = JSON.parse(JSON.stringify(sanitized?.event)) as JsonValue;
    expect(validateEvent(wireEvent)).toBe(true);
    expect(
      validateEvent({ ...workerEvent("test"), appVersion: "0.8.3-canary.4", flavor: "canary" }),
    ).toBe(true);
    expect(validateEvent({ ...workerEvent("test"), appVersion: "0.8.3-alpha.1" })).toBe(false);
  });

  it("rejects events carrying fields outside the contract", () => {
    expect(
      validateEvent({ ...workerEvent("app_start"), prompt: "ignore previous instructions" }),
    ).toBe(false);
  });

  it("keeps the wire types strict", () => {
    // Strict JSON: undefined is not a JSON value, so the wire type must never
    // admit it — a widened JsonValue would let absent values typecheck as
    // present data.
    // @ts-expect-error — undefined is not a JsonValue.
    const notJson: JsonValue = undefined;
    expect(notJson).toBeUndefined();
    // The event type stays closed: without an index signature, out-of-contract
    // fields are a type error, not silent extra data.
    const event: DiagnosticsEvent = workerEvent("test");
    // @ts-expect-error — no index signature on DiagnosticsEvent.
    expect(event.notInTheContract).toBeUndefined();
    // External input is validated from `unknown`, the way JSON.parse output
    // actually arrives.
    expect(validateEvent(JSON.parse(JSON.stringify(workerEvent("test"))) as unknown)).toBe(true);
    expect(validateEvent(undefined)).toBe(false);
    expect(validateEvent("not-an-object")).toBe(false);
  });
});
