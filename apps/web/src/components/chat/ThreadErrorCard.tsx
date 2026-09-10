// FILE: ThreadErrorCard.tsx
// Purpose: Floating top-center card for thread-level errors; replaces the raw error toast.
// Layer: Chat status presentation
// Exports: ThreadErrorCard, type ThreadErrorCardProps

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  LoaderIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "~/lib/icons";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { presentThreadError } from "./threadErrorPresentation";
import type { RateLimitStatus } from "./RateLimitBanner";

export type ThreadErrorCardProps = {
  error: string;
  unblocking?: boolean;
  onDismiss?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  /** Identity of the thread (or surface) the retry belongs to; a change cancels a pending retry. */
  retryKey?: string | null;
  onUnblock?: (() => void) | undefined;
  rateLimitStatus?: RateLimitStatus | null;
};

type RetryStep = "idle" | "preparing" | "sending";

type StepStatus = "pending" | "active" | "done";

function StepGlyph({ status }: { status: StepStatus }) {
  return (
    <span className="relative z-10 flex size-3.5 shrink-0 items-center justify-center rounded-full bg-[var(--color-background-elevated-primary-opaque)]">
      {status === "done" ? (
        <CircleCheckIcon className="size-3 text-[var(--color-text-foreground)]" />
      ) : status === "active" ? (
        <LoaderIcon className="size-3 animate-spin text-[var(--color-text-foreground)]" />
      ) : (
        <span className="block size-1.5 rounded-full bg-[var(--color-border)]" />
      )}
    </span>
  );
}

function RetryStepper({ step }: { step: "preparing" | "sending" }) {
  const steps: Array<[string, StepStatus]> = [
    ["Preparing retry", step === "preparing" ? "active" : "done"],
    ["Sending...", step === "sending" ? "active" : "pending"],
  ];
  return (
    <ol className="flex flex-col">
      {steps.map(([label, status], index) => {
        const isLast = index === steps.length - 1;
        return (
          <li key={label} className="relative flex items-center gap-2.5 py-[3px]">
            {isLast ? null : (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-[6.5px] top-1/2 h-full w-px",
                  status === "done" || step === "sending"
                    ? "bg-[var(--color-text-foreground)]"
                    : "bg-[var(--color-border)]",
                )}
              />
            )}
            <StepGlyph status={status} />
            <span
              className={cn(
                "text-[13px] leading-5",
                status === "active"
                  ? "text-[var(--color-text-foreground)]"
                  : status === "done"
                    ? "text-[var(--color-text-foreground)]"
                    : "text-[var(--color-text-foreground-tertiary)] opacity-70",
              )}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Soft status card floating at the top of the chat: a tinted icon circle, a
 * one-line title, and a plain-English detail line — the same visual language as
 * the "Preparing worktree..." setup card.
 *
 * Flows:
 * - Morph: the icon/title/detail gently fade/scale when the error string is
 *   replaced while the card is open.
 * - Details: a "Show details" chevron expands the raw error string inside the
 *   card with the shared disclosure motion.
 * - Try again: a two-step stepper ("Preparing" → "Sending...") briefly plays
 *   before the actual send, then the card closes as the error clears.
 * - Rate limit: if the active account has a known reset time, "Try again" shows
 *   a live countdown and is disabled until the reset window passes.
 */
export function ThreadErrorCard({
  error,
  unblocking,
  onDismiss,
  onRetry,
  retryKey,
  onUnblock,
  rateLimitStatus,
}: ThreadErrorCardProps) {
  const presentation = useMemo(() => presentThreadError(error), [error]);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const isWarning = presentation.tone === "warning";
  const ErrorIcon = isWarning ? TriangleAlertIcon : CircleAlertIcon;

  // Morph content when the error string is replaced while the card is open.
  const [morphing, setMorphing] = useState(false);
  const previousErrorRef = useRef(error);
  useEffect(() => {
    if (previousErrorRef.current !== error) {
      previousErrorRef.current = error;
      setMorphing(true);
      const id = window.setTimeout(() => setMorphing(false), 160);
      return () => window.clearTimeout(id);
    }
  }, [error]);

  // Live countdown for rate-limit resets.
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    if (!rateLimitStatus?.resetsAt) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [rateLimitStatus?.resetsAt]);

  const rateLimitResetMs = rateLimitStatus?.resetsAt ? Date.parse(rateLimitStatus.resetsAt) : null;
  const rateLimitSecondsLeft =
    rateLimitResetMs != null && !Number.isNaN(rateLimitResetMs)
      ? Math.max(0, Math.ceil((rateLimitResetMs - nowMs) / 1000))
      : 0;
  const rateLimitBlocked = presentation.kind === "rate-limit" && rateLimitSecondsLeft > 0;

  // Retry stepper state.
  const [retryStep, setRetryStep] = useState<RetryStep>("idle");
  const preparingTimer = useRef<number | null>(null);
  const sendingTimer = useRef<number | null>(null);
  const isRetrying = retryStep !== "idle";

  const clearRetryTimers = useCallback(() => {
    if (preparingTimer.current !== null) {
      window.clearTimeout(preparingTimer.current);
      preparingTimer.current = null;
    }
    if (sendingTimer.current !== null) {
      window.clearTimeout(sendingTimer.current);
      sendingTimer.current = null;
    }
  }, []);

  useEffect(() => clearRetryTimers, [clearRetryTimers]);

  // A pending retry is bound to the error it was started for: the card is
  // reused across threads and error rewrites, so a thread switch or a newer
  // failure replacing the error must cancel the delayed onRetry — otherwise
  // the previous chat's failed message would be sent through whichever
  // callback is captured when the 180ms preparing timer fires. The retry key
  // (the owning thread) keeps unrelated updates on the same thread from
  // cancelling: the parent's retry callback identity churns on every store
  // update, which must not abort an in-flight retry.
  useEffect(() => {
    clearRetryTimers();
    setRetryStep("idle");
  }, [clearRetryTimers, error, retryKey]);

  const startRetry = useCallback(() => {
    if (!onRetry || isRetrying) return;
    setRetryStep("preparing");
    preparingTimer.current = window.setTimeout(() => {
      setRetryStep("sending");
      onRetry();
      // If the send never clears the error for any reason, reset after a bound.
      sendingTimer.current = window.setTimeout(() => setRetryStep("idle"), 1200);
    }, 180);
  }, [isRetrying, onRetry]);

  // Details accordion.
  const [detailsOpen, setDetailsOpen] = useState(false);

  const canRetry = presentation.retryable && onRetry && !isRetrying && !rateLimitBlocked;
  const canUnblock = presentation.canUnblock && onUnblock && !unblocking && !isRetrying;

  const actionVariant = isWarning ? "warning-outline" : "destructive-outline";

  return (
    <div
      className={cn(
        "w-fit max-w-full rounded-xl border px-3.5 py-3 font-system-ui shadow-xs",
        isWarning
          ? "border-warning/40 bg-[color-mix(in_srgb,var(--color-background-elevated-primary-opaque)_96%,var(--color-warning))]"
          : "border-destructive/40 bg-[color-mix(in_srgb,var(--color-background-elevated-primary-opaque)_96%,var(--color-destructive))]",
      )}
      data-slot="thread-error-card"
      role="alert"
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className="mt-0.5 shrink-0" data-slot="thread-error-icon">
          {isRetrying ? (
            <LoaderIcon className="size-4 animate-spin text-[var(--color-text-foreground-tertiary)]" />
          ) : (
            <ErrorIcon className={cn("size-4", isWarning ? "text-warning" : "text-destructive")} />
          )}
        </span>
        {isRetrying ? (
          <div className="min-w-0 max-w-md pt-0.5" data-slot="thread-error-retry-stepper">
            <div className="shimmer text-[13px] font-medium leading-5 text-[var(--color-text-foreground-secondary)]">
              Retrying…
            </div>
            <div className="mt-1">
              <RetryStepper step={retryStep} />
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "min-w-0 max-w-md pt-0.5 transition-all duration-150 ease-out",
              morphing && "scale-[0.99] opacity-60",
            )}
          >
            <div className="text-[13px] font-medium leading-5 text-[var(--color-text-foreground)]">
              {presentation.title}
            </div>
            {presentation.detail ? (
              <p className="mt-0.5 text-[13px] leading-5 text-[var(--color-text-foreground-tertiary)]">
                {presentation.detail}
              </p>
            ) : null}
          </div>
        )}
        {onDismiss ? (
          <IconButton
            className="-mr-1 -mt-0.5 shrink-0 text-[var(--color-text-foreground-tertiary)]"
            label="Dismiss error"
            onClick={onDismiss}
            title="Dismiss error"
          >
            <XIcon className="size-3.5" />
          </IconButton>
        ) : null}
      </div>

      {/* The actions row always renders: Copy is available for every error. */}
      <div className="mt-2.5 flex items-center gap-1.5 pl-[26px]">
        {canRetry ? (
          <Button onClick={startRetry} size="xs" variant={actionVariant}>
            <RefreshCwIcon className="size-3" />
            <span>Try again</span>
          </Button>
        ) : null}
        {presentation.retryable && (isRetrying || rateLimitBlocked) ? (
          <Button disabled size="xs" variant={actionVariant}>
            {isRetrying ? (
              <>
                <LoaderIcon className="size-3 animate-spin" />
                <span>{retryStep === "preparing" ? "Preparing" : "Sending"}</span>
              </>
            ) : (
              <>
                <RefreshCwIcon className="size-3" />
                <span>
                  {rateLimitSecondsLeft < 60
                    ? `Retry in ${rateLimitSecondsLeft}s`
                    : `Retry in ${Math.ceil(rateLimitSecondsLeft / 60)}m`}
                </span>
              </>
            )}
          </Button>
        ) : null}
        {canUnblock ? (
          <Button onClick={onUnblock} size="xs" variant="destructive-outline">
            <RefreshCwIcon className="size-3" />
            <span>Unblock thread</span>
          </Button>
        ) : null}
        {presentation.canUnblock && unblocking ? (
          <Button disabled size="xs" variant="destructive-outline">
            <LoaderIcon className="size-3 animate-spin" />
            <span>Unblocking…</span>
          </Button>
        ) : null}
        <Button
          aria-label={detailsOpen ? "Hide error details" : "Show error details"}
          onClick={() => setDetailsOpen((open) => !open)}
          size="xs"
          title={detailsOpen ? "Hide error details" : "Show error details"}
          variant="ghost"
        >
          {detailsOpen ? (
            <ChevronUpIcon className="size-3" />
          ) : (
            <ChevronDownIcon className="size-3" />
          )}
          <span>{detailsOpen ? "Hide" : "Details"}</span>
        </Button>
        <Button
          aria-label={isCopied ? "Copied error details" : "Copy error details"}
          onClick={() => {
            copyToClipboard(presentation.raw, undefined);
          }}
          size="xs"
          title={isCopied ? "Copied error details" : "Copy error details"}
          variant="ghost"
        >
          {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          <span>{isCopied ? "Copied" : "Copy"}</span>
        </Button>
      </div>

      <DisclosureRegion open={detailsOpen} className="pl-[26px]">
        {detailsOpen ? (
          <pre className="mt-2 max-w-md break-all rounded-md border border-[var(--color-border-light)] bg-[var(--color-background-elevated-secondary-opaque)] p-2 text-[11px] leading-4 text-[var(--color-text-foreground-tertiary)]">
            {presentation.raw}
          </pre>
        ) : null}
      </DisclosureRegion>
    </div>
  );
}
