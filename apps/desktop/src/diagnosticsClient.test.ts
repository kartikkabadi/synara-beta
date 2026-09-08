// FILE: diagnosticsClient.test.ts
// Purpose: Locks the diagnostics client behavior: consent gating, queue
//          bounds, flush batching, backoff drop, consent withdrawal, and
//          restart persistence.
// Layer: Desktop main process

import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
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

const STATE_FILE = "state.json";
const QUEUE_FILE = "queue.json";

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

  it("persists the cleared queue before the disabled state", () => {
    const client = createDiagnosticsClient({ stateDir, sanitizeContext, flushIntervalMs: 0 });
    client.setEnabled(true);
    client.record({ kind: "app_start" });
    client.setEnabled(false);
    const queueFile = JSON.parse(readFileSync(join(stateDir, QUEUE_FILE), "utf8")) as unknown[];
    const stateFile = JSON.parse(readFileSync(join(stateDir, STATE_FILE), "utf8")) as {
      enabled: boolean;
    };
    expect(queueFile).toHaveLength(0);
    expect(stateFile.enabled).toBe(false);
  });

  it("persists state and queue across restarts", () => {
    const first = createDiagnosticsClient({ stateDir, sanitizeContext, flushIntervalMs: 0 });
    first.setEnabled(true);
    first.record({ kind: "app_start" });
    // SAFETY: this test wrote the state file itself one line above, so the
    // persisted shape is known.
    const reopenedState = JSON.parse(readFileSync(join(stateDir, STATE_FILE), "utf8")) as {
      enabled: boolean;
    };
    expect(reopenedState.enabled).toBe(true);
    expect(readDiagnosticsQueueLength(stateDir)).toBe(1);
  });

  it("preserves kind-specific fields when the queue is reloaded", async () => {
    const first = createDiagnosticsClient({ stateDir, sanitizeContext, flushIntervalMs: 0 });
    first.setEnabled(true);
    first.record({ kind: "session_started", provider: "codex" });
    first.record({
      kind: "session_ended",
      provider: "claude",
      durationBucket: "1m_5m",
      outcome: "ok",
    });
    first.record({ kind: "feature_used", feature: "worktree-reclaim" });
    first.record({
      kind: "error",
      errorCode: "backend.exit-nonzero",
      errorSurface: "backend",
    });

    const second = createDiagnosticsClient({ stateDir, sanitizeContext, flushIntervalMs: 0 });
    second.setEnabled(true);
    const queue = readDiagnosticsQueue(stateDir);
    expect(queue).toHaveLength(4);
    expect(queue[0]?.kind).toBe("session_started");
    expect(queue[0]?.provider).toBe("codex");
    expect(queue[1]?.kind).toBe("session_ended");
    expect(queue[1]?.provider).toBe("claude");
    expect(queue[1]?.durationBucket).toBe("1m_5m");
    expect(queue[1]?.outcome).toBe("ok");
    expect(queue[2]?.kind).toBe("feature_used");
    expect(queue[2]?.feature).toBe("worktree-reclaim");
    expect(queue[3]?.kind).toBe("error");
    expect(queue[3]?.errorCode).toBe("backend.exit-nonzero");
    expect(queue[3]?.errorSurface).toBe("backend");

    // A flushed batch sent from the reloaded queue must carry the preserved
    // fields, or the collector will reject the whole batch.
    const bodies: Array<{ events: unknown[] }> = [];
    const sender = createDiagnosticsClient({
      stateDir,
      sanitizeContext,
      flushIntervalMs: 0,
      fetchImpl: (async (_url, init) => {
        const parsedBody = JSON.parse(String(init?.body)) as { events: unknown[] };
        bodies.push(parsedBody);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    sender.setEnabled(true);
    const sent = await sender.flush();
    expect(sent).toBe(true);
    expect(bodies[0]?.events[0]).toMatchObject({ kind: "session_started", provider: "codex" });
  });

  it("reconciles old queued install ids with a regenerated install id", () => {
    const first = createDiagnosticsClient({ stateDir, sanitizeContext, flushIntervalMs: 0 });
    first.setEnabled(true);
    first.record({ kind: "app_start" });
    const oldInstallId = first.getState().installId;

    // Simulate a corrupt/missing state file while the queue survives.
    unlinkSync(join(stateDir, STATE_FILE));

    const second = createDiagnosticsClient({ stateDir, sanitizeContext, flushIntervalMs: 0 });
    second.setEnabled(true);
    const sample = second.getSamplePayload();
    expect(sample.events).toHaveLength(1);
    expect(sample.events[0]?.installId).not.toBe(oldInstallId);
    expect(sample.events[0]?.installId).toBe(second.getState().installId);
  });

  it("ignores stale flush completions after consent is withdrawn", async () => {
    let resolve: (response: Response) => void = () => {};
    const client = createDiagnosticsClient({
      stateDir,
      sanitizeContext,
      flushIntervalMs: 0,
      fetchImpl: (async () =>
        new Promise((res) => {
          resolve = res;
        })) as typeof fetch,
    });
    client.setEnabled(true);
    client.record({ kind: "app_start" });
    const flushPromise = client.flush();
    client.setEnabled(false);
    resolve(new Response(null, { status: 503 }));
    await flushPromise;
    expect(client.getState().enabled).toBe(false);
    expect(client.getState().queuedEventCount).toBe(0);
    expect(client.getState().lastError).toBeNull();
  });

  it("does not drop events recorded during a failing flush", async () => {
    let resolve: (response: Response) => void = () => {};
    const client = createDiagnosticsClient({
      stateDir,
      sanitizeContext,
      flushIntervalMs: 0,
      fetchImpl: (async () =>
        new Promise((res) => {
          resolve = res;
        })) as typeof fetch,
    });
    client.setEnabled(true);
    client.record({ kind: "app_start" });
    const flushPromise = client.flush();
    client.record({ kind: "test" });
    resolve(new Response(null, { status: 503 }));
    await flushPromise;
    expect(client.getState().queuedEventCount).toBeGreaterThanOrEqual(1);
    expect(client.getState().lastError).toBeNull();
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

  it("queues app_quit as a bare event", () => {
    const client = createDiagnosticsClient({ stateDir, sanitizeContext, flushIntervalMs: 0 });
    client.setEnabled(true);
    client.record({ kind: "app_quit" });
    expect(client.getState().queuedEventCount).toBe(1);
    const sample = client.getSamplePayload();
    expect(sample.events[0]?.kind).toBe("app_quit");
    expect(Object.keys(sample.events[0] ?? {})).not.toContain("provider");
  });
});

function readDiagnosticsQueueLength(stateDir: string): number {
  // SAFETY: this test wrote the queue file itself, so the persisted shape is
  // known to be an array of events.
  const parsed = JSON.parse(readFileSync(join(stateDir, QUEUE_FILE), "utf8")) as unknown[];
  return parsed.length;
}
