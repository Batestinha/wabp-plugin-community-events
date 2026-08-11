ALTER TABLE event_group_participants RENAME TO event_group_participants_legacy;

CREATE TABLE event_group_participants (
  event_id TEXT NOT NULL,
  wid TEXT NOT NULL,
  identity_id TEXT,
  evidence_digest TEXT,
  status_code INTEGER,
  message TEXT,
  is_group_creator INTEGER NOT NULL DEFAULT 0,
  is_invite_v4_sent INTEGER NOT NULL DEFAULT 0,
  required_creator_membership_status TEXT
  CHECK (
    required_creator_membership_status IS NULL OR
    required_creator_membership_status IN (
      'initial_create_missing',
      'technical_retry_pending',
      'direct_add_pending',
      'invite_pending',
      'privacy_invite_delivery_uncertain',
      'privacy_action_required',
      'provider_rejection',
      'outcome_ambiguous',
      'direct_add_not_observed',
      'membership_confirmed'
    )
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, wid),
  FOREIGN KEY (event_id) REFERENCES event_records(id) ON DELETE CASCADE,
  CHECK (required_creator_membership_status IS NULL OR identity_id IS NOT NULL)
);

WITH ranked_participants AS (
  SELECT
    participant.*,
    event.actor_identity_id,
    ROW_NUMBER() OVER (
      PARTITION BY participant.event_id
      ORDER BY
        CASE WHEN participant.required_creator_membership_status IS NULL THEN 1 ELSE 0 END,
        participant.created_at DESC,
        participant.wid ASC
    ) AS creator_rank
  FROM event_group_participants_legacy participant
  JOIN event_records event ON event.id = participant.event_id
)
INSERT INTO event_group_participants (
  event_id,
  wid,
  identity_id,
  evidence_digest,
  status_code,
  message,
  is_group_creator,
  is_invite_v4_sent,
  required_creator_membership_status,
  created_at
)
SELECT
  event_id,
  wid,
  CASE
    WHEN required_creator_membership_status IS NOT NULL AND creator_rank = 1
      THEN NULLIF(TRIM(actor_identity_id), '')
    ELSE NULL
  END,
  NULL,
  status_code,
  message,
  is_group_creator,
  is_invite_v4_sent,
  CASE
    WHEN required_creator_membership_status IS NULL
      OR creator_rank <> 1
      OR NULLIF(TRIM(actor_identity_id), '') IS NULL
      THEN NULL
    WHEN required_creator_membership_status = 'manual_join_pending'
      THEN 'outcome_ambiguous'
    ELSE required_creator_membership_status
  END,
  created_at
FROM ranked_participants;

DROP TABLE event_group_participants_legacy;

CREATE UNIQUE INDEX event_group_participants_identity_unique
  ON event_group_participants(event_id, identity_id)
  WHERE identity_id IS NOT NULL;
