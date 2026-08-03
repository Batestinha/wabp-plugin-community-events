ALTER TABLE event_records ADD COLUMN provisioning_recovery_generation TEXT;
ALTER TABLE event_records ADD COLUMN provisioning_recovery_attempt INTEGER
  CHECK (provisioning_recovery_attempt IS NULL OR provisioning_recovery_attempt >= 1);
ALTER TABLE event_records ADD COLUMN provisioning_recovery_next_run_at TEXT;

UPDATE event_records
   SET provisioning_recovery_generation = 'migration-' || lower(hex(randomblob(16))),
       provisioning_recovery_attempt = 1,
       provisioning_recovery_next_run_at = updated_at
 WHERE event_status = 'failed'
   AND group_lifecycle_status = 'none'
   AND poll_wa_msg_id IS NOT NULL
   AND subgroup_chat_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_records_provisioning_recovery_idx
  ON event_records(
    event_status,
    group_lifecycle_status,
    provisioning_recovery_next_run_at,
    id
  );
