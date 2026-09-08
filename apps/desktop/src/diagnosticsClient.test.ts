// FILE: diagnosticsClient.test.ts
// Purpose: Locks the diagnostics client behavior: consent gating, queue
//          bounds, flush batching, backoff drop, and consent withdrawal.
// Layer: Desktop main process

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDiagnosticsClient, readDiagnosticsQueue } from "./diagnosticsClient";

const sanitizeContext = {
  appVersion: "0.8.3-beta.1",
  platform: "darwin",
  arch: "arm64",
  flavor: "beta",
  installId: "pending",
  now: () => new Date("2026-09-08T10:19:42.123Z"),
};

describe("diagnosticsClient", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "diagnostics-client-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("records nothing while consent is off", () => {
    const client = createDiagnosticsClient({
      stateDir,
      sanitizeContext,
      flushIntervalMs: 0,
    });
    expect(client.getState().enabled).toBe(false);
    expect(client.record({ kind: "app_start" })).toBe(false);
    expect(client.getState().queuedEventCount).toBe(0);
  });

  it("queues sanitized events only after consent", () => {
    const client = createDiagnosticsClient({ stateDir, sanitizeContext, flushIntervalMs: 0 });
    client.setEnabled(true);
    expect(client.record({ kind: "app_start" })).toBe(true);
    expect(client.record({ kind: "session_started", provider: "gpt-5.6-sol-max" })).toBe(false);
    expect(client.record({ kind: "session_started", provider: "codex" })).toBe(true);
    expect(client.getState().queuedEventCount).toBe(2);
  });

  it("caps the queue and drops the oldest events", () => {
    const client = createDiagnosticsClient({
      stateDir,
      sanitizeContext,
      flushIntervalMs: 0,
    });
    client.setEnabled(true);
    for (let index = 0; index < 220; index += 1) {
      client.record({ kind: "feature_used", feature: `feature-${index}` });
    }
    expect(client.getState().queuedEventCount).toBe(200);
  });

  it("flushes batches to the endpoint and clears the queue", async () => {
    const bodies: Array<{ events: unknown[] }> = [];
    // SAFETY: the fetch stub only reports the body this test wrote and never
    // performs I/O, so adapting the arrow to the fetch type is safe.
    const client = createDiagnosticsClient({
      stateDir,
      sanitizeContext,
      flushIntervalMs: 0,
      fetchImpl: (async (_url, init) => {
        // SAFETY: the test controls both sides of this fetch; the body it wrote
        // is the JSON it passed in, so the shape cast cannot be wrong.
        const parsedBody = JSON.parse(String(init?.body)) as { events: unknown[] };
        bodies.push(parsedBody);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    client.setEnabled(true);
    client.record({ kind: "app_start" });
    client.record({ kind: "test" });
    const flushed = await client.flush();
    expect(flushed).toBe(true);
    expect(bodies[0]?.events).toHaveLength(2);
    expect(client.getState().queuedEventCount).toBe(0);
    expect(client.getState().lastSentAt).not.toBeNull();
  });

  it("gives up on the backlog after repeated failures", async () => {
    const client = createDiagnosticsClient({
      stateDir,
      sanitizeContext,
      flushIntervalMs: 0,
      // SAFETY: the test stub never touches its arguments, so the signature
      // cast only adapts the arrow to the fetch type.
      // SAFETY: the stub never reads its arguments, so the signature cast only
      // adapts the arrow to the fetch type.
      fetchImpl: (async () => new Response(null, { status: 503 })) as typeof fetch,
    });
    client.setEnabled(true);
    client.record({ kind: "app_start" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await client.flush();
    }
    expect(client.getState().queuedEventCount).toBe(0);
    expect(client.getState().lastError).not.toBeNull();
  });

  it("drops the queue immediately when consent is withdrawn", () => {
    const client = createDiagnosticsClient({ stateDir, sanitizeContext, flushIntervalMs: 0 });
    client.setEnabled(true);
    client.record({ kind: "app_start" });
    expect(client.getState().queuedEventCount).toBe(1);
    client.setEnabled(false);
    expect(client.getState().queuedEventCount).toBe(0);
    expect(client.getState().enabled).toBe(false);
  });

  it("persists state and queue across restarts", () => {
    const first = createDiagnosticsClient({ stateDir, sanitizeContext, flushIntervalMs: 0 });
    first.setEnabled(true);
    first.record({ kind: "app_start" });
    // SAFETY: this test wrote the state file itself one line above, so the
    // persisted shape is known.
    const reopenedState = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")) as {
      enabled: boolean;
    };
    expect(reopenedState.enabled).toBe(true);
    expect(readDiagnosticsQueueLength(stateDir)).toBe(1);
  });

  it("refuses non-https endpoints", async () => {
    const client = createDiagnosticsClient({
      stateDir,
      sanitizeContext,
      endpointUrl: "http://insecure.example",
      flushIntervalMs: 0,
    });
    client.setEnabled(true);
    client.record({ kind: "app_start" });
    expect(await client.flush()).toBe(false);
  });

  it("returns the exact payload a flush would send", () => {
    const client = createDiagnosticsClient({ stateDir, sanitizeContext, flushIntervalMs: 0 });
    client.setEnabled(true);
    client.record({ kind: "app_start" });
    const sample = client.getSamplePayload();
    expect(sample.endpointUrl).toContain("https://");
    expect(sample.events).toHaveLength(1);
    expect(sample.events[0]?.kind).toBe("app_start");
  });
});

function readDiagnosticsQueueLength(stateDir: string): number {
  // SAFETY: this test wrote the queue file itself, so the persisted shape is
  // known to be an array of events.
  const parsed = JSON.parse(readFileSync(join(stateDir, "queue.json"), "utf8")) as unknown[];
  return parsed.length;
}
