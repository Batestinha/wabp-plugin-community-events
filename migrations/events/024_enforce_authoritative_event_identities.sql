DROP TRIGGER IF EXISTS event_records_actor_identity_update_guard;

CREATE TRIGGER event_records_actor_identity_update_guard
BEFORE UPDATE ON event_records
WHEN NEW.actor_identity_id IS NULL OR trim(NEW.actor_identity_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'event actor identity is required');
END;
