ALTER TABLE event_records RENAME COLUMN status TO event_status;

ALTER TABLE event_records ADD COLUMN group_lifecycle_status TEXT NOT NULL DEFAULT 'poll_open';
ALTER TABLE event_records ADD COLUMN calendar_status TEXT NOT NULL DEFAULT 'included';

UPDATE event_records
  SET group_lifecycle_status = CASE event_status
      WHEN 'scheduled' THEN 'poll_open'
      WHEN 'closed' THEN 'poll_closed'
      WHEN 'cleanup_failed' THEN 'cleanup_failed'
      WHEN 'cleaned' THEN 'cleaned'
      WHEN 'cancelled' THEN
        CASE
          WHEN cleaned_at IS NOT NULL THEN 'cleaned'
          WHEN closed_at IS NOT NULL THEN 'poll_closed'
          ELSE 'none'
        END
      WHEN 'failed' THEN 'none'
      ELSE 'none'
    END,
    calendar_status = CASE event_status
      WHEN 'cancelled' THEN 'cancelled'
      WHEN 'failed' THEN 'hidden'
      ELSE 'included'
    END
;

UPDATE event_records
  SET event_status = CASE event_status
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'failed' THEN 'failed'
    ELSE 'scheduled'
  END
;

DROP INDEX IF EXISTS event_records_scope_status_idx;
CREATE INDEX IF NOT EXISTS event_records_scope_event_group_idx
  ON event_records(scope_id, event_status, group_lifecycle_status);
CREATE INDEX IF NOT EXISTS event_records_scope_calendar_idx
  ON event_records(scope_id, calendar_status, starts_at);
