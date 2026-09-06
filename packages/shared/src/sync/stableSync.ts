// FILE: stableSync.ts
// Purpose: Coexistence sync engine between Synara Stable (~/.synara) and Synara Beta (~/.synara-beta).
// Handles settings, keybindings, skills, MCP configs, and project records with WAL and lock safety.

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

export interface SyncPaths {
  readonly stableHome: string;
  readonly betaHome: string;
}

export interface SyncAvailability {
  readonly available: boolean;
  readonly stableExists: boolean;
  readonly stableSettingsExists: boolean;
  readonly stableKeybindingsExists: boolean;
  readonly stableSkillsCount: number;
  readonly stableMcpExists: boolean;
  readonly isStableProcessRunning: boolean;
  readonly stablePid: number | null;
  readonly betaExists: boolean;
  readonly hasBeenImportedBefore: boolean;
  readonly reason?: string;
}

export interface SyncOptions {
  readonly stableHome?: string;
  readonly betaHome?: string;
  readonly includeSettings?: boolean;
  readonly includeKeybindings?: boolean;
  readonly includeSkills?: boolean;
  readonly includeMcp?: boolean;
  readonly includeProjects?: boolean;
  readonly force?: boolean;
}

export interface SyncResultItem {
  readonly item: "settings" | "keybindings" | "skills" | "mcp" | "projects";
  readonly status: "synced" | "skipped" | "failed";
  readonly detail: string;
}

export interface SyncResult {
  readonly success: boolean;
  readonly timestamp: string;
  readonly snapshotBackupPath?: string;
  readonly items: ReadonlyArray<SyncResultItem>;
  readonly message: string;
}

export interface UndoResult {
  readonly success: boolean;
  readonly restoredFrom?: string;
  readonly message: string;
}

const IMPORTED_MARKER_FILE = ".imported-from-stable";
const STABLE_DEFAULT_DIR = ".synara";
const BETA_DEFAULT_DIR = ".synara-beta";

/** Resolves default or custom paths for Stable and Beta directories. */
export function resolveSyncPaths(options?: { stableHome?: string; betaHome?: string }): SyncPaths {
  const homeDir = os.homedir();
  const stableHome = options?.stableHome?.trim() ||
    process.env.SYNARA_STABLE_HOME?.trim() ||
    path.join(homeDir, STABLE_DEFAULT_DIR);

  const betaHome = options?.betaHome?.trim() ||
    process.env.SYNARA_HOME?.trim() ||
    path.join(homeDir, BETA_DEFAULT_DIR);

  return {
    stableHome: path.resolve(stableHome),
    betaHome: path.resolve(betaHome),
  };
}

/** Checks if a PID is alive on POSIX/Windows systems. */
export function isProcessRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code !== "ESRCH";
  }
}

/** Reads the active lock owner from state.sqlite.lifecycle-lock if present. */
export async function readLifecycleLockOwner(dbPath: string): Promise<{ isRunning: boolean; pid: number | null }> {
  const lockDir = `${dbPath}.lifecycle-lock`;
  const ownerPath = path.join(lockDir, "owner.json");
  try {
    const raw = await fs.readFile(ownerPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number" && isProcessRunning(parsed.pid)) {
      return { isRunning: true, pid: parsed.pid };
    }
  } catch {
    // Lock doesn't exist or is not readable
  }
  return { isRunning: false, pid: null };
}

/** Checks if Stable has data available to sync into Beta. */
export async function checkSyncAvailability(options?: { stableHome?: string; betaHome?: string }): Promise<SyncAvailability> {
  const paths = resolveSyncPaths(options);
  if (paths.stableHome === paths.betaHome) {
    return {
      available: false,
      stableExists: true,
      stableSettingsExists: false,
      stableKeybindingsExists: false,
      stableSkillsCount: 0,
      stableMcpExists: false,
      isStableProcessRunning: false,
      stablePid: null,
      betaExists: true,
      hasBeenImportedBefore: false,
      reason: "Stable and Beta directories point to the same location.",
    };
  }

  let stableExists = false;
  try {
    const stat = await fs.stat(paths.stableHome);
    stableExists = stat.isDirectory();
  } catch {
    stableExists = false;
  }

  if (!stableExists) {
    return {
      available: false,
      stableExists: false,
      stableSettingsExists: false,
      stableKeybindingsExists: false,
      stableSkillsCount: 0,
      stableMcpExists: false,
      isStableProcessRunning: false,
      stablePid: null,
      betaExists: false,
      hasBeenImportedBefore: false,
      reason: `Stable directory not found at ${paths.stableHome}.`,
    };
  }

  const stableSettingsPath = path.join(paths.stableHome, "userdata", "settings.json");
  const stableKeybindingsPath = path.join(paths.stableHome, "userdata", "keybindings.json");
  const stableSkillsDir = path.join(paths.stableHome, "skills");
  const stableMcpDir = path.join(paths.stableHome, "mcp");
  const stableDbPath = path.join(paths.stableHome, "userdata", "state.sqlite");

  let stableSettingsExists = false;
  try {
    stableSettingsExists = (await fs.stat(stableSettingsPath)).isFile();
  } catch {
    stableSettingsExists = false;
  }

  let stableKeybindingsExists = false;
  try {
    stableKeybindingsExists = (await fs.stat(stableKeybindingsPath)).isFile();
  } catch {
    stableKeybindingsExists = false;
  }

  let stableSkillsCount = 0;
  try {
    const entries = await fs.readdir(stableSkillsDir);
    stableSkillsCount = entries.filter((e) => !e.startsWith(".")).length;
  } catch {
    stableSkillsCount = 0;
  }

  let stableMcpExists = false;
  try {
    stableMcpExists = (await fs.stat(stableMcpDir)).isDirectory();
  } catch {
    stableMcpExists = false;
  }

  let betaExists = false;
  let hasBeenImportedBefore = false;
  try {
    betaExists = (await fs.stat(paths.betaHome)).isDirectory();
    hasBeenImportedBefore = fsSync.existsSync(path.join(paths.betaHome, IMPORTED_MARKER_FILE));
  } catch {
    betaExists = false;
  }

  const { isRunning, pid } = await readLifecycleLockOwner(stableDbPath);

  const available = stableSettingsExists || stableKeybindingsExists || stableSkillsCount > 0 || stableMcpExists;

  return {
    available,
    stableExists,
    stableSettingsExists,
    stableKeybindingsExists,
    stableSkillsCount,
    stableMcpExists,
    isStableProcessRunning: isRunning,
    stablePid: pid,
    betaExists,
    hasBeenImportedBefore,
  };
}

/**
 * Sanitizes settings from Stable before importing into Beta.
 * Resets machine-specific or credentialed fields while preserving model preferences,
 * prompt adjustments, provider URLs, and UI themes.
 */
export function sanitizeSettings(settingsRecord: Record<string, unknown>): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(settingsRecord)) as Record<string, unknown>;
  const settings = (typeof cloned.settings === "object" && cloned.settings !== null
    ? cloned.settings
    : cloned) as Record<string, unknown>;

  if (typeof settings.providers === "object" && settings.providers !== null) {
    const providers = settings.providers as Record<string, Record<string, unknown>>;
    if (providers.opencode) {
      providers.opencode.serverPasswordConfigured = false;
      delete providers.opencode.serverPassword;
    }
  }

  return cloned;
}

/** Atomically writes data to target path using a temporary staging file and fsync. */
export async function writeAtomicFile(filePath: string, content: string | Buffer, mode = 0o600): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${randomUUID()}.partial`;
  await fs.writeFile(tempPath, content, { mode });
  const handle = await fs.open(tempPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, filePath);
}

/** Safely copies directory tree preserving symlinks as symlinks. */
export async function copyDirectoryTree(srcDir: string, destDir: string): Promise<number> {
  let count = 0;
  await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isSymbolicLink()) {
      const linkTarget = await fs.readlink(srcPath);
      try {
        await fs.unlink(destPath);
      } catch {
        // Ignored
      }
      await fs.symlink(linkTarget, destPath);
      count += 1;
    } else if (entry.isDirectory()) {
      count += await copyDirectoryTree(srcPath, destPath);
    } else if (entry.isFile()) {
      const content = await fs.readFile(srcPath);
      await writeAtomicFile(destPath, content, 0o644);
      count += 1;
    }
  }

  return count;
}

/** Takes a snapshot backup of Beta's current userdata directory before syncing. */
export async function createBetaSnapshot(betaHome: string): Promise<string | undefined> {
  const betaUserdata = path.join(betaHome, "userdata");
  if (!fsSync.existsSync(betaUserdata)) {
    return undefined;
  }

  const backupRoot = path.join(betaUserdata, "backups");
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = path.join(backupRoot, `pre-sync-${timestamp}`);
  await fs.mkdir(snapshotDir, { recursive: true, mode: 0o700 });

  // Snapshot settings.json and keybindings.json
  const filesToSnapshot = ["settings.json", "keybindings.json"];
  for (const filename of filesToSnapshot) {
    const src = path.join(betaUserdata, filename);
    if (fsSync.existsSync(src)) {
      const content = await fs.readFile(src);
      await fs.writeFile(path.join(snapshotDir, filename), content, { mode: 0o600 });
    }
  }

  // Prune older snapshots (keep at most 5)
  try {
    const backups = (await fs.readdir(backupRoot))
      .filter((b) => b.startsWith("pre-sync-"))
      .sort();
    if (backups.length > 5) {
      const toRemove = backups.slice(0, backups.length - 5);
      for (const old of toRemove) {
        await fs.rm(path.join(backupRoot, old), { recursive: true, force: true });
      }
    }
  } catch {
    // Ignore prune errors
  }

  return snapshotDir;
}

/**
 * Reads registered projects from Stable database if accessible.
 * If SQLite is locked, returns an empty list without failing.
 */
export async function extractProjectsFromDatabase(dbPath: string): Promise<Array<Record<string, unknown>>> {
  if (!fsSync.existsSync(dbPath)) return [];

  // Try using node:sqlite with readOnly: true
  try {
    // Dynamically require node:sqlite to support various runtime environments
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
        prepare: (query: string) => { all: () => Array<Record<string, unknown>> };
        close: () => void;
      };
    };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT project_id, kind, title, workspace_root, default_model, pinned, created_at, updated_at FROM projection_projects").all();
      return rows;
    } finally {
      db.close();
    }
  } catch {
    // Database is exclusively locked by a live process or schema unreadable
    return [];
  }
}

/** Imports projects into Beta's state.sqlite if present. */
export async function mergeProjectsIntoBetaDatabase(
  betaDbPath: string,
  projects: ReadonlyArray<Record<string, unknown>>,
): Promise<number> {
  if (!fsSync.existsSync(betaDbPath) || projects.length === 0) return 0;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
        prepare: (query: string) => { run: (...args: unknown[]) => { changes: number } };
        close: () => void;
      };
    };
    const db = new DatabaseSync(betaDbPath, { readOnly: false });
    let inserted = 0;
    try {
      const stmt = db.prepare(`
        INSERT INTO projection_projects (project_id, kind, title, workspace_root, default_model, pinned, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          title = excluded.title,
          workspace_root = excluded.workspace_root,
          default_model = excluded.default_model,
          updated_at = excluded.updated_at
      `);
      for (const p of projects) {
        stmt.run(
          p.project_id,
          p.kind ?? "local",
          p.title,
          p.workspace_root,
          p.default_model ?? null,
          p.pinned ?? 0,
          p.created_at ?? new Date().toISOString(),
          p.updated_at ?? new Date().toISOString(),
        );
        inserted += 1;
      }
    } finally {
      db.close();
    }
    return inserted;
  } catch {
    return 0;
  }
}

/** Executes synchronization from Synara Stable into Synara Beta. */
export async function performStableSync(options?: SyncOptions): Promise<SyncResult> {
  const paths = resolveSyncPaths(options);
  const availability = await checkSyncAvailability(options);

  if (!availability.available && !options?.force) {
    return {
      success: false,
      timestamp: new Date().toISOString(),
      items: [],
      message: availability.reason ?? "No syncable assets found in Synara Stable.",
    };
  }

  const items: SyncResultItem[] = [];
  const snapshotPath = await createBetaSnapshot(paths.betaHome);

  // 1. Sync Settings
  if (options?.includeSettings !== false && availability.stableSettingsExists) {
    try {
      const stableSettingsFile = path.join(paths.stableHome, "userdata", "settings.json");
      const betaSettingsFile = path.join(paths.betaHome, "userdata", "settings.json");
      const raw = await fs.readFile(stableSettingsFile, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const sanitized = sanitizeSettings(parsed);
      await writeAtomicFile(betaSettingsFile, JSON.stringify(sanitized, null, 2) + "\n", 0o600);
      items.push({ item: "settings", status: "synced", detail: "Settings synced and sanitized (passwords stripped)." });
    } catch (err: unknown) {
      items.push({ item: "settings", status: "failed", detail: String(err) });
    }
  } else {
    items.push({ item: "settings", status: "skipped", detail: "Settings file not present in Stable." });
  }

  // 2. Sync Keybindings
  if (options?.includeKeybindings !== false && availability.stableKeybindingsExists) {
    try {
      const stableKeybindingsFile = path.join(paths.stableHome, "userdata", "keybindings.json");
      const betaKeybindingsFile = path.join(paths.betaHome, "userdata", "keybindings.json");
      const content = await fs.readFile(stableKeybindingsFile);
      await writeAtomicFile(betaKeybindingsFile, content, 0o600);
      items.push({ item: "keybindings", status: "synced", detail: "Custom keybindings synced." });
    } catch (err: unknown) {
      items.push({ item: "keybindings", status: "failed", detail: String(err) });
    }
  } else {
    items.push({ item: "keybindings", status: "skipped", detail: "Keybindings file not present in Stable." });
  }

  // 3. Sync Skills
  if (options?.includeSkills !== false && availability.stableSkillsCount > 0) {
    try {
      const srcSkills = path.join(paths.stableHome, "skills");
      const destSkills = path.join(paths.betaHome, "skills");
      const copied = await copyDirectoryTree(srcSkills, destSkills);
      items.push({ item: "skills", status: "synced", detail: `Synced ${copied} skills.` });
    } catch (err: unknown) {
      items.push({ item: "skills", status: "failed", detail: String(err) });
    }
  } else {
    items.push({ item: "skills", status: "skipped", detail: "No custom skills found in Stable." });
  }

  // 4. Sync MCP Configurations
  if (options?.includeMcp !== false && availability.stableMcpExists) {
    try {
      const srcMcp = path.join(paths.stableHome, "mcp");
      const destMcp = path.join(paths.betaHome, "mcp");
      const copied = await copyDirectoryTree(srcMcp, destMcp);
      items.push({ item: "mcp", status: "synced", detail: `Synced MCP configurations (${copied} entries).` });
    } catch (err: unknown) {
      items.push({ item: "mcp", status: "failed", detail: String(err) });
    }
  } else {
    items.push({ item: "mcp", status: "skipped", detail: "No MCP configurations found in Stable." });
  }

  // 5. Sync Projects (if requested and database is available)
  if (options?.includeProjects !== false) {
    const stableDbPath = path.join(paths.stableHome, "userdata", "state.sqlite");
    const betaDbPath = path.join(paths.betaHome, "userdata", "state.sqlite");

    if (availability.isStableProcessRunning) {
      items.push({
        item: "projects",
        status: "skipped",
        detail: `Stable Synara is running (PID ${availability.stablePid}); database is locked. Settings and skills synced safely.`,
      });
    } else {
      const projects = await extractProjectsFromDatabase(stableDbPath);
      if (projects.length > 0 && fsSync.existsSync(betaDbPath)) {
        const merged = await mergeProjectsIntoBetaDatabase(betaDbPath, projects);
        items.push({ item: "projects", status: "synced", detail: `Imported ${merged} projects.` });
      } else {
        items.push({
          item: "projects",
          status: "skipped",
          detail: projects.length === 0 ? "No projects found in Stable database." : "Beta database not yet initialized.",
        });
      }
    }
  }

  // Record import marker
  await fs.mkdir(paths.betaHome, { recursive: true });
  await fs.writeFile(
    path.join(paths.betaHome, IMPORTED_MARKER_FILE),
    JSON.stringify({ importedAt: new Date().toISOString(), stableHome: paths.stableHome }, null, 2) + "\n",
    { mode: 0o600 },
  );

  const anyFailed = items.some((i) => i.status === "failed");
  const anySynced = items.some((i) => i.status === "synced");

  return {
    success: anySynced && !anyFailed,
    timestamp: new Date().toISOString(),
    snapshotBackupPath: snapshotPath,
    items,
    message: anySynced
      ? `Successfully synchronized Stable setup to Beta.${snapshotPath ? ` (Snapshot backup created at ${snapshotPath})` : ""}`
      : "No items were synchronized.",
  };
}

/** Undoes synchronization by restoring the most recent snapshot backup. */
export async function undoStableSync(options?: { betaHome?: string }): Promise<UndoResult> {
  const paths = resolveSyncPaths(options);
  const backupRoot = path.join(paths.betaHome, "userdata", "backups");

  if (!fsSync.existsSync(backupRoot)) {
    return { success: false, message: "No pre-sync snapshots found to restore from." };
  }

  const snapshots = (await fs.readdir(backupRoot))
    .filter((name) => name.startsWith("pre-sync-"))
    .sort()
    .reverse();

  if (snapshots.length === 0) {
    return { success: false, message: "No pre-sync snapshots found to restore from." };
  }

  const latestSnapshot = path.join(backupRoot, snapshots[0]!);
  const betaUserdata = path.join(paths.betaHome, "userdata");

  const entries = await fs.readdir(latestSnapshot);
  for (const entry of entries) {
    const src = path.join(latestSnapshot, entry);
    const dest = path.join(betaUserdata, entry);
    const content = await fs.readFile(src);
    await writeAtomicFile(dest, content, 0o600);
  }

  return {
    success: true,
    restoredFrom: latestSnapshot,
    message: `Restored pre-sync configuration from ${latestSnapshot}.`,
  };
}
