// FILE: diagnostics-worker-fetch.test.ts
// Purpose: Tests the Cloudflare diagnostics collector's routing, body-size
//          guard, and per-batch validation. The worker contract test already
//          pins the sanitizer and the worker validator; this file checks the
//          request handler that wraps the validator.
// Layer: Scripts (cross-boundary integration test)

import { describe, expect, it } from "vitest";

import worker from "../infrastructure/diagnostics-worker/src/index";

interface FakeEnv {
  DB: {
    prepare: () => {
      bind: () => {
        first: () => Promise<{ count: number }>;
      };
    };
    batch: (statements: unknown[]) => Promise<unknown[]>;
  };
  batches: unknown[][];
}

function makeEnv(): FakeEnv {
  const batches: unknown[][] = [];
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ count: 0 }),
        }),
      }),
      batch: async (statements: unknown[]) => {
        batches.push(statements);
        return statements.map(() => ({}));
      },
    },
    batches,
  };
}

function workerEvent(kind: string, installId?: string) {
  return {
    schemaVersion: 1,
    kind,
    eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01",
    occurredAt: "2026-09-08T10:19:00Z",
    appVersion: "0.8.3-beta.1",
    platform: "darwin",
    arch: "arm64",
    flavor: "beta",
    installId: installId ?? "0f1a2b3c-0000-4000-8000-000000000001",
  };
}

function makeIngestRequest(body: unknown, extraHeaders?: Record<string, string>): Request {
  const json = JSON.stringify(body);
  return new Request("https://example.com/v1/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(json).length),
      ...extraHeaders,
    },
    body: json,
  });
}

describe("diagnostics worker fetch handler", () => {
  it("returns health on /health", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/health"),
      makeEnv() as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("does not expose /v1/stats", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/stats"),
      makeEnv() as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(404);
  });

  it("rejects bodies larger than 1 MiB", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/events", {
        method: "POST",
        headers: { "content-length": String(1024 * 1024 + 1) },
        body: "",
      }),
      makeEnv() as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(413);
  });

  it("rejects an empty or malformed body", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
      makeEnv() as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(400);
  });

  it("rejects a batch with an invalid event", async () => {
    const response = await worker.fetch(
      makeIngestRequest({
        events: [{ ...workerEvent("session_started"), provider: undefined }],
      }),
      makeEnv() as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(422);
  });

  it("rejects a batch with mixed install ids", async () => {
    const response = await worker.fetch(
      makeIngestRequest({
        events: [
          workerEvent("app_start", "0f1a2b3c-0000-4000-8000-000000000001"),
          workerEvent("app_start", "1f2a3b4c-1111-4111-8111-111111111111"),
        ],
      }),
      makeEnv() as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(422);
  });

  it("rejects an oversized batch", async () => {
    const events = Array.from({ length: 51 }, () => workerEvent("test"));
    const response = await worker.fetch(
      makeIngestRequest({ events }),
      makeEnv() as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(413);
  });

  it("accepts a valid batch and writes it to D1", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      makeIngestRequest({ events: [workerEvent("app_start")] }),
      env as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: 1 });
    expect(env.batches).toHaveLength(1);
    expect(env.batches[0]).toHaveLength(1);
  });
});
