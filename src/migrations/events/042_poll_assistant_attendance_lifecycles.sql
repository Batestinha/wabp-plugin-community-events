ALTER TABLE event_records
  ADD COLUMN attendance_lifecycle_owner TEXT NOT NULL DEFAULT 'legacy_events'
  CHECK (attendance_lifecycle_owner IN ('legacy_events', 'poll_assistant'));
ALTER TABLE event_records ADD COLUMN attendance_lifecycle_generation INTEGER;
ALTER TABLE event_records ADD COLUMN attendance_lifecycle_source_key TEXT;
ALTER TABLE event_records
  ADD COLUMN attendance_lifecycle_request_json TEXT
  CHECK (
    attendance_lifecycle_request_json IS NULL
    OR json_valid(attendance_lifecycle_request_json)
  );
ALTER TABLE event_records ADD COLUMN attendance_lifecycle_poll_id TEXT;
ALTER TABLE event_records ADD COLUMN attendance_lifecycle_round_id TEXT;
ALTER TABLE event_records ADD COLUMN attendance_lifecycle_snapshot_sha256 TEXT;
ALTER TABLE event_records
  ADD COLUMN attendance_lifecycle_snapshot_json TEXT
  CHECK (
    attendance_lifecycle_snapshot_json IS NULL
    OR json_valid(attendance_lifecycle_snapshot_json)
  );
ALTER TABLE event_records ADD COLUMN attendance_lifecycle_finalized_at TEXT;
ALTER TABLE event_records ADD COLUMN attendance_lifecycle_cancelled_at TEXT;

ALTER TABLE event_poll_replacements
  ADD COLUMN attendance_lifecycle_owner TEXT NOT NULL DEFAULT 'legacy_events'
  CHECK (attendance_lifecycle_owner IN ('legacy_events', 'poll_assistant'));
ALTER TABLE event_poll_replacements ADD COLUMN attendance_lifecycle_generation INTEGER;
ALTER TABLE event_poll_replacements ADD COLUMN attendance_lifecycle_source_key TEXT;
ALTER TABLE event_poll_replacements
  ADD COLUMN attendance_lifecycle_request_json TEXT
  CHECK (
    attendance_lifecycle_request_json IS NULL
    OR json_valid(attendance_lifecycle_request_json)
  );
ALTER TABLE event_poll_replacements ADD COLUMN attendance_lifecycle_poll_id TEXT;
ALTER TABLE event_poll_replacements ADD COLUMN attendance_lifecycle_round_id TEXT;

CREATE INDEX event_records_attendance_lifecycle_recovery_idx
  ON event_records(
    attendance_lifecycle_owner,
    event_status,
    group_lifecycle_status,
    attendance_lifecycle_cancelled_at,
    poll_wa_msg_id,
    updated_at
  );

CREATE TRIGGER event_records_attendance_lifecycle_shape_insert
BEFORE INSERT ON event_records
WHEN NOT (
  (
    NEW.attendance_lifecycle_owner = 'legacy_events'
    AND NEW.attendance_lifecycle_generation IS NULL
    AND NEW.attendance_lifecycle_source_key IS NULL
    AND NEW.attendance_lifecycle_request_json IS NULL
    AND NEW.attendance_lifecycle_poll_id IS NULL
    AND NEW.attendance_lifecycle_round_id IS NULL
    AND NEW.attendance_lifecycle_snapshot_sha256 IS NULL
    AND NEW.attendance_lifecycle_snapshot_json IS NULL
    AND NEW.attendance_lifecycle_finalized_at IS NULL
    AND NEW.attendance_lifecycle_cancelled_at IS NULL
  )
  OR
  (
    NEW.attendance_lifecycle_owner = 'poll_assistant'
    AND NEW.attendance_lifecycle_generation = NEW.poll_generation
    AND NEW.attendance_lifecycle_source_key IS NOT NULL
    AND trim(NEW.attendance_lifecycle_source_key) <> ''
    AND NEW.attendance_lifecycle_request_json IS NOT NULL
    AND json_valid(NEW.attendance_lifecycle_request_json)
    AND (
      (
        NEW.attendance_lifecycle_poll_id IS NULL
        AND NEW.attendance_lifecycle_round_id IS NULL
        AND NEW.poll_wa_msg_id IS NULL
      )
      OR
      (
        NEW.attendance_lifecycle_poll_id IS NOT NULL
        AND trim(NEW.attendance_lifecycle_poll_id) <> ''
        AND NEW.attendance_lifecycle_round_id IS NOT NULL
        AND trim(NEW.attendance_lifecycle_round_id) <> ''
      )
    )
    AND (
      (
        NEW.attendance_lifecycle_snapshot_sha256 IS NULL
        AND NEW.attendance_lifecycle_snapshot_json IS NULL
        AND NEW.attendance_lifecycle_finalized_at IS NULL
      )
      OR
      (
        length(NEW.attendance_lifecycle_snapshot_sha256) = 64
        AND NEW.attendance_lifecycle_snapshot_json IS NOT NULL
        AND json_valid(NEW.attendance_lifecycle_snapshot_json)
        AND NEW.attendance_lifecycle_finalized_at IS NOT NULL
        AND NEW.poll_wa_msg_id = json_extract(
          NEW.attendance_lifecycle_snapshot_json,
          '$.pollWaMessageId'
        )
        AND NEW.poll_close_cutoff_at = json_extract(
          NEW.attendance_lifecycle_snapshot_json,
          '$.cutoffAt'
        )
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid event attendance lifecycle shape');
END;

CREATE TRIGGER event_records_attendance_lifecycle_shape_update
BEFORE UPDATE ON event_records
WHEN NOT (
  (
    NEW.attendance_lifecycle_owner = 'legacy_events'
    AND NEW.attendance_lifecycle_generation IS NULL
    AND NEW.attendance_lifecycle_source_key IS NULL
    AND NEW.attendance_lifecycle_request_json IS NULL
    AND NEW.attendance_lifecycle_poll_id IS NULL
    AND NEW.attendance_lifecycle_round_id IS NULL
    AND NEW.attendance_lifecycle_snapshot_sha256 IS NULL
    AND NEW.attendance_lifecycle_snapshot_json IS NULL
    AND NEW.attendance_lifecycle_finalized_at IS NULL
    AND NEW.attendance_lifecycle_cancelled_at IS NULL
  )
  OR
  (
    NEW.attendance_lifecycle_owner = 'poll_assistant'
    AND NEW.attendance_lifecycle_generation = NEW.poll_generation
    AND NEW.attendance_lifecycle_source_key IS NOT NULL
    AND trim(NEW.attendance_lifecycle_source_key) <> ''
    AND NEW.attendance_lifecycle_request_json IS NOT NULL
    AND json_valid(NEW.attendance_lifecycle_request_json)
    AND (
      (
        NEW.attendance_lifecycle_poll_id IS NULL
        AND NEW.attendance_lifecycle_round_id IS NULL
        AND NEW.poll_wa_msg_id IS NULL
      )
      OR
      (
        NEW.attendance_lifecycle_poll_id IS NOT NULL
        AND trim(NEW.attendance_lifecycle_poll_id) <> ''
        AND NEW.attendance_lifecycle_round_id IS NOT NULL
        AND trim(NEW.attendance_lifecycle_round_id) <> ''
      )
    )
    AND (
      (
        NEW.attendance_lifecycle_snapshot_sha256 IS NULL
        AND NEW.attendance_lifecycle_snapshot_json IS NULL
        AND NEW.attendance_lifecycle_finalized_at IS NULL
      )
      OR
      (
        length(NEW.attendance_lifecycle_snapshot_sha256) = 64
        AND NEW.attendance_lifecycle_snapshot_json IS NOT NULL
        AND json_valid(NEW.attendance_lifecycle_snapshot_json)
        AND NEW.attendance_lifecycle_finalized_at IS NOT NULL
        AND NEW.poll_wa_msg_id = json_extract(
          NEW.attendance_lifecycle_snapshot_json,
          '$.pollWaMessageId'
        )
        AND NEW.poll_close_cutoff_at = json_extract(
          NEW.attendance_lifecycle_snapshot_json,
          '$.cutoffAt'
        )
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid event attendance lifecycle shape');
END;

CREATE TRIGGER event_records_attendance_lifecycle_immutable
BEFORE UPDATE ON event_records
WHEN OLD.attendance_lifecycle_owner = 'poll_assistant'
  AND (
    NEW.attendance_lifecycle_owner <> 'poll_assistant'
    OR NEW.attendance_lifecycle_generation < OLD.attendance_lifecycle_generation
    OR (
      NEW.attendance_lifecycle_generation = OLD.attendance_lifecycle_generation
      AND (
        NEW.attendance_lifecycle_source_key IS NOT OLD.attendance_lifecycle_source_key
        OR NEW.attendance_lifecycle_request_json IS NOT OLD.attendance_lifecycle_request_json
        OR (
          OLD.attendance_lifecycle_poll_id IS NOT NULL
          AND NEW.attendance_lifecycle_poll_id IS NOT OLD.attendance_lifecycle_poll_id
        )
        OR (
          OLD.attendance_lifecycle_round_id IS NOT NULL
          AND NEW.attendance_lifecycle_round_id IS NOT OLD.attendance_lifecycle_round_id
        )
        OR (
          OLD.poll_wa_msg_id IS NOT NULL
          AND NEW.poll_wa_msg_id IS NOT OLD.poll_wa_msg_id
        )
      )
    )
    OR (
      OLD.attendance_lifecycle_snapshot_json IS NOT NULL
      AND (
        NEW.attendance_lifecycle_snapshot_json IS NOT OLD.attendance_lifecycle_snapshot_json
        OR NEW.attendance_lifecycle_snapshot_sha256 IS NOT OLD.attendance_lifecycle_snapshot_sha256
        OR NEW.attendance_lifecycle_finalized_at IS NOT OLD.attendance_lifecycle_finalized_at
      )
    )
    OR (
      OLD.attendance_lifecycle_cancelled_at IS NOT NULL
      AND NEW.attendance_lifecycle_cancelled_at IS NOT OLD.attendance_lifecycle_cancelled_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'event Poll Assistant attendance lifecycle is immutable');
END;

CREATE TRIGGER event_poll_replacements_attendance_lifecycle_shape_insert
BEFORE INSERT ON event_poll_replacements
WHEN NOT (
  (
    NEW.attendance_lifecycle_owner = 'legacy_events'
    AND NEW.attendance_lifecycle_generation IS NULL
    AND NEW.attendance_lifecycle_source_key IS NULL
    AND NEW.attendance_lifecycle_request_json IS NULL
    AND NEW.attendance_lifecycle_poll_id IS NULL
    AND NEW.attendance_lifecycle_round_id IS NULL
  )
  OR
  (
    NEW.attendance_lifecycle_owner = 'poll_assistant'
    AND NEW.attendance_lifecycle_generation = NEW.old_poll_generation + 1
    AND NEW.attendance_lifecycle_source_key IS NOT NULL
    AND trim(NEW.attendance_lifecycle_source_key) <> ''
    AND NEW.attendance_lifecycle_request_json IS NOT NULL
    AND json_valid(NEW.attendance_lifecycle_request_json)
    AND (
      (
        NEW.attendance_lifecycle_poll_id IS NULL
        AND NEW.attendance_lifecycle_round_id IS NULL
      )
      OR
      (
        NEW.attendance_lifecycle_poll_id IS NOT NULL
        AND trim(NEW.attendance_lifecycle_poll_id) <> ''
        AND NEW.attendance_lifecycle_round_id IS NOT NULL
        AND trim(NEW.attendance_lifecycle_round_id) <> ''
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid replacement attendance lifecycle shape');
END;

CREATE TRIGGER event_poll_replacements_attendance_lifecycle_shape_update
BEFORE UPDATE ON event_poll_replacements
WHEN NOT (
  (
    NEW.attendance_lifecycle_owner = 'legacy_events'
    AND NEW.attendance_lifecycle_generation IS NULL
    AND NEW.attendance_lifecycle_source_key IS NULL
    AND NEW.attendance_lifecycle_request_json IS NULL
    AND NEW.attendance_lifecycle_poll_id IS NULL
    AND NEW.attendance_lifecycle_round_id IS NULL
  )
  OR
  (
    NEW.attendance_lifecycle_owner = 'poll_assistant'
    AND NEW.attendance_lifecycle_generation = NEW.old_poll_generation + 1
    AND NEW.attendance_lifecycle_source_key IS NOT NULL
    AND trim(NEW.attendance_lifecycle_source_key) <> ''
    AND NEW.attendance_lifecycle_request_json IS NOT NULL
    AND json_valid(NEW.attendance_lifecycle_request_json)
    AND (
      (
        NEW.attendance_lifecycle_poll_id IS NULL
        AND NEW.attendance_lifecycle_round_id IS NULL
      )
      OR
      (
        NEW.attendance_lifecycle_poll_id IS NOT NULL
        AND trim(NEW.attendance_lifecycle_poll_id) <> ''
        AND NEW.attendance_lifecycle_round_id IS NOT NULL
        AND trim(NEW.attendance_lifecycle_round_id) <> ''
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid replacement attendance lifecycle shape');
END;

CREATE TRIGGER event_poll_replacements_attendance_lifecycle_immutable
BEFORE UPDATE ON event_poll_replacements
WHEN OLD.attendance_lifecycle_owner = 'poll_assistant'
  AND (
    NEW.attendance_lifecycle_owner <> 'poll_assistant'
    OR NEW.attendance_lifecycle_generation IS NOT OLD.attendance_lifecycle_generation
    OR NEW.attendance_lifecycle_source_key IS NOT OLD.attendance_lifecycle_source_key
    OR NEW.attendance_lifecycle_request_json IS NOT OLD.attendance_lifecycle_request_json
    OR (
      OLD.attendance_lifecycle_poll_id IS NOT NULL
      AND NEW.attendance_lifecycle_poll_id IS NOT OLD.attendance_lifecycle_poll_id
    )
    OR (
      OLD.attendance_lifecycle_round_id IS NOT NULL
      AND NEW.attendance_lifecycle_round_id IS NOT OLD.attendance_lifecycle_round_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'replacement Poll Assistant attendance lifecycle is immutable');
END;
