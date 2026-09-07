import { readFileSync, writeFileSync } from "node:fs";
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

function main(args: ReadonlyArray<string>): void {
  const [arm64PathArg, x64PathArg, outputPathArg] = args;
  if (!arm64PathArg || !x64PathArg) {
    throw new Error(
      "Usage: node scripts/merge-linux-update-manifests.ts <latest-linux.yml> <latest-linux-x64.yml> [output-path]",
    );
  }
  mergeLinuxUpdateManifests(
    resolve(arm64PathArg),
    resolve(x64PathArg),
    resolve(outputPathArg ?? arm64PathArg),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
