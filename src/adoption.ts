import type { PluginCommandContext } from '../../../platform/pluginRuntime/types';
import type { PollVoteUpdate } from '../../../platform/transport/transportTypes';
import {
  IncompletePollVoteReadbackError,
  requireCompletePollVotes
} from '../../../platform/transport/pollVoteReadback';
import { requireOfficialCommandRuntime, type OfficialPluginCommandRuntime } from '../shared';
import { eventGroupHintEnabled, eventGroupJoinUrl, renderEventGroupAnnouncement } from './announcements';
import { eventFlowAnswersFromRaw } from './flow';
import { materializeEventLifecycle } from './materialize';
import { calendarResourceForProfile, parseEventsConfig, type EventProfile } from './config';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS } from './manifest';
import { eventWeatherForecastJobRequest } from './weather';
import {
  appendEventLog,
  eventsDatabase,
  getActiveEventByPoll,
  getActiveEventBySubgroup,
  insertEvent,
  listCalendarEvents,
  newEventId,
  upsertVote,
  type EventOrigin,
  type StoredEventRecord
} from './store';

export type EventAdoptionMode = 'poll' | 'group';

export interface EventTextTransport {
  sendText(chatId: string, text: string): Promise<{ messageId?: string | undefined }>;
}

export interface EventAdoptionInput {
  scopeId: string;
  mode: EventAdoptionMode;
  profileId: string;
  answers: Record<string, string>;
  locale?: string | undefined;
  pollWaMsgId?: string | undefined;
  subgroupChatId?: string | undefined;
  subgroupTitle?: string | undefined;
  actorWid: string;
  actorLabel: string;
}

export type EventAdoptionResult =
  | {
      status: 'adopted';
      event: StoredEventRecord;
      snapshotVoteCount: number;
      groupValidation?: EventAdoptedGroupValidation | undefined;
    }
  | {
      status: 'failed';
      reason: string;
      groupValidation?: EventAdoptedGroupValidation | undefined;
    };

export interface EventAdoptedGroupValidation {
  chatId: string;
  botIsMember: boolean;
  botIsAdmin: boolean;
  canRemoveMembers: boolean;
}

export async function adoptEventLifecycle(input: {
  context: PluginCommandContext;
  runtime?: OfficialPluginCommandRuntime | undefined;
  activeTransport?: EventTextTransport | undefined;
  adoption: EventAdoptionInput;
}): Promise<EventAdoptionResult> {
  const runtime = input.runtime ?? requireOfficialCommandRuntime(input.context);
  const db = eventsDatabase(runtime.databases);
  const adoption = normalizeAdoptionInput(input.adoption);
  const origin = adoptionOrigin(adoption.mode);

  if (origin === 'adopted_poll' && !adoption.pollWaMsgId) {
    return { status: 'failed', reason: 'Poll message id is required.' };
  }
  if (origin === 'adopted_group' && !adoption.subgroupChatId) {
    return { status: 'failed', reason: 'Event group id is required.' };
  }
  if (adoption.pollWaMsgId && getActiveEventByPoll(db, adoption.pollWaMsgId)) {
    return { status: 'failed', reason: 'This poll is already attached to an active event.' };
  }
  if (adoption.subgroupChatId && getActiveEventBySubgroup(db, adoption.subgroupChatId)) {
    return { status: 'failed', reason: 'This event group is already attached to an active event.' };
  }

  const config = parseEventsConfig(await runtime.configFor(adoption.scopeId, adoption.actorWid));
  const profile = config.eventProfiles.find((candidate) => candidate.id === adoption.profileId);
  if (!profile) {
    return { status: 'failed', reason: `Unknown event profile: ${adoption.profileId}` };
  }
  const announcementGroupWid = profile.announcementGroupWid ||
    await input.context.communityAnnouncementGroupWidForScope?.(adoption.scopeId);
  if (origin === 'adopted_poll' && !announcementGroupWid) {
    return { status: 'failed', reason: 'Announcement group is not configured for this event profile.' };
  }
  const answers = eventFlowAnswersFromRaw({
    profile,
    answers: adoption.answers,
    timezone: config.timezone,
    locale: adoption.locale ?? 'en'
  });
  if (!answers) {
    return { status: 'failed', reason: 'Event profile answers are incomplete or invalid.' };
  }

  let groupValidation: EventAdoptedGroupValidation | undefined;
  if (adoption.subgroupChatId) {
    groupValidation = await validateAdoptedGroup(input.context, adoption.subgroupChatId);
    if (!groupValidation.botIsMember || !groupValidation.botIsAdmin || !groupValidation.canRemoveMembers) {
      return {
        status: 'failed',
        reason: 'The bot must be a member and group admin with member-removal permission before this event group can be adopted.',
        groupValidation
      };
    }
  }

  const materialized = materializeEventLifecycle({
    profile,
    answers,
    timezone: config.timezone,
    locale: adoption.locale ?? 'en',
    creatorDisplayName: adoption.actorLabel || adoption.actorWid
  });
  const eventId = newEventId();
  const now = new Date();
  const event: StoredEventRecord = {
    id: eventId,
    scopeId: adoption.scopeId,
    profileId: profile.id,
    profileLabel: profile.label,
    origin,
    eventStatus: 'active',
    groupLifecycleStatus: origin === 'adopted_poll' ? 'poll_open' : 'poll_closed',
    calendarStatus: 'included',
    actorWid: adoption.actorWid,
    actorLabel: adoption.actorLabel,
    ...(announcementGroupWid ? { announcementGroupWid } : {}),
    ...(adoption.pollWaMsgId ? { pollWaMsgId: adoption.pollWaMsgId } : {}),
    ...(adoption.pollWaMsgId ? { pollQuestion: materialized.pollQuestion } : {}),
    pollOptions: adoption.pollWaMsgId ? materialized.pollOptions : [],
    responseClasses: materialized.responseClasses,
    answers: materialized.answers,
    startsAt: materialized.startsAt.toISOString(),
    startsAtUtc: materialized.startsAt.toISOString(),
    timezone: config.timezone,
    localDate: materialized.localDate,
    ...(materialized.localTime ? { localTime: materialized.localTime } : {}),
    ...(materialized.place ? { place: materialized.place } : {}),
    ...(materialized.style ? { style: materialized.style } : {}),
    closeAt: materialized.closeAt.toISOString(),
    cleanupAt: materialized.cleanupAt.toISOString(),
    groupTitle: materialized.groupTitle,
    calendarDurationMinutes: materialized.calendarDurationMinutes,
    ...(materialized.calendarLocation ? { calendarLocation: materialized.calendarLocation } : {}),
    ...(materialized.calendarDescription ? { calendarDescription: materialized.calendarDescription } : {}),
    ...(adoption.subgroupChatId ? { subgroupChatId: adoption.subgroupChatId } : {}),
    ...(adoption.subgroupTitle ? { subgroupTitle: adoption.subgroupTitle } : {}),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...(origin === 'adopted_poll' ? {} : { closedAt: now.toISOString() })
  };

  let snapshotVoteCount = 0;
  let snapshotVotes: PollVoteUpdate[] = [];
  if (adoption.pollWaMsgId) {
    if (!input.context.pollVoteReadbackFor) {
      throw new IncompletePollVoteReadbackError({
        pollWaMsgId: adoption.pollWaMsgId,
        coverage: 'incomplete',
        source: 'plugin-runtime',
        votes: [],
        reason: 'poll_readback_not_configured'
      });
    }
    snapshotVotes = requireCompletePollVotes(
      await input.context.pollVoteReadbackFor(adoption.pollWaMsgId)
    );
    snapshotVoteCount = snapshotVotes.length;
  }

  const calendarEvents = [...listCalendarEvents(db, adoption.scopeId), event];
  const publication = await writePublishAndRecordScopeCalendar({
    appConfig: runtime.config,
    db,
    config,
    scopeId: adoption.scopeId,
    calendarId: profile.calendar.calendarId,
    events: calendarEvents
  });
  const calendar = calendarResourceForProfile(config, profile);
  db.transaction(() => {
    insertEvent(db, event);
    for (const vote of snapshotVotes) {
      upsertVote(db, event.id, vote);
    }
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.adopted',
      metadata: {
        origin,
        pollWaMsgId: adoption.pollWaMsgId,
        subgroupChatId: adoption.subgroupChatId,
        actorWid: adoption.actorWid,
        snapshotVoteCount,
        groupValidation
      }
    });
  });
  if (adoption.subgroupChatId) {
    await input.context.registerManagedGroup?.({
      scopeId: adoption.scopeId,
      chatId: adoption.subgroupChatId,
      displayName: adoption.subgroupTitle || materialized.groupTitle
    });
  }
  await appendEventJsonLog(input.context, {
    action: 'event.adopted',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: adoption.actorWid,
    profileId: event.profileId,
    ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
    ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
    metadata: {
      origin,
      snapshotVoteCount,
      startsAt: event.startsAt,
      closeAt: event.closeAt,
      cleanupAt: event.cleanupAt,
      calendarId: calendar?.id ?? '',
      calendarEnabled: calendar?.enabled === true,
      ...(publication ? { publication } : {}),
      groupValidation
    }
  });
  await sendAdoptedEventGroupHint({
    context: input.context,
    activeTransport: input.activeTransport,
    event,
    profile,
    announcementGroupWid,
    locale: adoption.locale ?? 'en',
    creatorDisplayName: adoption.actorLabel || adoption.actorWid
  });

  await runtime.enqueuePluginJob({
    jobName: origin === 'adopted_poll' ? EVENTS_JOBS.close : EVENTS_JOBS.cleanup,
    scopeId: event.scopeId,
    runAt: new Date(origin === 'adopted_poll' ? event.closeAt : event.cleanupAt),
    payload: origin === 'adopted_poll' ? { eventId: event.id } : { eventId: event.id, attempt: 0 },
    dedupeKey: origin === 'adopted_poll'
      ? `${EVENTS_JOBS.close}:${event.id}`
      : `${EVENTS_JOBS.cleanup}:${event.id}:adopted`
  });
  if (origin !== 'adopted_poll') {
    const weatherRequest = eventWeatherForecastJobRequest({ event, profile, now });
    if (weatherRequest) {
      await runtime.enqueuePluginJob(weatherRequest);
    }
  }

  return {
    status: 'adopted',
    event,
    snapshotVoteCount,
    ...(groupValidation ? { groupValidation } : {})
  };
}

async function validateAdoptedGroup(
  context: PluginCommandContext,
  chatId: string
): Promise<EventAdoptedGroupValidation> {
  const capabilities = await context.botCapabilitiesFor?.(chatId);
  return {
    chatId,
    botIsMember: capabilities?.botIsMember === true,
    botIsAdmin: capabilities?.botIsAdmin === true || capabilities?.botIsSuperAdmin === true,
    canRemoveMembers: capabilities?.canRemoveMembers === true
  };
}

async function sendAdoptedEventGroupHint(input: {
  context: PluginCommandContext;
  activeTransport?: EventTextTransport | undefined;
  event: StoredEventRecord;
  profile: EventProfile;
  announcementGroupWid?: string | undefined;
  locale: string;
  creatorDisplayName: string;
}): Promise<void> {
  if (!eventGroupHintEnabled(input.profile, 'adopted')) {
    return;
  }
  if (!input.event.subgroupChatId) {
    await appendAdoptedAnnouncementSkipped(input.context, input.event, 'no_event_group');
    return;
  }
  if (!input.announcementGroupWid) {
    await appendAdoptedAnnouncementSkipped(input.context, input.event, 'announcement_group_missing', {
      subgroupChatId: input.event.subgroupChatId
    });
    return;
  }
  if (!input.activeTransport) {
    await appendAdoptedAnnouncementSkipped(input.context, input.event, 'transport_unavailable', {
      subgroupChatId: input.event.subgroupChatId,
      announcementGroupWid: input.announcementGroupWid
    });
    return;
  }
  const template = input.profile.eventGroupHint.template.trim();
  if (!template) {
    await appendAdoptedAnnouncementSkipped(input.context, input.event, 'empty_template', {
      subgroupChatId: input.event.subgroupChatId,
      announcementGroupWid: input.announcementGroupWid
    });
    return;
  }
  try {
    const groupJoinUrl = await eventGroupJoinUrl(input.context, template, input.event.subgroupChatId);
    const text = renderEventGroupAnnouncement({
      template,
      profile: input.profile,
      event: input.event,
      groupDisplayName: input.event.subgroupTitle || input.event.groupTitle,
      groupJoinUrl,
      subgroupChatId: input.event.subgroupChatId,
      locale: input.locale,
      creatorDisplayName: input.creatorDisplayName
    });
    if (!text) {
      await appendAdoptedAnnouncementSkipped(input.context, input.event, 'empty_rendered_text', {
        subgroupChatId: input.event.subgroupChatId,
        announcementGroupWid: input.announcementGroupWid
      });
      return;
    }
    const sent = await input.activeTransport.sendText(input.announcementGroupWid, text);
    await appendEventJsonLog(input.context, {
      action: 'event.adopted_announcement_sent',
      scopeId: input.event.scopeId,
      eventId: input.event.id,
      actorWid: input.event.actorWid,
      profileId: input.event.profileId,
      ...(input.event.pollWaMsgId ? { pollWaMsgId: input.event.pollWaMsgId } : {}),
      subgroupChatId: input.event.subgroupChatId,
      metadata: {
        announcementGroupWid: input.announcementGroupWid,
        messageId: sent.messageId,
        groupJoinUrl
      }
    });
  } catch (error) {
    await appendEventJsonLog(input.context, {
      action: 'event.adopted_announcement_failed',
      scopeId: input.event.scopeId,
      eventId: input.event.id,
      actorWid: input.event.actorWid,
      profileId: input.event.profileId,
      ...(input.event.pollWaMsgId ? { pollWaMsgId: input.event.pollWaMsgId } : {}),
      subgroupChatId: input.event.subgroupChatId,
      metadata: {
        announcementGroupWid: input.announcementGroupWid,
        reason: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

async function appendAdoptedAnnouncementSkipped(
  context: PluginCommandContext,
  event: StoredEventRecord,
  reason: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await appendEventJsonLog(context, {
    action: 'event.adopted_announcement_skipped',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: event.actorWid,
    profileId: event.profileId,
    ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
    ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
    metadata: {
      reason,
      ...metadata
    }
  });
}

function adoptionOrigin(mode: EventAdoptionMode): EventOrigin {
  if (mode === 'poll') {
    return 'adopted_poll';
  }
  return 'adopted_group';
}

function normalizeAdoptionInput(input: EventAdoptionInput): EventAdoptionInput {
  return {
    ...input,
    pollWaMsgId: input.pollWaMsgId?.trim() || undefined,
    subgroupChatId: input.subgroupChatId?.trim().toLowerCase() || undefined,
    subgroupTitle: input.subgroupTitle?.trim() || undefined,
    actorWid: input.actorWid.trim() || 'operator-console@system',
    actorLabel: input.actorLabel.trim() || input.actorWid.trim() || 'Operator Console'
  };
}

async function appendEventJsonLog(
  context: PluginCommandContext,
  entry: Parameters<typeof appendScopeEventJsonLog>[0]['entry']
): Promise<void> {
  try {
    await appendScopeEventJsonLog({ appConfig: context.config, entry });
  } catch {
    // Do not fail event adoption just because the append-only operator log is unavailable.
  }
}
