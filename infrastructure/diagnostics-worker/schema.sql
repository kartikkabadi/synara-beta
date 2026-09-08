CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  flavor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  provider TEXT,
  duration_bucket TEXT,
  outcome TEXT,
  feature TEXT,
  error_code TEXT,
  error_surface TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_install_received ON events (install_id, received_at);
CREATE INDEX IF NOT EXISTS idx_events_kind_received ON events (kind, received_at);
CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
