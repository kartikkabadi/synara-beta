// FILE: check-anti-slop.test.ts
// Purpose: Covers the anti-slop ratchet comparator: new violations fail, grown
//          counts fail, shrinkage reports burn-down, and stale entries are ignored.
// Layer: Local developer tooling

import { describe, expect, it } from "vitest";

import {
  countByRuleAndFile,
  compareAgainstBaseline,
  parseAntiSlopDiagnostics,
} from "./check-anti-slop.ts";

describe("parseAntiSlopDiagnostics", () => {
  it("keeps anti-slop diagnostics and drops every other plugin", () => {
    const report = {
      diagnostics: [
        { code: "anti-slop(no-runtime-typeof)", filename: "a.ts", severity: "error" },
        {
          code: "anti-slop-effect(no-service-constructor-imports)",
          filename: "b.ts",
          severity: "error",
        },
        {
          code: "eslint-plugin-unicorn(no-array-sort)",
          filename: "c.ts",
          severity: "warning",
        },
      ],
    };
    const parsed = parseAntiSlopDiagnostics(report);
    expect(parsed).toEqual([
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts" },
      { code: "anti-slop-effect(no-service-constructor-imports)", filename: "b.ts" },
    ]);
  });
});

describe("countByRuleAndFile", () => {
  it("counts diagnostics per rule and file", () => {
    const counts = countByRuleAndFile([
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts" },
      { code: "anti-slop(no-runtime-typeof)", filename: "a.ts" },
      { code: "anti-slop(no-runtime-typeof)", filename: "b.ts" },
      { code: "anti-slop(no-unknown-returns)", filename: "a.ts" },
    ]);
    expect(counts.get("anti-slop(no-runtime-typeof):a.ts")).toBe(2);
    expect(counts.get("anti-slop(no-runtime-typeof):b.ts")).toBe(1);
    expect(counts.get("anti-slop(no-unknown-returns):a.ts")).toBe(1);
    expect(counts.size).toBe(3);
  });
});

describe("compareAgainstBaseline", () => {
  it("passes when current matches the baseline exactly", () => {
    const baseline = { "anti-slop(no-runtime-typeof):a.ts": 2 };
    const current = new Map([["anti-slop(no-runtime-typeof):a.ts", 2]]);
    expect(compareAgainstBaseline(baseline, current)).toEqual({
      failures: [],
      burnDown: [],
    });
  });

  it("fails on a violation in a file the baseline never saw", () => {
    const baseline = { "anti-slop(no-runtime-typeof):a.ts": 1 };
    const current = new Map([
      ["anti-slop(no-runtime-typeof):a.ts", 1],
      ["anti-slop(no-unknown-returns):new-file.ts", 1],
    ]);
    const report = compareAgainstBaseline(baseline, current);
    expect(report.failures).toEqual(["anti-slop(no-unknown-returns):new-file.ts (new, 1)"]);
    expect(report.burnDown).toEqual([]);
  });

  it("fails when an existing entry grows", () => {
    const baseline = { "anti-slop(no-runtime-typeof):a.ts": 2 };
    const current = new Map([["anti-slop(no-runtime-typeof):a.ts", 3]]);
    const report = compareAgainstBaseline(baseline, current);
    expect(report.failures).toEqual(["anti-slop(no-runtime-typeof):a.ts (grew, 2 -> 3)"]);
  });

  it("reports burn-down without failing when an entry shrinks", () => {
    const baseline = { "anti-slop(no-runtime-typeof):a.ts": 5 };
    const current = new Map([["anti-slop(no-runtime-typeof):a.ts", 2]]);
    const report = compareAgainstBaseline(baseline, current);
    expect(report.failures).toEqual([]);
    expect(report.burnDown).toEqual(["anti-slop(no-runtime-typeof):a.ts (5 -> 2)"]);
  });

  it("reports burn-down for baseline entries that no longer occur", () => {
    const baseline = {
      "anti-slop(no-runtime-typeof):deleted.ts": 4,
      "anti-slop(no-runtime-typeof):a.ts": 1,
    };
    const current = new Map([["anti-slop(no-runtime-typeof):a.ts", 1]]);
    const report = compareAgainstBaseline(baseline, current);
    expect(report.failures).toEqual([]);
    expect(report.burnDown).toEqual(["anti-slop(no-runtime-typeof):deleted.ts (4 -> 0)"]);
  });

  it("keeps zero-count burn-down visible so allowances cannot be reused", () => {
    const baseline = { "anti-slop(no-runtime-typeof):a.ts": 2 };
    const current = new Map([["anti-slop(no-runtime-typeof):a.ts", 1]]);
    const report = compareAgainstBaseline(baseline, current);
    expect(report.burnDown).toEqual(["anti-slop(no-runtime-typeof):a.ts (2 -> 1)"]);
  });
});
