ALTER TABLE event_announcement_messages RENAME TO event_announcement_messages_before_delivery_keys;

CREATE TABLE event_announcement_messages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('poll', 'calendar_hint', 'event_group_hint', 'event_edit')),
  delivery_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  delete_error TEXT,
  UNIQUE(event_id, kind, delivery_key),
  UNIQUE(event_id, kind, message_id)
);

INSERT INTO event_announcement_messages (
  id,
  event_id,
  scope_id,
  kind,
  delivery_key,
  chat_id,
  message_id,
  created_at,
  deleted_at,
  delete_error
)
SELECT
  id,
  event_id,
  scope_id,
  kind,
  'initial',
  chat_id,
  message_id,
  created_at,
  deleted_at,
  delete_error
FROM event_announcement_messages_before_delivery_keys;

DROP TABLE event_announcement_messages_before_delivery_keys;

CREATE INDEX event_announcement_messages_event_idx
  ON event_announcement_messages(event_id);

CREATE INDEX event_announcement_messages_scope_idx
  ON event_announcement_messages(scope_id, kind);

ALTER TABLE event_announcement_delivery_claims RENAME TO event_announcement_delivery_claims_before_delivery_keys;

CREATE TABLE event_announcement_delivery_claims (
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('calendar_hint', 'event_group_hint', 'event_edit')),
  delivery_key TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'uncertain')),
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
  message_id,
  error,
  claimed_at,
  updated_at
)
SELECT
  event_id,
  kind,
  'initial',
  scope_id,
  chat_id,
  status,
  message_id,
  error,
  claimed_at,
  updated_at
FROM event_announcement_delivery_claims_before_delivery_keys;

DROP TABLE event_announcement_delivery_claims_before_delivery_keys;

CREATE INDEX event_announcement_delivery_claims_status_idx
  ON event_announcement_delivery_claims(status, updated_at);
