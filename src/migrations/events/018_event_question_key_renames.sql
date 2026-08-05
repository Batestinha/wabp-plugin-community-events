CREATE TABLE event_question_key_renames (
  operation_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  old_key TEXT NOT NULL,
  new_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('expanded', 'completed', 'rolled_back')),
  migrated_event_count INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (old_key <> new_key)
);

CREATE UNIQUE INDEX event_question_key_renames_active_profile_idx
  ON event_question_key_renames(scope_id, profile_id)
  WHERE status = 'expanded';

CREATE INDEX event_question_key_renames_recovery_idx
  ON event_question_key_renames(status, lease_expires_at, operation_id);

CREATE TRIGGER event_question_key_renames_insert_conflict
BEFORE INSERT ON event_records
WHEN EXISTS (
  SELECT 1
    FROM event_question_key_renames AS rename
   WHERE rename.status = 'expanded'
     AND rename.scope_id = NEW.scope_id
     AND rename.profile_id = NEW.profile_id
     AND json_type(NEW.answers_json, '$."' || rename.old_key || '"') IS NOT NULL
     AND json_type(NEW.answers_json, '$."' || rename.new_key || '"') IS NOT NULL
     AND json_extract(NEW.answers_json, '$."' || rename.old_key || '"')
         IS NOT json_extract(NEW.answers_json, '$."' || rename.new_key || '"')
)
BEGIN
  SELECT RAISE(ABORT, 'event question-key rename received divergent answers');
END;

CREATE TRIGGER event_question_key_renames_insert_expand
AFTER INSERT ON event_records
WHEN EXISTS (
  SELECT 1
    FROM event_question_key_renames AS rename
   WHERE rename.status = 'expanded'
     AND rename.scope_id = NEW.scope_id
     AND rename.profile_id = NEW.profile_id
     AND (
       (json_type(NEW.answers_json, '$."' || rename.old_key || '"') IS NOT NULL
        AND json_type(NEW.answers_json, '$."' || rename.new_key || '"') IS NULL)
       OR
       (json_type(NEW.answers_json, '$."' || rename.new_key || '"') IS NOT NULL
        AND json_type(NEW.answers_json, '$."' || rename.old_key || '"') IS NULL)
     )
)
BEGIN
  UPDATE event_records
     SET answers_json = (
       SELECT CASE
         WHEN json_type(NEW.answers_json, '$."' || rename.old_key || '"') IS NOT NULL
           THEN json_set(
             NEW.answers_json,
             '$."' || rename.new_key || '"',
             json_extract(NEW.answers_json, '$."' || rename.old_key || '"')
           )
         ELSE json_set(
           NEW.answers_json,
           '$."' || rename.old_key || '"',
           json_extract(NEW.answers_json, '$."' || rename.new_key || '"')
         )
       END
         FROM event_question_key_renames AS rename
        WHERE rename.status = 'expanded'
          AND rename.scope_id = NEW.scope_id
          AND rename.profile_id = NEW.profile_id
     )
   WHERE id = NEW.id;
END;

CREATE TRIGGER event_question_key_renames_update_conflict
BEFORE UPDATE OF answers_json, scope_id, profile_id ON event_records
WHEN EXISTS (
  SELECT 1
    FROM event_question_key_renames AS rename
   WHERE rename.status = 'expanded'
     AND rename.scope_id = NEW.scope_id
     AND rename.profile_id = NEW.profile_id
     AND json_type(NEW.answers_json, '$."' || rename.old_key || '"') IS NOT NULL
     AND json_type(NEW.answers_json, '$."' || rename.new_key || '"') IS NOT NULL
     AND json_extract(NEW.answers_json, '$."' || rename.old_key || '"')
         IS NOT json_extract(NEW.answers_json, '$."' || rename.new_key || '"')
)
BEGIN
  SELECT RAISE(ABORT, 'event question-key rename received divergent answers');
END;

CREATE TRIGGER event_question_key_renames_update_expand
AFTER UPDATE OF answers_json, scope_id, profile_id ON event_records
WHEN EXISTS (
  SELECT 1
    FROM event_question_key_renames AS rename
   WHERE rename.status = 'expanded'
     AND rename.scope_id = NEW.scope_id
     AND rename.profile_id = NEW.profile_id
     AND (
       (json_type(NEW.answers_json, '$."' || rename.old_key || '"') IS NOT NULL
        AND json_type(NEW.answers_json, '$."' || rename.new_key || '"') IS NULL)
       OR
       (json_type(NEW.answers_json, '$."' || rename.new_key || '"') IS NOT NULL
        AND json_type(NEW.answers_json, '$."' || rename.old_key || '"') IS NULL)
     )
)
BEGIN
  UPDATE event_records
     SET answers_json = (
       SELECT CASE
         WHEN json_type(NEW.answers_json, '$."' || rename.old_key || '"') IS NOT NULL
           THEN json_set(
             NEW.answers_json,
             '$."' || rename.new_key || '"',
             json_extract(NEW.answers_json, '$."' || rename.old_key || '"')
           )
         ELSE json_set(
           NEW.answers_json,
           '$."' || rename.old_key || '"',
           json_extract(NEW.answers_json, '$."' || rename.new_key || '"')
         )
       END
         FROM event_question_key_renames AS rename
        WHERE rename.status = 'expanded'
          AND rename.scope_id = NEW.scope_id
          AND rename.profile_id = NEW.profile_id
     )
   WHERE id = NEW.id;
END;
