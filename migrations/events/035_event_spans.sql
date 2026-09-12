ALTER TABLE event_records ADD COLUMN span_kind TEXT NOT NULL DEFAULT 'day_trip';
ALTER TABLE event_records ADD COLUMN ends_at TEXT;

DROP TRIGGER IF EXISTS event_records_actor_identity_update_guard;

UPDATE event_records
   SET ends_at = strftime(
         '%Y-%m-%dT%H:%M:%fZ',
         starts_at,
         printf('+%d minutes', calendar_duration_minutes)
       ),
       span_kind = CASE
         WHEN calendar_duration_minutes < 1440 THEN 'day_trip'
         ELSE 'multi_day'
       END
 WHERE ends_at IS NULL;

CREATE TRIGGER event_records_actor_identity_update_guard
BEFORE UPDATE ON event_records
WHEN NEW.actor_identity_id IS NULL OR trim(NEW.actor_identity_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'event actor identity is required');
END;

CREATE TRIGGER event_records_span_insert_guard
BEFORE INSERT ON event_records
WHEN NEW.ends_at IS NULL
  OR trim(NEW.ends_at) = ''
  OR NEW.span_kind NOT IN ('day_trip', 'multi_day')
  OR unixepoch(NEW.ends_at) IS NULL
  OR unixepoch(NEW.starts_at) IS NULL
  OR typeof(NEW.calendar_duration_minutes) <> 'integer'
  OR unixepoch(NEW.ends_at) - unixepoch(NEW.starts_at) <> NEW.calendar_duration_minutes * 60
  OR (NEW.span_kind = 'day_trip' AND (
    unixepoch(NEW.ends_at) - unixepoch(NEW.starts_at) < 60
    OR unixepoch(NEW.ends_at) - unixepoch(NEW.starts_at) >= 86400
  ))
  OR (NEW.span_kind = 'multi_day' AND (
    unixepoch(NEW.ends_at) - unixepoch(NEW.starts_at) < 86400
    OR unixepoch(NEW.ends_at) - unixepoch(NEW.starts_at) > 2592000
  ))
BEGIN
  SELECT RAISE(ABORT, 'event span is invalid');
END;

CREATE TRIGGER event_records_span_update_guard
BEFORE UPDATE OF starts_at, ends_at, span_kind, calendar_duration_minutes ON event_records
WHEN NEW.ends_at IS NULL
  OR trim(NEW.ends_at) = ''
  OR NEW.span_kind NOT IN ('day_trip', 'multi_day')
  OR unixepoch(NEW.ends_at) IS NULL
  OR unixepoch(NEW.starts_at) IS NULL
  OR typeof(NEW.calendar_duration_minutes) <> 'integer'
  OR unixepoch(NEW.ends_at) - unixepoch(NEW.starts_at) <> NEW.calendar_duration_minutes * 60
  OR (NEW.span_kind = 'day_trip' AND (
    unixepoch(NEW.ends_at) - unixepoch(NEW.starts_at) < 60
    OR unixepoch(NEW.ends_at) - unixepoch(NEW.starts_at) >= 86400
  ))
  OR (NEW.span_kind = 'multi_day' AND (
    unixepoch(NEW.ends_at) - unixepoch(NEW.starts_at) < 86400
    OR unixepoch(NEW.ends_at) - unixepoch(NEW.starts_at) > 2592000
  ))
BEGIN
  SELECT RAISE(ABORT, 'event span is invalid');
END;
