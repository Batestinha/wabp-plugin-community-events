ALTER TABLE event_weather_deliveries RENAME TO event_weather_deliveries_before_durable_delivery;

CREATE TABLE event_weather_deliveries (
  event_id TEXT NOT NULL,
  event_updated_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('poll-close', 'daily')),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'skipped')),
  chat_id TEXT,
  meteorological_text TEXT,
  marine_text TEXT,
  meteorological_idempotency_key TEXT,
  marine_idempotency_key TEXT,
  meteorological_message_id TEXT,
  marine_message_id TEXT,
  claim_id TEXT,
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_run_at TEXT,
  sent_at TEXT,
  skipped_at TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, kind, event_updated_at),
  FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE CASCADE
);

INSERT INTO event_weather_deliveries (
  event_id,
  event_updated_at,
  kind,
  schedule_kind,
  scheduled_at,
  status,
  attempt,
  next_run_at,
  skipped_at,
  error,
  updated_at
)
SELECT
  legacy.event_id,
  current_event.updated_at,
  legacy.kind,
  CASE WHEN legacy.kind LIKE 'forecast.daily.%' THEN 'daily' ELSE 'poll-close' END,
  legacy.scheduled_at,
  CASE WHEN legacy.status IN ('queued', 'skipped') THEN 'skipped' ELSE 'pending' END,
  0,
  CASE
    WHEN legacy.status IN ('queued', 'skipped') THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  END,
  CASE
    WHEN legacy.status = 'queued' THEN COALESCE(legacy.queued_at, legacy.updated_at)
    ELSE legacy.skipped_at
  END,
  CASE
    WHEN legacy.status = 'queued' THEN 'Legacy queued delivery has an uncertain outcome and was not replayed automatically.'
    ELSE legacy.error
  END,
  legacy.updated_at
FROM event_weather_deliveries_before_durable_delivery AS legacy
JOIN event_records AS current_event ON current_event.id = legacy.event_id;

DROP TABLE event_weather_deliveries_before_durable_delivery;

CREATE INDEX event_weather_deliveries_recovery_idx
  ON event_weather_deliveries(status, next_run_at, lease_expires_at, scheduled_at, event_updated_at);
