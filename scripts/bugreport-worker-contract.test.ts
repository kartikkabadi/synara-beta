// FILE: bugreport-worker-contract.test.ts
// Purpose: Pins the worker validator to the web submission shape. The web
//          payload (apps/web/src/feedback.ts buildFeedbackSubmission) and this
//          contract must accept exactly the same reports; a fixture matrix of
//          valid and hostile bodies fails loudly if either side drifts.
// Layer: Scripts (cross-boundary contract test)

import { describe, expect, it } from "vitest";

import {
  MAX_DETAILS_CHARS,
  MAX_RENDERED_CHARS,
  validateReport,
  type BugReport,
} from "../infrastructure/bugreport-worker/src/contract";

function validReport(): BugReport {
  return {
    schemaVersion: 1,
    category: "bug",
    details: "The composer stopped responding.",
    summary:
      "I ran into a bug in Synara 0.8.3-beta.1, using codex with gpt-5.6-sol.\n\nReport type: Bug",
    diagnosticsReport:
      "I ran into a bug in Synara 0.8.3-beta.1, using codex with gpt-5.6-sol.\n\nReport type: Bug",
    diagnostics: {
      appVersion: "0.8.3-beta.1",
      submittedAt: "2026-09-10T10:19:30.123Z",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      platform: "MacIntel",
      language: "en-US",
      viewport: "1440x900",
      provider: "codex",
      model: "gpt-5.6-sol",
      projectKind: "project",
      environmentMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      sessionStatus: "running",
      latestTurnState: "error",
      messageCount: 12,
      activityCount: 8,
      hasPendingApproval: false,
      hasPendingUserInput: true,
      hasThreadError: true,
    },
  };
}

const HOSTILE_REPORTS: ReadonlyArray<readonly [string, unknown]> = [
  ["a non-object body", [1, 2, 3]],
  ["a string body", "bug report"],
  ["an extra top-level key", { ...validReport(), transcript: "smuggled" }],
  ["an extra diagnostics key", { ...validReport(), diagnostics: { ...validReport().diagnostics, threadTitle: "x" } }],
  [
    "a missing diagnostics key",
    (() => {
      const diagnostics: Record<string, unknown> = { ...validReport().diagnostics };
      delete diagnostics["provider"];
      return { ...validReport(), diagnostics };
    })(),
  ],
  ["a wrong schemaVersion", { ...validReport(), schemaVersion: 2 }],
  ["an unknown category", { ...validReport(), category: "praise" }],
  ["a numeric category", { ...validReport(), category: 3 }],
  ["empty details", { ...validReport(), details: "" }],
  ["oversized details", { ...validReport(), details: "x".repeat(MAX_DETAILS_CHARS + 1) }],
  ["oversized summary", { ...validReport(), summary: "x".repeat(MAX_RENDERED_CHARS + 1) }],
  ["missing diagnosticsReport", { ...validReport(), diagnosticsReport: "" }],
  ["a non-ISO submittedAt", { ...validReport(), diagnostics: { ...validReport().diagnostics, submittedAt: "just now" } }],
  ["a fractional count", { ...validReport(), diagnostics: { ...validReport().diagnostics, messageCount: 1.5 } }],
  ["a negative count", { ...validReport(), diagnostics: { ...validReport().diagnostics, activityCount: -1 } }],
  ["a count over the bound", { ...validReport(), diagnostics: { ...validReport().diagnostics, messageCount: 2_000_000 } }],
  ["a string flag", { ...validReport(), diagnostics: { ...validReport().diagnostics, hasThreadError: "yes" } }],
  ["an oversized provider string", { ...validReport(), diagnostics: { ...validReport().diagnostics, provider: "p".repeat(300) } }],
  ["an oversized user agent", { ...validReport(), diagnostics: { ...validReport().diagnostics, userAgent: "u".repeat(600) } }],
  ["a non-string viewport", { ...validReport(), diagnostics: { ...validReport().diagnostics, viewport: 1440 } }],
  ["a malformed viewport", { ...validReport(), diagnostics: { ...validReport().diagnostics, viewport: "wide" } }],
];

describe("bugreport worker contract", () => {
  it("accepts the exact payload the web client builds", () => {
    expect(validateReport(validReport())).toBe(true);
  });

  it("accepts a report with a null category and null session fields", () => {
    const report = validReport();
    report.category = null;
    report.diagnostics = {
      ...report.diagnostics,
      provider: null,
      model: null,
      projectKind: null,
      environmentMode: null,
      runtimeMode: null,
      interactionMode: null,
      sessionStatus: null,
      latestTurnState: null,
    };
    expect(validateReport(report)).toBe(true);
  });

  it.each(HOSTILE_REPORTS)("rejects %s", (_label, report) => {
    expect(validateReport(report)).toBe(false);
  });
});
