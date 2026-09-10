// FILE: diagnosticsSessions.test.ts
// Purpose: Locks the provider-session-start tracker: exactly one
//          session_started per dead→live transition, none for turn-level
//          status churn on a live session, none for snapshot hydration.
// Layer: web diagnostics observer

import { describe, expect, it, vi } from "vitest";

import type { ThreadSession } from "./types";
import { createProviderSessionStartTracker, isLiveProviderSession } from "./diagnosticsSessions";

function makeSession(orchestrationStatus: ThreadSession["orchestrationStatus"]): ThreadSession {
  return {
    provider: "codex",
    status: "running",
    orchestrationStatus,
    createdAt: "2026-09-08T10:00:00Z",
    updatedAt: "2026-09-08T10:00:00Z",
  };
}

describe("isLiveProviderSession", () => {
  it("treats starting through interrupted as live and null/stopped/error as dead", () => {
    for (const status of ["idle", "starting", "running", "ready", "interrupted"] as const) {
      expect(isLiveProviderSession(makeSession(status))).toBe(true);
    }
    for (const status of ["stopped", "error"] as const) {
      expect(isLiveProviderSession(makeSession(status))).toBe(false);
    }
    expect(isLiveProviderSession(null)).toBe(false);
    expect(isLiveProviderSession(undefined)).toBe(false);
  });
});

describe("createProviderSessionStartTracker", () => {
  it("reports once when a known thread's session becomes live", () => {
    const onSessionStart = vi.fn();
    const track = createProviderSessionStartTracker(onSessionStart);
    track({ threadIds: ["t1"], sessionById: {} });
    track({ threadIds: ["t1"], sessionById: { t1: makeSession("starting") } });
    expect(onSessionStart).toHaveBeenCalledTimes(1);
    expect(onSessionStart).toHaveBeenCalledWith("codex");
    // Turn-level churn on the same session must not recount.
    track({ threadIds: ["t1"], sessionById: { t1: makeSession("running") } });
    track({ threadIds: ["t1"], sessionById: { t1: makeSession("ready") } });
    track({ threadIds: ["t1"], sessionById: { t1: makeSession("starting") } });
    expect(onSessionStart).toHaveBeenCalledTimes(1);
  });

  it("does not report sessions first observed already live (hydration)", () => {
    const onSessionStart = vi.fn();
    const track = createProviderSessionStartTracker(onSessionStart);
    track({ threadIds: ["t1"], sessionById: { t1: makeSession("running") } });
    expect(onSessionStart).not.toHaveBeenCalled();
  });

  it("reports a new session after the previous one stopped", () => {
    const onSessionStart = vi.fn();
    const track = createProviderSessionStartTracker(onSessionStart);
    track({ threadIds: ["t1"], sessionById: { t1: makeSession("running") } });
    track({ threadIds: ["t1"], sessionById: { t1: makeSession("stopped") } });
    track({ threadIds: ["t1"], sessionById: { t1: makeSession("starting") } });
    expect(onSessionStart).toHaveBeenCalledTimes(1);
  });

  it("does not report steer interrupts as new sessions", () => {
    const onSessionStart = vi.fn();
    const track = createProviderSessionStartTracker(onSessionStart);
    track({ threadIds: ["t1"], sessionById: {} });
    track({ threadIds: ["t1"], sessionById: { t1: makeSession("running") } });
    track({ threadIds: ["t1"], sessionById: { t1: makeSession("interrupted") } });
    track({ threadIds: ["t1"], sessionById: { t1: makeSession("running") } });
    expect(onSessionStart).toHaveBeenCalledTimes(1);
  });

  it("tracks sessions per thread", () => {
    const onSessionStart = vi.fn();
    const track = createProviderSessionStartTracker(onSessionStart);
    track({ threadIds: ["t1", "t2"], sessionById: {} });
    track({
      threadIds: ["t1", "t2"],
      sessionById: { t1: makeSession("starting"), t2: makeSession("starting") },
    });
    expect(onSessionStart).toHaveBeenCalledTimes(2);
  });

  it("reports a brand new thread that appears with a live session after hydration", () => {
    const onSessionStart = vi.fn();
    const track = createProviderSessionStartTracker(onSessionStart);
    // Initial hydration: one known thread with no live session.
    track({ threadIds: ["t1"], sessionById: {} });
    // A coalesced update introduces a new thread already live while the known
    // thread stays idle.
    track({
      threadIds: ["t1", "t2"],
      sessionById: { t1: null, t2: makeSession("starting") },
    });
    expect(onSessionStart).toHaveBeenCalledTimes(1);
    expect(onSessionStart).toHaveBeenCalledWith("codex");
  });
});
