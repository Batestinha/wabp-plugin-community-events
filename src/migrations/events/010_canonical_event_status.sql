UPDATE event_records
SET event_status = 'completed',
    error = NULL
WHERE event_status = 'scheduled'
  AND group_lifecycle_status = 'cleaned';

UPDATE event_records
SET event_status = 'active'
WHERE event_status = 'scheduled';
