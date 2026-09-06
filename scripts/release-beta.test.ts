import { describe, expect, it } from "vitest";

import { BETA_PACKAGE_FILES, resolveBetaReleaseVersion } from "./release-beta.ts";

describe("release-beta", () => {
  it("resolves version with explicit beta number", () => {
    const result = resolveBetaReleaseVersion("0.8.2", 1);
    expect(result).toEqual({
      baseVersion: "0.8.2",
      betaNumber: 1,
      version: "0.8.2-beta.1",
      tag: "v0.8.2-beta.1",
    });
  });

  it("handles 'v' prefix in base version", () => {
    const result = resolveBetaReleaseVersion("v0.8.2", 3);
    expect(result).toEqual({
      baseVersion: "0.8.2",
      betaNumber: 3,
      version: "0.8.2-beta.3",
      tag: "v0.8.2-beta.3",
    });
  });

  it("parses already-formatted beta version string", () => {
    const result = resolveBetaReleaseVersion("0.8.2-beta.2", undefined);
    expect(result).toEqual({
      baseVersion: "0.8.2",
      betaNumber: 2,
      version: "0.8.2-beta.2",
      tag: "v0.8.2-beta.2",
    });
  });

  it("parses already-formatted beta version with 'v' prefix", () => {
    const result = resolveBetaReleaseVersion("v0.8.2-beta.5", undefined);
    expect(result).toEqual({
      baseVersion: "0.8.2",
      betaNumber: 5,
      version: "0.8.2-beta.5",
      tag: "v0.8.2-beta.5",
    });
  });

  it("throws on missing version", () => {
    expect(() => resolveBetaReleaseVersion(undefined, undefined)).toThrow(/Missing version/);
  });

  it("throws on invalid version format", () => {
    expect(() => resolveBetaReleaseVersion("invalid-version", undefined)).toThrow(/Invalid version format/);
  });

  it("includes all expected workspace package files", () => {
    expect(BETA_PACKAGE_FILES).toEqual([
      "package.json",
      "apps/desktop/package.json",
      "apps/server/package.json",
      "apps/web/package.json",
      "packages/contracts/package.json",
    ]);
  });
});
