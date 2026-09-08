# Diagnostics (Beta)

Synara Beta collects optional, anonymous usage diagnostics. This page is the
complete, honest description of the system: what is sent, what is never sent,
where it goes, and how to turn it off.

## The short version

- **Off by default.** Nothing is collected until you turn it on in
  Settings → Diagnostics.
- **No free text, ever.** The schema has no field that can hold a prompt, a
  file path, an email, a token, or a model response. The sanitizer
  (`apps/desktop/src/diagnosticsSanitizer.ts`) drops anything that is not on
  the allowlist — and the server rejects anything the sanitizer would not
  have produced.
- **One random id.** Your install gets a random UUID on first run. It is not
  derived from your hardware, your accounts, or your network address.
- **You can see exactly what would be sent** before anything is sent: the
  Diagnostics settings panel shows the real queued payload.

## What gets sent

| Field               | Purpose                                                 | Example                               |
| ------------------- | ------------------------------------------------------- | ------------------------------------- |
| `kind`              | Which event happened                                    | `session_started`, `update_installed` |
| `appVersion`        | Which beta build                                        | `0.8.3-beta.1`                        |
| `platform` / `arch` | OS and CPU family                                       | `darwin`, `arm64`                     |
| `flavor`            | Build channel                                           | `beta`                                |
| `installId`         | Random per-install UUID, to count installs (not people) | `0f1a2b3c-…`                          |
| `eventId`           | Random per-event id, for deduplication                  | 32 hex chars                          |
| `occurredAt`        | When it happened, truncated to the minute               | `2026-09-08T10:19:00Z`                |
| `provider`          | Which coding agent ran (name only)                      | `codex`, `claude`                     |
| `durationBucket`    | Session length bucket                                   | `1m_5m`                               |
| `outcome`           | How a session ended                                     | `ok`, `error`, `cancelled`            |
| `feature`           | Which beta feature was used (slug)                      | `worktree-reclaim`                    |
| `errorCode`         | Bounded error slug, no message text                     | `backend.exit-nonzero`                |
| `errorSurface`      | Where the error surfaced                                | `desktop`, `backend`, `updater`       |

## What is never sent

- Prompts, responses, transcripts, or any conversation content
- File paths, folder names, repository names, URLs
- Email addresses, account names, tokens, or keys
- Model names beyond the provider enum (e.g. `codex`, `claude`)
- Exact timestamps below minute precision, or exact session durations
- IP addresses or user agents (the collector does not store them)

## How it works

1. You opt in in Settings → Diagnostics (off by default).
2. The desktop app records allowlisted events into a local queue capped at
   200 entries. Every event passes the sanitizer; anything that does not
   validate is dropped.
3. Every 15 minutes (and on quit) the app POSTs at most 50 queued events to
   the collector — a small Cloudflare Worker you can read in
   `infrastructure/diagnostics-worker/`.
4. The worker re-validates the whole batch against the same contract and
   stores it in a Cloudflare D1 database. Batches with any invalid event are
   rejected whole. Durable rate limits — an atomic per-install hourly quota
   and a global hourly cap — bound ingest abuse, and a daily scheduled job
   deletes events older than 90 days.
5. If sending fails five times in a row, the backlog is dropped. Diagnostics
   never degrades the app.

## Turning it off

Settings → Diagnostics → toggle off. The queued events are deleted
immediately and nothing further is recorded. You can also set the
`SYNARA_DIAGNOSTICS_DISABLED=1` environment variable to hard-disable the
sender regardless of the in-app setting.

## Source

- Client: `apps/desktop/src/diagnosticsClient.ts`, `apps/desktop/src/diagnosticsSanitizer.ts`
- Contract: `packages/contracts/src/diagnostics.ts`
- Collector: `infrastructure/diagnostics-worker/` (deployable to Cloudflare Workers + D1)
