CREATE TABLE IF NOT EXISTS event_weather_deliveries (
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL,
  queued_at TEXT,
  skipped_at TEXT,
  failed_at TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, kind),
  FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS event_weather_deliveries_status_idx
  ON event_weather_deliveries(status, scheduled_at);
