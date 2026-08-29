ALTER TABLE event_records ADD COLUMN poll_close_cutoff_at TEXT;

ALTER TABLE event_votes ADD COLUMN source_wa_msg_id TEXT;
ALTER TABLE event_votes ADD COLUMN received_at TEXT;

CREATE INDEX event_records_poll_close_cutoff_idx
  ON event_records(event_status, group_lifecycle_status, poll_close_cutoff_at);

CREATE TRIGGER event_records_poll_close_cutoff_immutable
BEFORE UPDATE OF poll_close_cutoff_at ON event_records
WHEN OLD.poll_close_cutoff_at IS NOT NULL
  AND NEW.poll_close_cutoff_at IS NOT OLD.poll_close_cutoff_at
  AND NOT (
    NEW.poll_close_cutoff_at IS NULL
    AND NEW.poll_generation > OLD.poll_generation
    AND NEW.poll_wa_msg_id IS NOT OLD.poll_wa_msg_id
  )
BEGIN
  SELECT RAISE(ABORT, 'event poll close cutoff is immutable');
END;
