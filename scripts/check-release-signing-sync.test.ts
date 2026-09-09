// FILE: check-release-signing-sync.test.ts
// Purpose: Runs the release-signing key drift check so a rotation that updates
//          only some of the four pinned-key locations fails loudly.
// Layer: Local developer tooling

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("release-signing key sync", () => {
  it("matches scripts/release-signing.pub against every embedded installer key", () => {
    const result = spawnSync("node", [resolve(repoRoot, "scripts/check-release-signing-sync.ts")], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "Release-signing public key is identical in scripts/release-signing.pub and all installers.",
    );
  });
});
