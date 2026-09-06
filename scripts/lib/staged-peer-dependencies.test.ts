// FILE: staged-peer-dependencies.test.ts
// Purpose: Covers peer-dependency satisfaction checks for the staged release install.
// Layer: Release/build helper

import { describe, expect, it } from "vitest";

import { findUnsatisfiedPeers, type StagedPackageManifest } from "./staged-peer-dependencies.ts";

function stagedPackage(
  name: string,
  peerDependencies?: Record<string, string>,
  peerDependenciesMeta?: Record<string, { optional?: boolean }>,
): StagedPackageManifest {
  return {
    name,
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
    ...(peerDependenciesMeta === undefined ? {} : { peerDependenciesMeta }),
  };
}

describe("findUnsatisfiedPeers", () => {
  it("passes when every non-optional peer is present", () => {
    const packages = [stagedPackage("sdk-a", { zod: "^4.0.0" }), stagedPackage("sdk-b")];
    expect(findUnsatisfiedPeers(packages, new Set(["zod"]))).toEqual([]);
  });

  it("skips peers marked optional in peerDependenciesMeta", () => {
    const packages = [
      stagedPackage("sdk-a", { zod: "^4.0.0", ws: "^8.0.0" }, { ws: { optional: true } }),
    ];
    expect(findUnsatisfiedPeers(packages, new Set(["zod"]))).toEqual([]);
  });

  it("reports a missing peer with the staged package that requires it", () => {
    const packages = [stagedPackage("@acp/sdk", { zod: "^4.0.0" })];
    expect(findUnsatisfiedPeers(packages, new Set(["effect"]))).toEqual([
      { from: "@acp/sdk", peer: "zod" },
    ]);
  });

  it("reports one entry per missing peer", () => {
    const packages = [
      stagedPackage("sdk-a", { zod: "^4.0.0", ws: "^8.0.0" }),
      stagedPackage("sdk-b", { zod: "^4.0.0" }),
    ];
    expect(findUnsatisfiedPeers(packages, new Set())).toEqual([
      { from: "sdk-a", peer: "zod" },
      { from: "sdk-a", peer: "ws" },
      { from: "sdk-b", peer: "zod" },
    ]);
  });
});
