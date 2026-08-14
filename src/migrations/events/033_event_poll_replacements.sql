ALTER TABLE event_records ADD COLUMN poll_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE event_edit_repairs ADD COLUMN calendar_hint_delivery_key TEXT;
ALTER TABLE event_edit_repairs ADD COLUMN calendar_hint_locale TEXT;
ALTER TABLE event_edit_repairs ADD COLUMN execution_claim_id TEXT;
ALTER TABLE event_edit_repairs ADD COLUMN execution_lease_expires_at TEXT;

CREATE INDEX event_edit_repairs_execution_lease_idx
  ON event_edit_repairs(status, execution_lease_expires_at, event_id);

-- Migration 024 deliberately permits unresolved legacy identities to remain
-- until the authoritative identity finalizer runs, while guarding every later
-- UPDATE. Temporarily remove that guard so this unrelated generation backfill
-- does not reject those legacy rows, then restore it exactly.
DROP TRIGGER IF EXISTS event_records_actor_identity_update_guard;

UPDATE event_records
   SET poll_generation = 1
 WHERE poll_wa_msg_id IS NOT NULL;

CREATE TRIGGER event_records_actor_identity_update_guard
BEFORE UPDATE ON event_records
WHEN NEW.actor_identity_id IS NULL OR trim(NEW.actor_identity_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'event actor identity is required');
END;

CREATE TABLE event_poll_replacements (
  operation_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'completed', 'aborted')),
  expected_event_updated_at TEXT NOT NULL,
  old_poll_wa_msg_id TEXT NOT NULL,
  old_poll_generation INTEGER NOT NULL,
  target_json TEXT NOT NULL,
  editor_identity_id TEXT NOT NULL,
  editor_wid TEXT NOT NULL,
  editor_label TEXT NOT NULL,
  locale TEXT NOT NULL,
  source_plugin_id TEXT NOT NULL,
  artifact_ids_json TEXT NOT NULL,
  publish_idempotency_key TEXT NOT NULL UNIQUE,
  new_poll_wa_msg_id TEXT,
  publication_claim_token TEXT,
  publication_lease_expires_at TEXT,
  publication_started_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  swapped_at TEXT,
  completed_at TEXT,
  retired_at TEXT,
  retirement_error TEXT,
  retirement_failure_count INTEGER NOT NULL DEFAULT 0,
  receipt_released_at TEXT,
  receipt_release_error TEXT,
  receipt_release_failure_count INTEGER NOT NULL DEFAULT 0,
  receipt_release_next_attempt_at TEXT,
  CHECK (
    (publication_claim_token IS NULL AND publication_lease_expires_at IS NULL)
    OR
    (publication_claim_token IS NOT NULL AND publication_lease_expires_at IS NOT NULL)
  ),
  FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX event_poll_replacements_active_event_idx
  ON event_poll_replacements(event_id)
  WHERE status NOT IN ('completed', 'aborted');

CREATE INDEX event_poll_replacements_recovery_idx
  ON event_poll_replacements(
    status, publication_lease_expires_at, next_attempt_at, updated_at, operation_id
  );

CREATE INDEX event_poll_replacements_receipt_recovery_idx
  ON event_poll_replacements(receipt_released_at, receipt_release_next_attempt_at, completed_at, operation_id);
