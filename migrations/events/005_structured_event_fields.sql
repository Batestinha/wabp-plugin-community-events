ALTER TABLE event_records ADD COLUMN starts_at_utc TEXT;
ALTER TABLE event_records ADD COLUMN local_date TEXT;
ALTER TABLE event_records ADD COLUMN local_time TEXT;
ALTER TABLE event_records ADD COLUMN place TEXT;
ALTER TABLE event_records ADD COLUMN style TEXT;

UPDATE event_records
  SET starts_at_utc = starts_at
  WHERE starts_at_utc IS NULL;

UPDATE event_records
  SET local_date = CASE
      WHEN json_valid(answers_json) THEN json_extract(answers_json, '$.startDate')
      ELSE NULL
    END,
    local_time = CASE
      WHEN json_valid(answers_json) THEN json_extract(answers_json, '$.startTime')
      ELSE NULL
    END,
    place = CASE
      WHEN json_valid(answers_json) THEN json_extract(answers_json, '$.place')
      ELSE NULL
    END,
    style = CASE
      WHEN json_valid(answers_json) THEN json_extract(answers_json, '$.style')
      ELSE NULL
    END
  WHERE answers_json IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_records_scope_local_date_idx
  ON event_records(scope_id, local_date, event_status);
