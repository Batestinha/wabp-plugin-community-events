CREATE TABLE unplanned_event_finalizations (
  event_id TEXT PRIMARY KEY REFERENCES event_records(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  event_updated_at TEXT NOT NULL,
  generation TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  next_run_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX unplanned_event_finalizations_recovery_idx
  ON unplanned_event_finalizations(status, next_run_at, updated_at);

INSERT INTO unplanned_event_finalizations (
  event_id,
  scope_id,
  event_updated_at,
  generation,
  attempt,
  next_run_at,
  status,
  last_error,
  created_at,
  updated_at,
  completed_at
)
SELECT
  id,
  scope_id,
  updated_at,
  'migration-' || lower(hex(randomblob(16))),
  1,
  updated_at,
  'pending',
  'Backfilled durable finalization for an unplanned event completed before migration 026.',
  updated_at,
  updated_at,
  NULL
FROM event_records
WHERE origin = 'unplanned'
  AND event_status = 'active'
  AND group_lifecycle_status = 'poll_closed'
  AND calendar_status = 'included'
  AND subgroup_chat_id IS NOT NULL;
