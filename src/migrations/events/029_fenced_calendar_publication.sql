DROP TABLE event_calendar_repair_leases;

ALTER TABLE event_calendar_publication_status
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE event_calendar_publication_generations (
  scope_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  requested_generation INTEGER NOT NULL CHECK (requested_generation >= 1),
  local_generation INTEGER NOT NULL DEFAULT 0 CHECK (local_generation >= 0),
  completed_generation INTEGER NOT NULL DEFAULT 0 CHECK (completed_generation >= 0),
  lease_token TEXT,
  lease_generation INTEGER,
  lease_expires_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  next_attempt_at TEXT,
  requested_config_fingerprint TEXT,
  document_generation INTEGER,
  document_body TEXT,
  document_sha256 TEXT,
  document_config_fingerprint TEXT,
  document_calendar_json TEXT,
  document_generated_at TEXT,
  document_event_count INTEGER,
  completed_config_fingerprint TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, calendar_id),
  CHECK (local_generation <= requested_generation),
  CHECK (completed_generation <= requested_generation),
  CHECK (requested_config_fingerprint IS NULL OR length(requested_config_fingerprint) = 64),
  CHECK (completed_config_fingerprint IS NULL OR length(completed_config_fingerprint) = 64),
  CHECK (document_generation IS NULL OR document_generation <= requested_generation),
  CHECK (
    (document_generation IS NULL AND document_body IS NULL AND document_sha256 IS NULL AND document_config_fingerprint IS NULL AND document_calendar_json IS NULL AND document_generated_at IS NULL AND document_event_count IS NULL)
    OR
    (document_generation IS NOT NULL AND document_body IS NOT NULL AND length(document_sha256) = 64 AND length(document_config_fingerprint) = 64 AND document_calendar_json IS NOT NULL AND document_generated_at IS NOT NULL AND document_event_count >= 0)
  ),
  CHECK (
    (lease_token IS NULL AND lease_generation IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_token IS NOT NULL AND lease_generation IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX event_calendar_publication_generations_dirty_idx
  ON event_calendar_publication_generations(completed_generation, requested_generation, scope_id, calendar_id);

CREATE INDEX event_calendar_publication_generations_lease_idx
  ON event_calendar_publication_generations(lease_expires_at, scope_id, calendar_id);

-- Existing assigned feeds must enter the fenced recovery queue on upgrade.
-- Publication-status rows are included so an already-empty published feed is
-- also republished under the generation protocol.
INSERT INTO event_calendar_publication_generations (
  scope_id, calendar_id, requested_generation, local_generation,
  completed_generation, lease_token, lease_generation, lease_expires_at,
  failure_count, next_attempt_at, updated_at
)
SELECT scope_id, calendar_id, 1, 0, 0, NULL, NULL, NULL, 0, NULL,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (
    SELECT scope_id, calendar_id
      FROM event_records
     WHERE calendar_ownership_status = 'assigned'
       AND calendar_id IS NOT NULL
       AND calendar_status IN ('included', 'cancelled')
    UNION
    SELECT scope_id, calendar_id
      FROM event_calendar_publication_status
  );

CREATE TRIGGER event_records_calendar_dirty_after_insert
AFTER INSERT ON event_records
WHEN NEW.calendar_ownership_status = 'assigned'
 AND NEW.calendar_id IS NOT NULL
 AND NEW.calendar_status IN ('included', 'cancelled')
BEGIN
  INSERT INTO event_calendar_publication_generations (
    scope_id, calendar_id, requested_generation, local_generation,
    completed_generation, lease_token, lease_generation, lease_expires_at,
    failure_count, next_attempt_at, updated_at
  ) VALUES (
    NEW.scope_id, NEW.calendar_id, 1, 0, 0, NULL, NULL, NULL, 0, NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT(scope_id, calendar_id) DO UPDATE SET
    requested_generation = event_calendar_publication_generations.requested_generation + 1,
    failure_count = 0,
    next_attempt_at = NULL,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER event_records_calendar_dirty_after_delete
AFTER DELETE ON event_records
WHEN OLD.calendar_ownership_status = 'assigned'
 AND OLD.calendar_id IS NOT NULL
 AND OLD.calendar_status IN ('included', 'cancelled')
BEGIN
  INSERT INTO event_calendar_publication_generations (
    scope_id, calendar_id, requested_generation, local_generation,
    completed_generation, lease_token, lease_generation, lease_expires_at,
    failure_count, next_attempt_at, updated_at
  ) VALUES (
    OLD.scope_id, OLD.calendar_id, 1, 0, 0, NULL, NULL, NULL, 0, NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT(scope_id, calendar_id) DO UPDATE SET
    requested_generation = event_calendar_publication_generations.requested_generation + 1,
    failure_count = 0,
    next_attempt_at = NULL,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER event_records_calendar_dirty_after_update_old
AFTER UPDATE ON event_records
WHEN OLD.calendar_ownership_status = 'assigned'
 AND OLD.calendar_id IS NOT NULL
 AND OLD.calendar_status IN ('included', 'cancelled')
BEGIN
  INSERT INTO event_calendar_publication_generations (
    scope_id, calendar_id, requested_generation, local_generation,
    completed_generation, lease_token, lease_generation, lease_expires_at,
    failure_count, next_attempt_at, updated_at
  ) VALUES (
    OLD.scope_id, OLD.calendar_id, 1, 0, 0, NULL, NULL, NULL, 0, NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT(scope_id, calendar_id) DO UPDATE SET
    requested_generation = event_calendar_publication_generations.requested_generation + 1,
    failure_count = 0,
    next_attempt_at = NULL,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER event_records_calendar_dirty_after_update_new_target
AFTER UPDATE ON event_records
WHEN NEW.calendar_ownership_status = 'assigned'
 AND NEW.calendar_id IS NOT NULL
 AND NEW.calendar_status IN ('included', 'cancelled')
 AND (
   OLD.calendar_ownership_status <> 'assigned'
   OR OLD.calendar_id IS NULL
   OR OLD.calendar_status NOT IN ('included', 'cancelled')
   OR OLD.scope_id <> NEW.scope_id
   OR OLD.calendar_id <> NEW.calendar_id
 )
BEGIN
  INSERT INTO event_calendar_publication_generations (
    scope_id, calendar_id, requested_generation, local_generation,
    completed_generation, lease_token, lease_generation, lease_expires_at,
    failure_count, next_attempt_at, updated_at
  ) VALUES (
    NEW.scope_id, NEW.calendar_id, 1, 0, 0, NULL, NULL, NULL, 0, NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT(scope_id, calendar_id) DO UPDATE SET
    requested_generation = event_calendar_publication_generations.requested_generation + 1,
    failure_count = 0,
    next_attempt_at = NULL,
    updated_at = excluded.updated_at;
END;
