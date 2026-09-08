// FILE: desktopStableImport.ts
// Purpose: One-time import of conversation data from a Synara Stable home
//          directory into the beta home. Offered once on a fresh beta install.
// Layer: Desktop main-process utility
//
// Safety model:
// - Only offered when the beta database does not exist yet (fresh install) and
//   the stable database does.
// - The backend fails closed (MigrationSchemaTooNewError + recovery flow) when
//   the imported database is newer than this build understands, so a bad match
//   degrades to a clean startup block, never silent corruption.
// - A marker file records the decision (imported or declined) so the prompt
//   never repeats.

import * as FS from "node:fs";
import * as Path from "node:path";

import { Schema } from "effect";

export const STABLE_IMPORT_MARKER_FILE = "import-from-synara-stable-v1.json";

export interface StableImportCandidate {
  readonly available: boolean;
  readonly reason: "no-stable-data" | "beta-already-initialized" | "already-decided" | "candidate";
  readonly sourceStateDir: string;
  readonly targetStateDir: string;
  readonly stableDatabasePath: string;
}

export interface StableImportPaths {
  readonly betaBaseDir: string;
  readonly stableBaseDir: string;
  readonly isDevelopment: boolean;
}

export function stableStateDir(baseDir: string, isDevelopment: boolean): string {
  return Path.join(baseDir, isDevelopment ? "dev" : "userdata");
}

export function resolveStableImportCandidate(input: {
  readonly betaBaseDir: string;
  readonly stableBaseDir: string;
  readonly isDevelopment: boolean;
}): StableImportCandidate {
  const sourceStateDir = stableStateDir(input.stableBaseDir, input.isDevelopment);
  const targetStateDir = stableStateDir(input.betaBaseDir, input.isDevelopment);
  const stableDatabasePath = Path.join(sourceStateDir, "state.sqlite");
  const betaDatabasePath = Path.join(targetStateDir, "state.sqlite");
  const markerPath = Path.join(targetStateDir, "migrations", STABLE_IMPORT_MARKER_FILE_NAME);
  if (readImportMarker(markerPath) !== null) {
    return {
      available: false,
      reason: "already-decided",
      sourceStateDir,
      targetStateDir,
      stableDatabasePath,
    };
  }
  if (!pathExists(stableDatabasePath)) {
    return {
      available: false,
      reason: "no-stable-data",
      sourceStateDir,
      targetStateDir,
      stableDatabasePath,
    };
  }
  if (pathExists(betaDatabasePath)) {
    return {
      available: false,
      reason: "beta-already-initialized",
      sourceStateDir,
      targetStateDir,
      stableDatabasePath,
    };
  }
  return {
    available: true,
    reason: "candidate",
    sourceStateDir,
    targetStateDir,
    stableDatabasePath,
  };
}

export const STABLE_IMPORT_MARKER_FILE_NAME = "import-from-synara-stable-v1.json";

export interface StableImportMarker {
  readonly status: "completed" | "declined";
  readonly sourceStateDir: string;
  readonly targetStateDir: string;
  readonly importedArtifacts: readonly string[];
  readonly importedAt: string;
}

const StableImportMarkerSchema = Schema.Struct({
  status: Schema.Literals(["completed", "declined"]),
  sourceStateDir: Schema.String,
  targetStateDir: Schema.String,
  importedArtifacts: Schema.Array(Schema.String),
  importedAt: Schema.String,
});

function readImportMarker(markerPath: string): StableImportMarker | null {
  try {
    return Schema.decodeUnknownSync(StableImportMarkerSchema)(
      JSON.parse(FS.readFileSync(markerPath, "utf8")),
    );
  } catch {
    return null;
  }
}

export interface StableImportResult {
  readonly ok: boolean;
  readonly importedArtifacts: readonly string[];
  readonly error: string | null;
}

const IMPORT_ARTIFACTS: ReadonlyArray<{
  readonly name: string;
  readonly relativePaths: (sourceStateDir: string) => readonly string[];
}> = [
  {
    name: "database",
    relativePaths: (stateDir) => [
      Path.join(stateDir, "state.sqlite"),
      Path.join(stateDir, "state.sqlite-wal"),
      Path.join(stateDir, "state.sqlite-shm"),
    ],
  },
  { name: "settings", relativePaths: (stateDir) => [Path.join(stateDir, "settings.json")] },
  { name: "keybindings", relativePaths: (stateDir) => [Path.join(stateDir, "keybindings.json")] },
  { name: "secrets", relativePaths: (stateDir) => [Path.join(stateDir, "secrets")] },
  { name: "environmentId", relativePaths: (stateDir) => [Path.join(stateDir, "environment-id")] },
];

/**
 * Copies the stable home's data artifacts into the beta home. Copies the
 * database file set together (WAL mode) and skips optional artifacts that do
 * not exist. Writes the decision marker either way so the offer never repeats.
 */
export function performStableImport(input: {
  readonly candidate: StableImportCandidate;
  readonly markerPath: string;
  readonly now: () => Date;
}): StableImportResult {
  const imported: string[] = [];
  try {
    for (const artifact of IMPORT_ARTIFACTS) {
      const sources = artifact.relativePaths(input.candidate.sourceStateDir).filter(pathExists);
      if (sources.length === 0) continue;
      for (const source of sources) {
        const relative = Path.relative(input.candidate.sourceStateDir, source);
        const target = Path.join(input.candidate.targetStateDir, relative);
        FS.mkdirSync(Path.dirname(target), { recursive: true });
        FS.cpSync(source, target, { recursive: true, force: true });
      }
      imported.push(artifact.name);
    }
  } catch (error) {
    return {
      ok: false,
      importedArtifacts: imported,
      error: error instanceof Error ? error.message : "import failed",
    };
  }
  writeImportMarker(input.markerPath, {
    status: "completed",
    sourceStateDir: input.candidate.sourceStateDir,
    targetStateDir: input.candidate.targetStateDir,
    importedArtifacts: imported,
    importedAt: input.now().toISOString(),
  });
  return { ok: true, importedArtifacts: imported, error: null };
}

export function writeDeclinedMarker(
  markerPath: string,
  sourceStateDir: string,
  targetStateDir: string,
): void {
  writeImportMarker(markerPath, {
    status: "declined",
    sourceStateDir,
    targetStateDir,
    importedArtifacts: [],
    importedAt: new Date().toISOString(),
  });
}

function writeImportMarker(markerPath: string, marker: StableImportMarker): void {
  FS.mkdirSync(Path.dirname(markerPath), { recursive: true });
  FS.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function pathExists(path: string): boolean {
  try {
    FS.statSync(path);
    return true;
  } catch {
    return false;
  }
}
