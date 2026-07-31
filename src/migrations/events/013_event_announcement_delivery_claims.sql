CREATE TABLE IF NOT EXISTS event_announcement_delivery_claims (
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('calendar_hint', 'event_group_hint')),
  scope_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'uncertain')),
  message_id TEXT,
  error TEXT,
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, kind),
  FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS event_announcement_delivery_claims_status_idx
  ON event_announcement_delivery_claims(status, updated_at);

INSERT OR IGNORE INTO event_announcement_delivery_claims (
  event_id,
  kind,
  scope_id,
  chat_id,
  status,
  message_id,
  error,
  claimed_at,
  updated_at
)
SELECT
  messages.event_id,
  messages.kind,
  messages.scope_id,
  messages.chat_id,
  'sent',
  messages.message_id,
  NULL,
  messages.created_at,
  messages.created_at
FROM event_announcement_messages AS messages
WHERE messages.kind IN ('calendar_hint', 'event_group_hint')
  AND messages.id = (
    SELECT candidate.id
      FROM event_announcement_messages AS candidate
     WHERE candidate.event_id = messages.event_id
       AND candidate.kind = messages.kind
     ORDER BY candidate.created_at ASC, candidate.id ASC
     LIMIT 1
  );
