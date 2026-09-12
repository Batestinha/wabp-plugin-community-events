ALTER TABLE event_records ADD COLUMN calendar_id TEXT;
ALTER TABLE event_records ADD COLUMN calendar_ownership_status TEXT NOT NULL DEFAULT 'unresolved';

CREATE INDEX event_records_scope_calendar_id_idx
  ON event_records(scope_id, calendar_id, calendar_status, starts_at, id);

CREATE TRIGGER event_records_require_resolved_calendar_ownership_insert
BEFORE INSERT ON event_records
FOR EACH ROW
WHEN NEW.calendar_ownership_status NOT IN ('assigned', 'none')
  OR (NEW.calendar_ownership_status = 'assigned' AND (
    NEW.calendar_id IS NULL
    OR trim(NEW.calendar_id) = ''
    OR NEW.calendar_id != trim(NEW.calendar_id)
  ))
  OR (NEW.calendar_ownership_status = 'none' AND NEW.calendar_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'event_records calendar ownership must be resolved');
END;

CREATE TRIGGER event_records_require_immutable_calendar_ownership_update
BEFORE UPDATE OF calendar_id, calendar_ownership_status ON event_records
FOR EACH ROW
WHEN
  (OLD.calendar_ownership_status IN ('assigned', 'none') AND (
    NEW.calendar_ownership_status IS NOT OLD.calendar_ownership_status
    OR NEW.calendar_id IS NOT OLD.calendar_id
  ))
  OR NEW.calendar_ownership_status NOT IN ('assigned', 'none')
  OR (NEW.calendar_ownership_status = 'assigned' AND (
    NEW.calendar_id IS NULL
    OR trim(NEW.calendar_id) = ''
    OR NEW.calendar_id != trim(NEW.calendar_id)
  ))
  OR (NEW.calendar_ownership_status = 'none' AND NEW.calendar_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'event_records calendar ownership is immutable once resolved');
END;
