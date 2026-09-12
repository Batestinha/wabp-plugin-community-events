CREATE TABLE community_event_suggestion_conversions (
  scope_id TEXT NOT NULL,
  community_jid TEXT NOT NULL,
  suggested_group_jid TEXT NOT NULL,
  suggestion_creator_jid TEXT NOT NULL,
  creator_identity_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'observed',
    'flow_started_pending_reject',
    'reject_outcome_unknown',
    'completed',
    'disappeared'
  )),
  flow_session_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_id TEXT,
  lease_expires_at TEXT,
  first_seen_at TEXT NOT NULL,
  rejected_at TEXT,
  flow_started_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, community_jid, suggested_group_jid, suggestion_creator_jid)
);

CREATE INDEX community_event_suggestion_conversions_recovery_idx
  ON community_event_suggestion_conversions(status, lease_expires_at, updated_at);

CREATE INDEX community_event_suggestion_conversions_creator_idx
  ON community_event_suggestion_conversions(scope_id, creator_identity_id, status);
