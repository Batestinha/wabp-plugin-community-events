ALTER TABLE event_records ADD COLUMN profile_revision TEXT;

ALTER TABLE event_question_key_renames ADD COLUMN old_profile_revision TEXT;
ALTER TABLE event_question_key_renames ADD COLUMN new_profile_revision TEXT;

CREATE TABLE event_profile_revision_fences (
  scope_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  current_revision TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, profile_id)
);

CREATE TABLE event_profile_retired_revisions (
  scope_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, profile_id, revision)
);

CREATE INDEX event_profile_retired_revisions_operation_idx
  ON event_profile_retired_revisions(operation_id);

-- The revision supplied by event writers is checked in the same SQLite write
-- transaction as the answer mutation. A revision retired by a completed rename
-- can therefore never reintroduce its discarded key, even when the writer read
-- the old profile before the rename began.
CREATE TRIGGER event_profile_revision_insert_guard
BEFORE INSERT ON event_records
WHEN NEW.profile_revision IS NULL
  OR trim(NEW.profile_revision) = ''
  OR (
    EXISTS (
      SELECT 1
        FROM event_profile_revision_fences AS fence
       WHERE fence.scope_id = NEW.scope_id
         AND fence.profile_id = NEW.profile_id
         AND fence.current_revision <> NEW.profile_revision
    )
    AND NOT EXISTS (
      SELECT 1
        FROM event_question_key_renames AS rename
       WHERE rename.scope_id = NEW.scope_id
         AND rename.profile_id = NEW.profile_id
         AND rename.status = 'expanded'
         AND NEW.profile_revision IN (rename.old_profile_revision, rename.new_profile_revision)
    )
    AND EXISTS (
      SELECT 1
        FROM event_profile_retired_revisions AS retired
       WHERE retired.scope_id = NEW.scope_id
         AND retired.profile_id = NEW.profile_id
         AND retired.revision = NEW.profile_revision
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'event profile revision is stale');
END;

CREATE TRIGGER event_profile_revision_update_guard
BEFORE UPDATE OF profile_revision, answers_json, scope_id, profile_id ON event_records
WHEN NEW.profile_revision IS NULL
  OR trim(NEW.profile_revision) = ''
  OR (
    EXISTS (
      SELECT 1
        FROM event_profile_revision_fences AS fence
       WHERE fence.scope_id = NEW.scope_id
         AND fence.profile_id = NEW.profile_id
         AND fence.current_revision <> NEW.profile_revision
    )
    AND NOT EXISTS (
      SELECT 1
        FROM event_question_key_renames AS rename
       WHERE rename.scope_id = NEW.scope_id
         AND rename.profile_id = NEW.profile_id
         AND rename.status = 'expanded'
         AND NEW.profile_revision IN (rename.old_profile_revision, rename.new_profile_revision)
    )
    AND EXISTS (
      SELECT 1
        FROM event_profile_retired_revisions AS retired
       WHERE retired.scope_id = NEW.scope_id
         AND retired.profile_id = NEW.profile_id
         AND retired.revision = NEW.profile_revision
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'event profile revision is stale');
END;

CREATE TRIGGER event_profile_revision_insert_advance
AFTER INSERT ON event_records
WHEN NEW.profile_revision IS NOT NULL
  AND trim(NEW.profile_revision) <> ''
  AND NOT EXISTS (
    SELECT 1
      FROM event_question_key_renames AS rename
     WHERE rename.scope_id = NEW.scope_id
       AND rename.profile_id = NEW.profile_id
       AND rename.status = 'expanded'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM event_profile_retired_revisions AS retired
     WHERE retired.scope_id = NEW.scope_id
       AND retired.profile_id = NEW.profile_id
       AND retired.revision = NEW.profile_revision
  )
BEGIN
  INSERT INTO event_profile_revision_fences (
    scope_id, profile_id, current_revision, updated_at
  ) VALUES (
    NEW.scope_id, NEW.profile_id, NEW.profile_revision, NEW.updated_at
  )
  ON CONFLICT(scope_id, profile_id) DO UPDATE SET
    current_revision = excluded.current_revision,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER event_profile_revision_update_advance
AFTER UPDATE OF profile_revision, answers_json, scope_id, profile_id ON event_records
WHEN NEW.profile_revision IS NOT NULL
  AND trim(NEW.profile_revision) <> ''
  AND NOT EXISTS (
    SELECT 1
      FROM event_question_key_renames AS rename
     WHERE rename.scope_id = NEW.scope_id
       AND rename.profile_id = NEW.profile_id
       AND rename.status = 'expanded'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM event_profile_retired_revisions AS retired
     WHERE retired.scope_id = NEW.scope_id
       AND retired.profile_id = NEW.profile_id
       AND retired.revision = NEW.profile_revision
  )
BEGIN
  INSERT INTO event_profile_revision_fences (
    scope_id, profile_id, current_revision, updated_at
  ) VALUES (
    NEW.scope_id, NEW.profile_id, NEW.profile_revision, NEW.updated_at
  )
  ON CONFLICT(scope_id, profile_id) DO UPDATE SET
    current_revision = excluded.current_revision,
    updated_at = excluded.updated_at;
END;
