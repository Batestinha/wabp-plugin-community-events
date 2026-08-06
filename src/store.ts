import { randomUUID } from 'node:crypto';
import type { ManagedCommunitySubgroupProvisioningStage } from '../../../platform/pluginRuntime/runtime/pluginCommunityOperations';
import type { PluginPollVote } from '../../../platform/pluginRuntime/types';
import type { CreatedGroupParticipantResult } from '../../../platform/transport/transportTypes';
import { equivalentWhatsAppMessageIds } from '../../../platform/transport/messageIds';
import type { PluginDatabase, PluginDatabaseRow, PluginDatabaseRegistry } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { CalendarPublicationOutcome } from './calendarPublication';
import { EVENTS_DATABASE } from './manifest';

export type EventStatus = 'active' | 'completed' | 'cancelled' | 'failed';
export type EventGroupLifecycleStatus = 'poll_open' | 'poll_closed' | 'cleanup_failed' | 'cleaned' | 'missed' | 'none';
export type EventCalendarStatus = 'included' | 'cancelled' | 'hidden';
export type EventOrigin = 'created' | 'unplanned' | 'adopted_poll' | 'adopted_group' | 'adopted_pair';
export type EventWeatherDeliveryScheduleKind = 'poll-close' | 'daily';
export type EventWeatherDeliveryStatus = 'pending' | 'sending' | 'sent' | 'skipped';
export type EventAnnouncementMessageKind = 'poll' | 'calendar_hint' | 'event_group_hint' | 'event_edit';
export type EventAnnouncementDeliveryKind = Exclude<EventAnnouncementMessageKind, 'poll'>;
export type EventAnnouncementDeliveryClaimStatus = 'pending' | 'sending' | 'sent' | 'uncertain' | 'superseded';
export type EventAnnouncementDeliveryClaimResult = 'claimed' | 'already_sent' | 'already_claimed' | 'superseded';
export type EventEditRepairStatus = 'pending' | 'completed';
export type EventQuestionKeyRenameStatus = 'expanded' | 'completed' | 'rolled_back';
export type UnplannedEventFinalizationStatus = 'pending' | 'completed';

export const EVENT_CLEANUP_CLAIM_LEASE_MS = 15 * 60 * 1000;
export const EVENT_ANNOUNCEMENT_DELIVERY_LEASE_MS = 2 * 60 * 1000;
export const EVENT_CALENDAR_REPAIR_LEASE_MS = 2 * 60 * 1000;
export const EVENT_WEATHER_DELIVERY_LEASE_MS = 5 * 60 * 1000;

export class EventQuestionKeyRenameConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventQuestionKeyRenameConflictError';
  }
}

export interface EventCleanupClaim {
  eventId: string;
  claimId: string;
  expectedEventUpdatedAt: string;
  claimedCleanupAt: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface EventAnnouncementDeliveryIntent {
  scopeId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  chatId: string;
  text: string;
  idempotencyKey: string;
}

export interface EventEditRepairIntent {
  operationId: string;
  scopeId: string;
  subgroupChatId?: string | undefined;
  targetGroupTitle: string;
  calendarId: string;
  announcementDeliveryKey?: string | undefined;
}

export interface StoredEventQuestionKeyRename {
  operationId: string;
  scopeId: string;
  profileId: string;
  oldKey: string;
  newKey: string;
  oldProfileRevision: string;
  newProfileRevision: string;
  status: EventQuestionKeyRenameStatus;
  migratedEventCount: number;
  leaseExpiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredEventPollOption {
  id: string;
  label: string;
  responseClassId: string;
}

export interface StoredEventResponseClass {
  id: string;
  label: string;
  includeInEventGroup: boolean;
  includeInAttendanceCount: boolean;
}

export interface StoredEventLocation {
  source: 'question' | 'fixed';
  displayLabel: string;
  resolvedLabel: string;
  latitude: number;
  longitude: number;
  timezone: string;
  query?: string | undefined;
  provider?: string | undefined;
  providerRef?: string | undefined;
}

export interface StoredEventRecord {
  id: string;
  scopeId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
  profileId: string;
  profileRevision: string;
  profileLabel: string;
  origin: EventOrigin;
  eventStatus: EventStatus;
  groupLifecycleStatus: EventGroupLifecycleStatus;
  calendarStatus: EventCalendarStatus;
  /**
   * The authoritative creator principal. Legacy rows migrated from the
   * WID-only schema have no value and therefore receive no creator privilege.
   */
  actorIdentityId?: string | undefined;
  actorWid: string;
  actorLabel: string;
  announcementGroupWid?: string | undefined;
  pollWaMsgId?: string | undefined;
  pollQuestion?: string | undefined;
  pollOptions: StoredEventPollOption[];
  responseClasses: StoredEventResponseClass[];
  answers: Record<string, string>;
  eventLocation?: StoredEventLocation | undefined;
  startsAt: string;
  startsAtUtc?: string | undefined;
  timezone: string;
  localDate?: string | undefined;
  localTime?: string | undefined;
  place?: string | undefined;
  closeAt: string;
  cleanupAt: string;
  groupTitle: string;
  calendarDurationMinutes: number;
  calendarLocation?: string | undefined;
  calendarDescription?: string | undefined;
  subgroupChatId?: string | undefined;
  subgroupTitle?: string | undefined;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | undefined;
  cleanedAt?: string | undefined;
  cancelledAt?: string | undefined;
  cancelledByWid?: string | undefined;
  cancelledByLabel?: string | undefined;
  cancelReason?: string | undefined;
  error?: string | undefined;
  provisioningRecoveryGeneration?: string | undefined;
  provisioningRecoveryAttempt?: number | undefined;
  provisioningRecoveryNextRunAt?: string | undefined;
}

export interface StoredUnplannedEventFinalization {
  eventId: string;
  scopeId: string;
  eventUpdatedAt: string;
  generation: string;
  attempt: number;
  status: UnplannedEventFinalizationStatus;
  nextRunAt?: string | undefined;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
}

export type NewStoredEventRecord = StoredEventRecord & {
  actorIdentityId: string;
};

export interface StoredEventVote {
  eventId: string;
  voterIdentityId: string;
  voterWid: string;
  selectedOptionIds: string[];
  selectedOptionNames: string[];
  selectedOptionNumbers: number[];
  interactedAt?: string | undefined;
  updatedAt: string;
}

export interface StoredCreatedGroupParticipant {
  eventId: string;
  wid: string;
  statusCode?: number | undefined;
  message?: string | undefined;
  isGroupCreator: boolean;
  isInviteV4Sent: boolean;
  createdAt: string;
}

export interface StoredCalendarPublicationStatus {
  scopeId: string;
  calendarId: string;
  generatedAt: string;
  generatedEventCount: number;
  publicationEnabled: boolean;
  attempted: boolean;
  ok: boolean;
  endpointUrl?: string | undefined;
  feedId?: string | undefined;
  label?: string | undefined;
  subscriptionUrl?: string | undefined;
  calendarUrl?: string | undefined;
  targetUpdatedAt?: string | undefined;
  lastSuccessAt?: string | undefined;
  lastErrorAt?: string | undefined;
  lastError?: string | undefined;
  updatedAt: string;
}

export interface StoredEventWeatherDelivery {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  scheduleKind: EventWeatherDeliveryScheduleKind;
  scheduledAt: string;
  status: EventWeatherDeliveryStatus;
  chatId?: string | undefined;
  meteorologicalText?: string | undefined;
  marineText?: string | undefined;
  meteorologicalIdempotencyKey?: string | undefined;
  marineIdempotencyKey?: string | undefined;
  meteorologicalMessageId?: string | undefined;
  marineMessageId?: string | undefined;
  claimId?: string | undefined;
  leaseExpiresAt?: string | undefined;
  attempt: number;
  nextRunAt?: string | undefined;
  sentAt?: string | undefined;
  skippedAt?: string | undefined;
  error?: string | undefined;
  updatedAt: string;
}

export interface ClaimedEventWeatherDelivery {
  claimId: string;
  delivery: StoredEventWeatherDelivery;
}

export interface StoredEventAnnouncementMessage {
  id: string;
  eventId: string;
  scopeId: string;
  kind: EventAnnouncementMessageKind;
  deliveryKey: string;
  chatId: string;
  messageId: string;
  createdAt: string;
  deletedAt?: string | undefined;
  deleteError?: string | undefined;
}

export interface StoredEventAnnouncementDeliveryClaim {
  eventId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  scopeId: string;
  chatId: string;
  status: EventAnnouncementDeliveryClaimStatus;
  text?: string | undefined;
  idempotencyKey?: string | undefined;
  leaseExpiresAt?: string | undefined;
  messageId?: string | undefined;
  error?: string | undefined;
  claimedAt: string;
  updatedAt: string;
}

export interface StoredEventEditRepair {
  operationId: string;
  eventId: string;
  scopeId: string;
  expectedEventUpdatedAt: string;
  subgroupChatId?: string | undefined;
  targetGroupTitle: string;
  calendarId: string;
  announcementDeliveryKey?: string | undefined;
  status: EventEditRepairStatus;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
}

interface EventRow extends PluginDatabaseRow {
  id: string;
  scope_id: string;
  group_id: string | null;
  group_wid: string | null;
  profile_id: string;
  profile_revision: string | null;
  profile_label: string;
  origin: EventOrigin;
  event_status: EventStatus;
  group_lifecycle_status: EventGroupLifecycleStatus;
  calendar_status: EventCalendarStatus;
  actor_identity_id: string | null;
  actor_wid: string;
  actor_label: string;
  announcement_group_wid: string | null;
  poll_wa_msg_id: string | null;
  poll_question: string | null;
  poll_options_json: string;
  response_classes_json: string;
  answers_json: string;
  event_location_json: string | null;
  starts_at: string;
  starts_at_utc: string | null;
  timezone: string;
  local_date: string | null;
  local_time: string | null;
  place: string | null;
  style: string | null;
  close_at: string;
  cleanup_at: string;
  group_title: string;
  calendar_duration_minutes: number;
  calendar_location: string | null;
  calendar_description: string | null;
  subgroup_chat_id: string | null;
  subgroup_title: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  cleaned_at: string | null;
  cancelled_at: string | null;
  cancelled_by_wid: string | null;
  cancelled_by_label: string | null;
  cancel_reason: string | null;
  error: string | null;
  provisioning_recovery_generation: string | null;
  provisioning_recovery_attempt: number | null;
  provisioning_recovery_next_run_at: string | null;
}

interface VoteRow extends PluginDatabaseRow {
  event_id: string;
  voter_identity_id: string;
  voter_wid: string;
  selected_option_ids_json: string;
  selected_option_names_json: string;
  selected_option_numbers_json: string;
  interacted_at: string | null;
  updated_at: string;
}

interface CalendarPublicationStatusRow extends PluginDatabaseRow {
  scope_id: string;
  calendar_id: string;
  generated_at: string;
  generated_event_count: number;
  publication_enabled: number;
  attempted: number;
  ok: number;
  endpoint_url: string | null;
  feed_id: string | null;
  label: string | null;
  subscription_url: string | null;
  calendar_url: string | null;
  target_updated_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  updated_at: string;
}

interface EventWeatherDeliveryRow extends PluginDatabaseRow {
  event_id: string;
  event_updated_at: string;
  kind: string;
  schedule_kind: EventWeatherDeliveryScheduleKind;
  scheduled_at: string;
  status: EventWeatherDeliveryStatus;
  chat_id: string | null;
  meteorological_text: string | null;
  marine_text: string | null;
  meteorological_idempotency_key: string | null;
  marine_idempotency_key: string | null;
  meteorological_message_id: string | null;
  marine_message_id: string | null;
  claim_id: string | null;
  lease_expires_at: string | null;
  attempt: number;
  next_run_at: string | null;
  sent_at: string | null;
  skipped_at: string | null;
  error: string | null;
  updated_at: string;
}

interface EventAnnouncementMessageRow extends PluginDatabaseRow {
  id: string;
  event_id: string;
  scope_id: string;
  kind: EventAnnouncementMessageKind;
  delivery_key: string;
  chat_id: string;
  message_id: string;
  created_at: string;
  deleted_at: string | null;
  delete_error: string | null;
}

interface EventAnnouncementDeliveryClaimRow extends PluginDatabaseRow {
  event_id: string;
  kind: EventAnnouncementDeliveryKind;
  delivery_key: string;
  scope_id: string;
  chat_id: string;
  status: EventAnnouncementDeliveryClaimStatus;
  text: string | null;
  idempotency_key: string | null;
  lease_expires_at: string | null;
  message_id: string | null;
  error: string | null;
  claimed_at: string;
  updated_at: string;
}

interface UnplannedEventFinalizationRow extends PluginDatabaseRow {
  event_id: string;
  scope_id: string;
  event_updated_at: string;
  generation: string;
  attempt: number;
  next_run_at: string | null;
  status: UnplannedEventFinalizationStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface EventEditRepairRow extends PluginDatabaseRow {
  operation_id: string;
  event_id: string;
  scope_id: string;
  expected_event_updated_at: string;
  subgroup_chat_id: string | null;
  target_group_title: string;
  calendar_id: string;
  announcement_delivery_key: string | null;
  status: EventEditRepairStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface EventCleanupClaimRow extends PluginDatabaseRow {
  event_id: string;
  claim_id: string;
  expected_event_updated_at: string;
  claimed_cleanup_at: string;
  claimed_at: string;
  lease_expires_at: string;
}

interface EventQuestionKeyRenameRow extends PluginDatabaseRow {
  operation_id: string;
  scope_id: string;
  profile_id: string;
  old_key: string;
  new_key: string;
  old_profile_revision: string | null;
  new_profile_revision: string | null;
  status: EventQuestionKeyRenameStatus;
  migrated_event_count: number;
  lease_expires_at: string;
  created_at: string;
  updated_at: string;
}

export function eventsDatabase(registry: PluginDatabaseRegistry | undefined): PluginDatabase {
  if (!registry) {
    throw new Error('official.community-events requires its plugin database registry.');
  }
  return registry.open(EVENTS_DATABASE);
}

export function newEventId(): string {
  return `evt-${randomUUID().slice(0, 8)}`;
}

export function beginEventQuestionKeyRename(db: PluginDatabase, input: {
  operationId: string;
  scopeId: string;
  profileId: string;
  oldKey: string;
  newKey: string;
  oldProfileRevision: string;
  newProfileRevision: string;
  leaseExpiresAt: string;
  createdAt?: string | undefined;
}): StoredEventQuestionKeyRename {
  if (!input.oldProfileRevision.trim() || !input.newProfileRevision.trim()) {
    throw new EventQuestionKeyRenameConflictError('Event profile revisions are required for a question-key rename.');
  }
  return db.transaction(() => {
    const active = db.get<EventQuestionKeyRenameRow>(
      `SELECT *
         FROM event_question_key_renames
        WHERE scope_id = ? AND profile_id = ? AND status = 'expanded'
        LIMIT 1`,
      input.scopeId,
      input.profileId
    );
    if (active) {
      throw new EventQuestionKeyRenameConflictError(
        `Question-key rename ${active.operation_id} is already in progress for event profile ${input.profileId}.`
      );
    }

    const now = input.createdAt ?? new Date().toISOString();
    const retiredOldRevision = db.get<{ revision: string }>(
      `SELECT revision
         FROM event_profile_retired_revisions
        WHERE scope_id = ? AND profile_id = ? AND revision = ?`,
      input.scopeId,
      input.profileId,
      input.oldProfileRevision
    );
    if (retiredOldRevision) {
      throw new EventQuestionKeyRenameConflictError(
        `Event profile ${input.profileId} is using a retired question schema revision.`
      );
    }
    // The CAS-validated operator config is authoritative. Ordinary profile
    // edits may not have written an event yet, so advance a non-retired fence
    // to the schema from which this rename is starting.
    db.run(
      `INSERT INTO event_profile_revision_fences (
         scope_id, profile_id, current_revision, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope_id, profile_id) DO UPDATE SET
         current_revision = excluded.current_revision,
         updated_at = excluded.updated_at`,
      input.scopeId,
      input.profileId,
      input.oldProfileRevision,
      now
    );

    const rows = db.all<{ id: string; answers_json: string }>(
      `SELECT id, answers_json
         FROM event_records
        WHERE scope_id = ? AND profile_id = ?`,
      input.scopeId,
      input.profileId
    );
    let migratedEventCount = 0;
    for (const row of rows) {
      const answers = parseEventAnswersForQuestionKeyRename(row.id, row.answers_json);
      if (Object.hasOwn(answers, input.newKey)) {
        throw new EventQuestionKeyRenameConflictError(
          Object.hasOwn(answers, input.oldKey)
            ? `Event ${row.id} already contains both ${input.oldKey} and ${input.newKey}; resolve the collision before renaming.`
            : `Event ${row.id} already contains ${input.newKey}; resolve the stored-answer collision before renaming.`
        );
      }
      if (Object.hasOwn(answers, input.oldKey)) {
        migratedEventCount += 1;
      }
    }

    db.run(
      `INSERT INTO event_question_key_renames (
         operation_id, scope_id, profile_id, old_key, new_key,
         old_profile_revision, new_profile_revision, status,
         migrated_event_count, lease_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'expanded', ?, ?, ?, ?)`,
      input.operationId,
      input.scopeId,
      input.profileId,
      input.oldKey,
      input.newKey,
      input.oldProfileRevision,
      input.newProfileRevision,
      migratedEventCount,
      input.leaseExpiresAt,
      now,
      now
    );

    const oldPath = eventAnswerJsonPath(input.oldKey);
    const newPath = eventAnswerJsonPath(input.newKey);
    db.run(
      `UPDATE event_records
          SET answers_json = json_set(answers_json, ?, json_extract(answers_json, ?)),
              profile_revision = ?
        WHERE scope_id = ?
          AND profile_id = ?
          AND json_type(answers_json, ?) IS NOT NULL`,
      newPath,
      oldPath,
      input.oldProfileRevision,
      input.scopeId,
      input.profileId,
      oldPath
    );

    return eventQuestionKeyRenameFromRow(requireEventQuestionKeyRenameRow(db, input.operationId));
  });
}

export function renewEventQuestionKeyRenameLease(db: PluginDatabase, input: {
  operationId: string;
  leaseExpiresAt: string;
  updatedAt?: string | undefined;
}): boolean {
  const result = db.run(
    `UPDATE event_question_key_renames
        SET lease_expires_at = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'expanded'`,
    input.leaseExpiresAt,
    input.updatedAt ?? new Date().toISOString(),
    input.operationId
  );
  return result.changes === 1;
}

export function listPendingEventQuestionKeyRenames(
  db: PluginDatabase,
  input: { scopeId?: string | undefined; operationId?: string | undefined } = {}
): StoredEventQuestionKeyRename[] {
  const clauses = ["status = 'expanded'"];
  const params: string[] = [];
  if (input.scopeId) {
    clauses.push('scope_id = ?');
    params.push(input.scopeId);
  }
  if (input.operationId) {
    clauses.push('operation_id = ?');
    params.push(input.operationId);
  }
  return db.all<EventQuestionKeyRenameRow>(
    `SELECT *
       FROM event_question_key_renames
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at ASC, operation_id ASC`,
    ...params
  ).map(eventQuestionKeyRenameFromRow);
}

export function settleEventQuestionKeyRename(db: PluginDatabase, input: {
  operationId: string;
  authority: 'old' | 'new';
  authorityRevision: string;
  settledAt?: string | undefined;
}): StoredEventQuestionKeyRename {
  if (!input.authorityRevision.trim()) {
    throw new EventQuestionKeyRenameConflictError('The authoritative event profile revision is required.');
  }
  return db.transaction(() => {
    const row = requireEventQuestionKeyRenameRow(db, input.operationId);
    if (row.status !== 'expanded') {
      return eventQuestionKeyRenameFromRow(row);
    }
    const settledAt = input.settledAt ?? new Date().toISOString();
    const status: EventQuestionKeyRenameStatus = input.authority === 'new' ? 'completed' : 'rolled_back';

    // Disable the dual-write triggers inside this transaction before contracting.
    // The status change and answer contraction commit or roll back together.
    const claimed = db.run(
      `UPDATE event_question_key_renames
          SET status = ?, updated_at = ?
        WHERE operation_id = ? AND status = 'expanded'`,
      status,
      settledAt,
      input.operationId
    );
    if (claimed.changes !== 1) {
      throw new EventQuestionKeyRenameConflictError(
        `Question-key rename ${input.operationId} changed while it was being settled.`
      );
    }

    const oldPath = eventAnswerJsonPath(row.old_key);
    const newPath = eventAnswerJsonPath(row.new_key);
    const authoritativePath = input.authority === 'new' ? newPath : oldPath;
    const discardedPath = input.authority === 'new' ? oldPath : newPath;
    const discardedRevision = input.authority === 'new'
      ? row.old_profile_revision
      : row.new_profile_revision;
    db.run(
      `DELETE FROM event_profile_retired_revisions
        WHERE scope_id = ? AND profile_id = ? AND revision = ?`,
      row.scope_id,
      row.profile_id,
      input.authorityRevision
    );
    if (discardedRevision && discardedRevision !== input.authorityRevision) {
      db.run(
        `INSERT INTO event_profile_retired_revisions (
           scope_id, profile_id, revision, operation_id, retired_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope_id, profile_id, revision) DO UPDATE SET
           operation_id = excluded.operation_id,
           retired_at = excluded.retired_at`,
        row.scope_id,
        row.profile_id,
        discardedRevision,
        row.operation_id,
        settledAt
      );
    }
    db.run(
      `INSERT INTO event_profile_revision_fences (
         scope_id, profile_id, current_revision, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope_id, profile_id) DO UPDATE SET
         current_revision = excluded.current_revision,
         updated_at = excluded.updated_at`,
      row.scope_id,
      row.profile_id,
      input.authorityRevision,
      settledAt
    );
    db.run(
      `UPDATE event_records
          SET answers_json = json_remove(
            CASE
              WHEN json_type(answers_json, ?) IS NULL
                   AND json_type(answers_json, ?) IS NOT NULL
                THEN json_set(answers_json, ?, json_extract(answers_json, ?))
              ELSE answers_json
            END,
            ?
          ),
              profile_revision = ?
        WHERE scope_id = ?
          AND profile_id = ?`,
      authoritativePath,
      discardedPath,
      authoritativePath,
      discardedPath,
      discardedPath,
      input.authorityRevision,
      row.scope_id,
      row.profile_id
    );

    return eventQuestionKeyRenameFromRow(requireEventQuestionKeyRenameRow(db, input.operationId));
  });
}

export function insertEvent(
  db: PluginDatabase,
  event: NewStoredEventRecord
): void {
  const actorIdentityId = event.actorIdentityId.trim();
  if (!actorIdentityId) {
    throw new Error('An authoritative actor identity id is required for new event records.');
  }
  db.run(
    `INSERT INTO event_records (
      id, scope_id, group_id, group_wid, profile_id, profile_revision, profile_label, origin,
      event_status, group_lifecycle_status, calendar_status, actor_identity_id, actor_wid, actor_label,
      announcement_group_wid, poll_wa_msg_id, poll_question, poll_options_json, response_classes_json,
      answers_json, event_location_json, starts_at, starts_at_utc, timezone, local_date, local_time, place, style,
      close_at, cleanup_at, group_title,
      calendar_duration_minutes, calendar_location, calendar_description, subgroup_chat_id, subgroup_title,
      created_at, updated_at, closed_at, cleaned_at, cancelled_at, cancelled_by_wid, cancelled_by_label,
      cancel_reason, error, provisioning_recovery_generation, provisioning_recovery_attempt,
      provisioning_recovery_next_run_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id,
    event.scopeId,
    event.groupId ?? null,
    event.groupWid ?? null,
    event.profileId,
    event.profileRevision,
    event.profileLabel,
    event.origin,
    event.eventStatus,
    event.groupLifecycleStatus,
    event.calendarStatus,
    actorIdentityId,
    event.actorWid,
    event.actorLabel,
    event.announcementGroupWid ?? null,
    event.pollWaMsgId ?? null,
    event.pollQuestion ?? null,
    JSON.stringify(event.pollOptions),
    JSON.stringify(event.responseClasses),
    JSON.stringify(event.answers),
    event.eventLocation ? JSON.stringify(event.eventLocation) : null,
    event.startsAt,
    event.startsAtUtc || event.startsAt,
    event.timezone,
    event.localDate ?? null,
    event.localTime ?? null,
    event.place ?? null,
    null,
    event.closeAt,
    event.cleanupAt,
    event.groupTitle,
    event.calendarDurationMinutes,
    event.calendarLocation ?? null,
    event.calendarDescription ?? null,
    event.subgroupChatId ?? null,
    event.subgroupTitle ?? null,
    event.createdAt,
    event.updatedAt,
    event.closedAt ?? null,
    event.cleanedAt ?? null,
    event.cancelledAt ?? null,
    event.cancelledByWid ?? null,
    event.cancelledByLabel ?? null,
    event.cancelReason ?? null,
    event.error ?? null,
    event.provisioningRecoveryGeneration ?? null,
    event.provisioningRecoveryAttempt ?? null,
    event.provisioningRecoveryNextRunAt ?? null
  );
}

export function updateEventStructuredData(db: PluginDatabase, input: {
  eventId: string;
  profileRevision: string;
  pollQuestion: string;
  pollOptions: StoredEventPollOption[];
  responseClasses: StoredEventResponseClass[];
  answers: Record<string, string>;
  eventLocation?: StoredEventLocation | undefined;
  startsAt: string;
  startsAtUtc: string;
  timezone: string;
  localDate: string;
  localTime?: string | undefined;
  place?: string | undefined;
  closeAt: string;
  cleanupAt: string;
  groupTitle: string;
  calendarDurationMinutes: number;
  calendarLocation?: string | undefined;
  calendarDescription?: string | undefined;
  expectedUpdatedAt: string;
  updatedAt: string;
  completeEvent?: boolean | undefined;
  announcementIntent?: EventAnnouncementDeliveryIntent | undefined;
  repairIntent?: EventEditRepairIntent | undefined;
}): boolean {
  return db.transaction(() => {
    const result = db.run(
      `UPDATE event_records
        SET event_status = CASE WHEN ? = 1 THEN 'completed' ELSE event_status END,
            poll_question = ?,
            poll_options_json = ?,
            response_classes_json = ?,
            answers_json = ?,
            profile_revision = ?,
            event_location_json = ?,
            starts_at = ?,
            starts_at_utc = ?,
            timezone = ?,
            local_date = ?,
            local_time = ?,
            place = ?,
            style = ?,
            close_at = ?,
            cleanup_at = ?,
            group_title = ?,
            subgroup_title = CASE WHEN subgroup_chat_id IS NOT NULL THEN ? ELSE subgroup_title END,
            calendar_duration_minutes = ?,
            calendar_location = ?,
            calendar_description = ?,
            updated_at = ?
      WHERE id = ?
        AND updated_at = ?
        AND (? = 0 OR (event_status = 'active' AND group_lifecycle_status <> 'poll_open'))
        AND NOT EXISTS (
          SELECT 1
            FROM event_cleanup_claims
           WHERE event_cleanup_claims.event_id = event_records.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM event_announcement_delivery_claims
           WHERE event_announcement_delivery_claims.event_id = event_records.id
             AND event_announcement_delivery_claims.kind = 'event_edit'
             AND event_announcement_delivery_claims.status = 'sending'
        )
        AND NOT EXISTS (
          SELECT 1
            FROM event_edit_repairs
           WHERE event_edit_repairs.event_id = event_records.id
             AND event_edit_repairs.status = 'pending'
        )`,
      input.completeEvent ? 1 : 0,
      input.pollQuestion,
      JSON.stringify(input.pollOptions),
      JSON.stringify(input.responseClasses),
      JSON.stringify(input.answers),
      input.profileRevision,
      input.eventLocation ? JSON.stringify(input.eventLocation) : null,
      input.startsAt,
      input.startsAtUtc,
      input.timezone,
      input.localDate,
      input.localTime ?? null,
      input.place ?? null,
      null,
      input.closeAt,
      input.cleanupAt,
      input.groupTitle,
      input.groupTitle,
      input.calendarDurationMinutes,
      input.calendarLocation ?? null,
      input.calendarDescription ?? null,
      input.updatedAt,
      input.eventId,
      input.expectedUpdatedAt,
      input.completeEvent ? 1 : 0
    );
    if (result.changes !== 1) {
      return false;
    }

    if (input.announcementIntent) {
      const intent = normalizedEventAnnouncementIntent(input.announcementIntent);
      const inserted = db.run(
        `INSERT INTO event_announcement_delivery_claims (
           event_id, kind, delivery_key, scope_id, chat_id, status, text, idempotency_key,
           lease_expires_at, message_id, error, claimed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(event_id, kind, delivery_key) DO NOTHING`,
        input.eventId,
        intent.kind,
        intent.deliveryKey,
        intent.scopeId,
        intent.chatId,
        intent.text,
        intent.idempotencyKey,
        input.updatedAt,
        input.updatedAt
      );
      if (inserted.changes !== 1) {
        throw new Error(
          `Event announcement operation ${intent.deliveryKey} already exists for event ${input.eventId}.`
        );
      }
    }

    if (input.repairIntent) {
      const repair = normalizedEventEditRepairIntent(input.repairIntent);
      const inserted = db.run(
        `INSERT INTO event_edit_repairs (
           operation_id, event_id, scope_id, expected_event_updated_at, subgroup_chat_id,
           target_group_title, calendar_id, announcement_delivery_key, status, last_error,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)
         ON CONFLICT(operation_id) DO NOTHING`,
        repair.operationId,
        input.eventId,
        repair.scopeId,
        input.updatedAt,
        repair.subgroupChatId ?? null,
        repair.targetGroupTitle,
        repair.calendarId,
        repair.announcementDeliveryKey ?? null,
        input.updatedAt,
        input.updatedAt
      );
      if (inserted.changes !== 1) {
        throw new Error(`Event edit repair operation ${repair.operationId} already exists.`);
      }
    }
    return true;
  });
}

export function updateEventSubgroupTitle(db: PluginDatabase, input: {
  eventId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  updatedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET subgroup_title = ?, updated_at = ?
      WHERE id = ?
        AND subgroup_chat_id = ?
        AND origin = 'adopted_group'
        AND event_status = 'active'
        AND group_lifecycle_status = 'poll_closed'
        AND subgroup_title IS NULL`,
    input.subgroupTitle,
    input.updatedAt,
    input.eventId,
    input.subgroupChatId
  );
  return result.changes === 1;
}

export function getEvent(db: PluginDatabase, eventId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>('SELECT * FROM event_records WHERE id = ?', eventId);
  return row ? eventFromRow(row) : undefined;
}

export function getEventByPoll(db: PluginDatabase, pollWaMsgId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>('SELECT * FROM event_records WHERE poll_wa_msg_id = ?', pollWaMsgId);
  return row ? eventFromRow(row) : undefined;
}

export function getEventByEquivalentPoll(db: PluginDatabase, pollWaMsgId: string): StoredEventRecord | undefined {
  const exact = getEventByPoll(db, pollWaMsgId);
  if (exact) {
    return exact;
  }
  const rows = db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE poll_wa_msg_id IS NOT NULL
        AND event_status = 'active'
        AND group_lifecycle_status IN ('poll_open', 'poll_closed', 'cleanup_failed')
      ORDER BY starts_at ASC, id ASC`
  );
  const row = rows.find((candidate) => equivalentWhatsAppMessageIds(candidate.poll_wa_msg_id ?? undefined, pollWaMsgId));
  return row ? eventFromRow(row) : undefined;
}

export function getActiveEventByPoll(db: PluginDatabase, pollWaMsgId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>(
    `SELECT * FROM event_records
      WHERE poll_wa_msg_id = ?
        AND event_status = 'active'
        AND group_lifecycle_status IN ('poll_open', 'poll_closed', 'cleanup_failed')
      ORDER BY starts_at ASC, id ASC
      LIMIT 1`,
    pollWaMsgId
  );
  return row ? eventFromRow(row) : undefined;
}

export function getLiveEventBySubgroup(db: PluginDatabase, subgroupChatId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>(
    `SELECT * FROM event_records
      WHERE subgroup_chat_id = ?
        AND (
          (event_status = 'active' AND group_lifecycle_status IN ('poll_open', 'poll_closed', 'cleanup_failed'))
          OR (event_status = 'completed' AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed'))
        )
      ORDER BY starts_at ASC, id ASC
      LIMIT 1`,
    subgroupChatId
  );
  return row ? eventFromRow(row) : undefined;
}

export function listEventsBySubgroupChatId(
  db: PluginDatabase,
  scopeId: string,
  subgroupChatId: string
): StoredEventRecord[] {
  const rows = db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE scope_id = ?
        AND subgroup_chat_id = ?
        AND (
          (event_status = 'active' AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed'))
          OR (event_status = 'completed' AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed', 'cleaned'))
        )
      ORDER BY starts_at ASC, id ASC`,
    scopeId,
    subgroupChatId
  );
  return rows.map(eventFromRow);
}

export function listCancellableEvents(db: PluginDatabase, scopeId: string): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE scope_id = ?
        AND event_status = 'active'
        AND group_lifecycle_status IN ('poll_open', 'poll_closed', 'cleanup_failed')
      ORDER BY starts_at ASC, id ASC`,
    scopeId
  ).map(eventFromRow);
}

export function listPendingCleanupEvents(db: PluginDatabase): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE event_status IN ('active', 'completed')
        AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed')
      ORDER BY cleanup_at ASC, id ASC`
  ).map(eventFromRow);
}

export function listWeatherForecastCandidateEvents(db: PluginDatabase): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE event_records.event_status = 'active'
        AND event_records.group_lifecycle_status IN ('poll_closed', 'cleanup_failed')
        AND event_records.subgroup_chat_id IS NOT NULL
      ORDER BY event_records.starts_at ASC, event_records.id ASC`
  ).map(eventFromRow);
}

export function listOpenPollEvents(db: PluginDatabase): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE event_status = 'active'
        AND group_lifecycle_status = 'poll_open'
        AND poll_wa_msg_id IS NOT NULL
      ORDER BY close_at ASC, starts_at ASC, id ASC`
  ).map(eventFromRow);
}

export function listFailedProvisioningEvents(db: PluginDatabase): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE event_status = 'failed'
        AND group_lifecycle_status = 'none'
        AND subgroup_chat_id IS NOT NULL
      ORDER BY updated_at ASC, id ASC`
  ).map(eventFromRow);
}

export function updateEventCloseAt(db: PluginDatabase, input: {
  eventId: string;
  closeAt: string;
  updatedAt: string;
}): void {
  db.run(
    `UPDATE event_records
        SET close_at = ?, updated_at = ?
      WHERE id = ?
        AND event_status = 'active'
        AND group_lifecycle_status = 'poll_open'`,
    input.closeAt,
    input.updatedAt,
    input.eventId
  );
}

export function markEventProvisioningResumed(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  resumedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET event_status = 'active',
            group_lifecycle_status = 'poll_open',
            calendar_status = 'included',
            subgroup_chat_id = ?,
            subgroup_title = ?,
            error = NULL,
            provisioning_recovery_generation = NULL,
            provisioning_recovery_attempt = NULL,
            provisioning_recovery_next_run_at = NULL,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status = 'none'
        AND (subgroup_chat_id IS NULL OR subgroup_chat_id = ?)`,
    input.subgroupChatId,
    input.subgroupTitle,
    input.resumedAt,
    input.eventId,
    input.scopeId,
    input.subgroupChatId
  );
  return result.changes === 1;
}

export function checkpointEventProvisioningCandidate(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  participants: Record<string, CreatedGroupParticipantResult>;
  checkpointedAt: string;
  reason?: string | undefined;
}): boolean {
  return db.transaction(() => {
    const current = db.get<{ id: string }>(
      `SELECT id
         FROM event_records
        WHERE id = ?
          AND scope_id = ?
          AND event_status = 'failed'
          AND group_lifecycle_status = 'none'
          AND (subgroup_chat_id IS NULL OR subgroup_chat_id = ?)`,
      input.eventId,
      input.scopeId,
      input.subgroupChatId
    );
    if (!current) {
      return false;
    }

    db.run('DELETE FROM event_group_participants WHERE event_id = ?', input.eventId);
    writeCreatedGroupParticipants(
      db,
      input.eventId,
      input.participants,
      input.checkpointedAt
    );
    const result = db.run(
      `UPDATE event_records
          SET subgroup_chat_id = ?,
              subgroup_title = ?,
              error = COALESCE(?, error),
              updated_at = ?
        WHERE id = ?
          AND scope_id = ?
          AND event_status = 'failed'
          AND group_lifecycle_status = 'none'
          AND (subgroup_chat_id IS NULL OR subgroup_chat_id = ?)`,
      input.subgroupChatId,
      input.subgroupTitle,
      input.reason ?? null,
      input.checkpointedAt,
      input.eventId,
      input.scopeId,
      input.subgroupChatId
    );
    if (result.changes !== 1) {
      throw new Error(`Event ${input.eventId} changed while checkpointing its provisioning candidate.`);
    }
    return true;
  });
}

export interface UnplannedEventProvisioningProgress {
  standaloneRegistered: boolean;
  attendeesVerified: boolean;
  communityLinkConfirmed: boolean;
  linkedChildRegistered: boolean;
}

export function checkpointUnplannedEventProvisioningFailure(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  participants: Record<string, CreatedGroupParticipantResult>;
  parentCommunityWid: string;
  stage: ManagedCommunitySubgroupProvisioningStage;
  progress: UnplannedEventProvisioningProgress;
  reason: string;
  failedAt: string;
  recoveryGeneration: string;
  recoveryAttempt: number;
  recoveryNextRunAt: string;
}): boolean {
  return db.transaction(() => {
    const current = db.get<{ id: string }>(
      `SELECT id
         FROM event_records
        WHERE id = ?
          AND scope_id = ?
          AND origin = 'unplanned'
          AND event_status = 'failed'
          AND group_lifecycle_status = 'none'
          AND calendar_status = 'hidden'
          AND (subgroup_chat_id IS NULL OR subgroup_chat_id = ?)`,
      input.eventId,
      input.scopeId,
      input.subgroupChatId
    );
    if (!current) {
      return false;
    }

    db.run('DELETE FROM event_group_participants WHERE event_id = ?', input.eventId);
    writeCreatedGroupParticipants(db, input.eventId, input.participants, input.failedAt);
    const result = db.run(
      `UPDATE event_records
          SET subgroup_chat_id = ?,
              subgroup_title = ?,
              error = ?,
              provisioning_recovery_generation = ?,
              provisioning_recovery_attempt = ?,
              provisioning_recovery_next_run_at = ?,
              updated_at = ?
        WHERE id = ?
          AND scope_id = ?
          AND origin = 'unplanned'
          AND event_status = 'failed'
          AND group_lifecycle_status = 'none'
          AND calendar_status = 'hidden'
          AND (subgroup_chat_id IS NULL OR subgroup_chat_id = ?)`,
      input.subgroupChatId,
      input.subgroupTitle,
      input.reason,
      input.recoveryGeneration,
      input.recoveryAttempt,
      input.recoveryNextRunAt,
      input.failedAt,
      input.eventId,
      input.scopeId,
      input.subgroupChatId
    );
    if (result.changes !== 1) {
      throw new Error(`Event ${input.eventId} changed while checkpointing unplanned subgroup provisioning.`);
    }
    appendEventLog(db, {
      eventId: input.eventId,
      action: 'events.unplanned.provisioning_failed',
      metadata: {
        reason: input.reason,
        subgroupChatId: input.subgroupChatId,
        subgroupTitle: input.subgroupTitle,
        parentCommunityWid: input.parentCommunityWid,
        stage: input.stage,
        progress: input.progress,
        participants: input.participants,
        recoveryGeneration: input.recoveryGeneration,
        recoveryAttempt: input.recoveryAttempt,
        recoveryNextRunAt: input.recoveryNextRunAt
      }
    });
    return true;
  });
}

export function completeUnplannedEventProvisioning(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  participants: Record<string, CreatedGroupParticipantResult>;
  completedAt: string;
}): boolean {
  return db.transaction(() => {
    const current = db.get<{ id: string }>(
      `SELECT id
         FROM event_records
        WHERE id = ?
          AND scope_id = ?
          AND origin = 'unplanned'
          AND event_status = 'failed'
          AND group_lifecycle_status = 'none'
          AND calendar_status = 'hidden'
          AND (subgroup_chat_id IS NULL OR subgroup_chat_id = ?)`,
      input.eventId,
      input.scopeId,
      input.subgroupChatId
    );
    if (!current) {
      return false;
    }

    db.run('DELETE FROM event_group_participants WHERE event_id = ?', input.eventId);
    writeCreatedGroupParticipants(db, input.eventId, input.participants, input.completedAt);
    const result = db.run(
      `UPDATE event_records
          SET event_status = 'active',
              group_lifecycle_status = 'poll_closed',
              calendar_status = 'included',
              subgroup_chat_id = ?,
              subgroup_title = ?,
              closed_at = ?,
              error = NULL,
              provisioning_recovery_generation = NULL,
              provisioning_recovery_attempt = NULL,
              provisioning_recovery_next_run_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND scope_id = ?
          AND origin = 'unplanned'
          AND event_status = 'failed'
          AND group_lifecycle_status = 'none'
          AND calendar_status = 'hidden'
          AND (subgroup_chat_id IS NULL OR subgroup_chat_id = ?)`,
      input.subgroupChatId,
      input.subgroupTitle,
      input.completedAt,
      input.completedAt,
      input.eventId,
      input.scopeId,
      input.subgroupChatId
    );
    if (result.changes !== 1) {
      throw new Error(`Event ${input.eventId} changed while completing unplanned subgroup provisioning.`);
    }
    db.run(
      `INSERT INTO unplanned_event_finalizations (
         event_id, scope_id, event_updated_at, generation, attempt, next_run_at, status,
         last_error, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, 1, ?, 'pending', NULL, ?, ?, NULL)`,
      input.eventId,
      input.scopeId,
      input.completedAt,
      randomUUID(),
      input.completedAt,
      input.completedAt,
      input.completedAt
    );
    appendEventLog(db, {
      eventId: input.eventId,
      action: 'events.unplanned.provisioning_completed',
      metadata: {
        subgroupChatId: input.subgroupChatId,
        subgroupTitle: input.subgroupTitle,
        participants: input.participants
      }
    });
    return true;
  });
}

export function getUnplannedEventFinalization(
  db: PluginDatabase,
  eventId: string
): StoredUnplannedEventFinalization | undefined {
  const row = db.get<UnplannedEventFinalizationRow>(
    'SELECT * FROM unplanned_event_finalizations WHERE event_id = ?',
    eventId
  );
  return row ? unplannedEventFinalizationFromRow(row) : undefined;
}

export function listPendingUnplannedEventFinalizations(
  db: PluginDatabase
): StoredUnplannedEventFinalization[] {
  return db.all<UnplannedEventFinalizationRow>(
    `SELECT *
       FROM unplanned_event_finalizations
      WHERE status = 'pending'
      ORDER BY next_run_at ASC, created_at ASC, event_id ASC`
  ).map(unplannedEventFinalizationFromRow);
}

export function completeUnplannedEventFinalization(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  generation: string;
  attempt: number;
  completedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE unplanned_event_finalizations
        SET status = 'completed',
            next_run_at = NULL,
            last_error = NULL,
            completed_at = ?,
            updated_at = ?
      WHERE event_id = ?
        AND scope_id = ?
        AND generation = ?
        AND attempt = ?
        AND status = 'pending'`,
    input.completedAt,
    input.completedAt,
    input.eventId,
    input.scopeId,
    input.generation,
    input.attempt
  );
  return result.changes === 1;
}

export function advanceUnplannedEventFinalization(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  generation: string;
  expectedAttempt: number;
  nextAttempt: number;
  nextRunAt: string;
  reason: string;
  updatedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE unplanned_event_finalizations
        SET attempt = ?,
            next_run_at = ?,
            last_error = ?,
            updated_at = ?
      WHERE event_id = ?
        AND scope_id = ?
        AND generation = ?
        AND attempt = ?
        AND status = 'pending'`,
    input.nextAttempt,
    input.nextRunAt,
    input.reason,
    input.updatedAt,
    input.eventId,
    input.scopeId,
    input.generation,
    input.expectedAttempt
  );
  return result.changes === 1;
}

export function markEventClosed(db: PluginDatabase, input: {
  eventId: string;
  subgroupChatId?: string | undefined;
  subgroupTitle?: string | undefined;
  closedAt: string;
}): void {
  db.run(
    `UPDATE event_records
        SET group_lifecycle_status = 'poll_closed', subgroup_chat_id = ?, subgroup_title = ?, closed_at = ?, updated_at = ?
      WHERE id = ?`,
    input.subgroupChatId ?? null,
    input.subgroupTitle ?? null,
    input.closedAt,
    input.closedAt,
    input.eventId
  );
}

export function markEventCleaned(db: PluginDatabase, input: {
  eventId: string;
  expectedUpdatedAt: string;
  cleanedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET event_status = 'completed',
            group_lifecycle_status = 'cleaned',
            cleaned_at = ?,
            error = NULL,
            updated_at = ?
      WHERE id = ?
        AND event_status IN ('active', 'completed')
        AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed')
        AND updated_at = ?`,
    input.cleanedAt,
    input.cleanedAt,
    input.eventId,
    input.expectedUpdatedAt
  );
  return result.changes === 1;
}

export function claimEventCleanup(db: PluginDatabase, input: {
  eventId: string;
  expectedUpdatedAt: string;
  expectedCleanupAt: string;
  claimedAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
}): EventCleanupClaim | undefined {
  const claimId = `evtcleanup-${randomUUID()}`;
  const claimedAt = input.claimedAt ?? new Date().toISOString();
  const leaseExpiresAt = input.leaseExpiresAt ?? new Date(
    new Date(claimedAt).getTime() + EVENT_CLEANUP_CLAIM_LEASE_MS
  ).toISOString();
  const result = db.run(
    `INSERT INTO event_cleanup_claims (
       event_id, claim_id, expected_event_updated_at, claimed_cleanup_at, claimed_at, lease_expires_at
     )
     SELECT id, ?, updated_at, cleanup_at, ?, ?
       FROM event_records
      WHERE id = ?
        AND event_status IN ('active', 'completed')
        AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed')
        AND updated_at = ?
        AND cleanup_at = ?
        AND cleanup_at <= ?
        AND NOT EXISTS (
          SELECT 1
            FROM event_cleanup_claims
           WHERE event_cleanup_claims.event_id = event_records.id
        )`,
    claimId,
    claimedAt,
    leaseExpiresAt,
    input.eventId,
    input.expectedUpdatedAt,
    input.expectedCleanupAt,
    claimedAt
  );
  return result.changes === 1
    ? {
        eventId: input.eventId,
        claimId,
        expectedEventUpdatedAt: input.expectedUpdatedAt,
        claimedCleanupAt: input.expectedCleanupAt,
        claimedAt,
        leaseExpiresAt
      }
    : undefined;
}

export function getEventCleanupClaim(db: PluginDatabase, eventId: string): EventCleanupClaim | undefined {
  const row = db.get<EventCleanupClaimRow>(
    'SELECT * FROM event_cleanup_claims WHERE event_id = ?',
    eventId
  );
  return row ? eventCleanupClaimFromRow(row) : undefined;
}

export function renewEventCleanupClaim(db: PluginDatabase, input: {
  eventId: string;
  claimId: string;
  expectedUpdatedAt: string;
  leaseExpiresAt: string;
}): boolean {
  return db.run(
    `UPDATE event_cleanup_claims
        SET lease_expires_at = ?
      WHERE event_id = ?
        AND claim_id = ?
        AND expected_event_updated_at = ?
        AND EXISTS (
          SELECT 1 FROM event_records
           WHERE event_records.id = event_cleanup_claims.event_id
             AND event_records.updated_at = event_cleanup_claims.expected_event_updated_at
        )`,
    input.leaseExpiresAt,
    input.eventId,
    input.claimId,
    input.expectedUpdatedAt
  ).changes === 1;
}

export function releaseExpiredEventCleanupClaims(
  db: PluginDatabase,
  now: string = new Date().toISOString()
): number {
  return db.run(
    `DELETE FROM event_cleanup_claims
      WHERE lease_expires_at IS NULL OR lease_expires_at <= ?`,
    now
  ).changes;
}

export function releaseEventCleanupClaim(db: PluginDatabase, input: {
  eventId: string;
  claimId: string;
}): boolean {
  return db.run(
    `DELETE FROM event_cleanup_claims
      WHERE event_id = ? AND claim_id = ?`,
    input.eventId,
    input.claimId
  ).changes === 1;
}

export function markClaimedEventCleaned(db: PluginDatabase, input: {
  eventId: string;
  claimId: string;
  expectedUpdatedAt: string;
  cleanedAt: string;
}): boolean {
  return db.transaction(() => {
    const result = db.run(
      `UPDATE event_records
          SET event_status = 'completed',
              group_lifecycle_status = 'cleaned',
              cleaned_at = ?,
              error = NULL,
              updated_at = ?
        WHERE id = ?
          AND event_status IN ('active', 'completed')
          AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed')
          AND updated_at = ?
          AND EXISTS (
            SELECT 1
              FROM event_cleanup_claims
             WHERE event_cleanup_claims.event_id = event_records.id
               AND event_cleanup_claims.claim_id = ?
               AND event_cleanup_claims.expected_event_updated_at = event_records.updated_at
          )`,
      input.cleanedAt,
      input.cleanedAt,
      input.eventId,
      input.expectedUpdatedAt,
      input.claimId
    );
    if (result.changes !== 1) {
      return false;
    }
    const released = releaseEventCleanupClaim(db, {
      eventId: input.eventId,
      claimId: input.claimId
    });
    if (!released) {
      throw new Error(`Cleanup claim ${input.claimId} disappeared while completing event ${input.eventId}.`);
    }
    return true;
  });
}

export function markEventCancelled(db: PluginDatabase, input: {
  eventId: string;
  expectedUpdatedAt: string;
  cancelledAt: string;
  cancelledByWid: string;
  cancelledByLabel: string;
  calendarStatus?: Extract<EventCalendarStatus, 'cancelled' | 'hidden'> | undefined;
  reason?: string | undefined;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET event_status = 'cancelled',
            calendar_status = ?,
            cancelled_at = ?,
            cancelled_by_wid = ?,
            cancelled_by_label = ?,
            cancel_reason = ?,
            error = NULL,
            updated_at = ?
      WHERE id = ?
        AND event_status = 'active'
        AND group_lifecycle_status IN ('poll_open', 'poll_closed', 'cleanup_failed')
        AND updated_at = ?`,
    input.calendarStatus ?? 'cancelled',
    input.cancelledAt,
    input.cancelledByWid,
    input.cancelledByLabel,
    input.reason ?? null,
    input.cancelledAt,
    input.eventId,
    input.expectedUpdatedAt
  );
  return result.changes === 1;
}

export function updateEventCalendarStatus(db: PluginDatabase, input: {
  eventId: string;
  calendarStatus: EventCalendarStatus;
  updatedAt: string;
}): void {
  db.run(
    `UPDATE event_records
        SET calendar_status = ?,
            updated_at = ?
      WHERE id = ?`,
    input.calendarStatus,
    input.updatedAt,
    input.eventId
  );
}

export function recordEventAnnouncementMessage(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  kind: EventAnnouncementMessageKind;
  deliveryKey: string;
  chatId: string;
  messageId: string;
  createdAt?: string | undefined;
}): StoredEventAnnouncementMessage {
  const messageId = input.messageId.trim();
  if (!messageId) {
    throw new Error(`Cannot persist ${input.kind} announcement without a WhatsApp message id.`);
  }
  const now = input.createdAt ?? new Date().toISOString();
  const id = `evtmsg-${randomUUID()}`;
  db.run(
    `INSERT INTO event_announcement_messages (
        id, event_id, scope_id, kind, delivery_key, chat_id, message_id, created_at, deleted_at, delete_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(event_id, kind, delivery_key) DO UPDATE SET
        scope_id = excluded.scope_id,
        chat_id = excluded.chat_id,
        message_id = excluded.message_id,
        deleted_at = NULL,
        delete_error = NULL`,
    id,
    input.eventId,
    input.scopeId,
    input.kind,
    input.deliveryKey,
    input.chatId,
    messageId,
    now
  );
  const row = db.get<EventAnnouncementMessageRow>(
    `SELECT * FROM event_announcement_messages
      WHERE event_id = ? AND kind = ? AND delivery_key = ?
      LIMIT 1`,
    input.eventId,
    input.kind,
    input.deliveryKey
  );
  if (!row) {
    throw new Error(`Could not read persisted ${input.kind} WhatsApp message ${messageId}.`);
  }
  return eventAnnouncementMessageFromRow(row);
}

export function claimEventAnnouncementDelivery(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  chatId: string;
  text: string;
  idempotencyKey: string;
  expectedEventUpdatedAt?: string | undefined;
  claimedAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
}): EventAnnouncementDeliveryClaimResult {
  return db.transaction(() => {
    const existingMessage = db.get<{ id: string }>(
      `SELECT id
         FROM event_announcement_messages
        WHERE event_id = ?
          AND kind = ?
          AND delivery_key = ?
        LIMIT 1`,
      input.eventId,
      input.kind,
      input.deliveryKey
    );
    if (existingMessage) {
      return 'already_sent';
    }

    const intent = normalizedEventAnnouncementIntent(input);
    const now = input.claimedAt ?? new Date().toISOString();
    if (input.expectedEventUpdatedAt) {
      const currentEvent = db.get<{ updated_at: string }>(
        'SELECT updated_at FROM event_records WHERE id = ?',
        input.eventId
      );
      if (!currentEvent || currentEvent.updated_at !== input.expectedEventUpdatedAt) {
        db.run(
          `UPDATE event_announcement_delivery_claims
              SET status = 'superseded', lease_expires_at = NULL, error = NULL, updated_at = ?
            WHERE event_id = ? AND kind = ? AND delivery_key = ? AND status <> 'sent'`,
          now,
          input.eventId,
          intent.kind,
          intent.deliveryKey
        );
        return 'superseded';
      }
    }
    const leaseExpiresAt = input.leaseExpiresAt ?? new Date(
      new Date(now).getTime() + EVENT_ANNOUNCEMENT_DELIVERY_LEASE_MS
    ).toISOString();
    const inserted = db.run(
      `INSERT INTO event_announcement_delivery_claims (
         event_id, kind, delivery_key, scope_id, chat_id, status, text, idempotency_key,
         lease_expires_at, message_id, error, claimed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'sending', ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(event_id, kind, delivery_key) DO NOTHING`,
      input.eventId,
      intent.kind,
      intent.deliveryKey,
      intent.scopeId,
      intent.chatId,
      intent.text,
      intent.idempotencyKey,
      leaseExpiresAt,
      now,
      now
    );
    if (inserted.changes === 1) {
      return 'claimed';
    }
    const existingClaim = getEventAnnouncementDeliveryClaim(db, input.eventId, intent.kind, intent.deliveryKey);
    if (existingClaim?.status === 'sent') {
      return 'already_sent';
    }
    if (!existingClaim) {
      return 'already_claimed';
    }
    if (
      existingClaim.scopeId !== intent.scopeId ||
      existingClaim.chatId !== intent.chatId ||
      existingClaim.text !== intent.text ||
      existingClaim.idempotencyKey !== intent.idempotencyKey
    ) {
      throw new Error(
        `Persisted ${intent.kind} delivery ${intent.deliveryKey} does not match the requested announcement intent.`
      );
    }

    const reacquired = db.run(
      `UPDATE event_announcement_delivery_claims
          SET status = 'sending',
              lease_expires_at = ?,
              error = NULL,
              claimed_at = ?,
              updated_at = ?
        WHERE event_id = ?
          AND kind = ?
          AND delivery_key = ?
          AND (
            status IN ('pending', 'uncertain')
            OR (status = 'sending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          )`,
      leaseExpiresAt,
      now,
      now,
      input.eventId,
      intent.kind,
      intent.deliveryKey,
      now
    );
    return reacquired.changes === 1 ? 'claimed' : 'already_claimed';
  });
}

export function supersedeEventAnnouncementDelivery(db: PluginDatabase, input: {
  eventId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  updatedAt?: string | undefined;
}): boolean {
  return db.transaction(() => {
    const existingMessage = db.get<{ id: string }>(
      `SELECT id FROM event_announcement_messages
        WHERE event_id = ? AND kind = ? AND delivery_key = ?
        LIMIT 1`,
      input.eventId,
      input.kind,
      input.deliveryKey
    );
    if (existingMessage) {
      return true;
    }
    const result = db.run(
      `UPDATE event_announcement_delivery_claims
          SET status = 'superseded', lease_expires_at = NULL, error = NULL, updated_at = ?
        WHERE event_id = ? AND kind = ? AND delivery_key = ? AND status <> 'sent'`,
      input.updatedAt ?? new Date().toISOString(),
      input.eventId,
      input.kind,
      input.deliveryKey
    );
    if (result.changes === 1) {
      return true;
    }
    return getEventAnnouncementDeliveryClaim(db, input.eventId, input.kind, input.deliveryKey)?.status === 'sent';
  });
}

export function completeEventAnnouncementDelivery(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  chatId: string;
  messageId: string;
  completedAt?: string | undefined;
}): StoredEventAnnouncementMessage {
  const messageId = input.messageId.trim();
  if (!messageId) {
    throw new Error(`Cannot complete ${input.kind} delivery without a WhatsApp message id.`);
  }
  return db.transaction(() => {
    const existing = db.get<EventAnnouncementMessageRow>(
      `SELECT * FROM event_announcement_messages
        WHERE event_id = ? AND kind = ? AND delivery_key = ?
        LIMIT 1`,
      input.eventId,
      input.kind,
      input.deliveryKey
    );
    if (existing) {
      return eventAnnouncementMessageFromRow(existing);
    }
    const current = getEventAnnouncementDeliveryClaim(db, input.eventId, input.kind, input.deliveryKey);
    if (!current || current.status !== 'sending') {
      throw new Error(
        `Cannot complete ${input.kind} delivery for event ${input.eventId} from ${current?.status ?? 'missing'} state.`
      );
    }
    const completedAt = input.completedAt ?? new Date().toISOString();
    const message = recordEventAnnouncementMessage(db, {
      eventId: input.eventId,
      scopeId: input.scopeId,
      kind: input.kind,
      deliveryKey: input.deliveryKey,
      chatId: input.chatId,
      messageId,
      createdAt: completedAt
    });
    const updated = db.run(
      `UPDATE event_announcement_delivery_claims
          SET status = 'sent',
              scope_id = ?,
              chat_id = ?,
              message_id = ?,
              lease_expires_at = NULL,
              error = NULL,
              updated_at = ?
        WHERE event_id = ?
          AND kind = ?
          AND delivery_key = ?
          AND status = 'sending'`,
      input.scopeId,
      input.chatId,
      messageId,
      completedAt,
      input.eventId,
      input.kind,
      input.deliveryKey
    );
    if (updated.changes !== 1) {
      throw new Error(`Event ${input.eventId} changed while completing ${input.kind} delivery.`);
    }
    return message;
  });
}

export function markEventAnnouncementDeliveryUncertain(db: PluginDatabase, input: {
  eventId: string;
  kind: EventAnnouncementDeliveryKind;
  deliveryKey: string;
  reason: string;
  updatedAt?: string | undefined;
}): void {
  const updated = db.run(
      `UPDATE event_announcement_delivery_claims
        SET status = 'uncertain',
            lease_expires_at = NULL,
            error = ?,
            updated_at = ?
      WHERE event_id = ?
        AND kind = ?
        AND delivery_key = ?
        AND status = 'sending'`,
    input.reason,
    input.updatedAt ?? new Date().toISOString(),
    input.eventId,
    input.kind,
    input.deliveryKey
  );
  if (updated.changes !== 1) {
    const current = getEventAnnouncementDeliveryClaim(db, input.eventId, input.kind, input.deliveryKey);
    if (current?.status === 'sent') {
      return;
    }
    throw new Error(
      `Cannot mark ${input.kind} delivery for event ${input.eventId} uncertain from its current state.`
    );
  }
}

export function getEventAnnouncementDeliveryClaim(
  db: PluginDatabase,
  eventId: string,
  kind: EventAnnouncementDeliveryKind,
  deliveryKey: string
): StoredEventAnnouncementDeliveryClaim | undefined {
  const row = db.get<EventAnnouncementDeliveryClaimRow>(
    `SELECT *
       FROM event_announcement_delivery_claims
      WHERE event_id = ? AND kind = ? AND delivery_key = ?`,
    eventId,
    kind,
    deliveryKey
  );
  return row ? eventAnnouncementDeliveryClaimFromRow(row) : undefined;
}

export function getEventEditRepair(
  db: PluginDatabase,
  operationId: string
): StoredEventEditRepair | undefined {
  const row = db.get<EventEditRepairRow>(
    'SELECT * FROM event_edit_repairs WHERE operation_id = ?',
    operationId
  );
  return row ? eventEditRepairFromRow(row) : undefined;
}

export function listPendingEventEditRepairs(
  db: PluginDatabase,
  input: { operationId?: string | undefined } = {}
): StoredEventEditRepair[] {
  const rows = input.operationId
    ? db.all<EventEditRepairRow>(
      `SELECT * FROM event_edit_repairs
        WHERE status = 'pending' AND operation_id = ?
        ORDER BY created_at ASC, operation_id ASC`,
      input.operationId
    )
    : db.all<EventEditRepairRow>(
      `SELECT * FROM event_edit_repairs
        WHERE status = 'pending'
        ORDER BY created_at ASC, operation_id ASC`
    );
  return rows.map(eventEditRepairFromRow);
}

export function completeEventEditRepair(db: PluginDatabase, input: {
  operationId: string;
  completedAt?: string | undefined;
}): boolean {
  const completedAt = input.completedAt ?? new Date().toISOString();
  return db.run(
    `UPDATE event_edit_repairs
        SET status = 'completed', last_error = NULL, completed_at = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'pending'`,
    completedAt,
    completedAt,
    input.operationId
  ).changes === 1;
}

export function markEventEditRepairPending(db: PluginDatabase, input: {
  operationId: string;
  reason: string;
  updatedAt?: string | undefined;
}): boolean {
  return db.run(
    `UPDATE event_edit_repairs
        SET last_error = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'pending'`,
    input.reason,
    input.updatedAt ?? new Date().toISOString(),
    input.operationId
  ).changes === 1;
}

export function claimEventCalendarRepairLease(db: PluginDatabase, input: {
  scopeId: string;
  calendarId: string;
  operationId: string;
  now?: string | undefined;
  leaseExpiresAt?: string | undefined;
}): string | undefined {
  const now = input.now ?? new Date().toISOString();
  const leaseExpiresAt = input.leaseExpiresAt ?? new Date(
    new Date(now).getTime() + EVENT_CALENDAR_REPAIR_LEASE_MS
  ).toISOString();
  return db.transaction(() => {
    db.run(
      `INSERT INTO event_calendar_repair_leases (
         scope_id, calendar_id, operation_id, lease_expires_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope_id, calendar_id) DO UPDATE SET
         operation_id = excluded.operation_id,
         lease_expires_at = excluded.lease_expires_at,
         updated_at = excluded.updated_at
       WHERE event_calendar_repair_leases.operation_id = excluded.operation_id
          OR event_calendar_repair_leases.lease_expires_at <= excluded.updated_at`,
      input.scopeId,
      input.calendarId,
      input.operationId,
      leaseExpiresAt,
      now
    );
    const lease = db.get<{ operation_id: string; lease_expires_at: string }>(
      `SELECT operation_id, lease_expires_at
         FROM event_calendar_repair_leases
        WHERE scope_id = ? AND calendar_id = ?`,
      input.scopeId,
      input.calendarId
    );
    return lease?.operation_id === input.operationId ? lease.lease_expires_at : undefined;
  });
}

export function releaseEventCalendarRepairLease(db: PluginDatabase, input: {
  scopeId: string;
  calendarId: string;
  operationId: string;
}): boolean {
  return db.run(
    `DELETE FROM event_calendar_repair_leases
      WHERE scope_id = ? AND calendar_id = ? AND operation_id = ?`,
    input.scopeId,
    input.calendarId,
    input.operationId
  ).changes === 1;
}

export function renewEventCalendarRepairLease(db: PluginDatabase, input: {
  scopeId: string;
  calendarId: string;
  operationId: string;
  leaseExpiresAt: string;
  updatedAt?: string | undefined;
}): boolean {
  return db.run(
    `UPDATE event_calendar_repair_leases
        SET lease_expires_at = ?, updated_at = ?
      WHERE scope_id = ? AND calendar_id = ? AND operation_id = ?`,
    input.leaseExpiresAt,
    input.updatedAt ?? new Date().toISOString(),
    input.scopeId,
    input.calendarId,
    input.operationId
  ).changes === 1;
}

export function eventCalendarRepairLeaseExpiry(
  db: PluginDatabase,
  scopeId: string,
  calendarId: string
): string | undefined {
  return db.get<{ lease_expires_at: string }>(
    `SELECT lease_expires_at FROM event_calendar_repair_leases
      WHERE scope_id = ? AND calendar_id = ?`,
    scopeId,
    calendarId
  )?.lease_expires_at;
}

export function listEventAnnouncementMessages(db: PluginDatabase, eventId: string, input: {
  includeDeleted?: boolean | undefined;
} = {}): StoredEventAnnouncementMessage[] {
  const rows = input.includeDeleted
    ? db.all<EventAnnouncementMessageRow>(
      `SELECT * FROM event_announcement_messages
        WHERE event_id = ?
        ORDER BY created_at ASC, id ASC`,
      eventId
    )
    : db.all<EventAnnouncementMessageRow>(
      `SELECT * FROM event_announcement_messages
        WHERE event_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`,
      eventId
    );
  return rows.map(eventAnnouncementMessageFromRow);
}

export function markEventAnnouncementMessageDeleted(
  db: PluginDatabase,
  id: string,
  deletedAt: string
): void {
  db.run(
    `UPDATE event_announcement_messages
        SET deleted_at = ?,
            delete_error = NULL
      WHERE id = ?`,
    deletedAt,
    id
  );
}

export function markEventAnnouncementMessageDeleteFailed(
  db: PluginDatabase,
  id: string,
  reason: string
): void {
  db.run(
    `UPDATE event_announcement_messages
        SET delete_error = ?
      WHERE id = ?`,
    reason,
    id
  );
}

export function markEventCleanupFailed(db: PluginDatabase, input: {
  eventId: string;
  expectedUpdatedAt: string;
  reason: string;
  failedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET group_lifecycle_status = 'cleanup_failed', error = ?, updated_at = ?
      WHERE id = ?
        AND event_status IN ('active', 'completed')
        AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed')
        AND updated_at = ?`,
    input.reason,
    input.failedAt,
    input.eventId,
    input.expectedUpdatedAt
  );
  return result.changes === 1;
}

export function markEventFailed(db: PluginDatabase, eventId: string, reason: string, failedAt: string): void {
  db.run(
    `UPDATE event_records
        SET event_status = 'failed',
            group_lifecycle_status = 'none',
            calendar_status = 'hidden',
            error = ?,
            updated_at = ?
      WHERE id = ?`,
    reason,
    failedAt,
    eventId
  );
}

export function markEventProvisioningFailed(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  participants: Record<string, CreatedGroupParticipantResult>;
  reason: string;
  failedAt: string;
  recoveryGeneration: string;
  recoveryAttempt: number;
  recoveryNextRunAt: string;
}): boolean {
  return db.transaction(() => {
    const current = db.get<{ id: string }>(
      `SELECT id
         FROM event_records
        WHERE id = ?
          AND scope_id = ?
          AND event_status = 'active'
          AND group_lifecycle_status = 'poll_open'
          AND (subgroup_chat_id IS NULL OR subgroup_chat_id = ?)`,
      input.eventId,
      input.scopeId,
      input.subgroupChatId
    );
    if (!current) {
      return false;
    }

    db.run('DELETE FROM event_group_participants WHERE event_id = ?', input.eventId);
    writeCreatedGroupParticipants(
      db,
      input.eventId,
      input.participants,
      input.failedAt
    );
    const result = db.run(
      `UPDATE event_records
          SET event_status = 'failed',
              group_lifecycle_status = 'none',
              calendar_status = 'hidden',
              subgroup_chat_id = ?,
              subgroup_title = ?,
              error = ?,
              provisioning_recovery_generation = ?,
              provisioning_recovery_attempt = ?,
              provisioning_recovery_next_run_at = ?,
              updated_at = ?
        WHERE id = ?
          AND scope_id = ?
          AND event_status = 'active'
          AND group_lifecycle_status = 'poll_open'
          AND (subgroup_chat_id IS NULL OR subgroup_chat_id = ?)`,
      input.subgroupChatId,
      input.subgroupTitle,
      input.reason,
      input.recoveryGeneration,
      input.recoveryAttempt,
      input.recoveryNextRunAt,
      input.failedAt,
      input.eventId,
      input.scopeId,
      input.subgroupChatId
    );
    if (result.changes !== 1) {
      throw new Error(`Event ${input.eventId} changed while checkpointing subgroup provisioning failure.`);
    }
    return true;
  });
}

export function initializeEventProvisioningRecovery(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  generation: string;
  attempt: number;
  nextRunAt: string;
  updatedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET provisioning_recovery_generation = ?,
            provisioning_recovery_attempt = ?,
            provisioning_recovery_next_run_at = ?,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status = 'none'
        AND subgroup_chat_id = ?
        AND provisioning_recovery_generation IS NULL
        AND provisioning_recovery_attempt IS NULL
        AND provisioning_recovery_next_run_at IS NULL`,
    input.generation,
    input.attempt,
    input.nextRunAt,
    input.updatedAt,
    input.eventId,
    input.scopeId,
    input.subgroupChatId
  );
  return result.changes === 1;
}

export function advanceEventProvisioningRecovery(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  subgroupChatId: string;
  generation: string;
  expectedAttempt: number;
  nextAttempt: number;
  nextRunAt: string;
  updatedAt: string;
}): boolean {
  const result = db.run(
    `UPDATE event_records
        SET provisioning_recovery_attempt = ?,
            provisioning_recovery_next_run_at = ?,
            updated_at = ?
      WHERE id = ?
        AND scope_id = ?
        AND event_status = 'failed'
        AND group_lifecycle_status = 'none'
        AND subgroup_chat_id = ?
        AND provisioning_recovery_generation = ?
        AND provisioning_recovery_attempt = ?`,
    input.nextAttempt,
    input.nextRunAt,
    input.updatedAt,
    input.eventId,
    input.scopeId,
    input.subgroupChatId,
    input.generation,
    input.expectedAttempt
  );
  return result.changes === 1;
}

export function markEventMissed(db: PluginDatabase, eventId: string, reason: string, missedAt: string): void {
  db.run(
    `UPDATE event_records
        SET event_status = 'failed',
            group_lifecycle_status = 'missed',
            calendar_status = 'hidden',
            error = ?,
            updated_at = ?
      WHERE id = ?
        AND event_status = 'active'
        AND group_lifecycle_status = 'poll_open'`,
    reason,
    missedAt,
    eventId
  );
}

export function upsertVote(db: PluginDatabase, eventId: string, vote: PluginPollVote): void {
  const voterIdentityId = vote.voterIdentityId.trim();
  const voterWid = vote.voterWid.trim();
  if (!voterIdentityId || !voterWid) {
    throw new Error('Event votes require an authoritative voter identity and delivery address.');
  }
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO event_votes (
       event_id, voter_identity_id, voter_wid, selected_option_ids_json, selected_option_names_json,
       selected_option_numbers_json, interacted_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, voter_identity_id) DO UPDATE SET
       voter_wid = excluded.voter_wid,
       selected_option_ids_json = excluded.selected_option_ids_json,
       selected_option_names_json = excluded.selected_option_names_json,
       selected_option_numbers_json = excluded.selected_option_numbers_json,
       interacted_at = excluded.interacted_at,
       updated_at = excluded.updated_at`,
    eventId,
    voterIdentityId,
    voterWid,
    JSON.stringify(vote.selectedOptionIds),
    JSON.stringify(vote.selectedOptionNames),
    JSON.stringify(vote.selectedOptionNumbers),
    vote.interactedAt?.toISOString() ?? null,
    now
  );
}

export function replaceVotes(db: PluginDatabase, eventId: string, votes: PluginPollVote[]): void {
  db.transaction(() => {
    db.run('DELETE FROM event_votes WHERE event_id = ?', eventId);
    for (const vote of votes) {
      upsertVote(db, eventId, vote);
    }
  });
}

export function listVotes(db: PluginDatabase, eventId: string): StoredEventVote[] {
  return db.all<VoteRow>(
    'SELECT * FROM event_votes WHERE event_id = ? ORDER BY voter_identity_id ASC',
    eventId
  ).map(voteFromRow);
}

export function listCreatedGroupParticipants(
  db: PluginDatabase,
  eventId: string
): StoredCreatedGroupParticipant[] {
  return db.all<{
    event_id: string;
    wid: string;
    status_code: number | null;
    message: string | null;
    is_group_creator: number;
    is_invite_v4_sent: number;
    created_at: string;
  }>(
    `SELECT event_id, wid, status_code, message, is_group_creator, is_invite_v4_sent, created_at
       FROM event_group_participants
      WHERE event_id = ?
      ORDER BY wid ASC`,
    eventId
  ).map((row) => ({
    eventId: row.event_id,
    wid: row.wid,
    ...(row.status_code !== null ? { statusCode: row.status_code } : {}),
    ...(row.message ? { message: row.message } : {}),
    isGroupCreator: row.is_group_creator === 1,
    isInviteV4Sent: row.is_invite_v4_sent === 1,
    createdAt: row.created_at
  }));
}

export function saveCreatedGroupParticipants(
  db: PluginDatabase,
  eventId: string,
  participants: Record<string, CreatedGroupParticipantResult>
): void {
  db.transaction(() => {
    writeCreatedGroupParticipants(db, eventId, participants, new Date().toISOString());
  });
}

function writeCreatedGroupParticipants(
  db: PluginDatabase,
  eventId: string,
  participants: Record<string, CreatedGroupParticipantResult>,
  createdAt: string
): void {
  const insert = db.prepare(
    `INSERT INTO event_group_participants (
       event_id, wid, status_code, message, is_group_creator, is_invite_v4_sent, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, wid) DO UPDATE SET
       status_code = excluded.status_code,
       message = excluded.message,
       is_group_creator = excluded.is_group_creator,
       is_invite_v4_sent = excluded.is_invite_v4_sent`
  );
  for (const [wid, participant] of Object.entries(participants)) {
    insert.run(
      eventId,
      wid,
      participant.statusCode ?? null,
      participant.message ?? null,
      participant.isGroupCreator ? 1 : 0,
      participant.isInviteV4Sent ? 1 : 0,
      createdAt
    );
  }
}

export function appendEventLog(db: PluginDatabase, input: {
  eventId?: string | undefined;
  action: string;
  metadata?: unknown;
}): void {
  db.run(
    'INSERT INTO event_logs (id, event_id, action, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)',
    randomUUID(),
    input.eventId ?? null,
    input.action,
    JSON.stringify(input.metadata ?? {}),
    new Date().toISOString()
  );
}

export function getEventWeatherDelivery(
  db: PluginDatabase,
  eventId: string,
  kind: string,
  eventUpdatedAt: string
): StoredEventWeatherDelivery | undefined {
  const row = db.get<EventWeatherDeliveryRow>(
    `SELECT * FROM event_weather_deliveries
      WHERE event_id = ? AND kind = ? AND event_updated_at = ?`,
    eventId,
    kind,
    eventUpdatedAt
  );
  return row ? eventWeatherDeliveryFromRow(row) : undefined;
}

export function listRecoverableEventWeatherDeliveries(
  db: PluginDatabase
): StoredEventWeatherDelivery[] {
  return db.all<EventWeatherDeliveryRow>(
    `SELECT *
       FROM event_weather_deliveries
      WHERE status IN ('pending', 'sending')
      ORDER BY COALESCE(next_run_at, lease_expires_at, scheduled_at) ASC, event_id ASC, kind ASC`
  ).map(eventWeatherDeliveryFromRow);
}

export function prepareEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  scheduleKind: EventWeatherDeliveryScheduleKind;
  scheduledAt: string;
  chatId: string;
  meteorologicalText?: string | undefined;
  marineText?: string | undefined;
  meteorologicalIdempotencyKey?: string | undefined;
  marineIdempotencyKey?: string | undefined;
  preparedAt?: string | undefined;
}): StoredEventWeatherDelivery {
  const meteorologicalText = input.meteorologicalText?.trim() || undefined;
  const marineText = input.marineText?.trim() || undefined;
  if (!meteorologicalText && !marineText) {
    throw new Error(`Cannot prepare empty weather delivery ${input.eventId}/${input.kind}.`);
  }
  if (meteorologicalText && !input.meteorologicalIdempotencyKey?.trim()) {
    throw new Error(`Weather delivery ${input.eventId}/${input.kind} has no meteorological idempotency key.`);
  }
  if (marineText && !input.marineIdempotencyKey?.trim()) {
    throw new Error(`Weather delivery ${input.eventId}/${input.kind} has no marine idempotency key.`);
  }
  return db.transaction(() => {
    if (!eventRecordVersionMatches(db, input.eventId, input.eventUpdatedAt)) {
      throw new Error(
        `Event ${input.eventId} changed before weather delivery ${input.kind} could be prepared.`
      );
    }
    const existing = getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
    if (existing?.status === 'sent' || existing?.status === 'skipped') {
      return existing;
    }
    if (
      existing?.chatId &&
      (existing.meteorologicalText || existing.marineText) &&
      (!existing.meteorologicalText || existing.meteorologicalIdempotencyKey) &&
      (!existing.marineText || existing.marineIdempotencyKey)
    ) {
      return existing;
    }
    const preparedAt = input.preparedAt ?? new Date().toISOString();
    const persisted = db.run(
      `INSERT INTO event_weather_deliveries (
         event_id, event_updated_at, kind, schedule_kind, scheduled_at, status, chat_id,
         meteorological_text, marine_text,
         meteorological_idempotency_key, marine_idempotency_key,
         meteorological_message_id, marine_message_id,
         claim_id, lease_expires_at, attempt, next_run_at,
         sent_at, skipped_at, error, updated_at
       )
       SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, NULL, NULL, NULL, ?
         FROM event_records
        WHERE id = ? AND updated_at = ?
       ON CONFLICT(event_id, kind, event_updated_at) DO UPDATE SET
         schedule_kind = excluded.schedule_kind,
         scheduled_at = excluded.scheduled_at,
         status = 'pending',
         chat_id = excluded.chat_id,
         meteorological_text = excluded.meteorological_text,
         marine_text = excluded.marine_text,
         meteorological_idempotency_key = excluded.meteorological_idempotency_key,
         marine_idempotency_key = excluded.marine_idempotency_key,
         claim_id = NULL,
         lease_expires_at = NULL,
         next_run_at = excluded.next_run_at,
         error = NULL,
         updated_at = excluded.updated_at
      WHERE event_weather_deliveries.status IN ('pending', 'sending')`,
      input.eventId,
      input.eventUpdatedAt,
      input.kind,
      input.scheduleKind,
      input.scheduledAt,
      input.chatId,
      meteorologicalText ?? null,
      marineText ?? null,
      input.meteorologicalIdempotencyKey?.trim() ?? null,
      input.marineIdempotencyKey?.trim() ?? null,
      preparedAt,
      preparedAt,
      input.eventId,
      input.eventUpdatedAt
    );
    if (persisted.changes !== 1) {
      throw new Error(
        `Event ${input.eventId} changed before weather delivery ${input.kind} could be prepared.`
      );
    }
    const prepared = getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
    if (!prepared) {
      throw new Error(`Could not read prepared weather delivery ${input.eventId}/${input.kind}.`);
    }
    return prepared;
  });
}

export function claimEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  claimedAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
}): ClaimedEventWeatherDelivery | undefined {
  return db.transaction(() => {
    const claimedAt = input.claimedAt ?? new Date().toISOString();
    const leaseExpiresAt = input.leaseExpiresAt ?? new Date(
      new Date(claimedAt).getTime() + EVENT_WEATHER_DELIVERY_LEASE_MS
    ).toISOString();
    const claimId = randomUUID();
    const result = db.run(
      `UPDATE event_weather_deliveries
          SET status = 'sending',
              claim_id = ?,
              lease_expires_at = ?,
              next_run_at = NULL,
              updated_at = ?
        WHERE event_id = ?
          AND kind = ?
          AND event_updated_at = ?
          AND EXISTS (
            SELECT 1 FROM event_records
             WHERE event_records.id = event_weather_deliveries.event_id
               AND event_records.updated_at = event_weather_deliveries.event_updated_at
          )
          AND chat_id IS NOT NULL
          AND (meteorological_text IS NOT NULL OR marine_text IS NOT NULL)
          AND (
            (status = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?))
            OR (status = 'sending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          )`,
      claimId,
      leaseExpiresAt,
      claimedAt,
      input.eventId,
      input.kind,
      input.eventUpdatedAt,
      claimedAt,
      claimedAt
    );
    if (result.changes !== 1) {
      return undefined;
    }
    const delivery = getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
    if (!delivery || delivery.status !== 'sending' || delivery.claimId !== claimId) {
      throw new Error(`Could not read claimed weather delivery ${input.eventId}/${input.kind}.`);
    }
    return { claimId, delivery };
  });
}

export function completeEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  claimId: string;
  meteorologicalMessageId?: string | undefined;
  marineMessageId?: string | undefined;
  completedAt?: string | undefined;
}): boolean {
  const completedAt = input.completedAt ?? new Date().toISOString();
  const result = db.run(
    `UPDATE event_weather_deliveries
        SET status = 'sent',
            meteorological_message_id = ?,
            marine_message_id = ?,
            claim_id = NULL,
            lease_expires_at = NULL,
            next_run_at = NULL,
            sent_at = ?,
            error = NULL,
            updated_at = ?
      WHERE event_id = ?
        AND kind = ?
        AND event_updated_at = ?
        AND status = 'sending'
        AND claim_id = ?
        AND EXISTS (
          SELECT 1 FROM event_records
           WHERE event_records.id = event_weather_deliveries.event_id
             AND event_records.updated_at = event_weather_deliveries.event_updated_at
        )`,
    input.meteorologicalMessageId?.trim() ?? null,
    input.marineMessageId?.trim() ?? null,
    completedAt,
    completedAt,
    input.eventId,
    input.kind,
    input.eventUpdatedAt,
    input.claimId
  );
  return result.changes === 1;
}

export function deferEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  scheduleKind: EventWeatherDeliveryScheduleKind;
  scheduledAt: string;
  nextRunAt: string;
  reason: string;
  claimId?: string | undefined;
  updatedAt?: string | undefined;
}): StoredEventWeatherDelivery | undefined {
  return db.transaction(() => {
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const existing = getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
    if (existing?.status === 'sent' || existing?.status === 'skipped') {
      return existing;
    }
    if (!eventRecordVersionMatches(db, input.eventId, input.eventUpdatedAt)) {
      return existing;
    }
    if (input.claimId && existing?.claimId !== input.claimId) {
      return existing;
    }
    if (!existing) {
      db.run(
        `INSERT INTO event_weather_deliveries (
           event_id, event_updated_at, kind, schedule_kind, scheduled_at, status, attempt,
           next_run_at, error, updated_at
         )
         SELECT ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?
           FROM event_records
          WHERE id = ? AND updated_at = ?`,
        input.eventId,
        input.eventUpdatedAt,
        input.kind,
        input.scheduleKind,
        input.scheduledAt,
        input.nextRunAt,
        input.reason,
        updatedAt,
        input.eventId,
        input.eventUpdatedAt
      );
    } else {
      db.run(
        `UPDATE event_weather_deliveries
            SET schedule_kind = ?,
                scheduled_at = ?,
                status = 'pending',
                claim_id = NULL,
                lease_expires_at = NULL,
                attempt = attempt + 1,
                next_run_at = ?,
                error = ?,
                updated_at = ?
          WHERE event_id = ? AND kind = ? AND event_updated_at = ?`,
        input.scheduleKind,
        input.scheduledAt,
        input.nextRunAt,
        input.reason,
        updatedAt,
        input.eventId,
        input.kind,
        input.eventUpdatedAt
      );
    }
    return getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
  });
}

export function skipEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  scheduleKind: EventWeatherDeliveryScheduleKind;
  scheduledAt: string;
  reason: string;
  skippedAt?: string | undefined;
}): StoredEventWeatherDelivery | undefined {
  return db.transaction(() => {
    const skippedAt = input.skippedAt ?? new Date().toISOString();
    db.run(
    `INSERT INTO event_weather_deliveries (
       event_id, event_updated_at, kind, schedule_kind, scheduled_at, status, attempt,
       skipped_at, error, updated_at
     )
     SELECT ?, ?, ?, ?, ?, 'skipped', 0, ?, ?, ?
       FROM event_records
      WHERE id = ? AND updated_at = ?
     ON CONFLICT(event_id, kind, event_updated_at) DO UPDATE SET
       schedule_kind = excluded.schedule_kind,
       scheduled_at = excluded.scheduled_at,
       status = 'skipped',
       claim_id = NULL,
       lease_expires_at = NULL,
       next_run_at = NULL,
       sent_at = NULL,
       skipped_at = excluded.skipped_at,
       error = excluded.error,
       updated_at = excluded.updated_at
     WHERE event_weather_deliveries.status <> 'sent'
       AND EXISTS (
         SELECT 1 FROM event_records
          WHERE event_records.id = event_weather_deliveries.event_id
            AND event_records.updated_at = event_weather_deliveries.event_updated_at
       )`,
    input.eventId,
    input.eventUpdatedAt,
    input.kind,
    input.scheduleKind,
    input.scheduledAt,
    skippedAt,
    input.reason,
    skippedAt,
    input.eventId,
    input.eventUpdatedAt
    );
    return getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
  });
}

export function supersedeEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  eventUpdatedAt: string;
  kind: string;
  reason: string;
  supersededAt?: string | undefined;
}): StoredEventWeatherDelivery | undefined {
  const supersededAt = input.supersededAt ?? new Date().toISOString();
  db.run(
    `UPDATE event_weather_deliveries
        SET status = 'skipped',
            claim_id = NULL,
            lease_expires_at = NULL,
            next_run_at = NULL,
            sent_at = NULL,
            skipped_at = ?,
            error = ?,
            updated_at = ?
      WHERE event_id = ?
        AND event_updated_at = ?
        AND kind = ?
        AND status IN ('pending', 'sending')`,
    supersededAt,
    input.reason,
    supersededAt,
    input.eventId,
    input.eventUpdatedAt,
    input.kind
  );
  return getEventWeatherDelivery(db, input.eventId, input.kind, input.eventUpdatedAt);
}

function eventRecordVersionMatches(
  db: PluginDatabase,
  eventId: string,
  eventUpdatedAt: string
): boolean {
  return Boolean(db.get<{ id: string }>(
    'SELECT id FROM event_records WHERE id = ? AND updated_at = ?',
    eventId,
    eventUpdatedAt
  ));
}

export function recordCalendarPublicationStatus(db: PluginDatabase, input: {
  scopeId: string;
  calendarId: string;
  generatedAt: string;
  generatedEventCount: number;
  publication?: CalendarPublicationOutcome | undefined;
}): void {
  const publication = input.publication;
  const updatedAt = new Date().toISOString();
  const lastSuccessAt = publication?.ok ? publication.updatedAt || updatedAt : null;
  const lastErrorAt = publication && !publication.ok ? updatedAt : null;
  const lastError = publication && !publication.ok ? publication.error || 'Calendar publication failed.' : null;
  db.run(
    `INSERT INTO event_calendar_publication_status (
       scope_id, calendar_id, generated_at, generated_event_count,
       publication_enabled, attempted, ok, endpoint_url, feed_id, label,
       subscription_url, calendar_url, target_updated_at, last_success_at,
       last_error_at, last_error, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_id, calendar_id) DO UPDATE SET
       generated_at = excluded.generated_at,
       generated_event_count = excluded.generated_event_count,
       publication_enabled = excluded.publication_enabled,
       attempted = excluded.attempted,
       ok = excluded.ok,
       endpoint_url = excluded.endpoint_url,
       feed_id = excluded.feed_id,
       label = excluded.label,
       subscription_url = COALESCE(excluded.subscription_url, event_calendar_publication_status.subscription_url),
       calendar_url = COALESCE(excluded.calendar_url, event_calendar_publication_status.calendar_url),
       target_updated_at = COALESCE(excluded.target_updated_at, event_calendar_publication_status.target_updated_at),
       last_success_at = CASE
         WHEN excluded.last_success_at IS NOT NULL THEN excluded.last_success_at
         ELSE event_calendar_publication_status.last_success_at
       END,
       last_error_at = CASE
         WHEN excluded.last_error_at IS NOT NULL THEN excluded.last_error_at
         WHEN excluded.ok = 1 THEN NULL
         ELSE event_calendar_publication_status.last_error_at
       END,
       last_error = CASE
         WHEN excluded.last_error IS NOT NULL THEN excluded.last_error
         WHEN excluded.ok = 1 THEN NULL
         ELSE event_calendar_publication_status.last_error
       END,
       updated_at = excluded.updated_at`,
    input.scopeId,
    input.calendarId,
    input.generatedAt,
    input.generatedEventCount,
    publication?.enabled ? 1 : 0,
    publication?.attempted ? 1 : 0,
    publication ? (publication.ok ? 1 : 0) : 0,
    publication?.endpointUrl || null,
    publication?.feedId || null,
    publication?.label || null,
    publication?.subscriptionUrl || null,
    publication?.calendarUrl || null,
    publication?.updatedAt || null,
    lastSuccessAt,
    lastErrorAt,
    lastError,
    updatedAt
  );
}

export function getCalendarPublicationStatus(
  db: PluginDatabase,
  scopeId: string,
  calendarId: string
): StoredCalendarPublicationStatus | undefined {
  const row = db.get<CalendarPublicationStatusRow>(
    'SELECT * FROM event_calendar_publication_status WHERE scope_id = ? AND calendar_id = ?',
    scopeId,
    calendarId
  );
  return row ? calendarPublicationStatusFromRow(row) : undefined;
}

export function listCalendarEvents(db: PluginDatabase, scopeId: string, profileId?: string | undefined): StoredEventRecord[] {
  const rows = profileId
    ? db.all<EventRow>(
      `SELECT * FROM event_records
        WHERE scope_id = ? AND profile_id = ? AND calendar_status IN ('included', 'cancelled')
        ORDER BY starts_at ASC, id ASC`,
      scopeId,
      profileId
    )
    : db.all<EventRow>(
      `SELECT * FROM event_records
        WHERE scope_id = ? AND calendar_status IN ('included', 'cancelled')
        ORDER BY starts_at ASC, id ASC`,
      scopeId
    );
  return rows.map(eventFromRow);
}

export function listScopeEvents(db: PluginDatabase, scopeId: string): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE scope_id = ?
      ORDER BY starts_at ASC, id ASC`,
    scopeId
  ).map(eventFromRow);
}

function eventFromRow(row: EventRow): StoredEventRecord {
  const eventLocation = parseStoredEventLocation(row.event_location_json);
  return {
    id: row.id,
    scopeId: row.scope_id,
    ...(row.group_id ? { groupId: row.group_id } : {}),
    ...(row.group_wid ? { groupWid: row.group_wid } : {}),
    profileId: row.profile_id,
    profileRevision: row.profile_revision ?? '',
    profileLabel: row.profile_label,
    origin: row.origin ?? 'created',
    eventStatus: row.event_status,
    groupLifecycleStatus: row.group_lifecycle_status,
    calendarStatus: row.calendar_status,
    ...(row.actor_identity_id ? { actorIdentityId: row.actor_identity_id } : {}),
    actorWid: row.actor_wid,
    actorLabel: row.actor_label,
    ...(row.announcement_group_wid ? { announcementGroupWid: row.announcement_group_wid } : {}),
    ...(row.poll_wa_msg_id ? { pollWaMsgId: row.poll_wa_msg_id } : {}),
    ...(row.poll_question ? { pollQuestion: row.poll_question } : {}),
    pollOptions: parseJson<StoredEventPollOption[]>(row.poll_options_json, []),
    responseClasses: parseJson<StoredEventResponseClass[]>(row.response_classes_json, []),
    answers: parseJson<Record<string, string>>(row.answers_json, {}),
    ...(eventLocation ? { eventLocation } : {}),
    startsAt: row.starts_at,
    startsAtUtc: row.starts_at_utc || row.starts_at,
    timezone: row.timezone,
    ...(row.local_date ? { localDate: row.local_date } : {}),
    ...(row.local_time ? { localTime: row.local_time } : {}),
    ...(row.place ? { place: row.place } : {}),
    closeAt: row.close_at,
    cleanupAt: row.cleanup_at,
    groupTitle: row.group_title,
    calendarDurationMinutes: Number(row.calendar_duration_minutes),
    ...(row.calendar_location ? { calendarLocation: row.calendar_location } : {}),
    ...(row.calendar_description ? { calendarDescription: row.calendar_description } : {}),
    ...(row.subgroup_chat_id ? { subgroupChatId: row.subgroup_chat_id } : {}),
    ...(row.subgroup_title ? { subgroupTitle: row.subgroup_title } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
    ...(row.cleaned_at ? { cleanedAt: row.cleaned_at } : {}),
    ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
    ...(row.cancelled_by_wid ? { cancelledByWid: row.cancelled_by_wid } : {}),
    ...(row.cancelled_by_label ? { cancelledByLabel: row.cancelled_by_label } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.provisioning_recovery_generation
      ? { provisioningRecoveryGeneration: row.provisioning_recovery_generation }
      : {}),
    ...(row.provisioning_recovery_attempt !== null
      ? { provisioningRecoveryAttempt: Number(row.provisioning_recovery_attempt) }
      : {}),
    ...(row.provisioning_recovery_next_run_at
      ? { provisioningRecoveryNextRunAt: row.provisioning_recovery_next_run_at }
      : {})
  };
}

function eventAnnouncementMessageFromRow(row: EventAnnouncementMessageRow): StoredEventAnnouncementMessage {
  return {
    id: row.id,
    eventId: row.event_id,
    scopeId: row.scope_id,
    kind: row.kind,
    deliveryKey: row.delivery_key,
    chatId: row.chat_id,
    messageId: row.message_id,
    createdAt: row.created_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    ...(row.delete_error ? { deleteError: row.delete_error } : {})
  };
}

function eventAnnouncementDeliveryClaimFromRow(
  row: EventAnnouncementDeliveryClaimRow
): StoredEventAnnouncementDeliveryClaim {
  return {
    eventId: row.event_id,
    kind: row.kind,
    deliveryKey: row.delivery_key,
    scopeId: row.scope_id,
    chatId: row.chat_id,
    status: row.status,
    ...(row.text ? { text: row.text } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at
  };
}

function eventEditRepairFromRow(row: EventEditRepairRow): StoredEventEditRepair {
  return {
    operationId: row.operation_id,
    eventId: row.event_id,
    scopeId: row.scope_id,
    expectedEventUpdatedAt: row.expected_event_updated_at,
    ...(row.subgroup_chat_id ? { subgroupChatId: row.subgroup_chat_id } : {}),
    targetGroupTitle: row.target_group_title,
    calendarId: row.calendar_id,
    ...(row.announcement_delivery_key
      ? { announcementDeliveryKey: row.announcement_delivery_key }
      : {}),
    status: row.status,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {})
  };
}

function eventCleanupClaimFromRow(row: EventCleanupClaimRow): EventCleanupClaim {
  return {
    eventId: row.event_id,
    claimId: row.claim_id,
    expectedEventUpdatedAt: row.expected_event_updated_at,
    claimedCleanupAt: row.claimed_cleanup_at,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at
  };
}

function normalizedEventAnnouncementIntent(
  input: EventAnnouncementDeliveryIntent
): EventAnnouncementDeliveryIntent {
  const scopeId = requiredEventOperationValue(input.scopeId, 'announcement scope id');
  const deliveryKey = requiredEventOperationValue(input.deliveryKey, 'announcement delivery key');
  const chatId = requiredEventOperationValue(input.chatId, 'announcement chat id');
  const text = requiredEventOperationValue(input.text, 'announcement text', false);
  const idempotencyKey = requiredEventOperationValue(input.idempotencyKey, 'announcement idempotency key');
  return { scopeId, kind: input.kind, deliveryKey, chatId, text, idempotencyKey };
}

function normalizedEventEditRepairIntent(input: EventEditRepairIntent): EventEditRepairIntent {
  const operationId = requiredEventOperationValue(input.operationId, 'edit operation id');
  const scopeId = requiredEventOperationValue(input.scopeId, 'edit scope id');
  const targetGroupTitle = requiredEventOperationValue(input.targetGroupTitle, 'edit target group title', false);
  const calendarId = requiredEventOperationValue(input.calendarId, 'edit calendar id');
  const subgroupChatId = input.subgroupChatId?.trim() || undefined;
  const announcementDeliveryKey = input.announcementDeliveryKey?.trim() || undefined;
  return {
    operationId,
    scopeId,
    ...(subgroupChatId ? { subgroupChatId } : {}),
    targetGroupTitle,
    calendarId,
    ...(announcementDeliveryKey ? { announcementDeliveryKey } : {})
  };
}

function requiredEventOperationValue(value: string, label: string, trim = true): string {
  if (!value.trim()) {
    throw new Error(`Event ${label} is required.`);
  }
  return trim ? value.trim() : value;
}

function parseStoredEventLocation(value: string | null): StoredEventLocation | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseJson<unknown>(value, undefined);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const location = parsed as Record<string, unknown>;
  if (
    (location.source !== 'question' && location.source !== 'fixed') ||
    typeof location.displayLabel !== 'string' ||
    !location.displayLabel.trim() ||
    typeof location.resolvedLabel !== 'string' ||
    !location.resolvedLabel.trim() ||
    typeof location.latitude !== 'number' ||
    !Number.isFinite(location.latitude) ||
    location.latitude < -90 ||
    location.latitude > 90 ||
    typeof location.longitude !== 'number' ||
    !Number.isFinite(location.longitude) ||
    location.longitude < -180 ||
    location.longitude > 180 ||
    typeof location.timezone !== 'string' ||
    !location.timezone.trim()
  ) {
    return undefined;
  }
  return {
    source: location.source,
    displayLabel: location.displayLabel,
    resolvedLabel: location.resolvedLabel,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: location.timezone,
    ...(typeof location.query === 'string' && location.query.trim() ? { query: location.query } : {}),
    ...(typeof location.provider === 'string' && location.provider.trim() ? { provider: location.provider } : {}),
    ...(typeof location.providerRef === 'string' && location.providerRef.trim()
      ? { providerRef: location.providerRef }
      : {})
  };
}

function voteFromRow(row: VoteRow): StoredEventVote {
  return {
    eventId: row.event_id,
    voterIdentityId: row.voter_identity_id,
    voterWid: row.voter_wid,
    selectedOptionIds: parseJson<string[]>(row.selected_option_ids_json, []),
    selectedOptionNames: parseJson<string[]>(row.selected_option_names_json, []),
    selectedOptionNumbers: parseJson<number[]>(row.selected_option_numbers_json, []),
    ...(row.interacted_at ? { interactedAt: row.interacted_at } : {}),
    updatedAt: row.updated_at
  };
}

function calendarPublicationStatusFromRow(row: CalendarPublicationStatusRow): StoredCalendarPublicationStatus {
  return {
    scopeId: row.scope_id,
    calendarId: row.calendar_id,
    generatedAt: row.generated_at,
    generatedEventCount: Number(row.generated_event_count),
    publicationEnabled: row.publication_enabled === 1,
    attempted: row.attempted === 1,
    ok: row.ok === 1,
    ...(row.endpoint_url ? { endpointUrl: row.endpoint_url } : {}),
    ...(row.feed_id ? { feedId: row.feed_id } : {}),
    ...(row.label ? { label: row.label } : {}),
    ...(row.subscription_url ? { subscriptionUrl: row.subscription_url } : {}),
    ...(row.calendar_url ? { calendarUrl: row.calendar_url } : {}),
    ...(row.target_updated_at ? { targetUpdatedAt: row.target_updated_at } : {}),
    ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
    ...(row.last_error_at ? { lastErrorAt: row.last_error_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    updatedAt: row.updated_at
  };
}

function eventWeatherDeliveryFromRow(row: EventWeatherDeliveryRow): StoredEventWeatherDelivery {
  return {
    eventId: row.event_id,
    eventUpdatedAt: row.event_updated_at,
    kind: row.kind,
    scheduleKind: row.schedule_kind,
    scheduledAt: row.scheduled_at,
    status: row.status,
    ...(row.chat_id ? { chatId: row.chat_id } : {}),
    ...(row.meteorological_text ? { meteorologicalText: row.meteorological_text } : {}),
    ...(row.marine_text ? { marineText: row.marine_text } : {}),
    ...(row.meteorological_idempotency_key
      ? { meteorologicalIdempotencyKey: row.meteorological_idempotency_key }
      : {}),
    ...(row.marine_idempotency_key ? { marineIdempotencyKey: row.marine_idempotency_key } : {}),
    ...(row.meteorological_message_id ? { meteorologicalMessageId: row.meteorological_message_id } : {}),
    ...(row.marine_message_id ? { marineMessageId: row.marine_message_id } : {}),
    ...(row.claim_id ? { claimId: row.claim_id } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    attempt: Number(row.attempt),
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    ...(row.sent_at ? { sentAt: row.sent_at } : {}),
    ...(row.skipped_at ? { skippedAt: row.skipped_at } : {}),
    ...(row.error ? { error: row.error } : {}),
    updatedAt: row.updated_at
  };
}

function unplannedEventFinalizationFromRow(
  row: UnplannedEventFinalizationRow
): StoredUnplannedEventFinalization {
  return {
    eventId: row.event_id,
    scopeId: row.scope_id,
    eventUpdatedAt: row.event_updated_at,
    generation: row.generation,
    attempt: Number(row.attempt),
    status: row.status,
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {})
  };
}

function eventQuestionKeyRenameFromRow(row: EventQuestionKeyRenameRow): StoredEventQuestionKeyRename {
  return {
    operationId: row.operation_id,
    scopeId: row.scope_id,
    profileId: row.profile_id,
    oldKey: row.old_key,
    newKey: row.new_key,
    oldProfileRevision: row.old_profile_revision ?? '',
    newProfileRevision: row.new_profile_revision ?? '',
    status: row.status,
    migratedEventCount: row.migrated_event_count,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requireEventQuestionKeyRenameRow(db: PluginDatabase, operationId: string): EventQuestionKeyRenameRow {
  const row = db.get<EventQuestionKeyRenameRow>(
    'SELECT * FROM event_question_key_renames WHERE operation_id = ?',
    operationId
  );
  if (!row) {
    throw new EventQuestionKeyRenameConflictError(`Unknown event question-key rename operation: ${operationId}`);
  }
  return row;
}

function parseEventAnswersForQuestionKeyRename(eventId: string, value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new EventQuestionKeyRenameConflictError(
      `Event ${eventId} has invalid stored answers and cannot be migrated safely.`
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((answer) => typeof answer !== 'string')
  ) {
    throw new EventQuestionKeyRenameConflictError(
      `Event ${eventId} has invalid stored answers and cannot be migrated safely.`
    );
  }
  return parsed as Record<string, string>;
}

function eventAnswerJsonPath(key: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
    throw new EventQuestionKeyRenameConflictError(`Invalid event question key: ${key}`);
  }
  return `$."${key}"`;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
