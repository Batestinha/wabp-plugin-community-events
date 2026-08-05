CREATE TRIGGER event_records_actor_identity_insert_guard
BEFORE INSERT ON event_records
WHEN NEW.actor_identity_id IS NULL OR trim(NEW.actor_identity_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'event actor identity is required');
END;

CREATE TRIGGER event_records_actor_identity_update_guard
BEFORE UPDATE OF actor_identity_id ON event_records
WHEN NEW.actor_identity_id IS NULL OR trim(NEW.actor_identity_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'event actor identity is required');
END;
