# Synara Beta diagnostics collector

A standalone Cloudflare Worker that receives the beta's opt-in diagnostics
events and stores them in D1. No VPS, no third-party analytics service.

## Privacy contract

- The desktop app sends **only** events that passed
  `apps/desktop/src/diagnosticsSanitizer.ts` — a closed allowlist of fields,
  each a validated enum, identifier, or coarse bucket. There are no free-text
  fields anywhere in the schema.
- This worker re-validates every event against the same structural contract
  and rejects a whole batch when any event fails. Nothing outside the schema
  is ever stored.
- Never stored: IP addresses, user agents, prompts, model outputs, file
  paths, account identifiers, model names, exact durations. The install id is
  a random per-install UUID generated on first run — it is not derived from
  hardware, accounts, or network identifiers.
- Events are kept for 90 days and then deleted (see Retention below).

## Deploy

Requires `wrangler` authentication (`wrangler whoami`).

```console
wrangler d1 create synara-beta-diagnostics
# put the returned database_id into wrangler.jsonc
wrangler d1 execute synara-beta-diagnostics --remote --file schema.sql
wrangler deploy
```

The deployed workers.dev URL is the diagnostics endpoint the desktop client
posts to (`DEFAULT_DIAGNOSTICS_ENDPOINT_URL` in
`apps/desktop/src/diagnosticsClient.ts`). Update that constant if the worker
moves.

## Endpoints

- `POST /v1/events` — batch ingest `{ events: [...] }` (max 50). Rejects the
  whole batch when any event fails validation (422), exceeds the
  per-install hourly limit (429), or carries a body larger than 1 MB (413).
- `GET /health` — liveness.

## Retention

The worker enforces 90-day retention itself: a daily cron trigger (`0 3 * * *`,
declared in `wrangler.jsonc`) runs the `scheduled` handler, which deletes every
event older than 90 days. The same cleanup can be run manually:

```console
wrangler d1 execute synara-beta-diagnostics --remote \
  --command "DELETE FROM events WHERE received_at < datetime('now', '-90 days')"
```
