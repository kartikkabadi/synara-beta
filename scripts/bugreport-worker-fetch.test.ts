// FILE: bugreport-worker-fetch.test.ts
// Purpose: Tests the Cloudflare bug-report collector's auth gate, CORS,
//          body-size cap, payload re-validation, durable rate-limit
//          reservations, D1 writes, and the R2 attachment route. The contract
//          test pins the validator; this file checks the request handler that
//          wraps it.
// Layer: Scripts (cross-boundary integration test)

import { describe, expect, it } from "vitest";

import worker, {
  type D1Database,
  type D1PreparedStatement,
  type D1RunResult,
  type D1Value,
  type Env,
  type R2Bucket,
} from "../infrastructure/bugreport-worker/src/index";

const TOKEN = "test-secret";

interface CapturingEnv extends Env {
  inserts: D1Value[][];
  attachmentRows: D1Value[][];
  counters: Map<string, number>;
  reportIds: Set<string>;
  objects: Map<string, { bytes: number; contentType: string | undefined }>;
}

function makeEnv(options?: {
  token?: string | undefined;
  withBucket?: boolean;
  failQuota?: boolean;
  failInsert?: boolean;
  failR2?: boolean;
  counters?: Map<string, number>;
}): CapturingEnv {
  const inserts: D1Value[][] = [];
  const attachmentRows: D1Value[][] = [];
  const counters = options?.counters ?? new Map<string, number>();
  const reportIds = new Set<string>();
  const objects = new Map<string, { bytes: number; contentType: string | undefined }>();
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
          if (sql.startsWith("SELECT id FROM bug_reports")) {
            const id = String(bound[0]);
            return (reportIds.has(id) ? { id } : null) as T | null;
          }
          if (sql.startsWith("SELECT COUNT(*) AS n FROM bug_report_attachments")) {
            const n = attachmentRows.filter((row) => row[1] === bound[0]).length;
            return { n } as T;
          }
          return null;
        },
        run: async (): Promise<D1RunResult> => {
          if (options?.failQuota === true && sql.includes("rate_counters")) {
            throw new Error("no such table: rate_counters");
          }
          if (sql.startsWith("INSERT INTO rate_counters")) {
            const key = `${String(bound[0])}|${String(bound[1])}`;
            counters.set(key, (counters.get(key) ?? 0) + 1);
            return {};
          }
          if (sql.startsWith("UPDATE rate_counters")) {
            // The worker binds (scope, window_start) — no count arg.
            const key = `${String(bound[0])}|${String(bound[1])}`;
            counters.set(key, Math.max(0, (counters.get(key) ?? 0) - 1));
            return {};
          }
          if (options?.failInsert === true) throw new Error("d1 write failed");
          if (sql.startsWith("INSERT INTO bug_reports")) {
            inserts.push(bound);
            reportIds.add(String(bound[0]));
            return {};
          }
          if (sql.startsWith("INSERT INTO bug_report_attachments")) {
            attachmentRows.push(bound);
            return {};
          }
          return {};
        },
      };
      return statement;
    },
  };
  const bucket: R2Bucket | undefined =
    options?.withBucket === false
      ? undefined
      : {
          put: async (key, value, putOptions) => {
            if (options?.failR2 === true) throw new Error("r2 write failed");
            const bytes = value instanceof Uint8Array ? value.byteLength : -1;
            objects.set(key, { bytes, contentType: putOptions?.httpMetadata?.contentType });
            return { key };
          },
          delete: async (key) => {
            objects.delete(key);
          },
        };
  return {
    DB: db,
    // `token` in options is the unconfigured-secret case: `undefined ?? TOKEN`
    // would silently re-add it, so presence — not truthiness — decides.
    BUG_REPORT_TOKEN: options !== undefined && "token" in options ? options.token : TOKEN,
    BUG_REPORT_ATTACHMENTS: bucket,
    inserts,
    attachmentRows,
    counters,
    reportIds,
    objects,
  };
}

function reportBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    category: "bug",
    details: "The composer stopped responding.",
    summary: "I ran into a bug in Synara 0.8.3-beta.1, using codex with gpt-5.6-sol.",
    diagnosticsReport: "I ran into a bug in Synara 0.8.3-beta.1, using codex with gpt-5.6-sol.",
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
    ...overrides,
  };
}

function makeReportRequest(
  body: unknown,
  extraHeaders?: Record<string, string>,
): Request {
  const json = JSON.stringify(body);
  return new Request("https://example.com/v1/reports", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(json).length),
      authorization: `Bearer ${TOKEN}`,
      ...extraHeaders,
    },
    body: json,
  });
}

function makeAttachmentRequest(
  reportId: string,
  bytes: Uint8Array,
  contentType = "image/png",
  extraHeaders?: Record<string, string>,
): Request {
  return new Request(`https://example.com/v1/reports/${reportId}/attachment`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
      authorization: `Bearer ${TOKEN}`,
      ...extraHeaders,
    },
    body: bytes,
  });
}

async function seedReport(env: CapturingEnv): Promise<string> {
  const response = await worker.fetch(makeReportRequest(reportBody()), env);
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as { id: string };
  return id;
}

describe("bugreport worker fetch handler", () => {
  it("returns health on /health without auth", async () => {
    const response = await worker.fetch(new Request("https://example.com/health"), makeEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers the /v1/* preflight with CORS headers", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/reports", { method: "OPTIONS" }),
      makeEnv(),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("exposes no read API", async () => {
    for (const path of ["/v1/reports", "/v1/reports/abc", "/v1/stats"]) {
      const response = await worker.fetch(new Request(`https://example.com${path}`), makeEnv());
      expect(response.status).toBe(404);
    }
  });

  it("rejects POST /v1/reports without a bearer token", async () => {
    const env = makeEnv();
    const request = makeReportRequest(reportBody(), { authorization: "" });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
    expect(env.inserts).toHaveLength(0);
  });

  it("rejects a wrong bearer token", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      makeReportRequest(reportBody(), { authorization: "Bearer wrong" }),
      env,
    );
    expect(response.status).toBe(401);
    expect(env.inserts).toHaveLength(0);
  });

  it("fails closed when the worker secret is not configured", async () => {
    const env = makeEnv({ token: undefined });
    const response = await worker.fetch(makeReportRequest(reportBody()), env);
    expect(response.status).toBe(401);
    expect(env.inserts).toHaveLength(0);
  });

  it("rejects bodies larger than the cap by Content-Length", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/reports", {
        method: "POST",
        headers: {
          "content-length": String(256 * 1024 + 1),
          authorization: `Bearer ${TOKEN}`,
        },
        body: "",
      }),
      makeEnv(),
    );
    expect(response.status).toBe(413);
  });

  it("rejects a streamed body over the cap with no Content-Length", async () => {
    const oversized = new Uint8Array(256 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const response = await worker.fetch(
      new Request("https://example.com/v1/reports", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: stream,
        // Node's Request requires duplex for stream bodies; the Cloudflare
        // runtime ignores the hint.
        duplex: "half",
      }),
      makeEnv(),
    );
    expect(response.status).toBe(413);
  });

  it("rejects malformed JSON and non-object bodies", async () => {
    const env = makeEnv();
    const badJson = await worker.fetch(
      new Request("https://example.com/v1/reports", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: "not-json",
      }),
      env,
    );
    expect(badJson.status).toBe(400);
    const array = await worker.fetch(makeReportRequest([1, 2]), env);
    expect(array.status).toBe(400);
  });

  it("rejects a report that fails structural validation", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      makeReportRequest(reportBody({ category: "praise" })),
      env,
    );
    expect(response.status).toBe(422);
    expect(env.inserts).toHaveLength(0);
  });

  it("stores a valid report with a derived title and coarse os", async () => {
    const env = makeEnv();
    const response = await worker.fetch(makeReportRequest(reportBody()), env);
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(env.inserts).toHaveLength(1);
    const row = env.inserts[0] ?? [];
    expect(row[0]).toBe(id); // id
    expect(row[2]).toBe("0.8.3-beta.1"); // app_version
    expect(row[3]).toBe("macos"); // os derived from MacIntel
    expect(row[4]).toBeNull(); // arch: not observable from the web
    expect(row[5]).toBe("bug"); // category
    expect(String(row[6])).toContain("I ran into a bug in Synara 0.8.3-beta.1"); // title
    expect(row[7]).toBe("The composer stopped responding."); // details_sanitized
    expect(String(row[8])).toContain('"appVersion":"0.8.3-beta.1"'); // diagnostics_json
    expect(row[9]).toBe("new"); // status
  });

  it("reserves the hourly report quota before writing", async () => {
    const env = makeEnv();
    await worker.fetch(makeReportRequest(reportBody()), env);
    expect([...env.counters.keys()].some((key) => key.startsWith("reports|"))).toBe(true);
  });

  it("rejects once the hourly report quota is spent", async () => {
    const env = makeEnv();
    await worker.fetch(makeReportRequest(reportBody()), env);
    const scopeKey = [...env.counters.keys()].find((key) => key.startsWith("reports|"));
    env.counters.set(scopeKey ?? "reports|", 240);
    const response = await worker.fetch(makeReportRequest(reportBody()), env);
    expect(response.status).toBe(429);
    // The rejected report hands its reservation back.
    expect(env.counters.get(scopeKey ?? "")).toBe(240);
  });

  it("hands the reservation back when the insert fails", async () => {
    const env = makeEnv({ failInsert: true });
    const response = await worker.fetch(makeReportRequest(reportBody()), env);
    expect(response.status).toBe(503);
    const scopeKey = [...env.counters.keys()].find((key) => key.startsWith("reports|"));
    expect(env.counters.get(scopeKey ?? "")).toBe(0);
  });

  it("returns 503 when the quota store is missing", async () => {
    const env = makeEnv({ failQuota: true });
    const response = await worker.fetch(makeReportRequest(reportBody()), env);
    expect(response.status).toBe(503);
    expect(env.inserts).toHaveLength(0);
  });

  it("rejects attachments without auth", async () => {
    const env = makeEnv();
    const id = await seedReport(env);
    const response = await worker.fetch(
      makeAttachmentRequest(id, new Uint8Array(16), "image/png", { authorization: "" }),
      env,
    );
    expect(response.status).toBe(401);
    expect(env.objects.size).toBe(0);
  });

  it("returns 503 for attachments when the R2 binding is absent", async () => {
    const env = makeEnv({ withBucket: false });
    const id = await seedReport(env);
    const response = await worker.fetch(
      makeAttachmentRequest(id, new Uint8Array(16)),
      env,
    );
    expect(response.status).toBe(503);
  });

  it("rejects attachments for an unknown report", async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      makeAttachmentRequest("0f1a2b3c-0000-4000-8000-000000000099", new Uint8Array(16)),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("rejects non-image attachment content types", async () => {
    const env = makeEnv();
    const id = await seedReport(env);
    const response = await worker.fetch(
      makeAttachmentRequest(id, new Uint8Array(16), "text/html"),
      env,
    );
    expect(response.status).toBe(415);
  });

  it("rejects attachments over 5 MB", async () => {
    const env = makeEnv();
    const id = await seedReport(env);
    const response = await worker.fetch(
      new Request(`https://example.com/v1/reports/${id}/attachment`, {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "content-length": String(5 * 1024 * 1024 + 1),
          authorization: `Bearer ${TOKEN}`,
        },
        body: "",
      }),
      env,
    );
    expect(response.status).toBe(413);
  });

  it("stores an attachment in R2 and records the row", async () => {
    const env = makeEnv();
    const id = await seedReport(env);
    const response = await worker.fetch(
      makeAttachmentRequest(id, new Uint8Array(1024)),
      env,
    );
    expect(response.status).toBe(201);
    const { key } = (await response.json()) as { key: string };
    expect(key.startsWith(`reports/${id}/`)).toBe(true);
    expect(env.objects.get(key)?.bytes).toBe(1024);
    expect(env.objects.get(key)?.contentType).toBe("image/png");
    expect(env.attachmentRows).toHaveLength(1);
    expect(env.attachmentRows[0]?.[1]).toBe(id);
    expect(env.attachmentRows[0]?.[2]).toBe(key);
    expect(env.attachmentRows[0]?.[4]).toBe(1024);
  });

  it("caps attachments at five per report", async () => {
    const env = makeEnv();
    const id = await seedReport(env);
    for (let i = 0; i < 5; i += 1) {
      const response = await worker.fetch(
        makeAttachmentRequest(id, new Uint8Array(8)),
        env,
      );
      expect(response.status).toBe(201);
    }
    const sixth = await worker.fetch(makeAttachmentRequest(id, new Uint8Array(8)), env);
    expect(sixth.status).toBe(429);
  });

  it("deletes the R2 object when the attachment row insert fails", async () => {
    const env = makeEnv();
    const id = await seedReport(env);
    envWithInsertFailure(env);
    const response = await worker.fetch(
      makeAttachmentRequest(id, new Uint8Array(16)),
      env,
    );
    expect(response.status).toBe(503);
    expect(env.objects.size).toBe(0);
    const scopeKey = [...env.counters.keys()].find((key) => key.startsWith("attachments|"));
    expect(env.counters.get(scopeKey ?? "")).toBe(0);
  });
});

// Flips the fake to fail only the attachment-row insert (the report insert
// already landed during seeding, so a blanket failInsert would break setup).
function envWithInsertFailure(env: CapturingEnv): void {
  const original = env.DB.prepare;
  env.DB.prepare = (sql: string) => {
    const inner = original(sql);
    const wrapper: D1PreparedStatement = {
      bind: (...values: D1Value[]) => {
        inner.bind(...values);
        return wrapper;
      },
      first: <T>() => inner.first<T>(),
      run: async () => {
        if (sql.startsWith("INSERT INTO bug_report_attachments")) {
          throw new Error("d1 write failed");
        }
        return inner.run();
      },
    };
    return wrapper;
  };
}
