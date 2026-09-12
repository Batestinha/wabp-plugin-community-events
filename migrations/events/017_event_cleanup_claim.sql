PRAGMA foreign_keys = ON;

CREATE TABLE event_cleanup_claims (
  event_id TEXT PRIMARY KEY REFERENCES event_records(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL UNIQUE,
  expected_event_updated_at TEXT NOT NULL,
  claimed_cleanup_at TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);

CREATE INDEX event_cleanup_claims_claimed_at_idx
  ON event_cleanup_claims(claimed_at);
