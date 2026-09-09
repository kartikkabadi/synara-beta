// FILE: diagnosticsClient.ts
// Purpose: Opt-in diagnostics sender for the desktop main process. Persists
//          consent and a bounded queue, flushes batches to the Cloudflare
//          collector, and never sends anything while consent is off.
// Layer: Desktop main process
//
// Design invariants:
// - Every event passes through sanitizeDiagnosticsEvent before queueing.
// - The queue is bounded; the oldest events are dropped when full.
// - Flush failures back off and eventually drop the queue instead of retrying
//   forever; diagnostics must never harm the app.
// - Nothing is sent when `enabled` is false, when the endpoint is not https,
//   or when SYNARA_DIAGNOSTICS_DISABLED is set.

import * as FS from "node:fs";
import * as Path from "node:path";

import { Schema } from "effect";

import {
  type DiagnosticsEvent,
  type DiagnosticsEventInput,
  type DiagnosticsSamplePayload,
  type DiagnosticsState,
} from "@synara/contracts";

import {
  SanitizedEventSchema,
  sanitizeDiagnosticsEvent,
  type SanitizeContext,
} from "./diagnosticsSanitizer";

const STATE_FILE = "state.json";
const QUEUE_FILE = "queue.json";
const MAX_QUEUED_EVENTS = 200;
const FLUSH_BATCH_LIMIT = 50;
const FLUSH_INTERVAL_MS = 15 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 5;

export const DEFAULT_DIAGNOSTICS_ENDPOINT_URL =
  "https://synara-beta-diagnostics.1kartikkabadi1.workers.dev";

export interface DiagnosticsStateFile {
  readonly version: 1;
  readonly enabled: boolean;
  readonly installId: string;
}

export interface DiagnosticsClient {
  getState: () => DiagnosticsState;
  setEnabled: (enabled: boolean) => DiagnosticsState;
  record: (input: DiagnosticsEventInput) => boolean;
  getSamplePayload: () => DiagnosticsSamplePayload;
  flush: () => Promise<boolean>;
  dispose: () => void;
}

export interface PersistedDiagnosticsState {
  readonly enabled: boolean;
  readonly installId: string;
}

const StateFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  installId: Schema.String,
});

export function parseDiagnosticsStateFile(raw: string): DiagnosticsStateFile | null {
  try {
    return Schema.decodeUnknownSync(StateFileSchema)(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readDiagnosticsState(stateDir: string): DiagnosticsStateFile {
  try {
    const parsed = parseDiagnosticsStateFile(
      FS.readFileSync(Path.join(stateDir, STATE_FILE), "utf8"),
    );
    if (parsed !== null) return parsed;
  } catch {
    // fall through to a fresh state
  }
  const fresh: DiagnosticsStateFile = {
    version: 1,
    enabled: false,
    installId: crypto.randomUUID(),
  };
  try {
    writeDiagnosticsState(stateDir, fresh);
  } catch {
    // A read-only or full disk must never block desktop startup; the client
    // then runs in-memory only and simply does not persist consent.
  }
  return fresh;
}

export function writeDiagnosticsState(stateDir: string, state: DiagnosticsStateFile): void {
  FS.mkdirSync(stateDir, { recursive: true });
  FS.writeFileSync(Path.join(stateDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function readDiagnosticsQueue(stateDir: string): readonly DiagnosticsEvent[] {
  try {
    const parsed = Schema.decodeUnknownSync(Schema.Array(SanitizedEventSchema))(
      JSON.parse(FS.readFileSync(Path.join(stateDir, QUEUE_FILE), "utf8")),
    );
    return parsed;
  } catch {
    return [];
  }
}

export function writeDiagnosticsQueue(stateDir: string, events: readonly DiagnosticsEvent[]): void {
  FS.mkdirSync(stateDir, { recursive: true });
  FS.writeFileSync(Path.join(stateDir, QUEUE_FILE), `${JSON.stringify(events, null, 2)}\n`, "utf8");
}

function reconcileInstallIds(
  events: readonly DiagnosticsEvent[],
  installId: string,
): readonly DiagnosticsEvent[] {
  if (events.length === 0) return events;
  if (events.every((event) => event.installId === installId)) return events;
  // State was regenerated (missing/corrupt) while an old queue survived. Stamp
  // every queued event with the current install id so batches remain valid.
  return events.map((event) => ({ ...event, installId }));
}

export function createDiagnosticsClient(options: DiagnosticsOptions): DiagnosticsClient {
  const endpointUrl = options.endpointUrl ?? DEFAULT_DIAGNOSTICS_ENDPOINT_URL;
  // Distinguish a persisted opt-out from a missing/corrupt state file: only a
  // state file that parsed and says disabled proves consent was revoked.
  const persistedState = (() => {
    try {
      return parseDiagnosticsStateFile(
        FS.readFileSync(Path.join(options.stateDir, STATE_FILE), "utf8"),
      );
    } catch {
      return null;
    }
  })();
  const state = persistedState ?? readDiagnosticsState(options.stateDir);
  const stateRef = {
    enabled: state.enabled,
    installId: state.installId,
  };
  const loadedQueue = readDiagnosticsQueue(options.stateDir);
  // A queue that outlived a persisted opt-out (its delete hit a disk error at
  // withdrawal) is consent-revoked data: never load or send it. A missing
  // state file proves nothing about consent, so its queue is reconciled to
  // the regenerated install id instead.
  const reconciledQueue =
    persistedState !== null && persistedState.enabled === false
      ? []
      : reconcileInstallIds(loadedQueue, stateRef.installId);
  let queue: readonly DiagnosticsEvent[] = reconciledQueue;
  if (reconciledQueue !== loadedQueue && loadedQueue.length > 0) {
    // The queue was dropped as orphaned or re-stamped to the current install
    // id. Persist the result so the on-disk copy stays valid. Best-effort:
    // persistence failures must never crash the app; the in-memory queue is
    // already correct.
    try {
      writeDiagnosticsQueue(options.stateDir, reconciledQueue);
    } catch {
      // A delete is the next best way to keep revoked or stale events off disk.
      try {
        FS.rmSync(Path.join(options.stateDir, QUEUE_FILE), { force: true });
      } catch {
        // Unwritable disk; the in-memory queue still wins for this session.
      }
    }
  }
  let lastSentAt: string | null = null;
  let lastError: string | null = null;
  let consecutiveFailures = 0;
  let inFlightFlush: Promise<boolean> | null = null;
  let inFlightAbort: AbortController | null = null;
  let consentGeneration = 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const timer = flushIntervalMs > 0 ? setInterval(() => void flush(), flushIntervalMs) : null;
  if (timer !== null) timer.unref();

  const sanitizeContext: SanitizeContext = {
    ...options.sanitizeContext,
  };

  function isAllowedEndpoint(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.username !== "" || parsed.password !== "") return false;
      if (parsed.hostname === "") return false;
      const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      // The production endpoint must be HTTPS with a real multi-label domain.
      // http://localhost and http://127.0.0.1 are allowed for local Wrangler
      // dev so the beta build can be exercised against a local worker.
      if (parsed.protocol !== "https:" && !(isLocalhost && parsed.protocol === "http:")) {
        return false;
      }
      if (parsed.hostname.includes(":")) return false;
      if (!isLocalhost && /^\d+\.\d+\.\d+\.\d+$/u.test(parsed.hostname)) return false;
      if (!isLocalhost && !parsed.hostname.includes(".")) return false;
      const defaultPort = parsed.protocol === "https:" ? 443 : 80;
      const port = parsed.port === "" ? defaultPort : Number(parsed.port);
      if (Number.isNaN(port) || port < 1 || port > 65_535) return false;
      return true;
    } catch {
      return false;
    }
  }

  function isSendable(): boolean {
    if (!stateRef.enabled) return false;
    if (process.env.SYNARA_DIAGNOSTICS_DISABLED === "1") return false;
    if (!isAllowedEndpoint(endpointUrl)) return false;
    return true;
  }

  function persistQueue(): void {
    try {
      writeDiagnosticsQueue(options.stateDir, queue);
    } catch {
      // Persistence failures must never crash the app; the queue stays in memory.
    }
  }

  function buildState(): DiagnosticsState {
    return {
      supported: true,
      enabled: stateRef.enabled,
      installId: stateRef.installId,
      endpointUrl,
      queuedEventCount: queue.length,
      lastSentAt,
      lastError,
    };
  }

  async function flushOnce(controller: AbortController, startConsent: number): Promise<boolean> {
    const batch = queue.slice(0, FLUSH_BATCH_LIMIT);
    const batchEventIds = new Set(batch.map((event) => event.eventId));
    const batchHeadId = batch[0]?.eventId ?? null;
    try {
      const response = await fetchImpl(`${endpointUrl}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        // The consent abort wins over the timeout: an opt-out mid-flight must
        // stop the request so a queued batch cannot land after revocation.
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      // If consent or the queue changed while the request was in flight, this
      // completion is stale. Do not mutate state or the queue.
      if (consentGeneration !== startConsent) return false;
      // Remove exactly the submitted events by id, since the live queue may
      // have grown or been capped while the request was in flight.
      queue = queue.filter((event) => !batchEventIds.has(event.eventId));
      consecutiveFailures = 0;
      lastError = null;
      lastSentAt = new Date().toISOString();
      persistQueue();
      return true;
    } catch (error) {
      // Stale completions must not restore a failure streak or drop a queue
      // that was cleared/re-enabled while the request was in flight.
      if (consentGeneration !== startConsent) return false;
      // If the queue head changed, the failed batch is no longer the head
      // (e.g., it was dropped by the cap or the queue was cleared). Reset the
      // failure streak so a new backlog starts fresh.
      if (queue[0]?.eventId !== batchHeadId) {
        consecutiveFailures = 0;
        return false;
      }
      consecutiveFailures += 1;
      lastError = error instanceof Error ? error.message : "flush failed";
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Drop only the failed batch; events that arrived while it was failing
        // survive and become the new head of the queue.
        queue = queue.filter((event) => !batchEventIds.has(event.eventId));
        consecutiveFailures = 0;
      }
      persistQueue();
      return false;
    }
  }

  function flush(): Promise<boolean> {
    // A flush already in flight does not cover events queued after its batch
    // snapshot (e.g. app_quit recorded at will-quit). Wait for it to settle,
    // then re-check and flush the new head instead of dropping the call.
    if (inFlightFlush !== null) return inFlightFlush.then(flush, flush);
    if (!isSendable() || queue.length === 0) return Promise.resolve(false);
    const controller = new AbortController();
    inFlightAbort = controller;
    const pending = flushOnce(controller, consentGeneration).finally(() => {
      inFlightFlush = null;
      inFlightAbort = null;
    });
    inFlightFlush = pending;
    return pending;
  }

  return {
    getState: () => buildState(),
    setEnabled: (enabled) => {
      if (enabled !== stateRef.enabled) {
        // A real consent transition invalidates any in-flight flush: bump the
        // generation so its completion cannot mutate post-toggle state, and
        // abort the request so a batch queued under consent cannot land after
        // opt-out. Repeating the current value changes nothing and must not
        // discard a healthy in-flight completion.
        consentGeneration += 1;
        inFlightAbort?.abort();
      }
      if (!enabled) {
        // Consent withdrawn: disable recording and sending first, drop the
        // queue, and reset the failure counter so a stale streak cannot drop
        // the next backlog. Opt-out must hold even when the filesystem cannot
        // persist anything, so neither write may abort the disable.
        stateRef.enabled = false;
        queue = [];
        consecutiveFailures = 0;
        lastError = null;
        // Persist the opt-out before clearing the queue file: if the process
        // dies between the two writes, the surviving pair is (disabled state,
        // stale queue), which the next launch resolves by dropping the queue.
        // Clearing the queue first could leave (enabled state, empty queue)
        // behind — a silently resurrected consent.
        try {
          writeDiagnosticsState(options.stateDir, {
            version: 1,
            enabled: false,
            installId: stateRef.installId,
          });
        } catch {
          // A missing state file reads back as consent-off on the next start,
          // so deleting it is safer than leaving a stale enabled:true behind.
          try {
            FS.rmSync(Path.join(options.stateDir, STATE_FILE), { force: true });
          } catch {
            // In-memory consent still holds for this session; a fully
            // unwritable disk cannot record an opt-out at all.
          }
        }
        try {
          writeDiagnosticsQueue(options.stateDir, queue);
        } catch {
          // A full or read-only disk can still allow a delete; a missing queue
          // file is the next best way to keep revoked events off disk.
          try {
            FS.rmSync(Path.join(options.stateDir, QUEUE_FILE), { force: true });
          } catch {
            // Nothing persisted. Startup drops any queue that outlives a
            // persisted opt-out, and events are never sent while disabled.
          }
        }
        return buildState();
      }
      if (stateRef.enabled) return buildState();
      try {
        writeDiagnosticsState(options.stateDir, {
          version: 1,
          enabled: true,
          installId: stateRef.installId,
        });
      } catch {
        // If the opt-in cannot be persisted, do not enable collection for this
        // session. The panel will show off, and nothing is queued.
        stateRef.enabled = false;
        return buildState();
      }
      stateRef.enabled = true;
      return buildState();
    },
    record: (input) => {
      if (!isSendable()) return false;
      const sanitized = sanitizeDiagnosticsEvent(input, {
        ...sanitizeContext,
        installId: stateRef.installId,
      });
      if (sanitized === null) return false;
      queue = [...queue, sanitized.event].slice(-MAX_QUEUED_EVENTS);
      persistQueue();
      return true;
    },
    getSamplePayload: () => ({ endpointUrl, events: queue.slice(0, FLUSH_BATCH_LIMIT) }),
    flush,
    dispose: () => {
      if (timer !== null) clearInterval(timer);
      // A disposed client must not let a late completion mutate state.
      consentGeneration += 1;
      inFlightAbort?.abort();
    },
  };
}

export interface DiagnosticsOptions {
  readonly stateDir: string;
  readonly sanitizeContext: SanitizeContext;
  readonly endpointUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly flushIntervalMs?: number;
}
