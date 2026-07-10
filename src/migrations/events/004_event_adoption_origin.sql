PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

ALTER TABLE event_records RENAME TO event_records_legacy;

CREATE TABLE event_records (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  group_id TEXT,
  group_wid TEXT,
  profile_id TEXT NOT NULL,
  profile_label TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'created',
  event_status TEXT NOT NULL,
  group_lifecycle_status TEXT NOT NULL,
  calendar_status TEXT NOT NULL,
  actor_wid TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  announcement_group_wid TEXT,
  poll_wa_msg_id TEXT,
  poll_question TEXT,
  poll_options_json TEXT NOT NULL DEFAULT '[]',
  response_classes_json TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  close_at TEXT NOT NULL,
  cleanup_at TEXT NOT NULL,
  group_title TEXT NOT NULL,
  calendar_duration_minutes INTEGER NOT NULL,
  calendar_location TEXT,
  calendar_description TEXT,
  subgroup_chat_id TEXT,
  subgroup_title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  cleaned_at TEXT,
  cancelled_at TEXT,
  cancelled_by_wid TEXT,
  cancelled_by_label TEXT,
  cancel_reason TEXT,
  error TEXT
);

INSERT INTO event_records (
  id, scope_id, group_id, group_wid, profile_id, profile_label, origin,
  event_status, group_lifecycle_status, calendar_status, actor_wid, actor_label,
  announcement_group_wid, poll_wa_msg_id, poll_question, poll_options_json, response_classes_json,
  answers_json, starts_at, timezone, close_at, cleanup_at, group_title,
  calendar_duration_minutes, calendar_location, calendar_description, subgroup_chat_id, subgroup_title,
  created_at, updated_at, closed_at, cleaned_at, cancelled_at, cancelled_by_wid, cancelled_by_label,
  cancel_reason, error
)
SELECT
  id, scope_id, group_id, group_wid, profile_id, profile_label, 'created',
  event_status, group_lifecycle_status, calendar_status, actor_wid, actor_label,
  announcement_group_wid, poll_wa_msg_id, poll_question, poll_options_json, response_classes_json,
  answers_json, starts_at, timezone, close_at, cleanup_at, group_title,
  calendar_duration_minutes, calendar_location, calendar_description, subgroup_chat_id, subgroup_title,
  created_at, updated_at, closed_at, cleaned_at, cancelled_at, cancelled_by_wid, cancelled_by_label,
  cancel_reason, error
FROM event_records_legacy;

DROP INDEX IF EXISTS event_logs_event_idx;

ALTER TABLE event_votes RENAME TO event_votes_legacy;
CREATE TABLE event_votes (
  event_id TEXT NOT NULL,
  voter_wid TEXT NOT NULL,
  selected_option_ids_json TEXT NOT NULL,
  selected_option_names_json TEXT NOT NULL,
  selected_option_numbers_json TEXT NOT NULL,
  interacted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, voter_wid),
  FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE CASCADE
);
INSERT INTO event_votes (
  event_id, voter_wid, selected_option_ids_json, selected_option_names_json,
  selected_option_numbers_json, interacted_at, updated_at
)
SELECT
  event_id, voter_wid, selected_option_ids_json, selected_option_names_json,
  selected_option_numbers_json, interacted_at, updated_at
FROM event_votes_legacy;
DROP TABLE event_votes_legacy;

ALTER TABLE event_group_participants RENAME TO event_group_participants_legacy;
CREATE TABLE event_group_participants (
  event_id TEXT NOT NULL,
  wid TEXT NOT NULL,
  status_code INTEGER,
  message TEXT,
  is_group_creator INTEGER NOT NULL DEFAULT 0,
  is_invite_v4_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, wid),
  FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE CASCADE
);
INSERT INTO event_group_participants (
  event_id, wid, status_code, message, is_group_creator, is_invite_v4_sent, created_at
)
SELECT
  event_id, wid, status_code, message, is_group_creator, is_invite_v4_sent, created_at
FROM event_group_participants_legacy;
DROP TABLE event_group_participants_legacy;

ALTER TABLE event_logs RENAME TO event_logs_legacy;
CREATE TABLE event_logs (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  action TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE SET NULL
);
INSERT INTO event_logs (
  id, event_id, action, metadata_json, created_at
)
SELECT
  id, event_id, action, metadata_json, created_at
FROM event_logs_legacy;
DROP TABLE event_logs_legacy;

DROP TABLE event_records_legacy;

DROP INDEX IF EXISTS event_records_scope_event_group_idx;
DROP INDEX IF EXISTS event_records_scope_calendar_idx;
DROP INDEX IF EXISTS event_records_poll_idx;

CREATE INDEX IF NOT EXISTS event_records_scope_event_group_idx
  ON event_records(scope_id, event_status, group_lifecycle_status);
CREATE INDEX IF NOT EXISTS event_records_scope_calendar_idx
  ON event_records(scope_id, calendar_status, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS event_records_poll_unique_idx
  ON event_records(poll_wa_msg_id)
  WHERE poll_wa_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_records_subgroup_idx
  ON event_records(subgroup_chat_id)
  WHERE subgroup_chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_logs_event_idx
  ON event_logs(event_id, created_at);

PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
