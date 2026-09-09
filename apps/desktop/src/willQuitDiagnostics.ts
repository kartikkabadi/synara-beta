// FILE: willQuitDiagnostics.ts
// Purpose: Owns the once-guard behind the will-quit diagnostics flush, so the
//          app_quit telemetry rule is testable without booting Electron.
// Layer: Desktop main process

export interface WillQuitDiagnosticsFlushInput {
  /** The updater's quit-and-install owns this exit; delaying it is unsafe. */
  readonly updaterQuitAndInstallInFlight: boolean;
  /** Consent state at quit time; a disabled client has nothing to flush. */
  readonly diagnosticsEnabled: boolean;
  /** Queue depth after the app_quit record, so a non-empty queue flushes. */
  readonly queuedEventCount: number;
}

export interface WillQuitDiagnosticsCoordinator {
  /**
   * Claims the committed quit signal. Returns true only on the first
   * `will-quit` firing of a successful exit: the handler's own
   * preventDefault + `app.quit()` re-enters the signal, so this guard — not
   * the record call's position alone — is what keeps one exit to exactly one
   * app_quit event.
   */
  beginQuit(): boolean;
  /**
   * Whether the exit should be held for the final flush. Callers pass the
   * queue state read after the app_quit record, so a refused record (consent
   * off) never delays the exit.
   */
  shouldHoldForFlush(input: {
    readonly updaterQuitAndInstallInFlight: boolean;
    readonly diagnosticsEnabled: boolean;
    readonly queuedEventCount: number;
  }): boolean;
}

/**
 * Owns the once-guard for the will-quit diagnostics flush. The flush path
 * re-enters `will-quit` via its own `app.quit()`, so the guard must gate the
 * app_quit record itself: the first firing records, every later firing is a
 * no-op. A missed flush window is covered by the durable queue on the next
 * launch, never by re-recording.
 */
export function makeWillQuitDiagnosticsCoordinator(): WillQuitDiagnosticsCoordinator {
  let quitBegun = false;
  return {
    beginQuit(): boolean {
      if (quitBegun) return false;
      quitBegun = true;
      return true;
    },
    shouldHoldForFlush({
      updaterQuitAndInstallInFlight,
      diagnosticsEnabled,
      queuedEventCount,
    }): boolean {
      // The updater's quit-and-install owns this exit; delaying it can
      // interfere with the handoff. The queued event still survives to the
      // next launch.
      return !updaterQuitAndInstallInFlight && diagnosticsEnabled && queuedEventCount > 0;
    },
  };
}
