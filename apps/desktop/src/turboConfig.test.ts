// FILE: turboConfig.test.ts
// Purpose: Regression for desktop build Turbo cache inputs.
// Layer: Desktop build config tests

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readTurboJsonc(): { tasks?: { build?: { env?: string[] } } } {
  const raw = readFileSync(new URL("../turbo.jsonc", import.meta.url), "utf8");
  const stripped = raw.replace(/,\s*([}\]])/g, "$1");
  // SAFETY: the test only needs the build task env shape, and the file contains only known JSONC with trailing commas.
  return JSON.parse(stripped) as { tasks?: { build?: { env?: string[] } } };
}

describe("desktop build Turbo cache inputs", () => {
  it("includes signing envs in the build task hash", () => {
    const turbo = readTurboJsonc();
    const buildEnv = new Set(turbo.tasks?.build?.env ?? []);

    expect(buildEnv.has("SYNARA_DESKTOP_SIGNED")).toBe(true);
    expect(buildEnv.has("AZURE_TRUSTED_SIGNING_SUBJECT_DN")).toBe(true);
  });
});
