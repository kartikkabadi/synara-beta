import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "vitest";

import { performStableSync } from "@synara/shared/stableSync";

import { getStableFingerprint, parseSyncArgs } from "./sync-with-stable.ts";

describe("sync-with-stable CLI", () => {
  it("parses status, undo, dry-run, and watch flags", () => {
    NodeAssert.equal(parseSyncArgs(["--status"]).statusMode, true);
    NodeAssert.equal(parseSyncArgs(["--undo"]).undoMode, true);
    NodeAssert.equal(parseSyncArgs(["--dry-run"]).dryRun, true);
    NodeAssert.equal(parseSyncArgs(["--watch"]).watchMode, true);
  });

  it("parses skip, force, and path override flags", () => {
    const parsed = parseSyncArgs([
      "--no-projects",
      "--no-settings",
      "--no-skills",
      "--force",
      "--stable-home",
      "/tmp/stable",
      "--beta-home",
      "/tmp/beta",
    ]);
    NodeAssert.equal(parsed.includeProjects, false);
    NodeAssert.equal(parsed.includeSettings, false);
    NodeAssert.equal(parsed.includeSkills, false);
    NodeAssert.equal(parsed.force, true);
    NodeAssert.equal(parsed.stableHome, "/tmp/stable");
    NodeAssert.equal(parsed.betaHome, "/tmp/beta");
  });

  it("defaults to syncing everything without modes", () => {
    const parsed = parseSyncArgs([]);
    NodeAssert.equal(parsed.includeProjects, true);
    NodeAssert.equal(parsed.includeSettings, true);
    NodeAssert.equal(parsed.includeSkills, true);
    NodeAssert.equal(parsed.statusMode, false);
    NodeAssert.equal(parsed.watchMode, false);
    NodeAssert.equal(parsed.unknownOption, undefined);
  });

  it("reports unknown options instead of silently ignoring them", () => {
    NodeAssert.equal(parseSyncArgs(["--bogus"]).unknownOption, "--bogus");
  });

  it("imports the shared sync engine and runs a no-op sync", async () => {
    const rootTmp = await NodeFS.promises.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "synara-cli-test-"),
    );
    try {
      const result = await performStableSync({
        stableHome: NodePath.join(rootTmp, "stable"),
        betaHome: NodePath.join(rootTmp, "beta"),
      });
      NodeAssert.equal(result.success, false);
      NodeAssert.match(result.message, /not found|no syncable/i);
    } finally {
      await NodeFS.promises.rm(rootTmp, { recursive: true, force: true });
    }
  });

  it("fingerprints Stable state and detects file changes", async () => {
    const rootTmp = await NodeFS.promises.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "synara-fingerprint-"),
    );
    const stableHome = NodePath.join(rootTmp, "stable");
    try {
      const before = getStableFingerprint(stableHome);
      NodeAssert.equal(getStableFingerprint(stableHome), before);

      await NodeFS.promises.mkdir(NodePath.join(stableHome, "userdata"), { recursive: true });
      await NodeFS.promises.writeFile(
        NodePath.join(stableHome, "userdata", "settings.json"),
        JSON.stringify({ settings: { appearance: { theme: "light" } } }),
      );
      const afterWrite = getStableFingerprint(stableHome);
      NodeAssert.notEqual(afterWrite, before);
      NodeAssert.equal(getStableFingerprint(stableHome), afterWrite);
    } finally {
      await NodeFS.promises.rm(rootTmp, { recursive: true, force: true });
    }
  });
});
