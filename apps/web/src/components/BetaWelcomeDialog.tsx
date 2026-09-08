// FILE: BetaWelcomeDialog.tsx
// Purpose: One-time welcome for the Synara Beta desktop flavor: what the beta
//          is, and an inline opt-in for anonymous diagnostics with the exact
//          transparency pitch. Never shows on production or canary builds.
// Layer: Root web overlay
//
// Same announcement-sheet geometry as AppSnapWelcomeDialog (420px, 20px
// padding, solid surface), with the beta gradient as the hero accent.

import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Switch } from "./ui/switch";

const BETA_WELCOME_STORAGE_KEY = "synara:beta-welcome:v1";

const BetaWelcomeStorageSchema = Schema.Struct({
  acknowledged: Schema.Boolean,
});
type BetaWelcomeStorage = typeof BetaWelcomeStorageSchema.Type;

const INITIAL_STORAGE: BetaWelcomeStorage = { acknowledged: false };

export function BetaWelcomeDialog() {
  const [storage, setStorage] = useLocalStorage(
    BETA_WELCOME_STORAGE_KEY,
    INITIAL_STORAGE,
    BetaWelcomeStorageSchema,
  );
  const [open, setOpen] = useState(false);
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (storage.acknowledged) {
      return;
    }

    const bridge = window.desktopBridge;
    if (!bridge?.diagnostics) return;

    let disposed = false;
    void bridge
      .getUpdateState()
      .then((state) => {
        if (disposed) return;
        if (state.flavor !== "beta") return;
        setOpen(true);
        return bridge.diagnostics?.getState().then((diagnostics) => {
          if (!disposed) setDiagnosticsEnabled(diagnostics.enabled);
        });
      })
      .catch(() => {
        // A transient desktop startup issue should not permanently hide the
        // welcome on the next launch, so a failed probe is not acknowledged.
      });

    return () => {
      disposed = true;
    };
  }, [storage.acknowledged]);

  const acknowledge = () => {
    setOpen(false);
    setStorage({ acknowledged: true });
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setOpen(true);
      return;
    }
    acknowledge();
  };

  const toggleDiagnostics = (enabled: boolean) => {
    setDiagnosticsEnabled(enabled);
    void window.desktopBridge?.diagnostics?.setEnabled(enabled);
  };

  const dialogOpen = open && !storage.acknowledged;

  return (
    <Dialog open={dialogOpen} onOpenChange={handleOpenChange}>
      <DialogPopup
        showCloseButton={false}
        initialFocus={sheetRef}
        className="max-w-[420px] rounded-[20px]"
      >
        <div ref={sheetRef} tabIndex={-1} className="flex flex-col p-5 outline-none">
          <span
            aria-hidden
            className="mb-6 flex size-14 shrink-0 items-center justify-center rounded-2xl bg-[image:var(--beta-gradient)] text-[15px] font-bold tracking-tight text-white"
          >
            β
          </span>

          <DialogHeader className="gap-2 p-0">
            <DialogTitle className="text-[19px] leading-tight">Welcome to Synara Beta</DialogTitle>
            <DialogDescription className="text-[14px] leading-[19.5px]">
              The fast lane: new features land here first, side by side with Synara Stable in its
              own data directory. One-click updates keep you current.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-[color:var(--color-border)] bg-muted/30 p-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-[13px] font-medium leading-tight">
                Share anonymous diagnostics
              </span>
              <span className="text-[12px] leading-[16px] text-muted-foreground">
                Off by default. Counters only — never prompts, paths, or account data. See exactly
                what gets sent in Settings → Diagnostics.
              </span>
            </div>
            <Switch
              checked={diagnosticsEnabled}
              onCheckedChange={toggleDiagnostics}
              aria-label="Share anonymous diagnostics"
            />
          </div>

          <DialogFooter className="gap-2 p-0 pt-4">
            <Button className="rounded-[10px]" onClick={acknowledge}>
              Get started
            </Button>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
