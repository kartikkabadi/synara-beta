CREATE TABLE IF NOT EXISTS bug_reports (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  app_version TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT,
  category TEXT,
  title TEXT NOT NULL,
  details_sanitized TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_received ON bug_reports (received_at);
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports (status, received_at);

-- Screenshot uploads stored in R2 under `reports/<report_id>/<uuid>`; one row
-- per object so a report's attachments are enumerable from D1 alone.
CREATE TABLE IF NOT EXISTS bug_report_attachments (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES bug_reports (id),
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bug_report_attachments_report
  ON bug_report_attachments (report_id);

-- Durable rate-limit reservations. One row per scope per fixed hour; the
-- worker upserts `event_count` atomically before writing so concurrent
-- requests cannot both pass on a stale count. Scopes are `reports` and
-- `attachments`. No IP or identity data.
CREATE TABLE IF NOT EXISTS rate_counters (
  scope TEXT NOT NULL,
  window_start TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  PRIMARY KEY (scope, window_start)
);
