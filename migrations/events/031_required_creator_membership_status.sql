ALTER TABLE event_group_participants
  ADD COLUMN required_creator_membership_status TEXT
  CHECK (
    required_creator_membership_status IS NULL OR
    required_creator_membership_status IN (
      'initial_create_missing',
      'direct_add_pending',
      'invite_pending',
      'manual_join_pending',
      'membership_confirmed'
    )
  );
