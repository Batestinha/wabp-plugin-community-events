ALTER TABLE event_records ADD COLUMN provisioning_recovery_halted_at TEXT;

-- Existing known-child NULL cursors predate an explicit claimed/halted fence.
-- Preserve their safe terminal behavior; only claims written after this
-- migration may be re-armed automatically after a process restart.
UPDATE event_records
   SET provisioning_recovery_halted_at = updated_at
 WHERE subgroup_chat_id IS NOT NULL
   AND event_status = 'failed'
   AND group_lifecycle_status = 'none'
   AND provisioning_recovery_generation IS NOT NULL
   AND provisioning_recovery_attempt IS NOT NULL
   AND provisioning_recovery_next_run_at IS NULL;
