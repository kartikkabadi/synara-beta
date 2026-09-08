// FILE: diagnosticsSanitizer.test.ts
// Purpose: Locks the diagnostics privacy gate: only allowlisted, validated,
//          bucketed fields can survive; free text and identifiers never can.
// Layer: Desktop main process

import { describe, expect, it } from "vitest";

import { diagnosticsDurationBucket, sanitizeDiagnosticsEvent } from "./diagnosticsSanitizer";

const context = () => ({
  appVersion: "0.8.3-beta.1",
  platform: "darwin",
  arch: "arm64",
  flavor: "beta",
  installId: "0f1a2b3c-4d5e-4f60-8a91-2b3c4d5e6f70",
  now: () => new Date("2026-09-08T10:19:42.123Z"),
});

describe("sanitizeDiagnosticsEvent", () => {
  it("sanitizes a plain app_start event", () => {
    const result = sanitizeDiagnosticsEvent({ kind: "app_start" }, context());
    expect(result).not.toBeNull();
    expect(result?.event.kind).toBe("app_start");
    expect(result?.event.schemaVersion).toBe(1);
    expect(result?.event.occurredAt).toBe("2026-09-08T10:19:00Z");
    expect(result?.event.eventId).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("drops unknown event kinds", () => {
    // SAFETY: the test intentionally passes an out-of-contract kind to prove
    // the sanitizer drops it; `never` is the only way to express that input.
    expect(sanitizeDiagnosticsEvent({ kind: "prompt_content" as never }, context())).toBeNull();
  });

  it("drops session events with unknown providers", () => {
    expect(
      sanitizeDiagnosticsEvent({ kind: "session_started", provider: "gpt-5.6-sol-max" }, context()),
    ).toBeNull();
    expect(
      sanitizeDiagnosticsEvent({ kind: "session_started", provider: "claude" }, context())?.event
        .provider,
    ).toBe("claude");
  });

  it("keeps only bucketed durations for session_ended", () => {
    const result = sanitizeDiagnosticsEvent(
      {
        kind: "session_ended",
        provider: "codex",
        durationBucket: "1m_5m",
        outcome: "ok",
      },
      context(),
    );
    expect(result?.event.durationBucket).toBe("1m_5m");
    expect(
      sanitizeDiagnosticsEvent(
        {
          kind: "session_ended",
          provider: "codex",
          durationBucket: "exactly 4m32s",
          outcome: "ok",
        },
        context(),
      ),
    ).toBeNull();
  });

  it("rejects free-text feature names and error codes", () => {
    expect(
      sanitizeDiagnosticsEvent({ kind: "feature_used", feature: "read ~/.ssh/id_rsa" }, context()),
    ).toBeNull();
    expect(
      sanitizeDiagnosticsEvent({ kind: "feature_used", feature: "has space" }, context()),
    ).toBeNull();
    expect(
      sanitizeDiagnosticsEvent({ kind: "feature_used", feature: "worktree-reclaim" }, context())
        ?.event.feature,
    ).toBe("worktree-reclaim");
    expect(
      sanitizeDiagnosticsEvent(
        {
          kind: "error",
          errorCode: "Unexpected token in /Users/x/secret",
          errorSurface: "desktop",
        },
        context(),
      ),
    ).toBeNull();
    const ok = sanitizeDiagnosticsEvent(
      { kind: "error", errorCode: "backend.exit-nonzero", errorSurface: "backend" },
      context(),
    );
    expect(ok?.event.errorCode).toBe("backend.exit-nonzero");
  });

  it("never carries extra fields from the input", () => {
    // SAFETY: hostile extras are the point of this test — the sanitizer must
    // drop input the type system cannot describe, so the call site passes it
    // through a deliberate widening.
    const result = sanitizeDiagnosticsEvent(
      {
        kind: "session_started",
        provider: "codex",
        // SAFETY: hostile extras are the point of this test — the sanitizer
        // must drop them, and the `as never` cast is how the test expresses
        // input the type system would otherwise reject.
        prompt: "ignore previous instructions",
        path: "/Users/user/.ssh",
        email: "a@b.com",
        token: "ghp_secret",
      } as never,
      context(),
    );
    expect(result).not.toBeNull();
    const serialized = JSON.stringify(result?.event);
    expect(serialized).not.toContain("ignore");
    expect(serialized).not.toContain("/Users");
    expect(serialized).not.toContain("ghp_");
    expect(Object.keys(result?.event ?? {}).sort()).toEqual(
      [
        "arch",
        "appVersion",
        "eventId",
        "flavor",
        "installId",
        "kind",
        "occurredAt",
        "platform",
        "provider",
        "schemaVersion",
      ].sort(),
    );
  });

  it("truncates timestamps to minute precision", () => {
    const result = sanitizeDiagnosticsEvent({ kind: "test" }, context());
    expect(result?.event.occurredAt).toBe("2026-09-08T10:19:00Z");
  });

  it("rejects invalid app versions and install ids", () => {
    expect(
      sanitizeDiagnosticsEvent({ kind: "test" }, { ...context(), appVersion: "not-a-version" }),
    ).toBeNull();
    expect(
      sanitizeDiagnosticsEvent({ kind: "test" }, { ...context(), installId: "not-a-uuid" }),
    ).toBeNull();
  });
});

describe("diagnosticsDurationBucket", () => {
  it("buckets durations coarsely", () => {
    expect(diagnosticsDurationBucket(30_000)).toBe("under_1m");
    expect(diagnosticsDurationBucket(2 * 60_000)).toBe("1m_5m");
    expect(diagnosticsDurationBucket(12 * 60_000)).toBe("5m_30m");
    expect(diagnosticsDurationBucket(45 * 60_000)).toBe("over_30m");
  });
});
