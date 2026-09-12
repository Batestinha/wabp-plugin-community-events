ALTER TABLE event_announcement_delivery_claims RENAME TO event_announcement_delivery_claims_before_durable_delivery;

CREATE TABLE event_announcement_delivery_claims (
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('calendar_hint', 'event_group_hint', 'event_edit')),
  delivery_key TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'uncertain', 'superseded')),
  text TEXT,
  idempotency_key TEXT,
  lease_expires_at TEXT,
  message_id TEXT,
  error TEXT,
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, kind, delivery_key),
  FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE CASCADE
);

INSERT INTO event_announcement_delivery_claims (
  event_id,
  kind,
  delivery_key,
  scope_id,
  chat_id,
  status,
  text,
  idempotency_key,
  lease_expires_at,
  message_id,
  error,
  claimed_at,
  updated_at
)
SELECT
  event_id,
  kind,
  delivery_key,
  scope_id,
  chat_id,
  status,
  NULL,
  NULL,
  CASE WHEN status = 'sending' THEN updated_at ELSE NULL END,
  message_id,
  error,
  claimed_at,
  updated_at
FROM event_announcement_delivery_claims_before_durable_delivery;

DROP TABLE event_announcement_delivery_claims_before_durable_delivery;

CREATE INDEX event_announcement_delivery_claims_status_idx
  ON event_announcement_delivery_claims(status, updated_at);

CREATE INDEX event_announcement_delivery_claims_recovery_idx
  ON event_announcement_delivery_claims(status, lease_expires_at, updated_at);

CREATE TABLE event_edit_repairs (
  operation_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES event_records(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  expected_event_updated_at TEXT NOT NULL,
  subgroup_chat_id TEXT,
  target_group_title TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  announcement_delivery_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX event_edit_repairs_recovery_idx
  ON event_edit_repairs(status, created_at, operation_id);

CREATE TABLE event_calendar_repair_leases (
  scope_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, calendar_id)
);

CREATE INDEX event_calendar_repair_leases_expiry_idx
  ON event_calendar_repair_leases(lease_expires_at, updated_at);

ALTER TABLE event_cleanup_claims ADD COLUMN lease_expires_at TEXT;

UPDATE event_cleanup_claims
   SET lease_expires_at = claimed_at
 WHERE lease_expires_at IS NULL;

CREATE INDEX event_cleanup_claims_lease_idx
  ON event_cleanup_claims(lease_expires_at, claimed_at);
