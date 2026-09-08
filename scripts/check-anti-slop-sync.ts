// FILE: check-anti-slop-sync.ts
// Purpose: Verifies the live anti-slop plugin and the bundled skill copy are identical.
// Layer: Local developer tooling

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(repoRoot, "tools/oxlint/anti-slop");
const skillRoot = resolve(repoRoot, ".agents/skills/install-anti-slop/assets/anti-slop");

function* walk(dir: string, base: string): Generator<{ relative: string; absolute: string }> {
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      yield* walk(absolute, base);
    } else {
      yield { relative: relative(base, absolute), absolute };
    }
  }
}

function collectFiles(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const { relative, absolute } of walk(dir, dir)) {
    map.set(relative, readFileSync(absolute, "utf8"));
  }
  return map;
}

function main(): void {
  const pluginFiles = collectFiles(pluginRoot);
  const skillFiles = collectFiles(skillRoot);
  const mismatches: string[] = [];

  for (const [path, pluginContent] of pluginFiles) {
    const skillContent = skillFiles.get(path);
    if (skillContent === undefined) {
      mismatches.push(`missing in skill copy: ${path}`);
    } else if (skillContent !== pluginContent) {
      mismatches.push(`content differs: ${path}`);
    }
  }

  for (const path of skillFiles.keys()) {
    if (!pluginFiles.has(path)) {
      mismatches.push(`extra in skill copy: ${path}`);
    }
  }

  if (mismatches.length === 0) {
    console.log("Anti-slop plugin and skill copy are synchronized.");
    return;
  }

  console.error("Anti-slop plugin and skill copy are out of sync:");
  for (const mismatch of mismatches) {
    console.error(`  ${mismatch}`);
  }
  process.exit(1);
}

main();
