CREATE TABLE IF NOT EXISTS event_provisioning_retries (
  event_id TEXT PRIMARY KEY,
  subgroup_chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  next_retry_at TEXT,
  claimed_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE CASCADE,
  CHECK (generation >= 1),
  CHECK (status IN ('scheduled', 'claimed', 'exhausted'))
);

CREATE INDEX IF NOT EXISTS event_provisioning_retries_due_idx
  ON event_provisioning_retries(status, next_retry_at);
