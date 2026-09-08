// FILE: tsdown.test.ts
// Purpose: Regression for build-time Windows updater publisher pin gating.
// Layer: Desktop build config tests

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadTsdownConfig() {
  vi.resetModules();
  const mod = await import("../tsdown.config.mts");
  const configs = mod.default ?? mod;
  if (!Array.isArray(configs)) {
    throw new Error("Expected tsdown config to export an array");
  }
  return configs.find((c) => Array.isArray(c.entry) && c.entry.includes("src/main.ts"));
}

describe("tsdown Windows updater publisher pin", () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AZURE_TRUSTED_SIGNING_") || key === "SYNARA_DESKTOP_SIGNED") {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("does not embed a pin when only the five Azure metadata envs are present", async () => {
    process.env.AZURE_TRUSTED_SIGNING_ENDPOINT = "https://endpoint";
    process.env.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME = "account";
    process.env.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME = "profile";
    process.env.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME = "Synara";
    process.env.AZURE_TRUSTED_SIGNING_SUBJECT_DN = "CN=Synara, O=Acme";
    // SYNARA_DESKTOP_SIGNED is missing: this must be treated as an unsigned build.

    const mainConfig = await loadTsdownConfig();
    expect(mainConfig?.define?.__SYNARA_WINDOWS_UPDATER_PUBLISHER__).toBe(JSON.stringify(""));
  });

  it("embeds the subject DN when the build is explicitly marked signed", async () => {
    process.env.SYNARA_DESKTOP_SIGNED = "1";
    process.env.AZURE_TRUSTED_SIGNING_SUBJECT_DN = "CN=Synara, O=Acme";

    const mainConfig = await loadTsdownConfig();
    expect(mainConfig?.define?.__SYNARA_WINDOWS_UPDATER_PUBLISHER__).toBe(
      JSON.stringify("CN=Synara, O=Acme"),
    );
  });
});
