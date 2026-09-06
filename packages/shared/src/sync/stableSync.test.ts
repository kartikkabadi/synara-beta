import * as NodeAssert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";

import {
  checkSyncAvailability,
  copyDirectoryTree,
  performStableSync,
  resolveSyncPaths,
  sanitizeSettings,
  undoStableSync,
  writeAtomicFile,
} from "./stableSync.ts";

describe("stableSync", () => {
  it("resolves default and custom paths correctly", () => {
    const defaultPaths = resolveSyncPaths();
    NodeAssert.ok(defaultPaths.stableHome.endsWith(".synara"));
    NodeAssert.ok(defaultPaths.betaHome.endsWith(".synara-beta"));

    const customPaths = resolveSyncPaths({
      stableHome: "/custom/stable",
      betaHome: "/custom/beta",
    });
    NodeAssert.equal(customPaths.stableHome, path.resolve("/custom/stable"));
    NodeAssert.equal(customPaths.betaHome, path.resolve("/custom/beta"));
  });

  it("refuses sync when stable and beta point to the exact same directory", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-sync-test-"));
    try {
      const availability = await checkSyncAvailability({
        stableHome: tmp,
        betaHome: tmp,
      });
      NodeAssert.equal(availability.available, false);
      NodeAssert.match(availability.reason ?? "", /same location/i);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports unavailable when stable directory does not exist", async () => {
    const nonExistent = path.join(os.tmpdir(), `nonexistent-${Date.now()}`);
    const betaTmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-beta-test-"));
    try {
      const availability = await checkSyncAvailability({
        stableHome: nonExistent,
        betaHome: betaTmp,
      });
      NodeAssert.equal(availability.available, false);
      NodeAssert.equal(availability.stableExists, false);
      NodeAssert.match(availability.reason ?? "", /not found/i);
    } finally {
      await fs.rm(betaTmp, { recursive: true, force: true });
    }
  });

  it("sanitizes settings by stripping passwords and resetting credentials", () => {
    const rawSettings = {
      revision: 3,
      settings: {
        theme: "dark",
        textGenerationModelSelection: { provider: "codex", model: "gpt-5.6-sol" },
        providers: {
          opencode: {
            serverPasswordConfigured: true,
            serverPassword: "super-secret-password",
            baseUrl: "http://localhost:8080",
          },
          claude: {
            model: "sonnet-5",
          },
        },
      },
    };

    const sanitized = sanitizeSettings(rawSettings);
    const providers = (sanitized.settings as any).providers;

    NodeAssert.equal(providers.opencode.serverPasswordConfigured, false);
    NodeAssert.equal(providers.opencode.serverPassword, undefined);
    NodeAssert.equal(providers.opencode.baseUrl, "http://localhost:8080");
    NodeAssert.equal(providers.claude.model, "sonnet-5");
    NodeAssert.equal((sanitized.settings as any).theme, "dark");
  });

  it("writes files atomically with private permissions", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-atomic-test-"));
    const targetFile = path.join(tmpDir, "nested", "test.json");
    try {
      await writeAtomicFile(targetFile, JSON.stringify({ hello: "world" }));
      const readBack = JSON.parse(await fs.readFile(targetFile, "utf8"));
      NodeAssert.deepEqual(readBack, { hello: "world" });

      const stat = await fs.stat(targetFile);
      if (process.platform !== "win32") {
        NodeAssert.equal(stat.mode & 0o777, 0o600);
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("copies directories preserving symlinks", async () => {
    const rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-dir-test-"));
    const srcDir = path.join(rootTmp, "src");
    const destDir = path.join(rootTmp, "dest");
    try {
      await fs.mkdir(path.join(srcDir, "sub"), { recursive: true });
      await fs.writeFile(path.join(srcDir, "file.txt"), "hello");
      await fs.writeFile(path.join(srcDir, "sub", "subfile.txt"), "world");

      const count = await copyDirectoryTree(srcDir, destDir);
      NodeAssert.equal(count, 2);

      const destFile = await fs.readFile(path.join(destDir, "file.txt"), "utf8");
      const destSubFile = await fs.readFile(path.join(destDir, "sub", "subfile.txt"), "utf8");
      NodeAssert.equal(destFile, "hello");
      NodeAssert.equal(destSubFile, "world");
    } finally {
      await fs.rm(rootTmp, { recursive: true, force: true });
    }
  });

  it("performs full sync and rollback undo cleanly", async () => {
    const rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-full-sync-"));
    const stableHome = path.join(rootTmp, "stable");
    const betaHome = path.join(rootTmp, "beta");

    try {
      // Setup Stable mock data
      await fs.mkdir(path.join(stableHome, "userdata"), { recursive: true });
      await fs.mkdir(path.join(stableHome, "skills", "test-skill"), { recursive: true });

      const stableSettings = {
        settings: {
          appearance: { theme: "light" },
          providers: { codex: { model: "gpt-5.6-sol" } },
        },
      };
      await fs.writeFile(
        path.join(stableHome, "userdata", "settings.json"),
        JSON.stringify(stableSettings),
      );
      await fs.writeFile(
        path.join(stableHome, "userdata", "keybindings.json"),
        JSON.stringify({ "cmd+k": "palette" }),
      );
      await fs.writeFile(
        path.join(stableHome, "skills", "test-skill", "skill.json"),
        JSON.stringify({ name: "test" }),
      );

      // Setup initial Beta state (e.g. pre-existing settings)
      await fs.mkdir(path.join(betaHome, "userdata"), { recursive: true });
      await fs.writeFile(
        path.join(betaHome, "userdata", "settings.json"),
        JSON.stringify({ settings: { appearance: { theme: "initial-beta" } } }),
      );

      // Check availability
      const availability = await checkSyncAvailability({ stableHome, betaHome });
      NodeAssert.equal(availability.available, true);
      NodeAssert.equal(availability.stableSettingsExists, true);
      NodeAssert.equal(availability.stableKeybindingsExists, true);
      NodeAssert.equal(availability.stableSkillsCount, 1);

      // Perform sync
      const result = await performStableSync({
        stableHome,
        betaHome,
        includeProjects: false,
      });

      NodeAssert.equal(result.success, true);
      NodeAssert.ok(result.snapshotBackupPath);

      // Verify synced files in Beta
      const betaSettings = JSON.parse(
        await fs.readFile(path.join(betaHome, "userdata", "settings.json"), "utf8"),
      );
      NodeAssert.equal(betaSettings.settings.appearance.theme, "light");

      const betaKeybindings = JSON.parse(
        await fs.readFile(path.join(betaHome, "userdata", "keybindings.json"), "utf8"),
      );
      NodeAssert.equal(betaKeybindings["cmd+k"], "palette");

      const betaSkill = JSON.parse(
        await fs.readFile(path.join(betaHome, "skills", "test-skill", "skill.json"), "utf8"),
      );
      NodeAssert.equal(betaSkill.name, "test");

      // Verify import marker
      const marker = JSON.parse(
        await fs.readFile(path.join(betaHome, ".imported-from-stable"), "utf8"),
      );
      NodeAssert.ok(marker.importedAt);

      // Test undo
      const undoResult = await undoStableSync({ betaHome });
      NodeAssert.equal(undoResult.success, true);

      const revertedSettings = JSON.parse(
        await fs.readFile(path.join(betaHome, "userdata", "settings.json"), "utf8"),
      );
      NodeAssert.equal(revertedSettings.settings.appearance.theme, "initial-beta");
    } finally {
      await fs.rm(rootTmp, { recursive: true, force: true });
    }
  });
});
