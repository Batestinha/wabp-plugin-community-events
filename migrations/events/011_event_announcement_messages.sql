CREATE TABLE IF NOT EXISTS event_announcement_messages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('poll', 'calendar_hint', 'event_group_hint')),
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  delete_error TEXT,
  UNIQUE(event_id, kind, message_id)
);

CREATE INDEX IF NOT EXISTS event_announcement_messages_event_idx
  ON event_announcement_messages(event_id);

CREATE INDEX IF NOT EXISTS event_announcement_messages_scope_idx
  ON event_announcement_messages(scope_id, kind);

INSERT OR IGNORE INTO event_announcement_messages (
  id,
  event_id,
  scope_id,
  kind,
  chat_id,
  message_id,
  created_at
)
SELECT
  'poll:' || id || ':' || poll_wa_msg_id,
  id,
  scope_id,
  'poll',
  announcement_group_wid,
  poll_wa_msg_id,
  created_at
FROM event_records
WHERE poll_wa_msg_id IS NOT NULL
  AND announcement_group_wid IS NOT NULL;
