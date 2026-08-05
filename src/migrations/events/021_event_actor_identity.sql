ALTER TABLE event_records ADD COLUMN actor_identity_id TEXT;

CREATE INDEX event_records_actor_identity_idx
  ON event_records(scope_id, actor_identity_id)
  WHERE actor_identity_id IS NOT NULL;
