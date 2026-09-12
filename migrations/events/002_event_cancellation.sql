ALTER TABLE event_records ADD COLUMN cancelled_at TEXT;
ALTER TABLE event_records ADD COLUMN cancelled_by_wid TEXT;
ALTER TABLE event_records ADD COLUMN cancelled_by_label TEXT;
ALTER TABLE event_records ADD COLUMN cancel_reason TEXT;
