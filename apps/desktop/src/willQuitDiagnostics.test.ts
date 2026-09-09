// FILE: willQuitDiagnostics.test.ts
// Purpose: Pins the will-quit once-guard: one successful exit records exactly
//          one app_quit, even though the flush path re-enters `will-quit` via
//          its own app.quit(), and only a flushable queue holds the exit.
// Layer: Desktop main process

import { describe, expect, it } from "vitest";

import { makeWillQuitDiagnosticsCoordinator } from "./willQuitDiagnostics";

function flushInput(
  overrides?: Partial<{
    updaterQuitAndInstallInFlight: boolean;
    diagnosticsEnabled: boolean;
    queuedEventCount: number;
  }>,
) {
  return {
    updaterQuitAndInstallInFlight: false,
    diagnosticsEnabled: true,
    queuedEventCount: 1,
    ...overrides,
  };
}

describe("will-quit diagnostics coordinator", () => {
  it("claims the quit exactly once, so one exit records one app_quit", () => {
    const coordinator = makeWillQuitDiagnosticsCoordinator();
    // First firing: the committed quit — record app_quit and start the flush.
    expect(coordinator.beginQuit()).toBe(true);
    // The flush path re-enters will-quit via its own app.quit(): that firing
    // must be a no-op, or every successful quit would record the event twice
    // and backend app_quit counts would read ~2x.
    expect(coordinator.beginQuit()).toBe(false);
    expect(coordinator.beginQuit()).toBe(false);
  });

  it("holds the exit only when a consented, non-empty queue is flushable", () => {
    const coordinator = makeWillQuitDiagnosticsCoordinator();
    expect(
      coordinator.shouldHoldForFlush({
        updaterQuitAndInstallInFlight: false,
        diagnosticsEnabled: true,
        queuedEventCount: 1,
      }),
    ).toBe(true);
    // The updater owns the exit: never delay the install handoff.
    expect(
      coordinator.shouldHoldForFlush({
        updaterQuitAndInstallInFlight: true,
        diagnosticsEnabled: true,
        queuedEventCount: 1,
      }),
    ).toBe(false);
    // Consent off: the record was refused, there is nothing to flush.
    expect(
      coordinator.shouldHoldForFlush({
        updaterQuitAndInstallInFlight: false,
        diagnosticsEnabled: false,
        queuedEventCount: 0,
      }),
    ).toBe(false);
    // Nothing queued: no batch to send, so the exit proceeds.
    expect(
      coordinator.shouldHoldForFlush({
        updaterQuitAndInstallInFlight: false,
        diagnosticsEnabled: true,
        queuedEventCount: 0,
      }),
    ).toBe(false);
  });
});
