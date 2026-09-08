// FILE: DiagnosticsSettingsPanel.tsx
// Purpose: Settings → Diagnostics. Opt-in consent plus full transparency:
//          the exact field table, the never-sent list, and the real queued
//          payload a flush would send, straight from the desktop client.
// Layer: web settings panel body.

import { useCallback, useEffect, useState } from "react";

import type { DiagnosticsSamplePayload, DiagnosticsState } from "@synara/contracts";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";

const FIELD_ROWS: ReadonlyArray<{
  field: string;
  purpose: string;
  example: string;
  collected: boolean;
}> = [
  { field: "kind", purpose: "Which event happened", example: "session_started", collected: true },
  { field: "schemaVersion", purpose: "Payload schema version", example: "1", collected: true },
  {
    field: "appVersion",
    purpose: "Which beta build you run",
    example: "0.8.3-beta.1",
    collected: true,
  },
  {
    field: "platform / arch",
    purpose: "OS and CPU family",
    example: "darwin / arm64",
    collected: true,
  },
  { field: "flavor", purpose: "Build channel", example: "beta", collected: true },
  {
    field: "eventId",
    purpose: "Random per-event id, for deduplication",
    example: "32 hex chars",
    collected: true,
  },
  {
    field: "installId",
    purpose: "Random per-install UUID; counts installs, not people",
    example: "0f1a2b3c-…",
    collected: true,
  },
  {
    field: "occurredAt",
    purpose: "Minute-precision time of the event",
    example: "2026-09-08T10:19:00Z",
    collected: true,
  },
  {
    field: "provider",
    purpose: "Which coding agent ran (name only, no model names)",
    example: "codex",
    collected: true,
  },
  {
    field: "durationBucket",
    purpose: "Session length bucket — never an exact duration",
    example: "1m_5m",
    collected: false,
  },
  { field: "outcome", purpose: "How a session ended", example: "ok", collected: false },
  {
    field: "feature",
    purpose: "Which beta feature was used (slug only)",
    example: "worktree-reclaim",
    collected: false,
  },
  {
    field: "errorCode / errorSurface",
    purpose: "Bounded error slug — never a message or stack",
    example: "backend.exit-nonzero",
    collected: false,
  },
];

const NEVER_SENT: ReadonlyArray<string> = [
  "Prompts, responses, and model outputs",
  "File paths, folder names, repository names",
  "Account names, emails, tokens",
  "Model names beyond the provider enum",
  "Seconds of timestamps and exact session durations (minute precision and buckets only)",
  "IP addresses and user agents (the collector never stores them)",
];

export function DiagnosticsSettingsPanel(props: { active: boolean }) {
  const bridge = window.desktopBridge?.diagnostics;
  const [state, setState] = useState<DiagnosticsState | null>(null);
  const [sample, setSample] = useState<DiagnosticsSamplePayload | null>(null);

  const refresh = useCallback(() => {
    if (!props.active) return;
    void bridge?.getState().then(setState);
    void bridge?.getSamplePayload().then(setSample);
  }, [bridge, props.active]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!props.active) return null;

  if (!bridge || state === null) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Diagnostics are part of the Synara Beta desktop app. This panel is unavailable in the
          browser.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-7">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex max-w-prose flex-col gap-1">
            <h3 className="text-sm font-medium">Share anonymous diagnostics</h3>
            <p className="text-sm text-muted-foreground">
              Off by default. When on, the app queues a few anonymous counters and sends them to a
              Cloudflare worker owned by this project. Nothing is sent before you opt in, and
              turning this off deletes the queue immediately.
            </p>
          </div>
          <Switch
            checked={state.enabled}
            onCheckedChange={(enabled) => {
              void bridge.setEnabled(enabled).then((next) => {
                setState(next);
                // Disabling deletes the queue; the sample payload must not
                // keep showing events that no longer exist.
                refresh();
              });
            }}
            aria-label="Share anonymous diagnostics"
          />
        </div>
        <dl className="grid gap-x-12 gap-y-2.5 text-sm md:grid-cols-2">
          <Row label="Status" value={state.enabled ? "On" : "Off"} />
          <Row label="Install id" value={state.installId} mono />
          <Row label="Endpoint" value={state.endpointUrl} mono />
          <Row
            label="Queued events"
            value={`${state.queuedEventCount}${state.lastSentAt === null ? "" : ` · last sent ${state.lastSentAt}`}`}
            mono
          />
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">What can be sent</h3>
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-start">
                <th className="px-3 py-2 text-start font-medium">Field</th>
                <th className="hidden px-3 py-2 text-start font-medium sm:table-cell">Purpose</th>
                <th className="hidden px-3 py-2 text-start font-medium md:table-cell">Example</th>
                <th className="px-3 py-2 text-start font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {FIELD_ROWS.map((row) => (
                <tr key={row.field} className="border-t border-border/50">
                  <td className="py-2 pe-3 font-mono text-xs">{row.field}</td>
                  <td className="py-2 pe-3 text-sm text-muted-foreground">{row.purpose}</td>
                  <td className="hidden py-2 font-mono text-xs text-muted-foreground sm:table-cell">
                    {row.example}
                  </td>
                  <td className="py-2 pe-3 text-sm text-muted-foreground">
                    {row.collected ? "Collected now" : "Reserved"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">
          Reserved fields are part of the schema but are not yet emitted by this build. Only
          `session_started` currently sends a kind-specific field (`provider`).
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">What is never sent</h3>
        <ul className="flex list-disc flex-col gap-1.5 ps-5 text-sm text-muted-foreground">
          {NEVER_SENT.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">Exactly what a flush sends</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void bridge.sendTestEvent().then(() => refresh());
            }}
          >
            Send test event
          </Button>
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">
          This is the real payload queued on this device right now (empty when nothing has
          happened). The collector re-validates every event and stores nothing outside this schema.
        </p>
        <pre className="max-h-72 overflow-auto rounded-xl bg-muted/50 p-3 text-xs leading-relaxed">
          {JSON.stringify(sample, null, 2)}
        </pre>
        <p className="text-sm text-muted-foreground">
          Full details live in <code className="font-mono text-xs">docs/diagnostics.md</code> in the
          repository, including the collector source and retention policy.
        </p>
      </section>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd
        className={`truncate text-sm tabular-nums ${mono ? "font-mono text-xs" : ""}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
