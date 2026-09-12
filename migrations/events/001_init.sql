CREATE TABLE IF NOT EXISTS event_records (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  group_id TEXT,
  group_wid TEXT,
  profile_id TEXT NOT NULL,
  profile_label TEXT NOT NULL,
  status TEXT NOT NULL,
  actor_wid TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  announcement_group_wid TEXT NOT NULL,
  poll_wa_msg_id TEXT NOT NULL UNIQUE,
  poll_question TEXT NOT NULL,
  poll_options_json TEXT NOT NULL,
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
  error TEXT
);

CREATE INDEX IF NOT EXISTS event_records_scope_status_idx ON event_records(scope_id, status);
CREATE INDEX IF NOT EXISTS event_records_poll_idx ON event_records(poll_wa_msg_id);

CREATE TABLE IF NOT EXISTS event_votes (
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

CREATE TABLE IF NOT EXISTS event_group_participants (
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

CREATE TABLE IF NOT EXISTS event_logs (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  action TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS event_logs_event_idx ON event_logs(event_id, created_at);
