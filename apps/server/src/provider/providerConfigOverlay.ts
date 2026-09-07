// FILE: providerConfigOverlay.ts
// Purpose: Reusable directory overlay helper for provider configuration isolation.
// Layer: Server provider process infrastructure

import { copyFile, lstat, mkdir, readdir, symlink } from "node:fs/promises";
import path from "node:path";

export interface ConfigDirectoryOverlayLinker {
  readonly symlink?: typeof symlink;
  readonly copyFile?: typeof copyFile;
}

export interface MirrorConfigDirectoryOverlayOptions {
  readonly sourceConfigDir: string;
  readonly targetRootDir: string;
  readonly excludedNamespaces?: ReadonlyArray<string>;
  readonly platform?: NodeJS.Platform;
  readonly linker?: ConfigDirectoryOverlayLinker;
}

/**
 * Mirrors existing entries from a user's configuration directory (such as ~/.config or APPDATA)
 * into an isolated target overlay directory using symlinks or directory junctions.
 *
 * Entries matching excludedNamespaces (such as 'devin') are skipped so the provider can manage
 * its own isolated configuration without collisions or mutation of user files.
 *
 * NOTE ON WRITE BEHAVIOR:
 * This overlay provides provider namespace isolation (preventing Synara-generated configs like
 * mcp_config.json from polluting the user's ~/.config), NOT read-only filesystem sandboxing.
 * Tools executed by the provider session (e.g. gh, git, npm) run on behalf of the user and
 * retain intentional read-write access to their respective configurations.
 *
 * Regular files that fail to symlink (such as on Windows without Developer Mode or elevated privileges)
 * fall back to being copied into the target overlay so user configurations remain accessible.
 * The copy fallback runs only when the target path is absent: an existing overlay entry (including
 * a symlink pointing outside the overlay) is never overwritten through a failed symlink call.
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
  const doSymlink = options.linker?.symlink ?? symlink;
  const doCopyFile = options.linker?.copyFile ?? copyFile;

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
      const symlinkType = platform === "win32" ? (isDirectory ? "junction" : "file") : undefined;

      try {
        await doSymlink(sourcePath, targetPath, symlinkType);
      } catch (symlinkError) {
        if (isDirectory) {
          throw symlinkError;
        }
        try {
          await lstat(targetPath);
        } catch {
          await doCopyFile(sourcePath, targetPath);
        }
      }
    } catch {
      // Best-effort: skip entries that fail to link or copy.
    }
  }
}
