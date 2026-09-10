# Synara Beta bug-report collector

A standalone Cloudflare Worker that receives the beta app's bug reports and
stores them in D1, with optional screenshot attachments in R2. No VPS, no
third-party feedback service — reports land on Kartik's own infrastructure,
not trysynara.com and not public GitHub issues.

## Privacy contract

- The web app sends **only** the payload built by `apps/web/src/feedback.ts`:
  sanitized details, the rendered summary, the allow-listed diagnostics block,
  and the diagnostics object. Secrets are masked with `[REDACTED]` and home
  paths folded to `~` before anything leaves the app.
- This worker re-validates every report against the structural contract in
  `src/contract.ts` (closed key set, closed category enum, bounded strings and
  counts) and rejects the whole report when any field fails. Nothing outside
  the schema is ever stored.
- Never stored: IP addresses, cookies, prompts, message contents, file paths
  (beyond the `~`-normalized forms the sanitizer leaves), account identifiers.
- Every POST requires `Authorization: Bearer <BUG_REPORT_TOKEN>` — a shared
  secret set with `wrangler secret put` and shipped in the beta build via
  `VITE_FEEDBACK_TOKEN` (or `DEFAULT_FEEDBACK_TOKEN` in
  `apps/web/src/feedback.ts`). The secret rides inside the distributed app, so
  it is a gate, not real secrecy: hourly write caps in `rate_counters`
  (240 reports/h, 480 attachments/h) bound the damage if it leaks.
- Attachments are screenshots only: `image/png|jpeg|webp|gif`, ≤ 5 MB, max 5
  per report, keyed `reports/<report_id>/<uuid>` in R2.

## Deploy

Requires `wrangler` authentication (`wrangler whoami`).

```console
wrangler d1 create synara-beta-bugreports
# put the returned database_id into wrangler.jsonc
wrangler r2 bucket create synara-beta-bugreport-attachments   # optional
wrangler d1 execute synara-beta-bugreports --remote --file schema.sql
wrangler secret put BUG_REPORT_TOKEN
wrangler deploy
```

`schema.sql` is idempotent (`IF NOT EXISTS`): re-run the same execute command
on an existing deployment whenever the schema changes.

The deployed workers.dev URL is the feedback endpoint the web app posts to
(`DEFAULT_FEEDBACK_ENDPOINT` in `apps/web/src/feedback.ts`, overridable with
`VITE_FEEDBACK_ENDPOINT`). Update that constant — and `DEFAULT_FEEDBACK_TOKEN`
(or build with `VITE_FEEDBACK_TOKEN`) — after deploying.

## Endpoints

- `POST /v1/reports` — ingest one report. Rejects with 401 without the bearer
  token, 413 over the 256 KB body cap (the header is only a fast path — the
  body is read with a hard byte cap, so a forged or missing `Content-Length`
  cannot make the worker buffer an oversized payload), 400 for malformed
  JSON, 422 for a schema violation, 429 over the hourly quota. Returns
  `202 { id }`; the id is the attachment path's report segment.
- `POST /v1/reports/:id/attachment` — one image body (see the content-type
  allowlist, ≤ 5 MB). 404 for an unknown report id, 429 past 5 attachments,
  503 when the R2 binding is absent. Returns `201 { key }`.
- `OPTIONS /v1/*` — CORS preflight (the app posts cross-origin from dev
  servers and the desktop window).
- `GET /health` — liveness.

There is no read API. Query D1 directly to triage:

```console
wrangler d1 execute synara-beta-bugreports --remote \
  --command "SELECT id, received_at, app_version, os, category, title FROM bug_reports ORDER BY received_at DESC LIMIT 50"
```

## Retention

Reports are a work queue, not telemetry, so nothing auto-deletes them. Triage
by flipping `status` (`new` → `triaged`/`resolved`/`wontfix`) and delete rows
manually when done:

```console
wrangler d1 execute synara-beta-bugreports --remote \
  --command "UPDATE bug_reports SET status = 'triaged' WHERE id = '<id>'"
```

Attachment objects under `reports/<id>/` in the R2 bucket can be removed with
the report row (delete the `bug_report_attachments` rows first, then the R2
objects, then the `bug_reports` row).
