// FILE: check-anti-slop.test.ts
// Purpose: Covers the anti-slop ratchet comparator: new violations fail, grown
//          counts fail, shrinkage reports burn-down, stale entries are ignored,
//          and same-count message swaps are still caught.
// Layer: Local developer tooling

import { describe, expect, it } from "vitest";

import {
  compareAgainstBaseline,
  countViolationsByRuleAndFile,
  messageFingerprint,
  parseAntiSlopDiagnostics,
  sortedBaselineEntries,
  type Baseline,
} from "./check-anti-slop.ts";

const FINGERPRINT_A = messageFingerprint("first message");
const FINGERPRINT_B = messageFingerprint("second message");

function entry(total: number, messages: Record<string, number>): Baseline[string] {
  return { total, messages };
}

describe("messageFingerprint", () => {
  it("is stable per message and distinct across messages", () => {
    expect(messageFingerprint("same message")).toBe(messageFingerprint("same message"));
    expect(messageFingerprint("first message")).not.toBe(messageFingerprint("second message"));
  });
});

describe("parseAntiSlopDiagnostics", () => {
  it("keeps anti-slop diagnostics and drops every other plugin", () => {
    const report = {
      diagnostics: [
        {
          code: "anti-slop(no-runtime-typeof)",
          filename: "a.ts",
          severity: "error",
          message: "one",
        },
        {
          code: "anti-slop-effect(no-service-constructor-imports)",
          filename: "b.ts",
          severity: "error",
          message: "two",
        },
        {
          code: "eslint-plugin-unicorn(no-array-sort)",
          filename: "c.ts",
          severity: "warning",
          message: "three",
        },
      ],
    };
    const parsed = parseAntiSlopDiagnostics(report);
    expect(parsed).toEqual([
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "one" },
      {
        code: "anti-slop-effect(no-service-constructor-imports)",
        filename: "b.ts",
        message: "two",
      },
    ]);
  });
});

describe("countViolationsByRuleAndFile", () => {
  it("counts diagnostics per rule, file, and message fingerprint", () => {
    const counts = countViolationsByRuleAndFile([
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "first message" },
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "first message" },
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "second message" },
      { code: "anti-slop(no-runtime-typeof)", filename: "b.ts", message: "first message" },
    ]);
    const forA = counts.get("anti-slop(no-runtime-typeof):a.ts");
    expect(forA?.get(FINGERPRINT_A)).toBe(2);
    expect(forA?.get(FINGERPRINT_B)).toBe(1);
    expect(counts.get("anti-slop(no-runtime-typeof):b.ts")?.get(FINGERPRINT_A)).toBe(1);
    expect(counts.size).toBe(2);
  });
});

describe("compareAgainstBaseline", () => {
  it("passes when current matches the baseline exactly", () => {
    const baseline: Baseline = {
      "anti-slop(no-runtime-typeof):a.ts": entry(2, { [FINGERPRINT_A]: 1, [FINGERPRINT_B]: 1 }),
    };
    const current = countViolationsByRuleAndFile([
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "first message" },
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "second message" },
    ]);
    expect(compareAgainstBaseline(baseline, current)).toEqual({ failures: [], burnDown: [] });
  });

  it("fails on a violation in a file the baseline never saw", () => {
    const baseline: Baseline = {
      "anti-slop(no-runtime-typeof):a.ts": entry(1, { [FINGERPRINT_A]: 1 }),
    };
    const current = countViolationsByRuleAndFile([
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "first message" },
      { code: "anti-slop(no-unknown-returns)", filename: "new-file.ts", message: "first message" },
    ]);
    const report = compareAgainstBaseline(baseline, current);
    expect(report.failures).toEqual(["anti-slop(no-unknown-returns):new-file.ts (new, 1)"]);
    expect(report.burnDown).toEqual([]);
  });

  it("fails when an existing message fingerprint grows", () => {
    const baseline: Baseline = {
      "anti-slop(no-runtime-typeof):a.ts": entry(2, { [FINGERPRINT_A]: 2 }),
    };
    const current = countViolationsByRuleAndFile([
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "first message" },
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "first message" },
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "first message" },
    ]);
    const report = compareAgainstBaseline(baseline, current);
    expect(report.failures).toEqual([
      `anti-slop(no-runtime-typeof):a.ts [${FINGERPRINT_A}] (grew, 2 -> 3)`,
    ]);
  });

  it("fails when the count is unchanged but a different message replaces one", () => {
    const baseline: Baseline = {
      "anti-slop(no-runtime-typeof):a.ts": entry(2, { [FINGERPRINT_A]: 2 }),
    };
    const current = countViolationsByRuleAndFile([
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "first message" },
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "second message" },
    ]);
    const report = compareAgainstBaseline(baseline, current);
    expect(report.failures).toEqual([
      `anti-slop(no-runtime-typeof):a.ts [${FINGERPRINT_B}] (grew, 0 -> 1)`,
    ]);
    expect(report.burnDown).toEqual([
      `anti-slop(no-runtime-typeof):a.ts [${FINGERPRINT_A}] (2 -> 1)`,
    ]);
  });

  it("reports burn-down without failing when an entry shrinks", () => {
    const baseline: Baseline = {
      "anti-slop(no-runtime-typeof):a.ts": entry(5, { [FINGERPRINT_A]: 5 }),
    };
    const current = countViolationsByRuleAndFile([
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "first message" },
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "first message" },
    ]);
    const report = compareAgainstBaseline(baseline, current);
    expect(report.failures).toEqual([]);
    expect(report.burnDown).toEqual([
      `anti-slop(no-runtime-typeof):a.ts [${FINGERPRINT_A}] (5 -> 2)`,
    ]);
  });

  it("reports burn-down for baseline entries that no longer occur", () => {
    const baseline: Baseline = {
      "anti-slop(no-runtime-typeof):deleted.ts": entry(4, { [FINGERPRINT_A]: 4 }),
      "anti-slop(no-runtime-typeof):a.ts": entry(1, { [FINGERPRINT_A]: 1 }),
    };
    const current = countViolationsByRuleAndFile([
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "first message" },
    ]);
    const report = compareAgainstBaseline(baseline, current);
    expect(report.failures).toEqual([]);
    expect(report.burnDown).toEqual(["anti-slop(no-runtime-typeof):deleted.ts (gone, 4 -> 0)"]);
  });
});

describe("sortedBaselineEntries", () => {
  it("writes entries and message fingerprints in stable key order", () => {
    const current = countViolationsByRuleAndFile([
      { code: "anti-slop(no-runtime-typeof)", filename: "b.ts", message: "second message" },
      { code: "anti-slop(no-module-mocking)", filename: "a.ts", message: "first message" },
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "first message" },
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", message: "second message" },
    ]);
    const baseline = sortedBaselineEntries(current);
    expect(Object.keys(baseline)).toEqual([
      "anti-slop(no-module-mocking):a.ts",
      "anti-slop(no-runtime-typeof):a.ts",
      "anti-slop(no-runtime-typeof):b.ts",
    ]);
    const entryForA = baseline["anti-slop(no-runtime-typeof):a.ts"];
    expect(entryForA?.messages && Object.keys(entryForA.messages)).toEqual(
      [FINGERPRINT_A, FINGERPRINT_B].sort(),
    );
  });
});
