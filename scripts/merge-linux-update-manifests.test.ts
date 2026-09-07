import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { mergeLinuxUpdateManifests } from "./merge-linux-update-manifests.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("merge-linux-update-manifests", () => {
  it("merges arm64 and x64 AppImage update entries", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-linux-update-manifests-"));
    roots.push(root);
    const arm64Path = join(root, "latest-linux.yml");
    const x64Path = join(root, "latest-linux-x64.yml");
    writeFileSync(
      arm64Path,
      "version: 1.2.3\nfiles:\n  - url: Synara-1.2.3-arm64.AppImage\n    sha512: arm\n    size: 10\npath: Synara-1.2.3-arm64.AppImage\nsha512: arm\nreleaseDate: '2026-09-07T00:00:00.000Z'\n",
    );
    writeFileSync(
      x64Path,
      "version: 1.2.3\nfiles:\n  - url: Synara-1.2.3-x64.AppImage\n    sha512: x64\n    size: 20\npath: Synara-1.2.3-x64.AppImage\nsha512: x64\nreleaseDate: '2026-09-07T00:00:01.000Z'\n",
    );

    mergeLinuxUpdateManifests(arm64Path, x64Path);

    const merged = readFileSync(arm64Path, "utf8");
    expect(merged).toContain("Synara-1.2.3-arm64.AppImage");
    expect(merged).toContain("Synara-1.2.3-x64.AppImage");
    expect(merged).toContain("releaseDate: '2026-09-07T00:00:01.000Z'");
  });
});
