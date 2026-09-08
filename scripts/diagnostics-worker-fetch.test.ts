// FILE: diagnostics-worker-fetch.test.ts
// Purpose: Tests the Cloudflare diagnostics collector's routing, body-size
//          guard, per-batch validation, and durable rate-limit reservations.
//          The worker contract test already pins the sanitizer and the worker
//          validator; this file checks the request handler that wraps it.
// Layer: Scripts (cross-boundary integration test)

import { describe, expect, it } from "vitest";

import worker, {
  type D1BatchResult,
  type D1Database,
  type D1PreparedStatement,
  type D1RunResult,
  type D1Value,
  type Env,
} from "../infrastructure/diagnostics-worker/src/index";

interface CapturingEnv extends Env {
  batches: D1PreparedStatement[][];
  counters: Map<string, number>;
}

function makeEnv(options?: { counters?: Map<string, number>; failQuota?: boolean }): CapturingEnv {
  const batches: D1PreparedStatement[][] = [];
  const counters = options?.counters ?? new Map<string, number>();
  const db: D1Database = {
    prepare: (sql: string) => {
      let bound: D1Value[] = [];
      const statement: D1PreparedStatement = {
        bind: (...values: D1Value[]) => {
          bound = values;
          return statement;
        },
        first: async <T>(): Promise<T | null> => {
          if (sql.startsWith("SELECT event_count FROM rate_counters")) {
            const count = counters.get(`${String(bound[0])}|${String(bound[1])}`);
            // SAFETY: this fake only serves the one row shape the counter
            // select produces; the caller's T is the row type it asked for.
            return (count === undefined ? null : { event_count: count }) as T | null;
          }
          return null;
        },
        run: async (): Promise<D1RunResult> => {
          if (options?.failQuota === true) throw new Error("no such table: rate_counters");
          if (sql.startsWith("INSERT INTO rate_counters")) {
            const key = `${String(bound[0])}|${String(bound[1])}`;
            counters.set(key, (counters.get(key) ?? 0) + Number(bound[2]));
          }
          return {};
        },
      };
      return statement;
    },
    batch: async (statements) => {
      batches.push(statements);
      return statements.map((): D1BatchResult => ({}));
    },
  };
  return { DB: db, batches, counters };
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

function makeIngestRequest(
  body: { events: unknown[] },
  extraHeaders?: Record<string, string>,
): Request {
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

// A streamed body carries no Content-Length, exercising the byte-cap reader
// rather than the header fast path.
function makeStreamedIngestRequest(body: { events: unknown[] }): Request {
  const json = new TextEncoder().encode(JSON.stringify(body));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(json);
      controller.close();
    },
  });
  return new Request("https://example.com/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    // Node's Request requires duplex for stream bodies; the Cloudflare
    // runtime ignores the hint.
    duplex: "half",
  });
}

describe("diagnostics worker fetch handler", () => {
  it("returns health on /health", async () => {
    const response = await worker.fetch(new Request("https://example.com/health"), makeEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("does not expose /v1/stats", async () => {
    const response = await worker.fetch(new Request("https://example.com/v1/stats"), makeEnv());
    expect(response.status).toBe(404);
  });

  it("rejects bodies larger than 1 MiB by Content-Length", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/events", {
        method: "POST",
        headers: { "content-length": String(1024 * 1024 + 1) },
        body: "",
      }),
      makeEnv(),
    );
    expect(response.status).toBe(413);
  });

  it("rejects a streamed body over 1 MiB with no Content-Length", async () => {
    const oversized = new Uint8Array(1024 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const response = await worker.fetch(
      new Request("https://example.com/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      }),
      makeEnv(),
    );
    expect(response.status).toBe(413);
  });

  it("accepts a valid streamed batch", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      makeStreamedIngestRequest({ events: [workerEvent("app_start")] }),
      env,
    );
    expect(response.status).toBe(202);
  });

  it("rejects an empty or malformed body", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a batch with an invalid event", async () => {
    const response = await worker.fetch(
      makeIngestRequest({
        events: [{ ...workerEvent("session_started"), provider: undefined }],
      }),
      makeEnv(),
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
      makeEnv(),
    );
    expect(response.status).toBe(422);
  });

  it("rejects an oversized batch", async () => {
    const events = Array.from({ length: 51 }, () => workerEvent("test"));
    const response = await worker.fetch(makeIngestRequest({ events }), makeEnv());
    expect(response.status).toBe(413);
  });

  it("accepts a valid batch and writes it to D1", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      makeIngestRequest({ events: [workerEvent("app_start")] }),
      env,
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: 1 });
    expect(env.batches).toHaveLength(1);
    expect(env.batches[0]).toHaveLength(1);
  });

  it("reserves the per-install hourly quota before writing", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      makeIngestRequest({ events: [workerEvent("app_start")] }),
      env,
    );
    expect(response.status).toBe(202);
    const installKeys = [...env.counters.keys()].filter((key) => key.startsWith("install:"));
    expect(installKeys).toHaveLength(1);
    expect(env.counters.get(installKeys[0] ?? "")).toBe(1);
    expect([...env.counters.keys()].some((key) => key.startsWith("global|"))).toBe(true);
  });

  it("rejects a batch once the per-install hourly quota is spent", async () => {
    const windowKey = `install:0f1a2b3c-0000-4000-8000-000000000001`;
    const counters = new Map<string, number>();
    const env = makeEnv({ counters });
    const first = await worker.fetch(
      makeIngestRequest({ events: [workerEvent("app_start")] }),
      env,
    );
    expect(first.status).toBe(202);
    // The fixed hour window is the second half of the counter key; reuse it so
    // the seeded total lands in the same window the worker will write to.
    const windowStart = [...env.counters.keys()]
      .find((key) => key.startsWith(`${windowKey}|`))
      ?.split("|")[1];
    counters.set(`${windowKey}|${String(windowStart)}`, 600);
    const response = await worker.fetch(
      makeIngestRequest({ events: [workerEvent("app_start")] }),
      env,
    );
    expect(response.status).toBe(429);
  });

  it("rejects when the global hourly quota is spent", async () => {
    const env = makeEnv();
    const first = await worker.fetch(
      makeIngestRequest({ events: [workerEvent("app_start")] }),
      env,
    );
    expect(first.status).toBe(202);
    const globalKey = [...env.counters.keys()].find((key) => key.startsWith("global|"));
    env.counters.set(globalKey ?? "global|", 20_000);
    const response = await worker.fetch(
      makeIngestRequest({ events: [workerEvent("app_start")] }),
      env,
    );
    expect(response.status).toBe(429);
  });

  it("fails closed with 503 when the quota store is unavailable", async () => {
    const response = await worker.fetch(
      makeIngestRequest({ events: [workerEvent("app_start")] }),
      makeEnv({ failQuota: true }),
    );
    expect(response.status).toBe(503);
  });

  it("scheduled deletes old events and stale rate counters", async () => {
    const env = makeEnv();
    await worker.scheduled({ scheduledAt: Date.now() }, env);
    expect(env.batches).toHaveLength(1);
    expect(env.batches[0]).toHaveLength(2);
  });
});
