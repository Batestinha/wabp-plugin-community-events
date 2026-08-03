import { randomUUID } from 'node:crypto';
import type { ManagedCommunitySubgroupProvisioningStage } from '../../../platform/pluginRuntime/runtime/pluginCommunityOperations';
import type { CreatedGroupParticipantResult, PollVoteUpdate } from '../../../platform/transport/transportTypes';
import { equivalentWhatsAppMessageIds } from '../../../platform/transport/messageIds';
import type { PluginDatabase, PluginDatabaseRow, PluginDatabaseRegistry } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { CalendarPublicationOutcome } from './calendarPublication';
import { EVENTS_DATABASE } from './manifest';

export type EventStatus = 'active' | 'completed' | 'cancelled' | 'failed';
export type EventGroupLifecycleStatus = 'poll_open' | 'poll_closed' | 'cleanup_failed' | 'cleaned' | 'missed' | 'none';
export type EventCalendarStatus = 'included' | 'cancelled' | 'hidden';
export type EventOrigin = 'created' | 'unplanned' | 'adopted_poll' | 'adopted_group' | 'adopted_pair';
export type EventWeatherDeliveryStatus = 'queued' | 'skipped' | 'failed';
export type EventAnnouncementMessageKind = 'poll' | 'calendar_hint' | 'event_group_hint';
export type EventAnnouncementDeliveryKind = Exclude<EventAnnouncementMessageKind, 'poll'>;
export type EventAnnouncementDeliveryClaimStatus = 'sending' | 'sent' | 'uncertain';
export type EventAnnouncementDeliveryClaimResult = 'claimed' | 'already_sent' | 'already_claimed';

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
  profileLabel: string;
  origin: EventOrigin;
  eventStatus: EventStatus;
  groupLifecycleStatus: EventGroupLifecycleStatus;
  calendarStatus: EventCalendarStatus;
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
  style?: string | undefined;
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

export interface StoredEventVote {
  eventId: string;
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
  kind: string;
  scheduledAt: string;
  status: EventWeatherDeliveryStatus;
  queuedAt?: string | undefined;
  skippedAt?: string | undefined;
  failedAt?: string | undefined;
  error?: string | undefined;
  updatedAt: string;
}

export interface StoredEventAnnouncementMessage {
  id: string;
  eventId: string;
  scopeId: string;
  kind: EventAnnouncementMessageKind;
  chatId: string;
  messageId: string;
  createdAt: string;
  deletedAt?: string | undefined;
  deleteError?: string | undefined;
}

export interface StoredEventAnnouncementDeliveryClaim {
  eventId: string;
  kind: EventAnnouncementDeliveryKind;
  scopeId: string;
  chatId: string;
  status: EventAnnouncementDeliveryClaimStatus;
  messageId?: string | undefined;
  error?: string | undefined;
  claimedAt: string;
  updatedAt: string;
}

interface EventRow extends PluginDatabaseRow {
  id: string;
  scope_id: string;
  group_id: string | null;
  group_wid: string | null;
  profile_id: string;
  profile_label: string;
  origin: EventOrigin;
  event_status: EventStatus;
  group_lifecycle_status: EventGroupLifecycleStatus;
  calendar_status: EventCalendarStatus;
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
  kind: string;
  scheduled_at: string;
  status: EventWeatherDeliveryStatus;
  queued_at: string | null;
  skipped_at: string | null;
  failed_at: string | null;
  error: string | null;
  updated_at: string;
}

interface EventAnnouncementMessageRow extends PluginDatabaseRow {
  id: string;
  event_id: string;
  scope_id: string;
  kind: EventAnnouncementMessageKind;
  chat_id: string;
  message_id: string;
  created_at: string;
  deleted_at: string | null;
  delete_error: string | null;
}

interface EventAnnouncementDeliveryClaimRow extends PluginDatabaseRow {
  event_id: string;
  kind: EventAnnouncementDeliveryKind;
  scope_id: string;
  chat_id: string;
  status: EventAnnouncementDeliveryClaimStatus;
  message_id: string | null;
  error: string | null;
  claimed_at: string;
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

export function insertEvent(db: PluginDatabase, event: StoredEventRecord): void {
  db.run(
    `INSERT INTO event_records (
      id, scope_id, group_id, group_wid, profile_id, profile_label, origin,
      event_status, group_lifecycle_status, calendar_status, actor_wid, actor_label,
      announcement_group_wid, poll_wa_msg_id, poll_question, poll_options_json, response_classes_json,
      answers_json, event_location_json, starts_at, starts_at_utc, timezone, local_date, local_time, place, style,
      close_at, cleanup_at, group_title,
      calendar_duration_minutes, calendar_location, calendar_description, subgroup_chat_id, subgroup_title,
      created_at, updated_at, closed_at, cleaned_at, cancelled_at, cancelled_by_wid, cancelled_by_label,
      cancel_reason, error, provisioning_recovery_generation, provisioning_recovery_attempt,
      provisioning_recovery_next_run_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id,
    event.scopeId,
    event.groupId ?? null,
    event.groupWid ?? null,
    event.profileId,
    event.profileLabel,
    event.origin,
    event.eventStatus,
    event.groupLifecycleStatus,
    event.calendarStatus,
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
    event.style ?? null,
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
  style?: string | undefined;
  closeAt: string;
  cleanupAt: string;
  groupTitle: string;
  calendarDurationMinutes: number;
  calendarLocation?: string | undefined;
  calendarDescription?: string | undefined;
  updatedAt: string;
}): void {
  db.run(
    `UPDATE event_records
        SET poll_question = ?,
            poll_options_json = ?,
            response_classes_json = ?,
            answers_json = ?,
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
      WHERE id = ?`,
    input.pollQuestion,
    JSON.stringify(input.pollOptions),
    JSON.stringify(input.responseClasses),
    JSON.stringify(input.answers),
    input.eventLocation ? JSON.stringify(input.eventLocation) : null,
    input.startsAt,
    input.startsAtUtc,
    input.timezone,
    input.localDate,
    input.localTime ?? null,
    input.place ?? null,
    input.style ?? null,
    input.closeAt,
    input.cleanupAt,
    input.groupTitle,
    input.groupTitle,
    input.calendarDurationMinutes,
    input.calendarLocation ?? null,
    input.calendarDescription ?? null,
    input.updatedAt,
    input.eventId
  );
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

export function getActiveEventBySubgroup(db: PluginDatabase, subgroupChatId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>(
    `SELECT * FROM event_records
      WHERE subgroup_chat_id = ?
        AND event_status = 'active'
        AND group_lifecycle_status IN ('poll_open', 'poll_closed', 'cleanup_failed')
      ORDER BY starts_at ASC, id ASC
      LIMIT 1`,
    subgroupChatId
  );
  return row ? eventFromRow(row) : undefined;
}

export function getEventBySubgroupChatId(db: PluginDatabase, subgroupChatId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>(
    `SELECT * FROM event_records
      WHERE subgroup_chat_id = ?
        AND (
          (event_status = 'active' AND group_lifecycle_status IN ('poll_closed', 'cleanup_failed'))
          OR (event_status = 'completed' AND group_lifecycle_status = 'cleaned')
        )
      ORDER BY starts_at ASC, id ASC
      LIMIT 1`,
    subgroupChatId,
  );
  return row ? eventFromRow(row) : undefined;
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
      WHERE event_status = 'active'
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
        AND poll_wa_msg_id IS NOT NULL
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
        participants: input.participants
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

export function markEventCleaned(db: PluginDatabase, eventId: string, cleanedAt: string): void {
  db.run(
    `UPDATE event_records
        SET event_status = 'completed',
            group_lifecycle_status = 'cleaned',
            cleaned_at = ?,
            error = NULL,
            updated_at = ?
      WHERE id = ?`,
    cleanedAt,
    cleanedAt,
    eventId
  );
}

export function markEventCancelled(db: PluginDatabase, input: {
  eventId: string;
  cancelledAt: string;
  cancelledByWid: string;
  cancelledByLabel: string;
  calendarStatus?: Extract<EventCalendarStatus, 'cancelled' | 'hidden'> | undefined;
  reason?: string | undefined;
}): void {
  db.run(
    `UPDATE event_records
        SET event_status = 'cancelled',
            calendar_status = ?,
            cancelled_at = ?,
            cancelled_by_wid = ?,
            cancelled_by_label = ?,
            cancel_reason = ?,
            error = NULL,
            updated_at = ?
      WHERE id = ?`,
    input.calendarStatus ?? 'cancelled',
    input.cancelledAt,
    input.cancelledByWid,
    input.cancelledByLabel,
    input.reason ?? null,
    input.cancelledAt,
    input.eventId
  );
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
        id, event_id, scope_id, kind, chat_id, message_id, created_at, deleted_at, delete_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(event_id, kind, message_id) DO UPDATE SET
        scope_id = excluded.scope_id,
        chat_id = excluded.chat_id,
        deleted_at = NULL,
        delete_error = NULL`,
    id,
    input.eventId,
    input.scopeId,
    input.kind,
    input.chatId,
    messageId,
    now
  );
  const row = db.get<EventAnnouncementMessageRow>(
    `SELECT * FROM event_announcement_messages
      WHERE event_id = ? AND kind = ? AND message_id = ?
      LIMIT 1`,
    input.eventId,
    input.kind,
    messageId
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
  chatId: string;
  claimedAt?: string | undefined;
}): EventAnnouncementDeliveryClaimResult {
  return db.transaction(() => {
    const existingMessage = db.get<{ id: string }>(
      `SELECT id
         FROM event_announcement_messages
        WHERE event_id = ?
          AND kind = ?
        LIMIT 1`,
      input.eventId,
      input.kind
    );
    if (existingMessage) {
      return 'already_sent';
    }

    const now = input.claimedAt ?? new Date().toISOString();
    const inserted = db.run(
      `INSERT INTO event_announcement_delivery_claims (
         event_id, kind, scope_id, chat_id, status, message_id, error, claimed_at, updated_at
       ) VALUES (?, ?, ?, ?, 'sending', NULL, NULL, ?, ?)
       ON CONFLICT(event_id, kind) DO NOTHING`,
      input.eventId,
      input.kind,
      input.scopeId,
      input.chatId,
      now,
      now
    );
    if (inserted.changes === 1) {
      return 'claimed';
    }
    const existingClaim = getEventAnnouncementDeliveryClaim(db, input.eventId, input.kind);
    return existingClaim?.status === 'sent' ? 'already_sent' : 'already_claimed';
  });
}

export function completeEventAnnouncementDelivery(db: PluginDatabase, input: {
  eventId: string;
  scopeId: string;
  kind: EventAnnouncementDeliveryKind;
  chatId: string;
  messageId: string;
  completedAt?: string | undefined;
}): StoredEventAnnouncementMessage {
  const messageId = input.messageId.trim();
  if (!messageId) {
    throw new Error(`Cannot complete ${input.kind} delivery without a WhatsApp message id.`);
  }
  return db.transaction(() => {
    const current = getEventAnnouncementDeliveryClaim(db, input.eventId, input.kind);
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
              error = NULL,
              updated_at = ?
        WHERE event_id = ?
          AND kind = ?
          AND status = 'sending'`,
      input.scopeId,
      input.chatId,
      messageId,
      completedAt,
      input.eventId,
      input.kind
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
  reason: string;
  updatedAt?: string | undefined;
}): void {
  const updated = db.run(
    `UPDATE event_announcement_delivery_claims
        SET status = 'uncertain',
            error = ?,
            updated_at = ?
      WHERE event_id = ?
        AND kind = ?
        AND status = 'sending'`,
    input.reason,
    input.updatedAt ?? new Date().toISOString(),
    input.eventId,
    input.kind
  );
  if (updated.changes !== 1) {
    throw new Error(
      `Cannot mark ${input.kind} delivery for event ${input.eventId} uncertain from its current state.`
    );
  }
}

export function getEventAnnouncementDeliveryClaim(
  db: PluginDatabase,
  eventId: string,
  kind: EventAnnouncementDeliveryKind
): StoredEventAnnouncementDeliveryClaim | undefined {
  const row = db.get<EventAnnouncementDeliveryClaimRow>(
    `SELECT *
       FROM event_announcement_delivery_claims
      WHERE event_id = ? AND kind = ?`,
    eventId,
    kind
  );
  return row ? eventAnnouncementDeliveryClaimFromRow(row) : undefined;
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

export function markEventCleanupFailed(db: PluginDatabase, eventId: string, reason: string, failedAt: string): void {
  db.run(
    `UPDATE event_records SET group_lifecycle_status = 'cleanup_failed', error = ?, updated_at = ? WHERE id = ?`,
    reason,
    failedAt,
    eventId
  );
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

export function upsertVote(db: PluginDatabase, eventId: string, vote: PollVoteUpdate): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO event_votes (
       event_id, voter_wid, selected_option_ids_json, selected_option_names_json,
       selected_option_numbers_json, interacted_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, voter_wid) DO UPDATE SET
       selected_option_ids_json = excluded.selected_option_ids_json,
       selected_option_names_json = excluded.selected_option_names_json,
       selected_option_numbers_json = excluded.selected_option_numbers_json,
       interacted_at = excluded.interacted_at,
       updated_at = excluded.updated_at`,
    eventId,
    vote.voterWid,
    JSON.stringify(vote.selectedOptionIds),
    JSON.stringify(vote.selectedOptionNames),
    JSON.stringify(vote.selectedOptionNumbers),
    vote.interactedAt?.toISOString() ?? null,
    now
  );
}

export function replaceVotes(db: PluginDatabase, eventId: string, votes: PollVoteUpdate[]): void {
  db.transaction(() => {
    db.run('DELETE FROM event_votes WHERE event_id = ?', eventId);
    for (const vote of votes) {
      upsertVote(db, eventId, vote);
    }
  });
}

export function listVotes(db: PluginDatabase, eventId: string): StoredEventVote[] {
  return db.all<VoteRow>(
    'SELECT * FROM event_votes WHERE event_id = ? ORDER BY voter_wid ASC',
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
  kind: string
): StoredEventWeatherDelivery | undefined {
  const row = db.get<EventWeatherDeliveryRow>(
    'SELECT * FROM event_weather_deliveries WHERE event_id = ? AND kind = ?',
    eventId,
    kind
  );
  return row ? eventWeatherDeliveryFromRow(row) : undefined;
}

export function recordEventWeatherDelivery(db: PluginDatabase, input: {
  eventId: string;
  kind: string;
  scheduledAt: string;
  status: EventWeatherDeliveryStatus;
  at: string;
  error?: string | undefined;
}): void {
  db.run(
    `INSERT INTO event_weather_deliveries (
       event_id, kind, scheduled_at, status, queued_at, skipped_at, failed_at, error, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, kind) DO UPDATE SET
       scheduled_at = excluded.scheduled_at,
       status = excluded.status,
       queued_at = excluded.queued_at,
       skipped_at = excluded.skipped_at,
       failed_at = excluded.failed_at,
       error = excluded.error,
       updated_at = excluded.updated_at`,
    input.eventId,
    input.kind,
    input.scheduledAt,
    input.status,
    input.status === 'queued' ? input.at : null,
    input.status === 'skipped' ? input.at : null,
    input.status === 'failed' ? input.at : null,
    input.error ?? null,
    input.at
  );
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
    profileLabel: row.profile_label,
    origin: row.origin ?? 'created',
    eventStatus: row.event_status,
    groupLifecycleStatus: row.group_lifecycle_status,
    calendarStatus: row.calendar_status,
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
    ...(row.style ? { style: row.style } : {}),
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
    scopeId: row.scope_id,
    chatId: row.chat_id,
    status: row.status,
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at
  };
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
    kind: row.kind,
    scheduledAt: row.scheduled_at,
    status: row.status,
    ...(row.queued_at ? { queuedAt: row.queued_at } : {}),
    ...(row.skipped_at ? { skippedAt: row.skipped_at } : {}),
    ...(row.failed_at ? { failedAt: row.failed_at } : {}),
    ...(row.error ? { error: row.error } : {}),
    updatedAt: row.updated_at
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
