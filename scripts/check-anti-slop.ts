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
  message: string;
}

export interface OxlintOutput {
  diagnostics: OxlintDiagnostic[];
}

export interface RatchetReport {
  failures: string[];
  burnDown: string[];
}

export interface BaselineEntry {
  total: number;
  messages: Record<string, number>;
}

export type Baseline = Record<string, BaselineEntry>;

/** Maps "rule:file" to per-message-fingerprint violation counts. */
export type ViolationCounts = Map<string, Map<string, number>>;

export const BASELINE_PATH = "tools/oxlint/anti-slop-baseline.json";
const ANTI_SLOP_CODE_PREFIX = "anti-slop";

export function parseAntiSlopDiagnostics(
  output: OxlintOutput,
): Array<{ code: string; filename: string; message: string }> {
  return output.diagnostics
    .filter((diagnostic) => diagnostic.code.startsWith(ANTI_SLOP_CODE_PREFIX))
    .map((diagnostic) => ({
      code: diagnostic.code,
      filename: diagnostic.filename,
      message: diagnostic.message,
    }));
}

export function messageFingerprint(message: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < message.length; index++) {
    hash ^= message.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function countViolationsByRuleAndFile(
  diagnostics: Array<{ code: string; filename: string; message: string }>,
): ViolationCounts {
  const counts: ViolationCounts = new Map();
  for (const { code, filename, message } of diagnostics) {
    const key = `${code}:${filename}`;
    const messages = countByMessage(counts, key);
    const fingerprint = messageFingerprint(message);
    messages.set(fingerprint, (messages.get(fingerprint) ?? 0) + 1);
  }
  return counts;
}

function countByMessage(counts: ViolationCounts, key: string): Map<string, number> {
  const messages = counts.get(key);
  if (messages !== undefined) return messages;
  const created = new Map<string, number>();
  counts.set(key, created);
  return created;
}

function totalViolations(messages: ReadonlyMap<string, number>): number {
  return [...messages.values()].reduce((sum, count) => sum + count, 0);
}

export function compareAgainstBaseline(
  baseline: Baseline,
  current: ViolationCounts,
): RatchetReport {
  const failures: string[] = [];
  const burnDown: string[] = [];
  for (const [key, messages] of current) {
    const before = baseline[key];
    if (before === undefined) {
      failures.push(`${key} (new, ${totalViolations(messages)})`);
      continue;
    }
    for (const [fingerprint, count] of messages) {
      const beforeCount = before.messages[fingerprint] ?? 0;
      if (count > beforeCount) {
        failures.push(`${key} [${fingerprint}] (grew, ${beforeCount} -> ${count})`);
      } else if (count < beforeCount) {
        burnDown.push(`${key} [${fingerprint}] (${beforeCount} -> ${count})`);
      }
    }
    for (const [fingerprint, beforeCount] of Object.entries(before.messages)) {
      if (!messages.has(fingerprint) && beforeCount > 0) {
        burnDown.push(`${key} [${fingerprint}] (${beforeCount} -> 0)`);
      }
    }
  }
  for (const [key, entry] of Object.entries(baseline)) {
    if (!current.has(key) && entry.total > 0) {
      burnDown.push(`${key} (gone, ${entry.total} -> 0)`);
    }
  }
  return { failures, burnDown };
}

function oxlintBinary(root: string): string {
  const binary = resolve(root, "node_modules/.bin/oxlint");
  return process.platform === "win32" ? `${binary}.cmd` : binary;
}

export function collectCurrentViolations(root: string): ViolationCounts {
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
  return countViolationsByRuleAndFile(parseAntiSlopDiagnostics(output));
}

export function sortedBaselineEntries(current: ViolationCounts): Baseline {
  const baseline: Baseline = {};
  for (const key of [...current.keys()].sort()) {
    const messages = current.get(key);
    if (messages === undefined) continue;
    const sortedMessages: Record<string, number> = {};
    for (const fingerprint of [...messages.keys()].sort()) {
      const count = messages.get(fingerprint);
      if (count !== undefined) sortedMessages[fingerprint] = count;
    }
    baseline[key] = { total: totalViolations(messages), messages: sortedMessages };
  }
  return baseline;
}

function readBaseline(root: string): Baseline {
  return JSON.parse(readFileSync(resolve(root, BASELINE_PATH), "utf8")) as Baseline;
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const update = process.argv.includes("--update");
  const current = collectCurrentViolations(root);

  if (update) {
    writeFileSync(
      resolve(root, BASELINE_PATH),
      `${JSON.stringify(sortedBaselineEntries(current), null, 2)}\n`,
    );
    const total = [...current.values()].reduce(
      (sum, messages) => sum + totalViolations(messages),
      0,
    );
    console.log(`Baseline updated: ${current.size} rule/file entries, ${total} violations.`);
    return;
  }

  const report = compareAgainstBaseline(readBaseline(root), current);
  if (report.burnDown.length > 0) {
    console.log(
      `Burn-down available: ${report.burnDown.length} entries shrank. Run \`bun run lint:anti-slop --update\` to record the improvement.`,
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
