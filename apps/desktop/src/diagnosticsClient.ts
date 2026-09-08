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
      // The in-memory queue is already correct.
    }
  }
  let lastSentAt: string | null = null;
  let lastError: string | null = null;
  let consecutiveFailures = 0;
  let flushing = false;
  let consentGeneration = 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const timer = flushIntervalMs > 0 ? setInterval(() => void flush(), flushIntervalMs) : null;
  if (timer !== null) timer.unref();

  const sanitizeContext: SanitizeContext = {
    ...options.sanitizeContext,
  };

  function isSendable(): boolean {
    if (!stateRef.enabled) return false;
    if (process.env.SYNARA_DIAGNOSTICS_DISABLED === "1") return false;
    if (!endpointUrl.startsWith("https://")) return false;
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

  async function flush(): Promise<boolean> {
    if (flushing || !isSendable() || queue.length === 0) return false;
    const startConsent = consentGeneration;
    const startQueue = queue;
    flushing = true;
    try {
      const batch = queue.slice(0, FLUSH_BATCH_LIMIT);
      const response = await fetchImpl(`${endpointUrl}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      // If consent or the queue changed while the request was in flight, this
      // completion is stale. Do not mutate state or the queue.
      if (consentGeneration !== startConsent) return false;
      // Remove exactly the submitted events by id, since the live queue may
      // have grown or been capped while the request was in flight.
      const sentIds = new Set(batch.map((event) => event.eventId));
      queue = queue.filter((event) => !sentIds.has(event.eventId));
      consecutiveFailures = 0;
      lastError = null;
      lastSentAt = new Date().toISOString();
      persistQueue();
      return true;
    } catch (error) {
      // Stale completions must not restore a failure streak or drop a queue
      // that was cleared/re-enabled while the request was in flight.
      if (consentGeneration !== startConsent) return false;
      // If events were recorded or dropped during the request, this failure
      // belongs to the old batch. Do not count it against a new backlog.
      if (queue !== startQueue) return false;
      consecutiveFailures += 1;
      lastError = error instanceof Error ? error.message : "flush failed";
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Give up on this backlog: diagnostics must never pile up or retry forever.
        queue = [];
        consecutiveFailures = 0;
        persistQueue();
      }
      return false;
    } finally {
      flushing = false;
    }
  }

  return {
    getState: () => buildState(),
    setEnabled: (enabled) => {
      // Bumping the consent generation before any mutation makes in-flight
      // flushes ignore stale completions after consent is toggled.
      consentGeneration += 1;
      if (!enabled) {
        // Consent withdrawn: disable recording and sending first, drop the
        // queue, and reset the failure counter so a stale streak cannot drop
        // the next backlog. Opt-out must hold even when the filesystem cannot
        // persist anything, so neither write may abort the disable.
        stateRef.enabled = false;
        queue = [];
        consecutiveFailures = 0;
        lastError = null;
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
        return buildState();
      }
      stateRef.enabled = true;
      writeDiagnosticsState(options.stateDir, {
        version: 1,
        enabled: true,
        installId: stateRef.installId,
      });
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
    },
  };
}

export interface DiagnosticsOptions {
  readonly stateDir: string;
  readonly sanitizeContext: SanitizeContext;
  readonly endpointUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly flushIntervalMs?: number;
}
