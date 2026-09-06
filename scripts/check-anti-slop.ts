// FILE: check-anti-slop.ts
// Purpose: Ratchet for the anti-slop oxlint plugin. Blocks new or grown violations
//          against a committed baseline; existing debt is tolerated until touched.
// Layer: Local developer tooling

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface OxlintDiagnostic {
  code: string;
  filename: string;
  severity: string;
}

export interface OxlintOutput {
  diagnostics: OxlintDiagnostic[];
}

export interface RatchetReport {
  failures: string[];
  burnDown: string[];
}

export const BASELINE_PATH = "tools/oxlint/anti-slop-baseline.json";
const ANTI_SLOP_CODE_PREFIX = "anti-slop";

export function parseAntiSlopDiagnostics(
  output: OxlintOutput,
): Array<{ code: string; filename: string }> {
  return output.diagnostics
    .filter((diagnostic) => diagnostic.code.startsWith(ANTI_SLOP_CODE_PREFIX))
    .map((diagnostic) => ({ code: diagnostic.code, filename: diagnostic.filename }));
}

export function countByRuleAndFile(
  diagnostics: Array<{ code: string; filename: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { code, filename } of diagnostics) {
    const key = `${code}:${filename}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function compareAgainstBaseline(
  baseline: Record<string, number>,
  current: Map<string, number>,
): RatchetReport {
  const failures: string[] = [];
  const burnDown: string[] = [];
  for (const [key, count] of current) {
    const before = baseline[key];
    if (before === undefined) {
      failures.push(`${key} (new, ${count})`);
    } else if (before < count) {
      failures.push(`${key} (grew, ${before} -> ${count})`);
    } else if (before > count) {
      burnDown.push(`${key} (${before} -> ${count})`);
    }
  }
  for (const [key, before] of Object.entries(baseline)) {
    if (!current.has(key) && before > 0) {
      burnDown.push(`${key} (${before} -> 0)`);
    }
  }
  return { failures, burnDown };
}

function oxlintBinary(root: string): string {
  const binary = resolve(root, "node_modules/.bin/oxlint");
  return process.platform === "win32" ? `${binary}.cmd` : binary;
}

export function collectCurrentViolations(root: string): Map<string, number> {
  const shell = process.platform === "win32";
  const binary = oxlintBinary(root);
  const result = spawnSync(shell ? `"${binary}"` : binary, ["-f", "json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    shell,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0 && result.status !== 1) {
    const stderr = (result.stderr ?? "").split("\n").slice(0, 4).join("\n");
    throw new Error(`oxlint failed with status ${result.status}: ${stderr}`);
  }
  if (!result.stdout) {
    throw new Error(`oxlint produced no JSON output (status ${result.status})`);
  }
  const output = JSON.parse(result.stdout) as OxlintOutput;
  return countByRuleAndFile(parseAntiSlopDiagnostics(output));
}

export function sortedBaselineEntries(current: Map<string, number>): Array<[string, number]> {
  return [...current.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function readBaseline(root: string): Record<string, number> {
  return JSON.parse(readFileSync(resolve(root, BASELINE_PATH), "utf8")) as Record<string, number>;
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const update = process.argv.includes("--update");
  const current = collectCurrentViolations(root);

  if (update) {
    writeFileSync(
      resolve(root, BASELINE_PATH),
      `${JSON.stringify(Object.fromEntries(sortedBaselineEntries(current)), null, 2)}\n`,
    );
    const total = [...current.values()].reduce((sum, count) => sum + count, 0);
    console.log(`Baseline updated: ${current.size} rule/file entries, ${total} violations.`);
    return;
  }

  const report = compareAgainstBaseline(readBaseline(root), current);
  if (report.burnDown.length > 0) {
    console.log(
      `Burn-down available: ${report.burnDown.length} rule/file entries shrank. Run \`bun run lint:anti-slop --update\` to record the improvement.`,
    );
  }
  if (report.failures.length === 0) {
    console.log("Anti-slop ratchet: no new violations.");
    return;
  }
  console.error(
    `Anti-slop ratchet: ${report.failures.length} new or grown violation(s). Fix them at the root cause; do not disable the rule.\n`,
  );
  for (const failure of report.failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
