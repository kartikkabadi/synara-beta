#!/usr/bin/env bun
// FILE: release-beta.ts
// Purpose: CLI utility to prepare and tag a new Beta release for Synara Beta.
// Usage: bun run release:beta -- <version> [betaNumber] [--dry-run] [--allow-dirty] [--skip-bump]

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const BETA_PACKAGE_FILES = [
  "package.json",
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

interface ReleaseBetaOptions {
  readonly versionInput?: string | undefined;
  readonly betaNumberInput?: number | undefined;
  readonly dryRun: boolean;
  readonly allowDirty: boolean;
  readonly skipBump: boolean;
  readonly help: boolean;
}

function printUsage(): void {
  console.log(`
Synara Beta Release Tagging Tool

Usage:
  bun run release:beta -- <version> [betaNumber] [options]

Examples:
  bun run release:beta -- 0.8.2 1
  bun run release:beta -- 0.8.2 1 --dry-run
  bun run release:beta -- 0.8.2-beta.1
  bun run release:beta -- 0.8.2

Arguments:
  <version>       Base release version (e.g. 0.8.2) or full beta version (e.g. 0.8.2-beta.1)
  [betaNumber]    Optional beta increment number (e.g. 1). If omitted, automatically
                  calculates the next available number from existing local and remote tags.

Options:
  --dry-run       Validate preflight conditions and preview actions without making changes
  --allow-dirty   Allow release preparation even if git working tree has uncommitted changes
  --skip-bump     Skip updating package.json versions and committing (tags existing HEAD)
  --help, -h      Show this help message
`);
}

function parseCliArgs(argv: ReadonlyArray<string>): ReleaseBetaOptions {
  let versionInput: string | undefined;
  let betaNumberInput: number | undefined;
  let dryRun = false;
  let allowDirty = false;
  let skipBump = false;
  let help = false;

  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--allow-dirty") {
      allowDirty = true;
    } else if (arg === "--skip-bump" || arg === "--no-bump") {
      skipBump = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}. Run with --help for usage.`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    versionInput = positional[0];
  }
  if (positional.length > 1) {
    const parsedNumber = Number.parseInt(positional[1]!, 10);
    if (Number.isNaN(parsedNumber) || parsedNumber < 1) {
      throw new Error(`Invalid beta number: ${positional[1]}. Must be a positive integer.`);
    }
    betaNumberInput = parsedNumber;
  }

  return {
    versionInput,
    betaNumberInput,
    dryRun,
    allowDirty,
    skipBump,
    help,
  };
}

function runGit(args: ReadonlyArray<string>): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}

function checkGitStatus(): { clean: boolean; summary: string } {
  const statusOutput = runGit(["status", "--porcelain=v1"]);
  if (statusOutput.length === 0) {
    return { clean: true, summary: "clean" };
  }
  const lines = statusOutput.split("\n").map((line) => line.trim());
  return {
    clean: false,
    summary: `${lines.length} uncommitted changes:\n  ${lines.slice(0, 10).join("\n  ")}${
      lines.length > 10 ? `\n  ... and ${lines.length - 10} more` : ""
    }`,
  };
}

function verifyBetaRemote(): { valid: boolean; remoteUrl: string; error?: string } {
  try {
    const remotesOutput = runGit(["remote", "-v"]);
    const lines = remotesOutput.split("\n");
    let foundBetaRemoteUrl: string | undefined;

    for (const line of lines) {
      const match = line.match(/^beta\s+(\S+)\s+\((?:fetch|push)\)$/);
      if (match) {
        foundBetaRemoteUrl = match[1];
        break;
      }
    }

    if (!foundBetaRemoteUrl) {
      return {
        valid: false,
        remoteUrl: "",
        error:
          "Remote 'beta' is not configured in git remote -v. Run:\n  git remote add beta https://github.com/kartikkabadi/synara-beta.git",
      };
    }

    if (!foundBetaRemoteUrl.includes("kartikkabadi/synara-beta")) {
      return {
        valid: false,
        remoteUrl: foundBetaRemoteUrl,
        error: `Remote 'beta' points to '${foundBetaRemoteUrl}', but expected 'kartikkabadi/synara-beta'.`,
      };
    }

    return { valid: true, remoteUrl: foundBetaRemoteUrl };
  } catch (err: unknown) {
    return {
      valid: false,
      remoteUrl: "",
      error: `Failed to inspect git remotes: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function getExistingBetaTagNumbers(baseVersion: string): number[] {
  const numbers = new Set<number>();

  // Check local tags
  try {
    const localTags = runGit(["tag", "-l", `v${baseVersion}-beta.*`]);
    if (localTags.length > 0) {
      for (const tag of localTags.split("\n")) {
        const match = tag.trim().match(new RegExp(`^v${baseVersion.replace(/\./g, "\\.")}-beta\\.(\\d+)$`));
        if (match) {
          numbers.add(Number.parseInt(match[1]!, 10));
        }
      }
    }
  } catch {
    // Ignore error reading local tags
  }

  // Check remote tags
  try {
    const remoteTags = runGit(["ls-remote", "--tags", "beta", `refs/tags/v${baseVersion}-beta.*`]);
    if (remoteTags.length > 0) {
      for (const line of remoteTags.split("\n")) {
        const match = line.trim().match(new RegExp(`refs/tags/v${baseVersion.replace(/\./g, "\\.")}-beta\\.(\\d+)`));
        if (match) {
          numbers.add(Number.parseInt(match[1]!, 10));
        }
      }
    }
  } catch {
    // Remote might be unreachable or empty; non-fatal here
  }

  return Array.from(numbers).sort((a, b) => a - b);
}

function checkTagExists(tag: string): { local: boolean; remote: boolean } {
  let local = false;
  let remote = false;

  try {
    const localOutput = runGit(["tag", "-l", tag]);
    if (localOutput.trim() === tag) {
      local = true;
    }
  } catch {
    // Ignore local check error
  }

  try {
    const remoteOutput = runGit(["ls-remote", "--tags", "beta", `refs/tags/${tag}`]);
    if (remoteOutput.includes(`refs/tags/${tag}`)) {
      remote = true;
    }
  } catch {
    // Ignore remote check error
  }

  return { local, remote };
}

export function resolveBetaReleaseVersion(
  versionInput: string | undefined,
  betaNumberInput: number | undefined,
): { baseVersion: string; betaNumber: number; version: string; tag: string } {
  if (!versionInput) {
    throw new Error(
      "Missing version argument. Provide a base version (e.g. 0.8.2) or full beta version (e.g. 0.8.2-beta.1).",
    );
  }

  const cleanInput = versionInput.trim().replace(/^v/, "");

  // Pattern A: 0.8.2-beta.1
  const fullBetaMatch = cleanInput.match(/^(\d+\.\d+\.\d+)-beta\.(\d+)$/);
  if (fullBetaMatch) {
    const baseVersion = fullBetaMatch[1]!;
    const parsedBetaNumber = Number.parseInt(fullBetaMatch[2]!, 10);
    const betaNumber = betaNumberInput ?? parsedBetaNumber;
    const version = `${baseVersion}-beta.${betaNumber}`;
    return {
      baseVersion,
      betaNumber,
      version,
      tag: `v${version}`,
    };
  }

  // Pattern B: 0.8.2
  const baseMatch = cleanInput.match(/^(\d+\.\d+\.\d+)$/);
  if (baseMatch) {
    const baseVersion = baseMatch[1]!;
    let betaNumber = betaNumberInput;
    if (betaNumber === undefined) {
      const existing = getExistingBetaTagNumbers(baseVersion);
      const maxExisting = existing.length > 0 ? Math.max(...existing) : 0;
      betaNumber = maxExisting + 1;
    }
    const version = `${baseVersion}-beta.${betaNumber}`;
    return {
      baseVersion,
      betaNumber,
      version,
      tag: `v${version}`,
    };
  }

  throw new Error(
    `Invalid version format: "${versionInput}". Expected semver base like 0.8.2 or beta format like 0.8.2-beta.1.`,
  );
}

export function bumpPackageJsonVersions(version: string): { updatedFiles: string[] } {
  const updatedFiles: string[] = [];

  for (const relativePath of BETA_PACKAGE_FILES) {
    const absolutePath = resolve(repoRoot, relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }

    const content = readFileSync(absolutePath, "utf8");
    const json = JSON.parse(content) as Record<string, unknown>;

    if (json.version !== version) {
      json.version = version;
      writeFileSync(absolutePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
      updatedFiles.push(relativePath);
    }
  }

  return { updatedFiles };
}

export function runReleaseBeta(options: ReleaseBetaOptions): void {
  if (options.help) {
    printUsage();
    return;
  }

  const resolved = resolveBetaReleaseVersion(options.versionInput, options.betaNumberInput);
  const { version, tag } = resolved;

  console.log("==================================================");
  console.log(`  Synara Beta Release: ${tag}`);
  console.log("==================================================");
  console.log(`Target Version : ${version}`);
  console.log(`Target Tag     : ${tag}`);
  console.log(`Execution Mode : ${options.dryRun ? "DRY RUN (preview only)" : "LIVE"}\n`);

  console.log("[PREFLIGHT CHECKS]");

  // 1. Git status check
  const gitStatus = checkGitStatus();
  if (gitStatus.clean) {
    console.log("  ✓ Git working tree is clean.");
  } else {
    if (options.dryRun || options.allowDirty) {
      console.log(`  ⚠ Git working tree is not clean (${gitStatus.summary.split("\n")[0]}).`);
      if (options.dryRun) {
        console.log("    (Warning acknowledged in dry-run mode)");
      }
    } else {
      console.error(`  ✗ Git working tree is not clean:\n  ${gitStatus.summary}`);
      console.error("\nPlease commit or stash your changes before tagging, or pass --allow-dirty.");
      process.exit(1);
    }
  }

  // 2. Remote verification
  const remoteCheck = verifyBetaRemote();
  if (remoteCheck.valid) {
    console.log(`  ✓ Remote 'beta' verified (${remoteCheck.remoteUrl}).`);
  } else {
    console.error(`  ✗ Remote verification failed: ${remoteCheck.error}`);
    process.exit(1);
  }

  // 3. Tag uniqueness check
  const tagExistence = checkTagExists(tag);
  if (tagExistence.local) {
    console.error(`  ✗ Tag '${tag}' already exists locally! Cannot create duplicate tag.`);
    process.exit(1);
  }
  if (tagExistence.remote) {
    console.error(`  ✗ Tag '${tag}' already exists on remote 'beta'! Cannot create duplicate tag.`);
    process.exit(1);
  }
  console.log(`  ✓ Tag '${tag}' is unique (not found locally or on remote 'beta').`);

  console.log("\n[PLANNED ACTIONS]");
  if (options.skipBump) {
    console.log("  • Skip package.json version bump (--skip-bump specified)");
  } else {
    console.log(`  • Bump version to ${version} in:`);
    for (const file of BETA_PACKAGE_FILES) {
      console.log(`    - ${file}`);
    }
    console.log("  • Refresh bun.lock (bun install --lockfile-only --ignore-scripts)");
    console.log(`  • Git commit: "chore(release): prepare ${tag}"`);
  }
  console.log(`  • Create annotated tag: ${tag} with message "Synara Beta ${tag}"`);
  console.log(`  • Push command: git push beta ${tag}`);

  if (options.dryRun) {
    console.log("\n==================================================");
    console.log("  DRY RUN COMPLETED: No changes were made.");
    console.log("==================================================");
    return;
  }

  // Live execution
  console.log("\n[EXECUTING RELEASE PREPARATION]");

  if (!options.skipBump) {
    console.log("Updating package versions...");
    const { updatedFiles } = bumpPackageJsonVersions(version);
    console.log(`  Updated ${updatedFiles.length} package file(s).`);

    console.log("Refreshing lockfile...");
    execSync("bun install --lockfile-only --ignore-scripts", {
      cwd: repoRoot,
      stdio: "inherit",
    });

    console.log("Staging package files...");
    const filesToStage = [...BETA_PACKAGE_FILES, "bun.lock"].filter((f) => existsSync(resolve(repoRoot, f)));
    execFileSync("git", ["add", ...filesToStage], { cwd: repoRoot, stdio: "inherit" });

    // Only commit if there are staged changes
    const stagedStatus = runGit(["diff", "--cached", "--name-only"]);
    if (stagedStatus.length > 0) {
      console.log(`Committing version bump: "chore(release): prepare ${tag}"`);
      execFileSync("git", ["commit", "-m", `chore(release): prepare ${tag}`], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    } else {
      console.log("No version changes detected to commit.");
    }
  }

  console.log(`Creating annotated tag '${tag}'...`);
  execFileSync("git", ["tag", "-a", tag, "-m", `Synara Beta ${tag}`], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  console.log("\n==================================================");
  console.log(`  Synara Beta ${tag} prepared and tagged!`);
  console.log("==================================================");
  console.log("\nTo publish this beta release, push the tag to the beta repository:");
  console.log(`\n    git push beta ${tag}\n`);
}

// CLI entrypoint when run directly
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    runReleaseBeta(options);
  } catch (error: unknown) {
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Run with --help for usage information.\n");
    process.exit(1);
  }
}
