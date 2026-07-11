import { randomUUID } from 'node:crypto';
import type { CreatedGroupParticipantResult, PollVoteUpdate } from '../../../platform/transport/transportTypes';
import type { PluginDatabase, PluginDatabaseRow, PluginDatabaseRegistry } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import { EVENTS_DATABASE } from './manifest';

export type EventStatus = 'scheduled' | 'cancelled' | 'failed';
export type EventGroupLifecycleStatus = 'poll_open' | 'poll_closed' | 'cleanup_failed' | 'cleaned' | 'none';
export type EventCalendarStatus = 'included' | 'cancelled' | 'hidden';
export type EventOrigin = 'created' | 'unplanned' | 'adopted_poll' | 'adopted_group' | 'adopted_pair';

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
  startsAt: string;
  timezone: string;
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
  starts_at: string;
  timezone: string;
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
      answers_json, starts_at, timezone, close_at, cleanup_at, group_title,
      calendar_duration_minutes, calendar_location, calendar_description, subgroup_chat_id, subgroup_title,
      created_at, updated_at, closed_at, cleaned_at, cancelled_at, cancelled_by_wid, cancelled_by_label,
      cancel_reason, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    event.startsAt,
    event.timezone,
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
    event.error ?? null
  );
}

export function getEvent(db: PluginDatabase, eventId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>('SELECT * FROM event_records WHERE id = ?', eventId);
  return row ? eventFromRow(row) : undefined;
}

export function getEventByPoll(db: PluginDatabase, pollWaMsgId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>('SELECT * FROM event_records WHERE poll_wa_msg_id = ?', pollWaMsgId);
  return row ? eventFromRow(row) : undefined;
}

export function getActiveEventByPoll(db: PluginDatabase, pollWaMsgId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>(
    `SELECT * FROM event_records
      WHERE poll_wa_msg_id = ?
        AND event_status = 'scheduled'
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
        AND event_status = 'scheduled'
        AND group_lifecycle_status IN ('poll_open', 'poll_closed', 'cleanup_failed')
      ORDER BY starts_at ASC, id ASC
      LIMIT 1`,
    subgroupChatId
  );
  return row ? eventFromRow(row) : undefined;
}

export function getEventBySubgroupChatId(db: PluginDatabase, subgroupChatId: string): StoredEventRecord | undefined {
  const row = db.get<EventRow>(
    'SELECT * FROM event_records WHERE subgroup_chat_id = ? AND event_status = ? AND group_lifecycle_status IN (?, ?, ?) ORDER BY starts_at ASC, id ASC LIMIT 1',
    subgroupChatId,
    'scheduled',
    'poll_closed',
    'cleanup_failed',
    'cleaned'
  );
  return row ? eventFromRow(row) : undefined;
}

export function listCancellableEvents(db: PluginDatabase, scopeId: string): StoredEventRecord[] {
  return db.all<EventRow>(
    `SELECT * FROM event_records
      WHERE scope_id = ?
        AND event_status = 'scheduled'
        AND group_lifecycle_status IN ('poll_open', 'poll_closed', 'cleanup_failed')
      ORDER BY starts_at ASC, id ASC`,
    scopeId
  ).map(eventFromRow);
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
    `UPDATE event_records SET group_lifecycle_status = 'cleaned', cleaned_at = ?, updated_at = ? WHERE id = ?`,
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
  reason?: string | undefined;
}): void {
  db.run(
    `UPDATE event_records
        SET event_status = 'cancelled',
            calendar_status = 'cancelled',
            cancelled_at = ?,
            cancelled_by_wid = ?,
            cancelled_by_label = ?,
            cancel_reason = ?,
            error = NULL,
            updated_at = ?
      WHERE id = ?`,
    input.cancelledAt,
    input.cancelledByWid,
    input.cancelledByLabel,
    input.reason ?? null,
    input.cancelledAt,
    input.eventId
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

export function listVotes(db: PluginDatabase, eventId: string): StoredEventVote[] {
  return db.all<VoteRow>(
    'SELECT * FROM event_votes WHERE event_id = ? ORDER BY voter_wid ASC',
    eventId
  ).map(voteFromRow);
}

export function saveCreatedGroupParticipants(
  db: PluginDatabase,
  eventId: string,
  participants: Record<string, CreatedGroupParticipantResult>
): void {
  const now = new Date().toISOString();
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
  db.transaction(() => {
    for (const [wid, participant] of Object.entries(participants)) {
      insert.run(
        eventId,
        wid,
        participant.statusCode ?? null,
        participant.message ?? null,
        participant.isGroupCreator ? 1 : 0,
        participant.isInviteV4Sent ? 1 : 0,
        now
      );
    }
  });
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

function eventFromRow(row: EventRow): StoredEventRecord {
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
    startsAt: row.starts_at,
    timezone: row.timezone,
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
    ...(row.error ? { error: row.error } : {})
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

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
