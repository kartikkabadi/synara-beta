// FILE: StableImportWelcomeDialog.browser.tsx
// Purpose: Lock the first-run Stable import offer: when it appears, what the
//          primary action does, and how failures and dismissal are surfaced.
// Layer: Browser UI test

import "../index.css";

import type { DesktopStableImportStatus } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { StableImportWelcomeDialog } from "./StableImportWelcomeDialog";

const STORAGE_KEY = "synara:stable-import-welcome:v1";

const harness = vi.hoisted(() => ({
  getStatus: vi.fn(),
  run: vi.fn(),
}));

const AVAILABLE_STATUS: DesktopStableImportStatus = {
  available: true,
  stableDatabaseExists: true,
  hasBeenImportedBefore: false,
  isStableProcessRunning: false,
  stableSkillsCount: 12,
  stableMcpExists: true,
};

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  harness.getStatus.mockReset();
  harness.run.mockReset();
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { stableImport: { getStatus: harness.getStatus, run: harness.run } },
  });
});

afterEach(() => {
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: undefined });
});

describe("StableImportWelcomeDialog", () => {
  it("offers the import when Stable data exists and nothing was imported yet", async () => {
    harness.getStatus.mockResolvedValue(AVAILABLE_STATUS);
    const mounted = await render(<StableImportWelcomeDialog />);

    await expect
      .element(mounted.getByText("Bring your work over from Synara Stable"))
      .toBeVisible();
    await expect
      .element(mounted.getByRole("button", { name: "Import from Synara Stable" }))
      .toBeVisible();
  });

  it("stays hidden after a previous import", async () => {
    harness.getStatus.mockResolvedValue({ ...AVAILABLE_STATUS, hasBeenImportedBefore: true });
    const mounted = await render(<StableImportWelcomeDialog />);

    await vi.waitFor(() => {
      expect(harness.getStatus).toHaveBeenCalledOnce();
    });
    expect(mounted.container.textContent ?? "").not.toContain(
      "Bring your work over from Synara Stable",
    );
  });

  it("runs the import and shows the restart state on success", async () => {
    harness.getStatus.mockResolvedValue(AVAILABLE_STATUS);
    harness.run.mockResolvedValue({ ok: true, message: "Import complete." });
    const mounted = await render(<StableImportWelcomeDialog />);

    await mounted.getByRole("button", { name: "Import from Synara Stable" }).click();

    await expect.element(mounted.getByText("Import complete")).toBeVisible();
    expect(harness.run).toHaveBeenCalledOnce();
  });

  it("surfaces the desktop failure message and re-enables the action", async () => {
    harness.getStatus.mockResolvedValue(AVAILABLE_STATUS);
    harness.run.mockResolvedValue({
      ok: false,
      message: "Quit Synara Stable first, then run the import again.",
    });
    const mounted = await render(<StableImportWelcomeDialog />);

    await mounted.getByRole("button", { name: "Import from Synara Stable" }).click();

    await expect
      .element(mounted.getByText("Quit Synara Stable first, then run the import again."))
      .toBeVisible();
    await expect
      .element(mounted.getByRole("button", { name: "Import from Synara Stable" }))
      .toBeEnabled();
  });

  it("shows the running-Stable hint from the status probe", async () => {
    harness.getStatus.mockResolvedValue({ ...AVAILABLE_STATUS, isStableProcessRunning: true });
    const mounted = await render(<StableImportWelcomeDialog />);

    await expect.element(mounted.getByText(/Quit Synara Stable before you import/)).toBeVisible();
  });

  it("dismisses for good on Not now", async () => {
    harness.getStatus.mockResolvedValue(AVAILABLE_STATUS);
    const mounted = await render(<StableImportWelcomeDialog />);

    await mounted.getByRole("button", { name: "Not now" }).click();

    expect(localStorage.getItem(STORAGE_KEY) ?? "").toContain('"acknowledged":true');
  });
});
