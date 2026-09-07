import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  mergeMacUpdateManifests,
  parseMacUpdateManifest,
  serializeMacUpdateManifest,
} from "./merge-mac-update-manifests.ts";

export function mergeLinuxUpdateManifests(
  arm64Path: string,
  x64Path: string,
  outputPath = arm64Path,
): void {
  const arm64Manifest = parseMacUpdateManifest(readFileSync(arm64Path, "utf8"), arm64Path);
  const x64Manifest = parseMacUpdateManifest(readFileSync(x64Path, "utf8"), x64Path);
  writeFileSync(
    outputPath,
    serializeMacUpdateManifest(mergeMacUpdateManifests(arm64Manifest, x64Manifest)),
  );
}

export function normalizeLinuxUpdateManifest(assetDirectory: string, arch: "arm64" | "x64"): void {
  if (arch === "x64") {
    const manifestPath = resolve(assetDirectory, "latest-linux.yml");
    if (existsSync(manifestPath)) {
      renameSync(manifestPath, resolve(assetDirectory, "latest-linux-x64.yml"));
    }
    return;
  }

  const arm64ManifestPath = resolve(assetDirectory, "latest-linux-arm64.yml");
  if (existsSync(arm64ManifestPath)) {
    rmSync(resolve(assetDirectory, "latest-linux.yml"), { force: true });
    renameSync(arm64ManifestPath, resolve(assetDirectory, "latest-linux.yml"));
  }
}

export function prepareMergedLinuxUpdateManifests(assetDirectory: string): void {
  const mergedPath = resolve(assetDirectory, "latest-linux.yml");
  mergeLinuxUpdateManifests(mergedPath, resolve(assetDirectory, "latest-linux-x64.yml"));
  rmSync(resolve(assetDirectory, "latest-linux-x64.yml"));
  cpSync(mergedPath, resolve(assetDirectory, "latest-linux-arm64.yml"));
}

function main(args: ReadonlyArray<string>): void {
  const [command, firstArg, secondArg] = args;
  if (command === "normalize") {
    if (!firstArg || (secondArg !== "arm64" && secondArg !== "x64")) {
      throw new Error(
        "Usage: node scripts/merge-linux-update-manifests.ts normalize <asset-directory> <arm64|x64>",
      );
    }
    normalizeLinuxUpdateManifest(resolve(firstArg), secondArg);
    return;
  }
  if (command === "merge") {
    if (!firstArg) {
      throw new Error(
        "Usage: node scripts/merge-linux-update-manifests.ts merge <asset-directory>",
      );
    }
    prepareMergedLinuxUpdateManifests(resolve(firstArg));
    return;
  }
  if (!command || !firstArg) {
    throw new Error(
      "Usage: node scripts/merge-linux-update-manifests.ts <latest-linux.yml> <latest-linux-x64.yml> [output-path]",
    );
  }
  mergeLinuxUpdateManifests(resolve(command), resolve(firstArg), resolve(secondArg ?? command));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
