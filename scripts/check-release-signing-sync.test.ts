// FILE: check-release-signing-sync.test.ts
// Purpose: Runs the release-signing key drift check so a rotation that updates
//          only some of the four pinned-key locations fails loudly, and covers
//          the failure path itself so a regression in the drift detection fails
//          loudly too.
// Layer: Local developer tooling

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { findReleaseSigningKeyDrift } from "./check-release-signing-sync.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_LINE =
  "synara-beta-releases ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFA61LZNkb3QTME3wdqznC/zghISZ9nsS2BnUMUQ1JRo";
const STALE_LINE =
  "synara-beta-releases ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStaleKey0000000000000000000000000000000000";

const installerRelativePaths = [
  "scripts/install-linux.sh",
  "scripts/install-macos.sh",
  "scripts/install-windows.ps1",
];

/** Writes a minimal repo layout the drift check can run against. */
function stageFixture(
  options: { pinnedLine?: string; installerLines?: Record<string, string[]> } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "release-signing-drift-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/release-signing.pub"), `${options.pinnedLine ?? PINNED_LINE}\n`);
  for (const installerPath of installerRelativePaths) {
    const lines = options.installerLines?.[installerPath] ?? [options.pinnedLine ?? PINNED_LINE];
    writeFileSync(join(root, installerPath), lines.map((line) => `${line}\n`).join(""));
  }
  return root;
}

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

  it("reports no drift when every installer embeds the pinned key", () => {
    const fixture = stageFixture();
    try {
      expect(findReleaseSigningKeyDrift(fixture)).toEqual([]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("reports the one installer whose embedded key went stale in a rotation", () => {
    const fixture = stageFixture({
      installerLines: { "scripts/install-linux.sh": [STALE_LINE] },
    });
    try {
      expect(findReleaseSigningKeyDrift(fixture)).toEqual([
        "scripts/install-linux.sh: embedded key differs from scripts/release-signing.pub",
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("reports an installer with no embedded signers line", () => {
    const fixture = stageFixture({ installerLines: { "scripts/install-macos.sh": ["# no key"] } });
    try {
      expect(findReleaseSigningKeyDrift(fixture)).toEqual([
        "scripts/install-macos.sh: no embedded synara-beta-releases signers line found",
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("reports an installer with duplicate signers lines", () => {
    const fixture = stageFixture({
      installerLines: { "scripts/install-windows.ps1": [PINNED_LINE, PINNED_LINE] },
    });
    try {
      expect(findReleaseSigningKeyDrift(fixture)).toEqual([
        "scripts/install-windows.ps1: multiple synara-beta-releases signers lines found",
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("reports a missing pinned public key", () => {
    const fixture = stageFixture({ pinnedLine: PINNED_LINE });
    rmSync(join(fixture, "scripts/release-signing.pub"));
    try {
      const drift = findReleaseSigningKeyDrift(fixture);
      expect(drift).toHaveLength(1);
      expect(drift[0]).toContain("scripts/release-signing.pub");
      expect(drift[0]).toMatch(/no such file or directory/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
