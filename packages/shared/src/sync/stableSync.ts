// FILE: stableSync.ts
// Purpose: Coexistence sync engine between Synara Stable (~/.synara) and Synara Beta (~/.synara-beta).
// Handles settings, keybindings, skills, MCP configs, and project records with WAL and lock safety.

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { expandHomePath } from "../synaraHome";

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
  readonly reason?: string | undefined;
}

export interface SyncOptions {
  readonly stableHome?: string | undefined;
  readonly betaHome?: string | undefined;
  readonly includeSettings?: boolean | undefined;
  readonly includeKeybindings?: boolean | undefined;
  readonly includeSkills?: boolean | undefined;
  readonly includeMcp?: boolean | undefined;
  readonly includeProjects?: boolean | undefined;
  readonly force?: boolean | undefined;
}

export interface SyncResultItem {
  readonly item: "settings" | "keybindings" | "skills" | "mcp" | "projects";
  readonly status: "synced" | "skipped" | "failed";
  readonly detail: string;
}

export interface SyncResult {
  readonly success: boolean;
  readonly timestamp: string;
  readonly snapshotBackupPath?: string | undefined;
  readonly items: ReadonlyArray<SyncResultItem>;
  readonly message: string;
}

export interface UndoResult {
  readonly success: boolean;
  readonly restoredFrom?: string | undefined;
  readonly message: string;
}
const IMPORTED_MARKER_FILE = ".imported-from-stable";
const STABLE_DEFAULT_DIR = ".synara";
const BETA_DEFAULT_DIR = ".synara-beta";
/** Stable-relative file assets the engine reads, shared with the CLI fingerprint. */
export const STABLE_SYNCED_FILES = [
  "userdata/settings.json",
  "userdata/keybindings.json",
  "userdata/state.sqlite",
] as const;
/** Stable-relative directory assets the engine reads, shared with the CLI fingerprint. */
export const STABLE_SYNCED_DIRS = ["skills", "mcp"] as const;

/** Private file mode so copied credentials are not exposed by group/world-readable umasks. */
const PRIVATE_FILE_MODE = 0o600;
/** Owner-execute bit preserved from sources so synced skill scripts stay runnable. */
const OWNER_EXECUTE_BIT = 0o100;
/** Private directory mode for created sync directories and snapshots. */
const PRIVATE_DIR_MODE = 0o700;
/** Maximum number of pre-sync snapshots retained per Beta home. */
const MAX_SNAPSHOTS = 5;

export function resolveSyncPaths(options?: {
  stableHome?: string | undefined;
  betaHome?: string | undefined;
}): SyncPaths {
  const homeDir = os.homedir();
  const stableHome = expandHomePath(
    options?.stableHome?.trim() ||
      process.env.SYNARA_STABLE_HOME?.trim() ||
      path.join(homeDir, STABLE_DEFAULT_DIR),
    homeDir,
  );

  const betaHome = expandHomePath(
    options?.betaHome?.trim() ||
      process.env.SYNARA_HOME?.trim() ||
      path.join(homeDir, BETA_DEFAULT_DIR),
    homeDir,
  );

  return {
    stableHome: path.resolve(stableHome),
    betaHome: path.resolve(betaHome),
  };
}

/**
 * Returns true when two paths resolve to the same directory, following
 * symlinks when both sides exist. Used for the unconditional same-path guard.
 */
export function isSamePath(a: string, b: string): boolean {
  const resolvedA = path.resolve(a);
  const resolvedB = path.resolve(b);
  if (resolvedA === resolvedB) return true;
  try {
    return fsSync.realpathSync(resolvedA) === fsSync.realpathSync(resolvedB);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EINVAL") return false;
    throw error;
  }
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
export async function readLifecycleLockOwner(
  dbPath: string,
): Promise<{ isRunning: boolean; pid: number | null }> {
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
export async function checkSyncAvailability(options?: {
  stableHome?: string | undefined;
  betaHome?: string | undefined;
}): Promise<SyncAvailability> {
  const paths = resolveSyncPaths(options);
  if (isSamePath(paths.stableHome, paths.betaHome)) {
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

  const stableExists = isExistingDirectory(paths.stableHome);

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

  const stableSettingsExists = fsSync.existsSync(stableSettingsPath);
  const stableKeybindingsExists = fsSync.existsSync(stableKeybindingsPath);

  let stableSkillsCount = 0;
  try {
    const entries = await fs.readdir(stableSkillsDir);
    stableSkillsCount = entries.filter((entry) => !entry.startsWith(".")).length;
  } catch {
    stableSkillsCount = 0;
  }

  const stableMcpExists = isExistingDirectory(stableMcpDir);

  const betaExists = isExistingDirectory(paths.betaHome);
  const hasBeenImportedBefore =
    betaExists && fsSync.existsSync(path.join(paths.betaHome, IMPORTED_MARKER_FILE));

  const { isRunning, pid } = await readLifecycleLockOwner(stableDbPath);

  const available =
    stableSettingsExists || stableKeybindingsExists || stableSkillsCount > 0 || stableMcpExists;

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
  const settings = (
    typeof cloned.settings === "object" && cloned.settings !== null ? cloned.settings : cloned
  ) as Record<string, unknown>;

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
export async function writeAtomicFile(
  filePath: string,
  content: string | Buffer,
  mode = PRIVATE_FILE_MODE,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
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

/**
 * Safely copies a directory tree, preserving source symlinks as symlinks.
 * Destination symlinks are never followed: a symlinked destination entry is
 * replaced so writes cannot be redirected outside the destination root, and
 * every created directory is verified by realpath to stay inside that root.
 */
export async function copyDirectoryTree(
  srcDir: string,
  destDir: string,
  fileMode = PRIVATE_FILE_MODE,
): Promise<number> {
  const rootReal = await ensureRealDirectory(destDir);
  return copyTreeInto(srcDir, destDir, rootReal, fileMode);
}

/**
 * Ensures dir exists as a real directory and returns its realpath.
 * A pre-existing symlink or file at dir is replaced, never followed.
 * When rootReal is given, throws if dir resolves outside that root.
 */
async function ensureRealDirectory(dir: string, rootReal?: string): Promise<string> {
  const existing = await fs.lstat(dir).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  });
  if (existing !== undefined && (existing.isSymbolicLink() || !existing.isDirectory())) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const real = await fs.realpath(dir);
  if (rootReal !== undefined && real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error(`Refusing to copy outside destination root: ${dir}`);
  }
  return real;
}

/** Removes destPath when it is a symlink so the caller replaces the link itself. */
async function removeSymlinkedDestination(destPath: string): Promise<void> {
  let destinationStat;
  try {
    destinationStat = await fs.lstat(destPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  if (destinationStat.isSymbolicLink()) {
    await fs.unlink(destPath);
  }
}

async function copyTreeInto(
  srcDir: string,
  destDir: string,
  rootReal: string,
  fileMode: number,
): Promise<number> {
  let copiedCount = 0;
  const entries = await fs.readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isSymbolicLink()) {
      const linkTarget = await fs.readlink(srcPath);
      await removeSymlinkedDestination(destPath);
      await fs.symlink(linkTarget, destPath);
      copiedCount += 1;
    } else if (entry.isDirectory()) {
      const destReal = await ensureRealDirectory(destPath, rootReal);
      copiedCount += await copyTreeInto(srcPath, destReal, rootReal, fileMode);
    } else if (entry.isFile()) {
      await removeSymlinkedDestination(destPath);
      const content = await fs.readFile(srcPath);
      // Preserve source owner-execute so synced scripts and hooks stay runnable;
      // group/other bits always stay private.
      const srcMode = (await fs.lstat(srcPath)).mode;
      const destMode =
        (srcMode & OWNER_EXECUTE_BIT) !== 0 ? fileMode | OWNER_EXECUTE_BIT : fileMode;
      await writeAtomicFile(destPath, content, destMode);
      copiedCount += 1;
    }
  }

  return copiedCount;
}

/** Presence of one Beta asset at snapshot time, so undo can restore absence too. */
export type SnapshotAssetPresence = "present" | "absent";

/** Records which Beta assets a snapshot holds, including assets absent before sync. */
export interface BetaSnapshotManifest {
  createdAt: string;
  settingsJson: SnapshotAssetPresence;
  keybindingsJson: SnapshotAssetPresence;
  skills: SnapshotAssetPresence;
  mcp: SnapshotAssetPresence;
  stateSqlite: SnapshotAssetPresence;
  importMarker: SnapshotAssetPresence;
}

const SNAPSHOT_MANIFEST_FILE = "manifest.json";
const SNAPSHOT_DB_FILE = "state.sqlite";

/** Returns true when candidate exists as a directory. */
function isExistingDirectory(candidate: string): boolean {
  try {
    return fsSync.statSync(candidate).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Takes a snapshot backup of every Beta asset sync can modify — settings,
 * keybindings, skills, MCP configs, state.sqlite, and the import marker —
 * recording absence metadata so undo restores "did not exist" as well.
 */
export async function createBetaSnapshot(betaHome: string): Promise<string | undefined> {
  const betaUserdata = path.join(betaHome, "userdata");
  const betaSkills = path.join(betaHome, "skills");
  const betaMcp = path.join(betaHome, "mcp");
  const betaMarker = path.join(betaHome, IMPORTED_MARKER_FILE);
  const hasSnapshotableAsset =
    fsSync.existsSync(betaUserdata) ||
    isExistingDirectory(betaSkills) ||
    isExistingDirectory(betaMcp) ||
    fsSync.existsSync(betaMarker);
  if (!hasSnapshotableAsset) {
    return undefined;
  }

  const backupRoot = path.join(betaUserdata, "backups");
  await fs.mkdir(backupRoot, { recursive: true, mode: PRIVATE_DIR_MODE });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = path.join(backupRoot, `pre-sync-${timestamp}`);
  await fs.mkdir(snapshotDir, { recursive: true, mode: PRIVATE_DIR_MODE });

  const manifest: BetaSnapshotManifest = {
    createdAt: new Date().toISOString(),
    settingsJson: "absent",
    keybindingsJson: "absent",
    skills: "absent",
    mcp: "absent",
    stateSqlite: "absent",
    importMarker: "absent",
  };

  // Snapshot settings.json and keybindings.json file bytes.
  const filesToSnapshot = ["settings.json", "keybindings.json"] as const;
  for (const filename of filesToSnapshot) {
    const src = path.join(betaUserdata, filename);
    if (fsSync.existsSync(src)) {
      const content = await fs.readFile(src);
      await fs.writeFile(path.join(snapshotDir, filename), content, { mode: PRIVATE_FILE_MODE });
      manifest[filename === "settings.json" ? "settingsJson" : "keybindingsJson"] = "present";
    }
  }

  // Snapshot skills/ and mcp/ directory trees.
  const dirsToSnapshot = [
    ["skills", betaSkills],
    ["mcp", betaMcp],
  ] as const;
  for (const [assetName, src] of dirsToSnapshot) {
    if (isExistingDirectory(src)) {
      await fs.cp(src, path.join(snapshotDir, assetName), { recursive: true });
      manifest[assetName] = "present";
    }
  }

  // Snapshot Beta state.sqlite bytes before any project merge touches them.
  // When Beta itself is running the file may be mid-write, so skip the byte
  // snapshot (the projects merge is skipped too) instead of storing a torn copy.
  const betaDb = path.join(betaUserdata, SNAPSHOT_DB_FILE);
  const { isRunning: isBetaRunning } = await readLifecycleLockOwner(betaDb);
  if (!isBetaRunning && fsSync.existsSync(betaDb)) {
    await fs.copyFile(betaDb, path.join(snapshotDir, SNAPSHOT_DB_FILE));
    await fs.chmod(path.join(snapshotDir, SNAPSHOT_DB_FILE), PRIVATE_FILE_MODE);
    manifest.stateSqlite = "present";
  }

  if (fsSync.existsSync(betaMarker)) {
    const markerContent = await fs.readFile(betaMarker);
    await fs.writeFile(path.join(snapshotDir, IMPORTED_MARKER_FILE), markerContent, {
      mode: PRIVATE_FILE_MODE,
    });
    manifest.importMarker = "present";
  }

  await fs.writeFile(
    path.join(snapshotDir, SNAPSHOT_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: PRIVATE_FILE_MODE },
  );

  await pruneSnapshots(backupRoot);

  return snapshotDir;
}

/** Keeps only the newest MAX_SNAPSHOTS pre-sync snapshots. */
async function pruneSnapshots(backupRoot: string): Promise<void> {
  let backups: string[];
  try {
    backups = (await fs.readdir(backupRoot))
      .filter((backup) => backup.startsWith("pre-sync-"))
      .toSorted();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  if (backups.length > MAX_SNAPSHOTS) {
    const toRemove = backups.slice(0, backups.length - MAX_SNAPSHOTS);
    for (const old of toRemove) {
      await fs.rm(path.join(backupRoot, old), { recursive: true, force: true });
    }
  }
}

/**
 * Live projection_projects columns (migrations 005 base, 016 model-selection
 * rename, 028 kind, 041 is_pinned, 079 space_id). Sync reads and writes this
 * shape; legacy columns such as default_model are ignored.
 */
export const CURRENT_PROJECT_COLUMNS = [
  "project_id",
  "kind",
  "title",
  "workspace_root",
  "default_model_selection_json",
  "scripts_json",
  "is_pinned",
  "space_id",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

type SqliteStatement = {
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
  run: (...args: unknown[]) => { changes: number };
};

type SqliteDatabase = {
  prepare: (query: string) => SqliteStatement;
  exec: (sql: string) => void;
  close: () => void;
};

type SqliteModule = {
  DatabaseSync: new (dbPath: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

const requireNode = createRequire(import.meta.url);

/** Loads node:sqlite when the runtime provides it, otherwise undefined. */
function loadSqlite(): SqliteModule["DatabaseSync"] | undefined {
  try {
    const sqliteModule = requireNode("node:sqlite") as SqliteModule;
    return sqliteModule.DatabaseSync;
  } catch {
    // node:sqlite is unavailable on this runtime: project sync degrades to
    // zero rows so file-based assets still synchronize.
    return undefined;
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Reads the actual column names of table from an open database. */
function readTableColumns(db: SqliteDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  const columns = new Set<string>();
  for (const row of rows) {
    if (typeof row.name === "string") columns.add(row.name);
  }
  return columns;
}

/**
 * Builds the SELECT for live project rows against the columns a Stable
 * database actually has. Returns undefined when the table cannot yield rows.
 */
export function buildProjectSelect(existingColumns: ReadonlySet<string>): string | undefined {
  const selected = CURRENT_PROJECT_COLUMNS.filter((column) => existingColumns.has(column));
  if (!selected.includes("project_id")) return undefined;
  const columnList = selected.map(quoteIdentifier).join(", ");
  const liveRowsOnly = existingColumns.has("deleted_at") ? " WHERE deleted_at IS NULL" : "";
  return `SELECT ${columnList} FROM projection_projects${liveRowsOnly}`;
}

/**
 * Builds the upsert for the columns a Beta database actually has.
 * deleted_at is never written: imports only carry live rows, so a Beta-side
 * soft delete must survive a re-import of the same project.
 */
export function buildProjectUpsert(existingColumns: ReadonlySet<string>): string | undefined {
  const writable = CURRENT_PROJECT_COLUMNS.filter(
    (column) => column !== "deleted_at" && existingColumns.has(column),
  );
  if (!writable.includes("project_id")) return undefined;
  const columnList = writable.map(quoteIdentifier).join(", ");
  const placeholders = writable.map(() => "?").join(", ");
  const updates = writable
    .filter((column) => column !== "project_id")
    .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
    .join(",\n          ");
  return [
    `INSERT INTO projection_projects (${columnList})`,
    `VALUES (${placeholders})`,
    "ON CONFLICT(project_id) DO UPDATE SET",
    `  ${updates}`,
  ].join("\n        ");
}

/** Default value for a synced project column when the Stable row omits it. */
function projectColumnFallback(column: string): unknown {
  switch (column) {
    case "kind":
      return "project";
    case "scripts_json":
      return "[]";
    case "is_pinned":
      return 0;
    case "created_at":
    case "updated_at":
      return new Date().toISOString();
    default:
      return null;
  }
}

/**
 * Reads registered projects from Stable database if accessible.
 * Selects the live projection_projects columns the file actually has, so a
 * schema mismatch surfaces as synced rows instead of a silent empty list.
 * If SQLite is locked or unreadable, returns an empty list without failing.
 */
export async function extractProjectsFromDatabase(
  dbPath: string,
): Promise<Array<Record<string, unknown>>> {
  if (!fsSync.existsSync(dbPath)) return [];

  try {
    const DatabaseSync = loadSqlite();
    if (DatabaseSync === undefined) return [];
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const existingColumns = readTableColumns(db, "projection_projects");
      const query = buildProjectSelect(existingColumns);
      if (query === undefined) return [];
      return db.prepare(query).all();
    } finally {
      db.close();
    }
  } catch (extractError) {
    // A locked or unreadable Stable database means "no importable rows":
    // report an empty list so the caller records a skipped projects item.
    // Anything else is a real bug; let it throw.
    if (extractError instanceof Error && isTolerableSqliteFailure(extractError)) return [];
    throw extractError;
  }
}

/**
 * Imports projects into Beta's state.sqlite if present.
 * Upserts inside one transaction with the live projection_projects columns
 * the file actually has, so a mid-merge failure rolls back instead of
 * leaving a partially merged registry. The pre-sync snapshot (not a
 * sidecar file) is the rollback path for undo.
 */
export async function mergeProjectsIntoBetaDatabase(
  betaDbPath: string,
  projects: ReadonlyArray<Record<string, unknown>>,
): Promise<number> {
  if (!fsSync.existsSync(betaDbPath) || projects.length === 0) return 0;

  try {
    const DatabaseSync = loadSqlite();
    if (DatabaseSync === undefined) return 0;
    const db = new DatabaseSync(betaDbPath, { readOnly: false });
    try {
      const existingColumns = readTableColumns(db, "projection_projects");
      const writable = CURRENT_PROJECT_COLUMNS.filter(
        (column) => column !== "deleted_at" && existingColumns.has(column),
      );
      const query = buildProjectUpsert(existingColumns);
      if (query === undefined) return 0;
      const stmt = db.prepare(query);
      let mergedCount = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const project of projects) {
          if (typeof project.project_id !== "string") continue;
          const values = writable.map((column) => {
            const value = project[column];
            return value === undefined ? projectColumnFallback(column) : value;
          });
          stmt.run(...values);
          mergedCount += 1;
        }
        db.exec("COMMIT");
      } catch (loopError) {
        try {
          db.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new Error(
            `Project merge failed (${String(loopError)}) and rollback failed: ${String(rollbackError)}`,
            { cause: rollbackError },
          );
        }
        throw loopError;
      }
      return mergedCount;
    } finally {
      db.close();
    }
  } catch (mergeError) {
    // A locked, busy, or unreadable Beta database must not fail the whole
    // sync: report zero merged rows so the caller records a skipped item.
    // Anything else is a real bug; let it throw.
    if (mergeError instanceof Error && isTolerableSqliteFailure(mergeError)) return 0;
    throw mergeError;
  }
}

/** True for SQLite busy/locked/schema-mismatch failures sync must tolerate. */
function isTolerableSqliteFailure(error: Error): boolean {
  return /database is locked|database is busy|database table is locked|attempt to write a readonly database|unable to open|no such table|no such column|unknown database|disk i\/o error|database disk image is malformed/i.test(
    error.message,
  );
}

/** Syncs settings.json from Stable, sanitizing embedded credentials. */
async function syncSettingsAsset(
  paths: SyncPaths,
  enabled: boolean,
  present: boolean,
): Promise<SyncResultItem> {
  if (!enabled) {
    return { item: "settings", status: "skipped", detail: "Settings sync excluded by option." };
  }
  if (!present) {
    return { item: "settings", status: "skipped", detail: "Settings file not present in Stable." };
  }
  const stableFile = path.join(paths.stableHome, "userdata", "settings.json");
  try {
    const raw = await fs.readFile(stableFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sanitized = sanitizeSettings(parsed);
    await writeAtomicFile(
      path.join(paths.betaHome, "userdata", "settings.json"),
      JSON.stringify(sanitized, null, 2) + "\n",
      PRIVATE_FILE_MODE,
    );
    return {
      item: "settings",
      status: "synced",
      detail: "Settings synced and sanitized (opencode server password removed).",
    };
  } catch (err: unknown) {
    return { item: "settings", status: "failed", detail: `Settings ${stableFile}: ${String(err)}` };
  }
}

/** Syncs keybindings.json verbatim after JSON validation. */
async function syncKeybindingsAsset(
  paths: SyncPaths,
  enabled: boolean,
  present: boolean,
): Promise<SyncResultItem> {
  if (!enabled) {
    return {
      item: "keybindings",
      status: "skipped",
      detail: "Keybindings sync excluded by option.",
    };
  }
  if (!present) {
    return {
      item: "keybindings",
      status: "skipped",
      detail: "Keybindings file not present in Stable.",
    };
  }
  const stableFile = path.join(paths.stableHome, "userdata", "keybindings.json");
  try {
    const content = await fs.readFile(stableFile, "utf8");
    JSON.parse(content);
    await writeAtomicFile(
      path.join(paths.betaHome, "userdata", "keybindings.json"),
      content,
      PRIVATE_FILE_MODE,
    );
    return { item: "keybindings", status: "synced", detail: "Keybindings synced." };
  } catch (err: unknown) {
    return {
      item: "keybindings",
      status: "failed",
      detail: `Keybindings ${stableFile}: ${String(err)}`,
    };
  }
}

/** Syncs the Stable skills tree into Beta. */
async function syncSkillsAsset(
  paths: SyncPaths,
  enabled: boolean,
  skillCount: number,
): Promise<SyncResultItem> {
  if (!enabled) {
    return { item: "skills", status: "skipped", detail: "Skills sync excluded by option." };
  }
  if (skillCount === 0) {
    return { item: "skills", status: "skipped", detail: "No custom skills found in Stable." };
  }
  const srcSkills = path.join(paths.stableHome, "skills");
  try {
    const copied = await copyDirectoryTree(srcSkills, path.join(paths.betaHome, "skills"));
    return { item: "skills", status: "synced", detail: `Synced ${copied} skills.` };
  } catch (err: unknown) {
    return { item: "skills", status: "failed", detail: `Skills ${srcSkills}: ${String(err)}` };
  }
}

/** Syncs the Stable MCP configuration tree into Beta. */
async function syncMcpAsset(
  paths: SyncPaths,
  enabled: boolean,
  present: boolean,
): Promise<SyncResultItem> {
  if (!enabled) {
    return { item: "mcp", status: "skipped", detail: "MCP sync excluded by option." };
  }
  if (!present) {
    return { item: "mcp", status: "skipped", detail: "No MCP configurations found in Stable." };
  }
  const srcMcp = path.join(paths.stableHome, "mcp");
  try {
    const copied = await copyDirectoryTree(srcMcp, path.join(paths.betaHome, "mcp"));
    return {
      item: "mcp",
      status: "synced",
      detail: `Synced MCP configurations (${copied} entries).`,
    };
  } catch (err: unknown) {
    return { item: "mcp", status: "failed", detail: `MCP ${srcMcp}: ${String(err)}` };
  }
}

/**
 * Syncs project rows unless a Stable or Beta database is live.
 * Returns undefined when project sync is excluded by option (no result item).
 */
async function syncProjectsAsset(
  paths: SyncPaths,
  enabled: boolean,
  availability: SyncAvailability,
): Promise<SyncResultItem | undefined> {
  if (!enabled) return undefined;
  const stableDbPath = path.join(paths.stableHome, "userdata", "state.sqlite");
  const betaDbPath = path.join(paths.betaHome, "userdata", "state.sqlite");
  if (availability.isStableProcessRunning) {
    return {
      item: "projects",
      status: "skipped",
      detail: `Stable Synara is running (PID ${availability.stablePid}); database is locked. Settings and skills synced safely.`,
    };
  }
  const { isRunning: isBetaRunning } = await readLifecycleLockOwner(betaDbPath);
  if (isBetaRunning) {
    return {
      item: "projects",
      status: "skipped",
      detail: "Beta Synara is running; project rows skipped to avoid torn reads and writes.",
    };
  }
  try {
    const projects = await extractProjectsFromDatabase(stableDbPath);
    if (projects.length > 0 && fsSync.existsSync(betaDbPath)) {
      const merged = await mergeProjectsIntoBetaDatabase(betaDbPath, projects);
      if (merged > 0) {
        return { item: "projects", status: "synced", detail: `Imported ${merged} projects.` };
      }
      return {
        item: "projects",
        status: "skipped",
        detail:
          "Stable projects could not be merged (Beta database locked or unreadable); file assets synced.",
      };
    }
    return {
      item: "projects",
      status: "skipped",
      detail:
        projects.length === 0
          ? "No projects found in Stable database."
          : "Beta database not yet initialized.",
    };
  } catch (err: unknown) {
    return {
      item: "projects",
      status: "failed",
      detail: `Projects ${stableDbPath}: ${String(err)}`,
    };
  }
}

/** Executes synchronization from Synara Stable into Synara Beta. */
export async function performStableSync(options?: SyncOptions): Promise<SyncResult> {
  const paths = resolveSyncPaths(options);
  if (isSamePath(paths.stableHome, paths.betaHome)) {
    return {
      success: false,
      timestamp: new Date().toISOString(),
      items: [],
      message: "Refusing sync: Stable and Beta directories resolve to the same location.",
    };
  }
  const availability = await checkSyncAvailability(options);

  if (!availability.available && !options?.force) {
    return {
      success: false,
      timestamp: new Date().toISOString(),
      items: [],
      message: availability.reason ?? "No syncable assets found in Synara Stable.",
    };
  }

  // Pin Beta userdata to a real directory (replacing a pre-existing symlink)
  // so atomic file writes and snapshots cannot escape the Beta root.
  await ensureRealDirectory(path.join(paths.betaHome, "userdata"));

  const snapshotPath = await createBetaSnapshot(paths.betaHome);

  const items: SyncResultItem[] = [
    await syncSettingsAsset(
      paths,
      options?.includeSettings !== false,
      availability.stableSettingsExists,
    ),
    await syncKeybindingsAsset(
      paths,
      options?.includeKeybindings !== false,
      availability.stableKeybindingsExists,
    ),
    await syncSkillsAsset(paths, options?.includeSkills !== false, availability.stableSkillsCount),
    await syncMcpAsset(paths, options?.includeMcp !== false, availability.stableMcpExists),
  ];
  const projectsItem = await syncProjectsAsset(
    paths,
    options?.includeProjects !== false,
    availability,
  );
  if (projectsItem !== undefined) items.push(projectsItem);

  const anyFailed = items.some((entry) => entry.status === "failed");
  const anySynced = items.some((entry) => entry.status === "synced");

  // Record the import marker only when the sync actually changed something,
  // so a no-op run never flips the previously-imported signal.
  await fs.mkdir(paths.betaHome, { recursive: true });
  if (anySynced) {
    await fs.writeFile(
      path.join(paths.betaHome, IMPORTED_MARKER_FILE),
      JSON.stringify(
        { importedAt: new Date().toISOString(), stableHome: paths.stableHome },
        null,
        2,
      ) + "\n",
      { mode: PRIVATE_FILE_MODE },
    );
  }

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

/**
 * Undoes synchronization by restoring the most recent snapshot backup.
 * Restores every snapshotted asset — settings, keybindings, skills, MCP
 * configs, and state.sqlite — and removes assets the sync created that were
 * absent before, per the snapshot manifest.
 */
export async function undoStableSync(options?: {
  betaHome?: string | undefined;
}): Promise<UndoResult> {
  const paths = resolveSyncPaths(options);
  const backupRoot = path.join(paths.betaHome, "userdata", "backups");

  if (!fsSync.existsSync(backupRoot)) {
    return { success: false, message: "No pre-sync snapshots found to restore from." };
  }

  const snapshots = (await fs.readdir(backupRoot))
    .filter((snapshotName) => snapshotName.startsWith("pre-sync-"))
    .toSorted((left, right) => (left < right ? 1 : left > right ? -1 : 0));

  const latestName = snapshots[0];
  if (latestName === undefined) {
    return { success: false, message: "No pre-sync snapshots found to restore from." };
  }

  const latestSnapshot = path.join(backupRoot, latestName);
  const betaUserdata = path.join(paths.betaHome, "userdata");
  const manifest = await readSnapshotManifest(latestSnapshot);
  const restored: string[] = [];
  const unrestorable: string[] = [];

  const snapshotFile = path.join(latestSnapshot, "settings.json");
  if (fsSync.existsSync(snapshotFile)) {
    await writeAtomicFile(
      path.join(betaUserdata, "settings.json"),
      await fs.readFile(snapshotFile),
      PRIVATE_FILE_MODE,
    );
    restored.push("settings.json");
  } else if (manifest?.settingsJson === "absent") {
    await fs.rm(path.join(betaUserdata, "settings.json"), { force: true });
    restored.push("settings.json (removed; absent before sync)");
  } else if (manifest?.settingsJson === "present") {
    unrestorable.push("settings.json (snapshot bytes missing)");
  }
  const snapshotKeybindings = path.join(latestSnapshot, "keybindings.json");
  if (fsSync.existsSync(snapshotKeybindings)) {
    await writeAtomicFile(
      path.join(betaUserdata, "keybindings.json"),
      await fs.readFile(snapshotKeybindings),
      PRIVATE_FILE_MODE,
    );
    restored.push("keybindings.json");
  } else if (manifest?.keybindingsJson === "absent") {
    await fs.rm(path.join(betaUserdata, "keybindings.json"), { force: true });
    restored.push("keybindings.json (removed; absent before sync)");
  } else if (manifest?.keybindingsJson === "present") {
    unrestorable.push("keybindings.json (snapshot bytes missing)");
  }
  for (const assetName of ["skills", "mcp"] as const) {
    const snapshotDir = path.join(latestSnapshot, assetName);
    const betaDir = path.join(paths.betaHome, assetName);
    if (fsSync.existsSync(snapshotDir)) {
      await fs.rm(betaDir, { recursive: true, force: true });
      await fs.cp(snapshotDir, betaDir, { recursive: true });
      restored.push(`${assetName}/`);
    } else if (manifest?.[assetName] === "absent") {
      await fs.rm(betaDir, { recursive: true, force: true });
      restored.push(`${assetName}/ (removed; absent before sync)`);
    } else if (manifest?.[assetName] === "present") {
      unrestorable.push(`${assetName}/ (snapshot bytes missing)`);
    }
  }

  const snapshotDb = path.join(latestSnapshot, SNAPSHOT_DB_FILE);
  if (fsSync.existsSync(snapshotDb)) {
    const betaDb = path.join(betaUserdata, SNAPSHOT_DB_FILE);
    // Same guard as the sync path: a raw copy over a live database (with
    // unsynchronized WAL pages) corrupts it, so restore only a quiet Beta.
    const { isRunning: isBetaRunning, pid } = await readLifecycleLockOwner(betaDb);
    if (isBetaRunning) {
      unrestorable.push(
        `${SNAPSHOT_DB_FILE} (Beta Synara is running${pid === null ? "" : `, PID ${pid}`}; close it and run --undo again to restore the database)`,
      );
    } else {
      await fs.copyFile(snapshotDb, betaDb);
      await fs.chmod(betaDb, PRIVATE_FILE_MODE);
      await fs.rm(`${betaDb}-wal`, { force: true });
      await fs.rm(`${betaDb}-shm`, { force: true });
      restored.push(SNAPSHOT_DB_FILE);
    }
  } else if (manifest?.stateSqlite === "present") {
    unrestorable.push(`${SNAPSHOT_DB_FILE} (snapshot bytes missing)`);
  }

  const snapshotMarker = path.join(latestSnapshot, IMPORTED_MARKER_FILE);
  if (manifest?.importMarker === "absent") {
    await fs.rm(path.join(paths.betaHome, IMPORTED_MARKER_FILE), { force: true });
  } else if (manifest?.importMarker === "present") {
    if (fsSync.existsSync(snapshotMarker)) {
      await writeAtomicFile(
        path.join(paths.betaHome, IMPORTED_MARKER_FILE),
        await fs.readFile(snapshotMarker),
        PRIVATE_FILE_MODE,
      );
      restored.push(IMPORTED_MARKER_FILE);
    } else {
      unrestorable.push(`${IMPORTED_MARKER_FILE} (snapshot bytes missing)`);
    }
  }

  if (restored.length === 0) {
    return { success: false, message: `Snapshot at ${latestSnapshot} holds no restorable assets.` };
  }

  const unrestorableNote =
    unrestorable.length > 0 ? ` Unrestorable assets left as-is: ${unrestorable.join(", ")}.` : "";
  return {
    success: true,
    restoredFrom: latestSnapshot,
    message: `Restored ${restored.join(", ")} from ${latestSnapshot}.${unrestorableNote}`,
  };
}

/** Reads a snapshot manifest, or undefined for snapshots written before manifests. */
async function readSnapshotManifest(
  snapshotDir: string,
): Promise<BetaSnapshotManifest | undefined> {
  const manifestPath = path.join(snapshotDir, SNAPSHOT_MANIFEST_FILE);
  if (!fsSync.existsSync(manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as BetaSnapshotManifest;
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (error instanceof SyntaxError || code === "ENOENT") return undefined;
    throw error;
  }
}
