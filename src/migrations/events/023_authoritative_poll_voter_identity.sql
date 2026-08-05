-- This migration is intentionally additive. The plugin lifecycle migration
-- resolves every durable delivery WID through the platform identity service
-- before it atomically rebuilds this table with the authoritative key.
ALTER TABLE event_votes ADD COLUMN voter_identity_id TEXT;

-- Permit current code to write only explicit identity-keyed rows while the
-- lifecycle finalizer is resolving pre-existing rows. NULL legacy rows remain
-- untouched until that finalizer can rebuild the table atomically.
CREATE UNIQUE INDEX event_votes_identity_transition_idx
  ON event_votes(event_id, voter_identity_id);
