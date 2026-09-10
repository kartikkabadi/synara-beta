// FILE: ThreadErrorCard.browser.tsx
// Purpose: Browser coverage for the floating thread-error card — presentation lifecycle
//   (open -> close animation -> unmount), action wiring, classified copy, retry stepper,
//   details accordion, and rate-limit countdown.
// Layer: Vitest browser tests (Chromium)
//
// Mirrors the ChatView mount: useTransientPresentation keeps the card alive through
// the shared DisclosureRegion close animation after the stored error clears.

import "../../index.css";

import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { DisclosureRegion } from "../ui/DisclosureRegion";
import { ThreadErrorCard } from "./ThreadErrorCard";
import { useTransientPresentation } from "./useTransientPresentation";
import type { RateLimitStatus } from "./RateLimitBanner";

function ThreadErrorCardHost({
  threadError,
  unblocking = false,
  rateLimitStatus,
  onDismiss,
  onRetry,
  onUnblock,
}: {
  threadError: string | null;
  unblocking?: boolean;
  rateLimitStatus?: RateLimitStatus | null;
  onDismiss?: () => void;
  onRetry?: () => void;
  onUnblock?: () => void;
}) {
  const presented = useTransientPresentation(threadError, { animateOpen: true });
  if (!presented) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center pt-3">
      <DisclosureRegion open={presented.open}>
        <div className="pointer-events-auto pb-1">
          <ThreadErrorCard
            error={presented.snapshot}
            unblocking={unblocking}
            {...(rateLimitStatus !== undefined ? { rateLimitStatus } : {})}
            {...(onDismiss ? { onDismiss } : {})}
            {...(onRetry ? { onRetry } : {})}
            {...(onUnblock ? { onUnblock } : {})}
          />
        </div>
      </DisclosureRegion>
    </div>
  );
}

const cardEl = () => document.querySelector<HTMLElement>('[data-slot="thread-error-card"]');
const cardInnerText = () => cardEl()?.innerText ?? "";

function cardButtons() {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-slot='thread-error-card'] button"),
  );
}

function findCardButton(text: string) {
  return cardButtons().find((b) => b.textContent?.includes(text));
}

function findCardButtonByLabel(label: string) {
  return cardButtons().find((b) => b.getAttribute("aria-label")?.includes(label));
}

describe("floating thread error card", () => {
  it("shows classified copy and hides the raw provider string", async () => {
    await render(
      <ThreadErrorCardHost
        threadError={
          'Error from provider (Console Go): Upstream request failed: {"code":"rate_limit_exceeded","message":"OpenAI API error (429): Rate limit exceeded."}'
        }
        onDismiss={() => {}}
        onRetry={() => {}}
      />,
    );

    await expect.poll(() => cardInnerText()).toContain("Rate limit reached");
    const card = cardInnerText();
    expect(card).not.toContain("rate_limit_exceeded");
    expect(card).toContain("Console Go");
  });

  it("animates out when the error clears", async () => {
    let setError: (value: string | null) => void = () => {};
    function Host() {
      const [error, set] = useState<string | null>('SocketOpenError: timeout waiting for "open"');
      setError = set;
      return <ThreadErrorCardHost threadError={error} onDismiss={() => set(null)} />;
    }
    await render(<Host />);

    await expect.poll(() => cardEl() !== null).toBe(true);
    setError(null);
    // Still mounted during the close animation...
    await expect.poll(() => cardEl() !== null).toBe(true);
    // ...then unmounted once the disclosure finishes.
    await expect.poll(() => cardEl()).toBeNull();
  });

  it("fires dismiss and retry actions", async () => {
    let dismissed = 0;
    let retried = 0;
    await render(
      <ThreadErrorCardHost
        threadError={"Agent is already processing a prompt."}
        onDismiss={() => (dismissed += 1)}
        onRetry={() => (retried += 1)}
      />,
    );

    await expect.poll(() => findCardButton("Try again")).toBeDefined();
    const tryAgain = findCardButton("Try again");
    expect(tryAgain).toBeDefined();
    tryAgain?.click();

    await expect.poll(() => cardEl()?.textContent ?? "").toContain("Preparing retry");
    // The retry stepper delays the actual onRetry callback by 180ms.
    await expect.poll(() => retried).toBe(1);

    const close = findCardButtonByLabel("Dismiss error");
    expect(close).toBeDefined();
    close?.click();
    expect(dismissed).toBe(1);
  });

  it("shows a retry stepper before firing onRetry", async () => {
    let retried = 0;
    await render(
      <ThreadErrorCardHost
        threadError={'SocketOpenError: timeout waiting for "open"'}
        onRetry={() => (retried += 1)}
      />,
    );

    await expect.poll(() => findCardButton("Try again")).toBeDefined();
    const tryAgain = findCardButton("Try again");
    expect(tryAgain).toBeDefined();
    tryAgain?.click();

    await expect.poll(() => cardEl()?.textContent ?? "").toContain("Retrying…");
    expect(cardEl()?.textContent ?? "").toContain("Preparing retry");
    expect(retried).toBe(0);

    await expect.poll(() => cardEl()?.textContent ?? "").toContain("Sending...");
    await expect.poll(() => retried).toBe(1);
  });

  it("shows Unblock instead of Try again for delivery blocks", async () => {
    let unblocked = 0;
    await render(
      <ThreadErrorCardHost
        threadError={
          "Thread is blocked by an earlier provider failure: delivery turn-completion was never acknowledged"
        }
        onUnblock={() => (unblocked += 1)}
      />,
    );
    const buttons = cardButtons();
    expect(buttons.some((b) => b.textContent?.includes("Unblock thread"))).toBe(true);
    expect(buttons.some((b) => b.textContent?.includes("Try again"))).toBe(false);
    buttons.find((b) => b.textContent?.includes("Unblock thread"))?.click();
    expect(unblocked).toBe(1);
  });

  it("expands and collapses raw error details", async () => {
    const raw = '{"ok":false,"context":{"stage":"stream-parsing"}}';
    await render(<ThreadErrorCardHost threadError={raw} onDismiss={() => {}} onRetry={() => {}} />);

    await expect.poll(() => findCardButton("Details")).toBeDefined();
    const detailsButton = findCardButton("Details");
    expect(detailsButton).toBeDefined();

    detailsButton?.click();
    await expect.poll(() => cardInnerText()).toContain(raw);

    await expect.poll(() => findCardButton("Hide")).toBeDefined();
    const hideButton = findCardButton("Hide");
    expect(hideButton).toBeDefined();
    hideButton?.click();
    await expect.poll(() => cardInnerText()).not.toContain(raw);
  });

  it("disables Try again and counts down while a rate-limit reset is pending", async () => {
    const future = new Date(Date.now() + 3500);
    await render(
      <ThreadErrorCardHost
        threadError={
          'Error from provider (Console Go): Upstream request failed: {"code":"rate_limit_exceeded","message":"OpenAI API error (429): Rate limit exceeded."}'
        }
        rateLimitStatus={{ status: "rejected", resetsAt: future.toISOString() }}
        onRetry={() => {}}
      />,
    );

    await expect.poll(() => findCardButton("Retry in")).toBeDefined();
    const button = findCardButton("Retry in");
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(true);
  });
});
