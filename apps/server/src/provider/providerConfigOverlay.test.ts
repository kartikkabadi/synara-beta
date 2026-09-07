import { access, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mirrorConfigDirectoryOverlay } from "./providerConfigOverlay.ts";

describe("providerConfigOverlay", () => {
  let tmpRoot: string;
  let sourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tmpRoot = path.join(
      os.tmpdir(),
      `test-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    sourceDir = path.join(tmpRoot, "source-config");
    targetDir = path.join(tmpRoot, "target-overlay");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("mirrors non-excluded directories and files as symlinks", async () => {
    await mkdir(path.join(sourceDir, "gh"), { recursive: true });
    await writeFile(path.join(sourceDir, "gh", "hosts.yml"), "github.com: test");
    await mkdir(path.join(sourceDir, "git"), { recursive: true });
    await writeFile(path.join(sourceDir, "git", "config"), "[user]\nname = test");
    await mkdir(path.join(sourceDir, "devin"), { recursive: true });
    await writeFile(path.join(sourceDir, "devin", "mcp_config.json"), "{}");
    await writeFile(path.join(sourceDir, "starship.toml"), "format = '$all'");

    await mirrorConfigDirectoryOverlay({
      sourceConfigDir: sourceDir,
      targetRootDir: targetDir,
      excludedNamespaces: ["devin"],
    });

    const ghStat = await lstat(path.join(targetDir, "gh"));
    expect(ghStat.isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(targetDir, "gh"))).toBe(path.join(sourceDir, "gh"));

    const gitStat = await lstat(path.join(targetDir, "git"));
    expect(gitStat.isSymbolicLink()).toBe(true);

    const starshipStat = await lstat(path.join(targetDir, "starship.toml"));
    expect(starshipStat.isSymbolicLink()).toBe(true);

    await expect(access(path.join(targetDir, "devin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("handles nonexistent source directory gracefully", async () => {
    const nonexistent = path.join(tmpRoot, "does-not-exist");
    await expect(
      mirrorConfigDirectoryOverlay({
        sourceConfigDir: nonexistent,
        targetRootDir: targetDir,
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores preexisting targets without throwing", async () => {
    await mkdir(path.join(sourceDir, "npm"), { recursive: true });
    await mkdir(path.join(targetDir, "npm"), { recursive: true });

    await expect(
      mirrorConfigDirectoryOverlay({
        sourceConfigDir: sourceDir,
        targetRootDir: targetDir,
      }),
    ).resolves.toBeUndefined();
  });

  it("falls back to copying regular files when file symlink fails", async () => {
    await writeFile(path.join(sourceDir, "config.json"), '{"theme":"dark"}');

    const failingSymlink = async () => {
      const error = new Error("A required privilege is not held by the client.");
      Object.assign(error, { code: "EPERM" });
      throw error;
    };

    await mirrorConfigDirectoryOverlay({
      sourceConfigDir: sourceDir,
      targetRootDir: targetDir,
      linker: {
        symlink: failingSymlink as unknown as typeof import("node:fs/promises").symlink,
      },
    });

    const targetFile = path.join(targetDir, "config.json");
    const stat = await lstat(targetFile);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(await readFile(targetFile, "utf8")).toBe('{"theme":"dark"}');
  });

  it("does not overwrite an existing target file when symlink fails with EEXIST", async () => {
    await writeFile(path.join(sourceDir, "config.json"), '{"theme":"dark"}');
    await writeFile(path.join(targetDir, "config.json"), '{"theme":"light"}');

    const eexistSymlink = async () => {
      const error = new Error("file already exists");
      Object.assign(error, { code: "EEXIST" });
      throw error;
    };

    await mirrorConfigDirectoryOverlay({
      sourceConfigDir: sourceDir,
      targetRootDir: targetDir,
      linker: {
        symlink: eexistSymlink as unknown as typeof import("node:fs/promises").symlink,
      },
    });

    expect(await readFile(path.join(targetDir, "config.json"), "utf8")).toBe('{"theme":"light"}');
  });

  it("leaves an existing target symlink untouched when symlink creation fails", async () => {
    await writeFile(path.join(sourceDir, "config.json"), '{"theme":"dark"}');
    const outsideFile = path.join(tmpRoot, "outside.json");
    await writeFile(outsideFile, "keep");

    const failingSymlink = async () => {
      const error = new Error("A required privilege is not held by the client.");
      Object.assign(error, { code: "EPERM" });
      throw error;
    };

    await symlink(outsideFile, path.join(targetDir, "config.json"));
    await mirrorConfigDirectoryOverlay({
      sourceConfigDir: sourceDir,
      targetRootDir: targetDir,
      linker: {
        symlink: failingSymlink as unknown as typeof import("node:fs/promises").symlink,
      },
    });

    const stat = await lstat(path.join(targetDir, "config.json"));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await readFile(outsideFile, "utf8")).toBe("keep");
  });
});
