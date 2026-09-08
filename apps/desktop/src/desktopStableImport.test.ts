// FILE: desktopStableImport.test.ts
// Purpose: Locks the stable-import gate: offered only on a fresh beta with
//          stable data present, decided exactly once, artifacts copied intact.
// Layer: Desktop main-process utility

import * as FS from "node:fs";
import * as Path from "node:path";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  performStableImport,
  resolveStableImportCandidate,
  writeDeclinedMarker,
  STABLE_IMPORT_MARKER_FILE,
} from "./desktopStableImport";

function makeHomes() {
  const root = mkdtempSync(Path.join(tmpdir(), "stable-import-"));
  const stable = Path.join(root, ".synara");
  const beta = Path.join(root, ".synara-beta");
  FS.mkdirSync(Path.join(stable, "userdata"), { recursive: true });
  FS.mkdirSync(Path.join(beta, "userdata"), { recursive: true });
  return { stable, beta };
}

describe("resolveStableImportCandidate", () => {
  it("offers the import on a fresh beta with stable data", () => {
    const { stable, beta } = makeHomes();
    writeFileSync(Path.join(stable, "userdata", "state.sqlite"), "db");
    const candidate = resolveStableImportCandidate({
      betaBaseDir: beta,
      stableBaseDir: stable,
      isDevelopment: false,
    });
    expect(candidate.available).toBe(true);
    expect(candidate.reason).toBe("candidate");
  });

  it("does not offer when stable has no database", () => {
    const { stable, beta } = makeHomes();
    const candidate = resolveStableImportCandidate({
      betaBaseDir: beta,
      stableBaseDir: stable,
      isDevelopment: false,
    });
    expect(candidate.available).toBe(false);
    expect(candidate.reason).toBe("no-stable-data");
  });

  it("does not offer when the beta database already exists", () => {
    const { stable, beta } = makeHomes();
    writeFileSync(Path.join(stable, "userdata", "state.sqlite"), "stable");
    writeFileSync(Path.join(beta, "userdata", "state.sqlite"), "beta");
    const candidate = resolveStableImportCandidate({
      betaBaseDir: beta,
      stableBaseDir: stable,
      isDevelopment: false,
    });
    expect(candidate.available).toBe(false);
    expect(candidate.reason).toBe("beta-already-initialized");
  });

  it("never re-offers after a decision marker exists", () => {
    const { stable, beta } = makeHomes();
    writeFileSync(Path.join(stable, "userdata", "state.sqlite"), "stable");
    const migrationsDir = Path.join(beta, "userdata", "migrations");
    FS.mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      Path.join(migrationsDir, STABLE_IMPORT_MARKER_FILE),
      JSON.stringify({
        status: "declined",
        sourceStateDir: stable,
        targetStateDir: beta,
        importedArtifacts: [],
        importedAt: "2026-09-08T00:00:00Z",
      }),
    );
    const candidate = resolveStableImportCandidate({
      betaBaseDir: beta,
      stableBaseDir: stable,
      isDevelopment: false,
    });
    expect(candidate.available).toBe(false);
    expect(candidate.reason).toBe("already-decided");
  });
});

describe("performStableImport", () => {
  it("copies the database file set, settings, keybindings, secrets, and environment id", () => {
    const { stable, beta } = makeHomes();
    const stableState = Path.join(stable, "userdata");
    writeFileSync(Path.join(stableState, "state.sqlite"), "db-bytes");
    writeFileSync(Path.join(stableState, "state.sqlite-wal"), "wal-bytes");
    writeFileSync(Path.join(stableState, "settings.json"), "{}");
    writeFileSync(Path.join(stableState, "keybindings.json"), "[]");
    FS.mkdirSync(Path.join(stableState, "secrets"), { recursive: true });
    writeFileSync(Path.join(stableState, "secrets", "token"), "s");
    writeFileSync(Path.join(stableState, "environment-id"), "env-1");

    const candidate = resolveStableImportCandidate({
      betaBaseDir: beta,
      stableBaseDir: stable,
      isDevelopment: false,
    });
    const result = performStableImport({
      candidate,
      markerPath: Path.join(candidate.targetStateDir, "migrations", STABLE_IMPORT_MARKER_FILE),
      now: () => new Date("2026-09-08T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    const betaState = Path.join(beta, "userdata");
    expect(FS.readFileSync(Path.join(betaState, "state.sqlite"), "utf8")).toBe("db-bytes");
    expect(FS.readFileSync(Path.join(betaState, "state.sqlite-wal"), "utf8")).toBe("wal-bytes");
    expect(FS.readFileSync(Path.join(betaState, "settings.json"), "utf8")).toBe("{}");
    expect(FS.readFileSync(Path.join(betaState, "keybindings.json"), "utf8")).toBe("[]");
    expect(FS.readFileSync(Path.join(betaState, "secrets", "token"), "utf8")).toBe("s");
    expect(FS.readFileSync(Path.join(betaState, "environment-id"), "utf8")).toBe("env-1");
    expect(result.importedArtifacts).toEqual([
      "database",
      "settings",
      "keybindings",
      "secrets",
      "environmentId",
    ]);

    // SAFETY: performStableImport wrote this marker during the call above.
    const marker = JSON.parse(
      FS.readFileSync(Path.join(betaState, "migrations", STABLE_IMPORT_MARKER_FILE), "utf8"),
    ) as { status: string };
    expect(marker.status).toBe("completed");
  });

  it("leaves the stable home untouched", () => {
    const { stable, beta } = makeHomes();
    const stableState = Path.join(stable, "userdata");
    writeFileSync(Path.join(stableState, "state.sqlite"), "stable-db");
    const before = FS.readFileSync(Path.join(stableState, "state.sqlite"), "utf8");

    const candidate = resolveStableImportCandidate({
      betaBaseDir: beta,
      stableBaseDir: stable,
      isDevelopment: false,
    });
    performStableImport({
      candidate,
      markerPath: Path.join(candidate.targetStateDir, "migrations", STABLE_IMPORT_MARKER_FILE),
      now: () => new Date(),
    });

    expect(FS.readFileSync(Path.join(stableState, "state.sqlite"), "utf8")).toBe(before);
  });

  it("writes a declined marker without copying when the user declines", () => {
    const { stable, beta } = makeHomes();
    writeFileSync(Path.join(stable, "userdata", "state.sqlite"), "stable-db");
    const candidate = resolveStableImportCandidate({
      betaBaseDir: beta,
      stableBaseDir: stable,
      isDevelopment: false,
    });
    const markerPath = Path.join(candidate.targetStateDir, "migrations", STABLE_IMPORT_MARKER_FILE);
    writeDeclinedMarker(markerPath, candidate.sourceStateDir, candidate.targetStateDir);
    // SAFETY: writeDeclinedMarker wrote this exact file one line above.
    const marker = JSON.parse(FS.readFileSync(markerPath, "utf8")) as { status: string };
    expect(marker.status).toBe("declined");
    expect(FS.existsSync(Path.join(beta, "userdata", "state.sqlite"))).toBe(false);
  });
});
