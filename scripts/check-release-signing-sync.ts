// FILE: check-release-signing-sync.ts
// Purpose: Verifies every installer embeds exactly the pinned release-signing
//          public key from scripts/release-signing.pub, so a rotation cannot
//          leave one installer verifying against a stale key.
// Layer: Local developer tooling

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicKeyPath = "scripts/release-signing.pub";
const installerPaths = [
  "scripts/install-linux.sh",
  "scripts/install-macos.sh",
  "scripts/install-windows.ps1",
];

// "synara-beta-releases ssh-ed25519 <base64 blob>", wherever the line hides
// (bare in the .pub file, inside ALLOWED_SIGNERS="..." in bash, or inside
// single quotes in PowerShell).
const SIGNERS_LINE_PATTERN = /synara-beta-releases\s+ssh-\S+\s+[A-Za-z0-9+/=]+/g;

function signersLineOf(source: string, label: string): string {
  const matches = [...source.matchAll(SIGNERS_LINE_PATTERN)].map((match) => match[0]);
  if (matches.length === 0) {
    throw new Error(`${label}: no embedded synara-beta-releases signers line found`);
  }
  if (matches.length > 1) {
    throw new Error(`${label}: multiple synara-beta-releases signers lines found`);
  }
  const line = matches[0];
  if (line === undefined) {
    throw new Error(`${label}: no embedded synara-beta-releases signers line found`);
  }
  return line;
}

/**
 * Returns one entry per installer whose embedded key is missing, duplicated, or
 * differs from scripts/release-signing.pub. An empty list means all four pinned
 * locations agree.
 */
export function findReleaseSigningKeyDrift(repoRoot: string): string[] {
  const mismatches: string[] = [];
  let pinnedLine: string;
  try {
    pinnedLine = signersLineOf(
      readFileSync(resolve(repoRoot, publicKeyPath), "utf8"),
      publicKeyPath,
    );
  } catch (error) {
    mismatches.push(error instanceof Error ? error.message : String(error));
    return mismatches;
  }

  for (const installerPath of installerPaths) {
    try {
      const embeddedLine = signersLineOf(
        readFileSync(resolve(repoRoot, installerPath), "utf8"),
        installerPath,
      );
      if (embeddedLine !== pinnedLine) {
        mismatches.push(`${installerPath}: embedded key differs from ${publicKeyPath}`);
      }
    } catch (error) {
      mismatches.push(error instanceof Error ? error.message : String(error));
    }
  }
  return mismatches;
}

function main(): void {
  const mismatches = findReleaseSigningKeyDrift(repoRoot);
  if (mismatches.length === 0) {
    console.log(
      "Release-signing public key is identical in scripts/release-signing.pub and all installers.",
    );
    return;
  }

  console.error("Release-signing public key is out of sync:");
  for (const mismatch of mismatches) {
    console.error(`  ${mismatch}`);
  }
  console.error(
    "Rotate together: the SYNARA_RELEASE_SIGNING_KEY secret, scripts/release-signing.pub, and every embedded installer key.",
  );
  process.exit(1);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
