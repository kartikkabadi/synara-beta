// FILE: stableDatabaseImport.ts
// Purpose: File-level import of Synara Stable's chat database and attachments into Synara Beta.
// Layer: Shared sync engine (used by the desktop onboarding import).

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { copyDirectoryTree, isSamePath, resolveSyncPaths } from "./stableSync";

/** Private file mode for the imported database and its sidecar files. */
const PRIVATE_FILE_MODE = 0o600;
/** Private directory mode for the Beta userdata directory when it must be created. */
const PRIVATE_DIR_MODE = 0o700;

export interface StableDatabaseImportResult {
  readonly success: boolean;
  readonly copiedDatabase: boolean;
  readonly copiedWriteAheadLog: boolean;
  readonly copiedAttachments: boolean;
  readonly attachmentEntries: number;
  readonly databaseBytes: number;
  readonly message: string;
}

function isExistingDirectory(target: string): boolean {
  try {
    return fsSync.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Copies Stable's chat database and attachment files over Beta's copies.
 *
 * File-level only: the caller owns process lifecycle and must stop the Beta
 * backend before calling this, because replacing the database under a live
 * SQLite connection is unsafe (and impossible on Windows while the file is
 * held). A pre-import snapshot from `performStableSync` is the undo path.
 */
export async function importStableDatabase(options?: {
  stableHome?: string | undefined;
  betaHome?: string | undefined;
}): Promise<StableDatabaseImportResult> {
  const paths = resolveSyncPaths(options);
  const emptyResult = {
    copiedDatabase: false,
    copiedWriteAheadLog: false,
    copiedAttachments: false,
    attachmentEntries: 0,
    databaseBytes: 0,
  } as const;

  if (isSamePath(paths.stableHome, paths.betaHome)) {
    return {
      ...emptyResult,
      success: false,
      message: "Refusing database import: Stable and Beta directories resolve to the same location.",
    };
  }

  const stableUserdata = path.join(paths.stableHome, "userdata");
  const betaUserdata = path.join(paths.betaHome, "userdata");
  const stableDbPath = path.join(stableUserdata, "state.sqlite");
  const stableWalPath = `${stableDbPath}-wal`;
  const betaDbPath = path.join(betaUserdata, "state.sqlite");

  if (!fsSync.existsSync(stableDbPath)) {
    return {
      ...emptyResult,
      success: false,
      message: `No Stable database found at ${stableDbPath}.`,
    };
  }

  await fs.mkdir(betaUserdata, { recursive: true, mode: PRIVATE_DIR_MODE });

  // Stage beside the destination first: a failed or interrupted copy must never
  // leave a torn database in place of the previous one.
  const stagedDbPath = `${betaDbPath}.${randomUUID()}.partial`;
  await fs.copyFile(stableDbPath, stagedDbPath);
  await fs.chmod(stagedDbPath, PRIVATE_FILE_MODE);

  let stagedWalPath: string | null = null;
  if (fsSync.existsSync(stableWalPath)) {
    stagedWalPath = `${betaDbPath}-wal.${randomUUID()}.partial`;
    await fs.copyFile(stableWalPath, stagedWalPath);
    await fs.chmod(stagedWalPath, PRIVATE_FILE_MODE);
  }

  // A stale WAL/SHM from the previous Beta database must never replay over the
  // imported file; SQLite rebuilds the SHM on next open.
  await fs.rm(`${betaDbPath}-wal`, { force: true });
  await fs.rm(`${betaDbPath}-shm`, { force: true });
  await fs.rename(stagedDbPath, betaDbPath);

  let copiedWriteAheadLog = false;
  if (stagedWalPath !== null) {
    await fs.rename(stagedWalPath, `${betaDbPath}-wal`);
    copiedWriteAheadLog = true;
  }

  let copiedAttachments = false;
  let attachmentEntries = 0;
  const stableAttachments = path.join(stableUserdata, "attachments");
  if (isExistingDirectory(stableAttachments)) {
    attachmentEntries = await copyDirectoryTree(
      stableAttachments,
      path.join(betaUserdata, "attachments"),
    );
    copiedAttachments = true;
  }

  const databaseBytes = (await fs.stat(betaDbPath)).size;
  return {
    success: true,
    copiedDatabase: true,
    copiedWriteAheadLog,
    copiedAttachments,
    attachmentEntries,
    databaseBytes,
    message: `Imported Stable database (${databaseBytes} bytes)${
      copiedAttachments ? ` and ${attachmentEntries} attachment entries` : ""
    }.`,
  };
}
