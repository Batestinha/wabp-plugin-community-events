ALTER TABLE event_records ADD COLUMN lifecycle_complete_at TEXT;

-- Migration 024 deliberately permits unresolved legacy identities to remain
-- until the authoritative identity finalizer runs, while guarding every later
-- UPDATE. Temporarily remove that guard so this unrelated lifecycle backfill
-- does not reject those legacy rows, then restore it exactly.
DROP TRIGGER IF EXISTS event_records_actor_identity_update_guard;

-- lifecycle_complete_at is scheduling-only metadata and does not change the
-- rendered calendar document, so its legacy backfill must not dirty every feed.
DROP TRIGGER IF EXISTS event_records_calendar_dirty_after_update_old;

UPDATE event_records
   SET lifecycle_complete_at = ends_at
 WHERE lifecycle_complete_at IS NULL;

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

CREATE TRIGGER event_records_actor_identity_update_guard
BEFORE UPDATE ON event_records
WHEN NEW.actor_identity_id IS NULL OR trim(NEW.actor_identity_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'event actor identity is required');
END;

CREATE INDEX event_records_lifecycle_complete_idx
  ON event_records(scope_id, event_status, lifecycle_complete_at, id);

CREATE TRIGGER event_records_lifecycle_complete_insert_guard
BEFORE INSERT ON event_records
WHEN NEW.lifecycle_complete_at IS NULL
  OR trim(NEW.lifecycle_complete_at) = ''
  OR unixepoch(NEW.lifecycle_complete_at) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'event lifecycle completion time is required');
END;

CREATE TRIGGER event_records_lifecycle_complete_update_guard
BEFORE UPDATE OF lifecycle_complete_at ON event_records
WHEN NEW.lifecycle_complete_at IS NULL
  OR trim(NEW.lifecycle_complete_at) = ''
  OR unixepoch(NEW.lifecycle_complete_at) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'event lifecycle completion time is required');
END;

CREATE TABLE event_start_time_agreements (
  event_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  band_poll_id TEXT,
  exact_poll_id TEXT,
  organizer_band_poll_id TEXT,
  organizer_time_poll_id TEXT,
  band_closes_at TEXT,
  exact_closes_at TEXT,
  organizer_band_closes_at TEXT,
  organizer_time_closes_at TEXT,
  winning_band TEXT,
  resolved_local_time TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  next_run_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  cancelled_at TEXT,
  FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE CASCADE,
  CHECK (generation > 0),
  CHECK (status IN (
    'pending_subgroup',
    'band_pending',
    'band_open',
    'exact_pending',
    'exact_open',
    'organizer_band_pending',
    'organizer_band_open',
    'organizer_time_pending',
    'organizer_time_open',
    'applying',
    'applied',
    'blocked',
    'cancelled',
    'expired'
  )),
  CHECK (winning_band IS NULL OR winning_band IN ('morning', 'afternoon', 'evening')),
  CHECK (resolved_local_time IS NULL OR resolved_local_time GLOB '[0-2][0-9]:[0-5][0-9]')
);

CREATE INDEX event_start_time_agreements_recovery_idx
  ON event_start_time_agreements(status, next_run_at, lease_expires_at, updated_at);

CREATE UNIQUE INDEX event_start_time_agreements_band_poll_idx
  ON event_start_time_agreements(band_poll_id)
  WHERE band_poll_id IS NOT NULL;

CREATE UNIQUE INDEX event_start_time_agreements_exact_poll_idx
  ON event_start_time_agreements(exact_poll_id)
  WHERE exact_poll_id IS NOT NULL;

CREATE UNIQUE INDEX event_start_time_agreements_organizer_band_poll_idx
  ON event_start_time_agreements(organizer_band_poll_id)
  WHERE organizer_band_poll_id IS NOT NULL;

CREATE UNIQUE INDEX event_start_time_agreements_organizer_time_poll_idx
  ON event_start_time_agreements(organizer_time_poll_id)
  WHERE organizer_time_poll_id IS NOT NULL;
