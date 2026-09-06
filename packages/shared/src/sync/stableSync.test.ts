import * as NodeAssert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";

import {
  buildProjectSelect,
  buildProjectUpsert,
  checkSyncAvailability,
  copyDirectoryTree,
  CURRENT_PROJECT_COLUMNS,
  extractProjectsFromDatabase,
  mergeProjectsIntoBetaDatabase,
  performStableSync,
  resolveSyncPaths,
  sanitizeSettings,
  undoStableSync,
  writeAtomicFile,
} from "./stableSync";

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

      let symlinkCreated = false;
      if (process.platform !== "win32") {
        try {
          await fs.symlink("file.txt", path.join(srcDir, "hello-link.txt"));
          symlinkCreated = true;
        } catch {
          symlinkCreated = false;
        }
      }

      const count = await copyDirectoryTree(srcDir, destDir);
      NodeAssert.equal(count, symlinkCreated ? 3 : 2);

      const destFile = await fs.readFile(path.join(destDir, "file.txt"), "utf8");
      const destSubFile = await fs.readFile(path.join(destDir, "sub", "subfile.txt"), "utf8");
      NodeAssert.equal(destFile, "hello");
      NodeAssert.equal(destSubFile, "world");

      if (symlinkCreated) {
        const linkStat = await fs.lstat(path.join(destDir, "hello-link.txt"));
        NodeAssert.equal(linkStat.isSymbolicLink(), true);
        NodeAssert.equal(await fs.readlink(path.join(destDir, "hello-link.txt")), "file.txt");
      }
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

  it("replaces symlinked destination entries instead of following them", async () => {
    if (process.platform === "win32") return;
    const rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-sneaky-dest-"));
    const srcDir = path.join(rootTmp, "src");
    const destDir = path.join(rootTmp, "dest");
    const outsideDir = path.join(rootTmp, "outside");
    try {
      await fs.mkdir(path.join(srcDir, "sub"), { recursive: true });
      await fs.writeFile(path.join(srcDir, "sub", "inner.txt"), "synced-content");
      await fs.mkdir(destDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "sentinel.txt"), "do-not-touch");
      try {
        await fs.symlink(outsideDir, path.join(destDir, "sub"));
      } catch {
        return;
      }

      await copyDirectoryTree(srcDir, destDir);

      const replacedStat = await fs.lstat(path.join(destDir, "sub"));
      NodeAssert.equal(replacedStat.isSymbolicLink(), false);
      NodeAssert.equal(
        await fs.readFile(path.join(destDir, "sub", "inner.txt"), "utf8"),
        "synced-content",
      );
      NodeAssert.deepEqual(await fs.readdir(outsideDir), ["sentinel.txt"]);
    } finally {
      await fs.rm(rootTmp, { recursive: true, force: true });
    }
  });

  it("copies tree files with private permissions", async () => {
    const rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-mode-test-"));
    try {
      await fs.mkdir(path.join(rootTmp, "src"), { recursive: true });
      await fs.writeFile(path.join(rootTmp, "src", "secret.json"), "{}");
      await copyDirectoryTree(path.join(rootTmp, "src"), path.join(rootTmp, "dest"));
      if (process.platform !== "win32") {
        const stat = await fs.stat(path.join(rootTmp, "dest", "secret.json"));
        NodeAssert.equal(stat.mode & 0o777, 0o600);
      }
    } finally {
      await fs.rm(rootTmp, { recursive: true, force: true });
    }
  });

  it("refuses sync when force is set but paths are identical", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-samepath-test-"));
    try {
      const result = await performStableSync({ stableHome: tmp, betaHome: tmp, force: true });
      NodeAssert.equal(result.success, false);
      NodeAssert.match(result.message, /same location/i);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("snapshots and restores every asset class including absences", async () => {
    const rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-assets-sync-"));
    const stableHome = path.join(rootTmp, "stable");
    const betaHome = path.join(rootTmp, "beta");
    try {
      await fs.mkdir(path.join(stableHome, "userdata"), { recursive: true });
      await fs.mkdir(path.join(stableHome, "skills", "new-skill"), { recursive: true });
      await fs.mkdir(path.join(stableHome, "mcp"), { recursive: true });
      await fs.writeFile(
        path.join(stableHome, "userdata", "settings.json"),
        JSON.stringify({ settings: { appearance: { theme: "light" } } }),
      );
      await fs.writeFile(
        path.join(stableHome, "userdata", "keybindings.json"),
        JSON.stringify({ "cmd+k": "palette" }),
      );
      await fs.writeFile(
        path.join(stableHome, "skills", "new-skill", "skill.json"),
        JSON.stringify({ name: "new" }),
      );
      await fs.writeFile(path.join(stableHome, "mcp", "other.json"), "{}");

      await fs.mkdir(path.join(betaHome, "userdata"), { recursive: true });
      await fs.mkdir(path.join(betaHome, "skills", "old-skill"), { recursive: true });
      await fs.mkdir(path.join(betaHome, "mcp"), { recursive: true });
      await fs.writeFile(
        path.join(betaHome, "userdata", "settings.json"),
        JSON.stringify({ settings: { appearance: { theme: "initial-beta" } } }),
      );
      await fs.writeFile(path.join(betaHome, "userdata", "state.sqlite"), "beta-db-v1");
      await fs.writeFile(
        path.join(betaHome, "skills", "old-skill", "skill.json"),
        JSON.stringify({ name: "old" }),
      );
      await fs.writeFile(
        path.join(betaHome, "mcp", "mcp.json"),
        JSON.stringify({ servers: ["beta"] }),
      );

      const result = await performStableSync({ stableHome, betaHome, includeProjects: false });
      NodeAssert.equal(result.success, true);
      NodeAssert.ok(result.snapshotBackupPath);

      const syncedSettings = JSON.parse(
        await fs.readFile(path.join(betaHome, "userdata", "settings.json"), "utf8"),
      );
      NodeAssert.equal(syncedSettings.settings.appearance.theme, "light");
      NodeAssert.ok(await fs.stat(path.join(betaHome, "userdata", "keybindings.json")));
      NodeAssert.ok(await fs.stat(path.join(betaHome, "skills", "new-skill", "skill.json")));
      NodeAssert.ok(await fs.stat(path.join(betaHome, "mcp", "other.json")));

      await fs.writeFile(path.join(betaHome, "userdata", "state.sqlite"), "tampered-after-sync");

      const undoResult = await undoStableSync({ betaHome });
      NodeAssert.equal(undoResult.success, true);

      const revertedSettings = JSON.parse(
        await fs.readFile(path.join(betaHome, "userdata", "settings.json"), "utf8"),
      );
      NodeAssert.equal(revertedSettings.settings.appearance.theme, "initial-beta");

      let keybindingsRestored = true;
      try {
        await fs.stat(path.join(betaHome, "userdata", "keybindings.json"));
      } catch {
        keybindingsRestored = false;
      }
      NodeAssert.equal(keybindingsRestored, false);

      const revertedSkill = JSON.parse(
        await fs.readFile(path.join(betaHome, "skills", "old-skill", "skill.json"), "utf8"),
      );
      NodeAssert.equal(revertedSkill.name, "old");
      let syncedSkillSurvived = true;
      try {
        await fs.stat(path.join(betaHome, "skills", "new-skill", "skill.json"));
      } catch {
        syncedSkillSurvived = false;
      }
      NodeAssert.equal(syncedSkillSurvived, false);

      const revertedMcp = JSON.parse(
        await fs.readFile(path.join(betaHome, "mcp", "mcp.json"), "utf8"),
      );
      NodeAssert.deepEqual(revertedMcp, { servers: ["beta"] });
      let syncedMcpSurvived = true;
      try {
        await fs.stat(path.join(betaHome, "mcp", "other.json"));
      } catch {
        syncedMcpSurvived = false;
      }
      NodeAssert.equal(syncedMcpSurvived, false);

      NodeAssert.equal(
        await fs.readFile(path.join(betaHome, "userdata", "state.sqlite"), "utf8"),
        "beta-db-v1",
      );
    } finally {
      await fs.rm(rootTmp, { recursive: true, force: true });
    }
  });

  it("matches project SQL to the live projection_projects schema", () => {
    const liveColumns = new Set<string>(CURRENT_PROJECT_COLUMNS);
    const select = buildProjectSelect(liveColumns);
    NodeAssert.ok(select);
    NodeAssert.match(select, /default_model_selection_json/);
    NodeAssert.match(select, /scripts_json/);
    NodeAssert.match(select, /is_pinned/);
    NodeAssert.match(select, /space_id/);
    NodeAssert.match(select, /WHERE deleted_at IS NULL/);
    NodeAssert.doesNotMatch(select, /default_model,/);

    const upsert = buildProjectUpsert(liveColumns);
    NodeAssert.ok(upsert);
    NodeAssert.match(upsert, /default_model_selection_json/);
    NodeAssert.match(upsert, /is_pinned/);
    NodeAssert.match(upsert, /ON CONFLICT\(project_id\)/);
    NodeAssert.doesNotMatch(upsert, /deleted_at/);

    const legacyColumns = new Set([
      "project_id",
      "title",
      "workspace_root",
      "default_model",
      "pinned",
      "created_at",
      "updated_at",
    ]);
    const legacySelect = buildProjectSelect(legacyColumns);
    NodeAssert.ok(legacySelect);
    NodeAssert.doesNotMatch(legacySelect, /default_model/);
    NodeAssert.equal(buildProjectSelect(new Set(["title"])), undefined);
  });

  it("extracts and merges projects through the live schema", async () => {
    const rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-projects-sync-"));
    const stableDbPath = path.join(rootTmp, "stable.sqlite");
    const betaDbPath = path.join(rootTmp, "beta.sqlite");
    try {
      const stableDb = new DatabaseSync(stableDbPath);
      stableDb.exec(
        "CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'project', title TEXT NOT NULL, workspace_root TEXT NOT NULL, default_model_selection_json TEXT, scripts_json TEXT NOT NULL, is_pinned INTEGER NOT NULL DEFAULT 0, space_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)",
      );
      stableDb
        .prepare(
          "INSERT INTO projection_projects (project_id, kind, title, workspace_root, default_model_selection_json, scripts_json, is_pinned, space_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "project-live",
          "project",
          "Live Project",
          "/tmp/live",
          null,
          "[]",
          1,
          null,
          "2026-01-01",
          "2026-01-02",
          null,
        );
      stableDb
        .prepare(
          "INSERT INTO projection_projects (project_id, kind, title, workspace_root, default_model_selection_json, scripts_json, is_pinned, space_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "project-gone",
          "project",
          "Gone",
          "/tmp/gone",
          null,
          "[]",
          0,
          null,
          "2026-01-01",
          "2026-01-02",
          "2026-02-01",
        );
      stableDb.close();

      const extracted = await extractProjectsFromDatabase(stableDbPath);
      NodeAssert.equal(extracted.length, 1);
      NodeAssert.equal(extracted[0]?.project_id, "project-live");
      NodeAssert.equal(extracted[0]?.is_pinned, 1);

      const betaDb = new DatabaseSync(betaDbPath);
      betaDb.exec(
        "CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'project', title TEXT NOT NULL, workspace_root TEXT NOT NULL, default_model_selection_json TEXT, scripts_json TEXT NOT NULL, is_pinned INTEGER NOT NULL DEFAULT 0, space_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)",
      );
      betaDb.close();

      const merged = await mergeProjectsIntoBetaDatabase(betaDbPath, extracted);
      NodeAssert.equal(merged, 1);
      const verifyDb = new DatabaseSync(betaDbPath, { readOnly: true });
      try {
        const rows = verifyDb
          .prepare("SELECT title, workspace_root, is_pinned FROM projection_projects")
          .all() as Array<{
          title: unknown;
          workspace_root: unknown;
          is_pinned: unknown;
        }>;
        NodeAssert.equal(rows.length, 1);
        NodeAssert.equal(rows[0]?.title, "Live Project");
        NodeAssert.equal(rows[0]?.workspace_root, "/tmp/live");
        NodeAssert.equal(rows[0]?.is_pinned, 1);
      } finally {
        verifyDb.close();
      }
    } finally {
      await fs.rm(rootTmp, { recursive: true, force: true });
    }
  });

  it("imports legacy-schema Stable rows without failing", async () => {
    const rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-legacy-projects-"));
    const stableDbPath = path.join(rootTmp, "stable.sqlite");
    const betaDbPath = path.join(rootTmp, "beta.sqlite");
    try {
      const stableDb = new DatabaseSync(stableDbPath);
      stableDb.exec(
        "CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, default_model TEXT, pinned INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
      );
      stableDb
        .prepare(
          "INSERT INTO projection_projects (project_id, title, workspace_root, default_model, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("legacy-one", "Legacy", "/tmp/legacy", "gpt-5", 0, "2026-01-01", "2026-01-02");
      stableDb.close();

      const extracted = await extractProjectsFromDatabase(stableDbPath);
      NodeAssert.equal(extracted.length, 1);

      const betaDb = new DatabaseSync(betaDbPath);
      betaDb.exec(
        "CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'project', title TEXT NOT NULL, workspace_root TEXT NOT NULL, default_model_selection_json TEXT, scripts_json TEXT NOT NULL, is_pinned INTEGER NOT NULL DEFAULT 0, space_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)",
      );
      betaDb.close();

      NodeAssert.equal(await mergeProjectsIntoBetaDatabase(betaDbPath, extracted), 1);
    } finally {
      await fs.rm(rootTmp, { recursive: true, force: true });
    }
  });
});
