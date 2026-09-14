ALTER TABLE event_records ADD COLUMN raw_answers_json TEXT;
ALTER TABLE event_announcement_delivery_claims ADD COLUMN template_mentions_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE event_weather_deliveries ADD COLUMN template_mentions_json TEXT NOT NULL DEFAULT '{}';

CREATE TRIGGER event_question_key_renames_raw_insert_conflict
BEFORE INSERT ON event_records
WHEN EXISTS (
  SELECT 1
    FROM event_question_key_renames AS rename
   WHERE rename.status = 'expanded'
     AND rename.scope_id = NEW.scope_id
     AND rename.profile_id = NEW.profile_id
     AND json_type(NEW.raw_answers_json, '$."' || rename.old_key || '"') IS NOT NULL
     AND json_type(NEW.raw_answers_json, '$."' || rename.new_key || '"') IS NOT NULL
     AND json_extract(NEW.raw_answers_json, '$."' || rename.old_key || '"')
         IS NOT json_extract(NEW.raw_answers_json, '$."' || rename.new_key || '"')
)
BEGIN
  SELECT RAISE(ABORT, 'event question-key rename received divergent answers');
END;

CREATE TRIGGER event_question_key_renames_raw_insert_expand
AFTER INSERT ON event_records
WHEN EXISTS (
  SELECT 1
    FROM event_question_key_renames AS rename
   WHERE rename.status = 'expanded'
     AND rename.scope_id = NEW.scope_id
     AND rename.profile_id = NEW.profile_id
     AND (
       (json_type(NEW.raw_answers_json, '$."' || rename.old_key || '"') IS NOT NULL
        AND json_type(NEW.raw_answers_json, '$."' || rename.new_key || '"') IS NULL)
       OR
       (json_type(NEW.raw_answers_json, '$."' || rename.new_key || '"') IS NOT NULL
        AND json_type(NEW.raw_answers_json, '$."' || rename.old_key || '"') IS NULL)
     )
)
BEGIN
  UPDATE event_records
     SET raw_answers_json = (
       SELECT CASE
         WHEN json_type(NEW.raw_answers_json, '$."' || rename.old_key || '"') IS NOT NULL
           THEN json_set(
             NEW.raw_answers_json,
             '$."' || rename.new_key || '"',
             json_extract(NEW.raw_answers_json, '$."' || rename.old_key || '"')
           )
         ELSE json_set(
           NEW.raw_answers_json,
           '$."' || rename.old_key || '"',
           json_extract(NEW.raw_answers_json, '$."' || rename.new_key || '"')
         )
       END
         FROM event_question_key_renames AS rename
        WHERE rename.status = 'expanded'
          AND rename.scope_id = NEW.scope_id
          AND rename.profile_id = NEW.profile_id
     )
   WHERE id = NEW.id;
END;

CREATE TRIGGER event_question_key_renames_raw_update_conflict
BEFORE UPDATE OF raw_answers_json, scope_id, profile_id ON event_records
WHEN EXISTS (
  SELECT 1
    FROM event_question_key_renames AS rename
   WHERE rename.status = 'expanded'
     AND rename.scope_id = NEW.scope_id
     AND rename.profile_id = NEW.profile_id
     AND json_type(NEW.raw_answers_json, '$."' || rename.old_key || '"') IS NOT NULL
     AND json_type(NEW.raw_answers_json, '$."' || rename.new_key || '"') IS NOT NULL
     AND json_extract(NEW.raw_answers_json, '$."' || rename.old_key || '"')
         IS NOT json_extract(NEW.raw_answers_json, '$."' || rename.new_key || '"')
)
BEGIN
  SELECT RAISE(ABORT, 'event question-key rename received divergent answers');
END;

CREATE TRIGGER event_question_key_renames_raw_update_expand
AFTER UPDATE OF raw_answers_json, scope_id, profile_id ON event_records
WHEN EXISTS (
  SELECT 1
    FROM event_question_key_renames AS rename
   WHERE rename.status = 'expanded'
     AND rename.scope_id = NEW.scope_id
     AND rename.profile_id = NEW.profile_id
     AND (
       (json_type(NEW.raw_answers_json, '$."' || rename.old_key || '"') IS NOT NULL
        AND json_type(NEW.raw_answers_json, '$."' || rename.new_key || '"') IS NULL)
       OR
       (json_type(NEW.raw_answers_json, '$."' || rename.new_key || '"') IS NOT NULL
        AND json_type(NEW.raw_answers_json, '$."' || rename.old_key || '"') IS NULL)
     )
)
BEGIN
  UPDATE event_records
     SET raw_answers_json = (
       SELECT CASE
         WHEN json_type(NEW.raw_answers_json, '$."' || rename.old_key || '"') IS NOT NULL
           THEN json_set(
             NEW.raw_answers_json,
             '$."' || rename.new_key || '"',
             json_extract(NEW.raw_answers_json, '$."' || rename.old_key || '"')
           )
         ELSE json_set(
           NEW.raw_answers_json,
           '$."' || rename.old_key || '"',
           json_extract(NEW.raw_answers_json, '$."' || rename.new_key || '"')
         )
       END
         FROM event_question_key_renames AS rename
        WHERE rename.status = 'expanded'
          AND rename.scope_id = NEW.scope_id
          AND rename.profile_id = NEW.profile_id
     )
   WHERE id = NEW.id;
END;
