// FILE: StableImportWelcomeDialog.tsx
// Purpose: First-run offer to import chats, projects, and setup from Synara Stable.
// Layer: Root web overlay
//
// Shown once on desktop when Synara Stable data exists and this Beta profile has
// never imported it. The desktop main process performs the import (it stops the
// backend, swaps the database, and relaunches), so this dialog only drives the
// ask: status probe, run, busy/error/restart states.

import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";

import type { DesktopStableImportStatus } from "@synara/contracts";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { CentralIcon } from "../lib/central-icons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const STABLE_IMPORT_WELCOME_STORAGE_KEY = "synara:stable-import-welcome:v1";

const StableImportWelcomeStorageSchema = Schema.Struct({
  acknowledged: Schema.Boolean,
});
type StableImportWelcomeStorage = typeof StableImportWelcomeStorageSchema.Type;

const INITIAL_STORAGE: StableImportWelcomeStorage = { acknowledged: false };

type ImportPhase = "idle" | "importing" | "done";

export function StableImportWelcomeDialog() {
  const [storage, setStorage] = useLocalStorage(
    STABLE_IMPORT_WELCOME_STORAGE_KEY,
    INITIAL_STORAGE,
    StableImportWelcomeStorageSchema,
  );
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<DesktopStableImportStatus | null>(null);
  const [phase, setPhase] = useState<ImportPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (storage.acknowledged) {
      return;
    }

    const bridge = window.desktopBridge?.stableImport;
    if (!bridge) return;

    let disposed = false;
    void bridge
      .getStatus()
      .then((next) => {
        if (disposed) return;
        setStatus(next);
        if (next.hasBeenImportedBefore) return;
        if (next.available || next.stableDatabaseExists) setOpen(true);
      })
      .catch((cause: unknown) => {
        // A failed probe must not acknowledge: the next launch should try again.
        console.warn("[stable-import] Could not check Synara Stable data", cause);
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

  const runImport = async () => {
    const bridge = window.desktopBridge?.stableImport;
    if (!bridge) return;
    setError(null);
    setPhase("importing");
    try {
      const result = await bridge.run();
      if (result.ok) {
        setPhase("done");
        return;
      }
      setPhase("idle");
      setError(result.message);
    } catch (cause: unknown) {
      setPhase("idle");
      setError(cause instanceof Error ? cause.message : "The import could not start.");
    }
  };

  // Derived instead of synced: acknowledging closes the dialog in the same render.
  const dialogOpen = open && !storage.acknowledged;

  const title = phase === "done" ? "Import complete" : "Bring your work over from Synara Stable";
  const description =
    phase === "importing"
      ? "Importing your chats, projects, and setup. Keep Synara Beta open."
      : phase === "done"
        ? "Synara Beta is restarting with your Synara Stable data."
        : "Import your chats, projects, skills, and settings from Synara Stable. Synara Beta restarts when the import finishes.";

  return (
    <Dialog open={dialogOpen} onOpenChange={handleOpenChange}>
      {/* "Not now" is the close affordance, so the popup's own X would be a duplicate. */}
      <DialogPopup
        showCloseButton={false}
        initialFocus={sheetRef}
        className="max-w-[420px] rounded-[20px]"
      >
        <div ref={sheetRef} tabIndex={-1} className="flex flex-col p-5 outline-none">
          <span
            aria-hidden
            className="mb-8 flex size-16 shrink-0 items-center justify-center rounded-2xl border border-[color:var(--color-border)] bg-muted/30 text-foreground"
          >
            <CentralIcon name="arrow-down-square" className="size-8" />
          </span>

          <DialogHeader className="gap-2 p-0">
            <DialogTitle className="text-[19px] leading-tight">{title}</DialogTitle>
            <DialogDescription className="text-[14px] leading-[19.5px]">
              {description}
            </DialogDescription>
          </DialogHeader>

          {status?.isStableProcessRunning && phase === "idle" && error === null ? (
            <p className="pt-3 text-[13px] leading-[18px] text-muted-foreground">
              Quit Synara Stable before you import — the import needs it closed.
            </p>
          ) : null}

          {error !== null ? (
            <p role="alert" className="pt-3 text-[13px] leading-[18px] text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter className="gap-2 p-0 pt-3">
            <Button
              variant="ghost"
              className="rounded-[10px]"
              onClick={acknowledge}
              disabled={phase === "importing"}
            >
              Not now
            </Button>
            <Button
              className="rounded-[10px]"
              onClick={() => void runImport()}
              disabled={phase !== "idle"}
            >
              {phase === "importing"
                ? "Importing..."
                : phase === "done"
                  ? "Restarting..."
                  : "Import from Synara Stable"}
            </Button>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
