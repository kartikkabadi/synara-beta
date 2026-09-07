// FILE: providerConfigOverlay.ts
// Purpose: Reusable directory overlay helper for provider configuration isolation.
// Layer: Server provider process infrastructure

import { lstat, mkdir, readdir, symlink } from "node:fs/promises";
import path from "node:path";

export interface MirrorConfigDirectoryOverlayOptions {
  readonly sourceConfigDir: string;
  readonly targetRootDir: string;
  readonly excludedNamespaces?: ReadonlyArray<string>;
  readonly platform?: NodeJS.Platform;
}

/**
 * Mirrors existing entries from a user's configuration directory (such as ~/.config or APPDATA)
 * into an isolated target overlay directory using symlinks or directory junctions.
 *
 * Entries matching excludedNamespaces (such as 'devin') are skipped so the provider can manage
 * its own isolated configuration without collisions or mutation of user files.
 *
 * All operations are best-effort: unreadable entries, broken source links, or permission issues
 * will not abort the mirroring pass or fail provider session startup.
 */
export async function mirrorConfigDirectoryOverlay(
  options: MirrorConfigDirectoryOverlayOptions,
): Promise<void> {
  const { sourceConfigDir, targetRootDir } = options;
  const platform = options.platform ?? process.platform;
  const excluded = new Set(options.excludedNamespaces ?? []);

  let entries: string[];
  try {
    entries = await readdir(sourceConfigDir);
  } catch {
    return;
  }

  await mkdir(targetRootDir, { recursive: true, mode: 0o700 });

  for (const entry of entries) {
    if (excluded.has(entry)) {
      continue;
    }
    const sourcePath = path.join(sourceConfigDir, entry);
    const targetPath = path.join(targetRootDir, entry);

    try {
      const sourceStat = await lstat(sourcePath);
      const isDirectory = sourceStat.isDirectory();
      const symlinkType = platform === "win32" ? (isDirectory ? "junction" : "file") : "dir";

      await symlink(sourcePath, targetPath, symlinkType);
    } catch {
      // Best-effort: skip entries that fail to link.
    }
  }
}
