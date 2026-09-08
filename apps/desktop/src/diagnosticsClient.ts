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
  DIAGNOSTICS_ARCHES,
  DIAGNOSTICS_EVENT_KINDS,
  DIAGNOSTICS_FLAVORS,
  DIAGNOSTICS_PLATFORMS,
  DIAGNOSTICS_SCHEMA_VERSION,
  type DiagnosticsEvent,
  type DiagnosticsEventInput,
  type DiagnosticsSamplePayload,
  type DiagnosticsState,
} from "@synara/contracts";

import { sanitizeDiagnosticsEvent, type SanitizeContext } from "./diagnosticsSanitizer";

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
  writeDiagnosticsState(stateDir, fresh);
  return fresh;
}

export function writeDiagnosticsState(stateDir: string, state: DiagnosticsStateFile): void {
  FS.mkdirSync(stateDir, { recursive: true });
  FS.writeFileSync(Path.join(stateDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

const QueuedEventSchema = Schema.Struct({
  schemaVersion: Schema.Literal(DIAGNOSTICS_SCHEMA_VERSION),
  kind: Schema.Literals([...DIAGNOSTICS_EVENT_KINDS]),
  eventId: Schema.String,
  occurredAt: Schema.String,
  appVersion: Schema.String,
  platform: Schema.Literals([...DIAGNOSTICS_PLATFORMS]),
  arch: Schema.Literals([...DIAGNOSTICS_ARCHES]),
  flavor: Schema.Literals([...DIAGNOSTICS_FLAVORS]),
  installId: Schema.String,
});

export function readDiagnosticsQueue(stateDir: string): readonly DiagnosticsEvent[] {
  try {
    const parsed = Schema.decodeUnknownSync(Schema.Array(QueuedEventSchema))(
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

export interface DiagnosticsClient {
  getState: () => DiagnosticsState;
  setEnabled: (enabled: boolean) => DiagnosticsState;
  record: (input: DiagnosticsEventInput) => boolean;
  getSamplePayload: () => DiagnosticsSamplePayload;
  flush: () => Promise<boolean>;
  dispose: () => void;
}

export function createDiagnosticsClient(options: DiagnosticsOptions): DiagnosticsClient {
  const endpointUrl = options.endpointUrl ?? DEFAULT_DIAGNOSTICS_ENDPOINT_URL;
  const state = readDiagnosticsState(options.stateDir);
  const stateRef = {
    enabled: state.enabled,
    installId: state.installId,
  };
  let queue: readonly DiagnosticsEvent[] = readDiagnosticsQueue(options.stateDir);
  let lastSentAt: string | null = null;
  let lastError: string | null = null;
  let consecutiveFailures = 0;
  let flushing = false;
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
      queue = queue.slice(batch.length);
      consecutiveFailures = 0;
      lastError = null;
      lastSentAt = new Date().toISOString();
      persistQueue();
      return true;
    } catch (error) {
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
      stateRef.enabled = enabled;
      writeDiagnosticsState(options.stateDir, {
        version: 1,
        enabled,
        installId: stateRef.installId,
      });
      if (!enabled) {
        // Consent withdrawn: drop everything queued, immediately.
        queue = [];
        persistQueue();
      }
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
