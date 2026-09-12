ALTER TABLE event_announcement_messages RENAME TO event_announcement_messages_before_cancellation_cleanup;

CREATE TABLE event_announcement_messages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('poll', 'calendar_hint', 'event_group_hint', 'event_edit', 'cancellation_notice')),
  delivery_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  delete_error TEXT,
  deletion_status TEXT CHECK (deletion_status IN ('pending', 'confirmed', 'unconfirmed', 'rejected', 'failed')),
  deletion_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (deletion_attempt_count >= 0),
  deletion_next_attempt_at TEXT,
  deletion_submitted_at TEXT,
  deletion_confirmed_at TEXT,
  deletion_finalized_at TEXT,
  deletion_last_error TEXT,
  UNIQUE(event_id, kind, delivery_key),
  UNIQUE(event_id, kind, message_id)
);

INSERT INTO event_announcement_messages (
  id, event_id, scope_id, kind, delivery_key, chat_id, message_id,
  created_at, deleted_at, delete_error
)
SELECT
  id, event_id, scope_id, kind, delivery_key, chat_id, message_id,
  created_at, deleted_at, delete_error
FROM event_announcement_messages_before_cancellation_cleanup;

DROP TABLE event_announcement_messages_before_cancellation_cleanup;

CREATE INDEX event_announcement_messages_event_idx
  ON event_announcement_messages(event_id);

CREATE INDEX event_announcement_messages_scope_idx
  ON event_announcement_messages(scope_id, kind);

CREATE INDEX event_announcement_messages_cancellation_cleanup_idx
  ON event_announcement_messages(deletion_status, deletion_next_attempt_at, event_id);
