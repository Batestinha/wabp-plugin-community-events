import type { PluginCommandContext, PluginPollVote } from '../../../platform/pluginRuntime/types';
import { resolvePluginPollVotes } from '../../../platform/pluginRuntime/runtime/pluginPollVoteIdentity';
import {
  IncompletePollVoteReadbackError,
  requireCompletePollVotes
} from '../../../platform/transport/pollVoteReadback';
import { requireOfficialCommandRuntime, type OfficialPluginCommandRuntime } from '../shared';
import {
  persistedEventAnnouncementDisposition,
  sendClaimedEventAnnouncement
} from './announcementDelivery';
import { eventGroupHintEnabled, eventGroupJoinUrl, renderEventGroupAnnouncement } from './announcements';
import { sendEventCalendarHint } from './calendarHint';
import { eventFlowAnswersFromRaw } from './flow';
import { materializeEventLifecycle } from './materialize';
import { parseEventsConfig, type EventProfile } from './config';
import { eventProfileQuestionSchemaRevision } from './profileRevision';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS } from './manifest';
import {
  EVENT_WEATHER_FORECAST_POLL_CLOSE_KIND,
  eventWeatherForecastJobRequest
} from './weather';
import {
  appendEventLog,
  configuredEventCalendarOwnership,
  eventsDatabase,
  getActiveEventByPoll,
  getLiveEventBySubgroup,
  getCalendarPublicationStatus,
  getEvent,
  getEventWeatherDelivery,
  insertEvent,
  newEventId,
  recordEventAnnouncementMessage,
  resolvedEventCalendarId,
  updateEventSubgroupTitle,
  upsertVote,
  type EventOrigin,
  type NewStoredEventRecord,
  type StoredEventLocation,
  type StoredEventRecord
} from './store';

export type EventAdoptionMode = 'poll' | 'group';

export interface EventTextTransport {
  sendText(chatId: string, text: string): Promise<{ messageId?: string | undefined }>;
}

export interface EventAdoptionInput {
  eventId?: string | undefined;
  scopeId: string;
  mode: EventAdoptionMode;
  profileId: string;
  answers: Record<string, string>;
  locale?: string | undefined;
  pollWaMsgId?: string | undefined;
  subgroupChatId?: string | undefined;
  eventLocation?: StoredEventLocation | undefined;
  actorIdentityId: string;
}

type ResolvedEventAdoptionInput = EventAdoptionInput & {
  actorWid: string;
  actorLabel: string;
};

export type EventAdoptionResult =
  | {
      status: 'adopted';
      event: StoredEventRecord;
      snapshotVoteCount: number;
      reconciled?: boolean | undefined;
      effects?: EventAdoptionReconcileEffects | undefined;
      groupValidation?: EventAdoptedGroupValidation | undefined;
    }
  | {
      status: 'failed';
      reason: string;
      groupValidation?: EventAdoptedGroupValidation | undefined;
    };

export interface EventAdoptedGroupValidation {
  chatId: string;
  displayName?: string | undefined;
  expectedParentChatId?: string | undefined;
  linkedParentChatId?: string | undefined;
  childIsEventSubgroup: boolean;
  parentIsCommunity: boolean;
  parentContainsChild: boolean;
  botIsMember: boolean;
  botIsAdmin: boolean;
  canRemoveMembers: boolean;
}

export interface EventAdoptionReconcileEffects {
  subgroupTitle: 'backfilled' | 'preserved';
  calendarPublication: 'published' | 'unavailable';
  eventGroupHint: AdoptedEventGroupHintResult;
  calendarHint: Awaited<ReturnType<typeof sendEventCalendarHint>>;
  weather: 'pending' | 'already_pending' | 'already_sent' | 'skipped' | 'not_scheduled';
  cleanup: 'ensured';
}

export async function adoptEventLifecycle(input: {
  context: PluginCommandContext;
  runtime?: OfficialPluginCommandRuntime | undefined;
  activeTransport?: EventTextTransport | undefined;
  adoption: EventAdoptionInput;
}): Promise<EventAdoptionResult> {
  const runtime = input.runtime ?? requireOfficialCommandRuntime(input.context);
  const db = eventsDatabase(runtime.databases);
  const request = normalizeAdoptionInput(input.adoption);
  if (!request.actorIdentityId) {
    return { status: 'failed', reason: 'An authoritative actor identity id is required.' };
  }
  if (!input.context.resolveStableIdentityById) {
    return { status: 'failed', reason: 'The authoritative identity address service is unavailable.' };
  }
  let actorAddress: Awaited<ReturnType<NonNullable<PluginCommandContext['resolveStableIdentityById']>>>;
  try {
    actorAddress = await input.context.resolveStableIdentityById(request.actorIdentityId);
  } catch {
    return { status: 'failed', reason: 'The authoritative actor identity could not be resolved.' };
  }
  if (actorAddress.identityId !== request.actorIdentityId) {
    return { status: 'failed', reason: 'The authoritative actor identity resolution was inconsistent.' };
  }
  const actorWid = actorAddress.addressBookWid.trim();
  if (!actorWid) {
    return { status: 'failed', reason: 'The authoritative actor identity has no address-book address.' };
  }
  const adoption: ResolvedEventAdoptionInput = {
    ...request,
    actorWid,
    actorLabel: actorAddress.displayName?.trim() || actorWid
  };
  const origin = adoptionOrigin(adoption.mode);

  if (origin === 'adopted_poll' && !adoption.pollWaMsgId) {
    return { status: 'failed', reason: 'Poll message id is required.' };
  }
  if (origin === 'adopted_group' && !adoption.subgroupChatId) {
    return { status: 'failed', reason: 'Event group id is required.' };
  }
  if (adoption.eventId && origin !== 'adopted_group') {
    return { status: 'failed', reason: 'Only adopted event groups can be reconciled.' };
  }
  if (adoption.pollWaMsgId && getActiveEventByPoll(db, adoption.pollWaMsgId)) {
    return { status: 'failed', reason: 'This poll is already attached to an active event.' };
  }
  const existingSubgroupEvent = adoption.subgroupChatId
    ? getLiveEventBySubgroup(db, adoption.subgroupChatId)
    : undefined;
  if (!adoption.eventId && existingSubgroupEvent) {
    return { status: 'failed', reason: 'This event group is already attached to an active event.' };
  }
  if (adoption.eventId && !existingSubgroupEvent) {
    return { status: 'failed', reason: `Active adopted event ${adoption.eventId} was not found for this event group.` };
  }
  if (adoption.eventId && existingSubgroupEvent?.id !== adoption.eventId) {
    return { status: 'failed', reason: 'The requested event id does not match the active event attached to this group.' };
  }

  const config = parseEventsConfig(await runtime.configFor(adoption.scopeId, adoption.actorIdentityId));
  const profile = config.eventProfiles.find((candidate) => candidate.id === adoption.profileId);
  if (!profile) {
    return { status: 'failed', reason: `Unknown event profile: ${adoption.profileId}` };
  }
  if (adoption.eventId && existingSubgroupEvent && (
    existingSubgroupEvent.scopeId !== adoption.scopeId ||
    existingSubgroupEvent.profileId !== adoption.profileId ||
    existingSubgroupEvent.origin !== 'adopted_group' ||
    existingSubgroupEvent.groupLifecycleStatus !== 'poll_closed'
  )) {
    return {
      status: 'failed',
      reason: 'The requested event does not match this active adopted-group lifecycle.'
    };
  }
  const announcementGroupWid = profile.announcementGroupWid ||
    await input.context.communityAnnouncementGroupWidForScope?.(adoption.scopeId);
  if (origin === 'adopted_poll' && !announcementGroupWid) {
    return { status: 'failed', reason: 'Announcement group is not configured for this event profile.' };
  }
  let groupValidation: EventAdoptedGroupValidation | undefined;
  if (adoption.subgroupChatId) {
    groupValidation = await validateAdoptedGroup(
      input.context,
      adoption.scopeId,
      adoption.subgroupChatId
    );
    if (
      !groupValidation.displayName ||
      !groupValidation.expectedParentChatId ||
      groupValidation.linkedParentChatId !== groupValidation.expectedParentChatId ||
      !groupValidation.childIsEventSubgroup ||
      !groupValidation.parentIsCommunity ||
      !groupValidation.parentContainsChild ||
      !groupValidation.botIsMember ||
      !groupValidation.botIsAdmin ||
      !groupValidation.canRemoveMembers
    ) {
      return {
        status: 'failed',
        reason: 'The bot must be a member and group admin with member-removal permission, and the event group must expose a live title and be natively linked to the scoped community before it can be adopted.',
        groupValidation
      };
    }
  }

  if (adoption.eventId && existingSubgroupEvent) {
    return reconcileAdoptedGroupLifecycle({
      context: input.context,
      runtime,
      db,
      activeTransport: input.activeTransport,
      adoption,
      event: existingSubgroupEvent,
      profile,
      config,
      announcementGroupWid: existingSubgroupEvent.announcementGroupWid || announcementGroupWid,
      groupValidation
    });
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
  const materialized = materializeEventLifecycle({
    profile,
    answers,
    timezone: config.timezone,
    locale: adoption.locale ?? 'en',
    creatorDisplayName: adoption.actorLabel || adoption.actorWid,
    ...(adoption.eventLocation ? { eventLocation: adoption.eventLocation } : {})
  });
  const eventId = newEventId();
  const now = new Date();
  const event: NewStoredEventRecord = {
    id: eventId,
    scopeId: adoption.scopeId,
    profileId: profile.id,
    profileRevision: eventProfileQuestionSchemaRevision(profile),
    profileLabel: profile.label,
    origin,
    eventStatus: 'active',
    groupLifecycleStatus: origin === 'adopted_poll' ? 'poll_open' : 'poll_closed',
    calendarStatus: 'included',
    ...configuredEventCalendarOwnership(profile.calendar.calendarId),
    actorIdentityId: adoption.actorIdentityId,
    actorWid: adoption.actorWid,
    actorLabel: adoption.actorLabel,
    ...(announcementGroupWid ? { announcementGroupWid } : {}),
    ...(adoption.pollWaMsgId ? { pollWaMsgId: adoption.pollWaMsgId } : {}),
    ...(adoption.pollWaMsgId ? { pollQuestion: materialized.pollQuestion } : {}),
    pollOptions: adoption.pollWaMsgId ? materialized.pollOptions : [],
    responseClasses: materialized.responseClasses,
    answers: materialized.answers,
    ...(materialized.eventLocation ? { eventLocation: materialized.eventLocation } : {}),
    startsAt: materialized.startsAt.toISOString(),
    startsAtUtc: materialized.startsAt.toISOString(),
    timezone: config.timezone,
    localDate: materialized.localDate,
    ...(materialized.localTime ? { localTime: materialized.localTime } : {}),
    ...(materialized.place ? { place: materialized.place } : {}),
    closeAt: materialized.closeAt.toISOString(),
    cleanupAt: materialized.cleanupAt.toISOString(),
    groupTitle: materialized.groupTitle,
    calendarDurationMinutes: materialized.calendarDurationMinutes,
    ...(materialized.calendarLocation ? { calendarLocation: materialized.calendarLocation } : {}),
    ...(materialized.calendarDescription ? { calendarDescription: materialized.calendarDescription } : {}),
    ...(adoption.subgroupChatId ? { subgroupChatId: adoption.subgroupChatId } : {}),
    ...(groupValidation?.displayName ? { subgroupTitle: groupValidation.displayName } : {}),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...(origin === 'adopted_poll' ? {} : { closedAt: now.toISOString() })
  };

  let snapshotVoteCount = 0;
  let snapshotVotes: PluginPollVote[] = [];
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
    snapshotVotes = await resolvePluginPollVotes(
      requireCompletePollVotes(await input.context.pollVoteReadbackFor(adoption.pollWaMsgId)),
      requireAdoptionPollVoteIdentityResolver(input.context)
    );
    snapshotVoteCount = snapshotVotes.length;
  }

  db.transaction(() => {
    insertEvent(db, event);
    if (event.pollWaMsgId && event.announcementGroupWid) {
      recordEventAnnouncementMessage(db, {
        eventId: event.id,
        scopeId: event.scopeId,
        kind: 'poll',
        deliveryKey: 'initial',
        chatId: event.announcementGroupWid,
        messageId: event.pollWaMsgId,
        createdAt: event.createdAt
      });
    }
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
  const calendarId = resolvedEventCalendarId(event);
  const calendar = calendarId
    ? config.calendars.find((candidate) => candidate.id === calendarId)
    : undefined;
  let publication: Awaited<ReturnType<typeof writePublishAndRecordScopeCalendar>> = undefined;
  try {
    publication = calendarId
      ? await writePublishAndRecordScopeCalendar({
        appConfig: runtime.config,
        db,
        config,
        scopeId: adoption.scopeId,
        calendarId
      })
      : undefined;
  } catch (error) {
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.adopted.calendar_failed',
      metadata: { reason: error instanceof Error ? error.message : String(error) }
    });
  }
  if (adoption.subgroupChatId) {
    await input.context.registerManagedGroup?.({
      scopeId: adoption.scopeId,
      chatId: adoption.subgroupChatId,
      displayName: event.subgroupTitle
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
      calendarId: calendarId ?? '',
      calendarEnabled: calendar?.enabled === true,
      ...(publication ? { publication } : {}),
      groupValidation
    }
  });
  await sendAdoptedEventGroupHint({
    context: input.context,
    db,
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

async function reconcileAdoptedGroupLifecycle(input: {
  context: PluginCommandContext;
  runtime: OfficialPluginCommandRuntime;
  db: ReturnType<typeof eventsDatabase>;
  activeTransport?: EventTextTransport | undefined;
  adoption: ResolvedEventAdoptionInput;
  event: StoredEventRecord;
  profile: EventProfile;
  config: ReturnType<typeof parseEventsConfig>;
  announcementGroupWid?: string | undefined;
  groupValidation?: EventAdoptedGroupValidation | undefined;
}): Promise<EventAdoptionResult> {
  const subgroupChatId = input.event.subgroupChatId;
  const liveTitle = input.groupValidation?.displayName?.trim();
  if (!subgroupChatId || !liveTitle) {
    return {
      status: 'failed',
      reason: 'The adopted event group does not have a verified live id and title.',
      ...(input.groupValidation ? { groupValidation: input.groupValidation } : {})
    };
  }

  if (input.event.subgroupTitle && input.event.subgroupTitle !== liveTitle) {
    return {
      status: 'failed',
      reason: 'The stored subgroup title differs from the verified live title; reconcile the title through the event title workflow first.',
      ...(input.groupValidation ? { groupValidation: input.groupValidation } : {})
    };
  }

  let subgroupTitle: EventAdoptionReconcileEffects['subgroupTitle'] = 'preserved';
  if (!input.event.subgroupTitle) {
    const updated = updateEventSubgroupTitle(input.db, {
      eventId: input.event.id,
      subgroupChatId,
      subgroupTitle: liveTitle,
      updatedAt: new Date().toISOString()
    });
    if (!updated) {
      return {
        status: 'failed',
        reason: 'The adopted event changed while its verified subgroup title was being backfilled.',
        ...(input.groupValidation ? { groupValidation: input.groupValidation } : {})
      };
    }
    subgroupTitle = 'backfilled';
  }
  const event = getEvent(input.db, input.event.id);
  if (!event) {
    return { status: 'failed', reason: `Adopted event ${input.event.id} disappeared during reconciliation.` };
  }
  await input.context.registerManagedGroup?.({
    scopeId: event.scopeId,
    chatId: subgroupChatId,
    displayName: liveTitle
  });

  let calendarPublication: EventAdoptionReconcileEffects['calendarPublication'] = 'unavailable';
  try {
    const calendarId = resolvedEventCalendarId(event);
    const calendar = input.config.calendars.find((candidate) => candidate.id === calendarId);
    if (calendarId && calendar) {
      await writePublishAndRecordScopeCalendar({
        appConfig: input.runtime.config,
        db: input.db,
        config: input.config,
        scopeId: event.scopeId,
        calendarId
      });
      calendarPublication = getCalendarPublicationStatus(input.db, event.scopeId, calendarId)?.ok
        ? 'published'
        : 'unavailable';
    }
  } catch (error) {
    appendEventLog(input.db, {
      eventId: event.id,
      action: 'events.adoption_reconcile.calendar_failed',
      metadata: { reason: error instanceof Error ? error.message : String(error) }
    });
  }

  const eventGroupHint = await sendAdoptedEventGroupHint({
    context: input.context,
    db: input.db,
    activeTransport: input.activeTransport,
    event,
    profile: input.profile,
    announcementGroupWid: input.announcementGroupWid,
    locale: input.adoption.locale ?? 'en',
    creatorDisplayName: event.actorLabel || event.actorWid
  });
  const calendarHint = input.announcementGroupWid && input.activeTransport
    ? await sendEventCalendarHint({
        context: input.context,
        runtime: input.runtime,
        activeTransport: input.activeTransport,
        trigger: 'unplanned_recovery',
        scopeId: event.scopeId,
        announcementGroupWid: input.announcementGroupWid,
        event,
        profile: input.profile,
        calendars: input.config.calendars,
        timezone: event.timezone,
        locale: input.adoption.locale ?? 'en',
        creatorDisplayName: event.actorLabel || event.actorWid,
        subgroupChatId
      })
    : 'skipped';

  const existingWeather = getEventWeatherDelivery(
    input.db,
    event.id,
    EVENT_WEATHER_FORECAST_POLL_CLOSE_KIND,
    event.updatedAt
  );
  let weather: EventAdoptionReconcileEffects['weather'] = existingWeather?.status === 'sent'
    ? 'already_sent'
    : existingWeather?.status === 'skipped'
      ? 'skipped'
      : existingWeather
        ? 'already_pending'
      : 'not_scheduled';
  if (!existingWeather) {
    const request = eventWeatherForecastJobRequest({ event, profile: input.profile, now: new Date() });
    if (request) {
      await input.runtime.enqueuePluginJob({
        ...request,
        dedupeKey: `${request.dedupeKey}:lifecycle-recovery:${event.updatedAt}`
      });
      weather = 'pending';
    }
  }
  await input.runtime.enqueuePluginJob({
    jobName: EVENTS_JOBS.cleanup,
    scopeId: event.scopeId,
    ...(event.groupId ? { groupId: event.groupId } : {}),
    ...(event.groupWid ? { groupWid: event.groupWid } : {}),
    runAt: new Date(event.cleanupAt),
    payload: { eventId: event.id, attempt: 0 },
    dedupeKey: `${EVENTS_JOBS.cleanup}:${event.id}:adopted`
  });
  const effects: EventAdoptionReconcileEffects = {
    subgroupTitle,
    calendarPublication,
    eventGroupHint,
    calendarHint,
    weather,
    cleanup: 'ensured'
  };
  appendEventLog(input.db, {
    eventId: event.id,
    action: 'events.adoption_reconciled',
    metadata: effects
  });
  await appendEventJsonLog(input.context, {
    action: 'event.adoption_reconciled',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: input.adoption.actorWid,
    profileId: event.profileId,
    subgroupChatId,
    metadata: effects
  });

  return {
    status: 'adopted',
    event,
    snapshotVoteCount: 0,
    reconciled: true,
    effects,
    ...(input.groupValidation ? { groupValidation: input.groupValidation } : {})
  };
}

export async function validateAdoptedGroup(
  context: PluginCommandContext,
  scopeId: string,
  chatId: string
): Promise<EventAdoptedGroupValidation> {
  const expectedParentChatId = await context.communityGroupWidForScope?.(scopeId);
  const [capabilities, childMetadata, parentMetadata, linkedGroups] = await Promise.all([
    context.botCapabilitiesFor?.(chatId),
    context.getGroupMetadataSnapshot?.(chatId),
    expectedParentChatId
      ? context.getGroupMetadataSnapshot?.(expectedParentChatId)
      : undefined,
    expectedParentChatId
      ? context.getCommunityLinkedGroups?.(expectedParentChatId)
      : undefined
  ]);
  const normalizedChatId = chatId.trim().toLowerCase();
  const childMatches = childMetadata?.chatId.trim().toLowerCase() === normalizedChatId;
  return {
    chatId,
    ...(childMatches && childMetadata?.displayName?.trim()
      ? { displayName: childMetadata.displayName.trim() }
      : {}),
    ...(expectedParentChatId ? { expectedParentChatId } : {}),
    ...(childMatches && childMetadata?.linkedParent
      ? { linkedParentChatId: childMetadata.linkedParent }
      : {}),
    childIsEventSubgroup: Boolean(
      childMatches &&
      childMetadata?.isCommunity !== true &&
      childMetadata?.isCommunityAnnounce !== true
    ),
    parentIsCommunity: Boolean(
      expectedParentChatId &&
      parentMetadata?.chatId.trim().toLowerCase() === expectedParentChatId.trim().toLowerCase() &&
      parentMetadata.isCommunity === true
    ),
    parentContainsChild: linkedGroups?.some((group) =>
      group.chatId.trim().toLowerCase() === normalizedChatId
    ) === true,
    botIsMember: capabilities?.botIsMember === true,
    botIsAdmin: capabilities?.botIsAdmin === true || capabilities?.botIsSuperAdmin === true,
    canRemoveMembers: capabilities?.canRemoveMembers === true
  };
}

export type AdoptedEventGroupHintResult =
  | 'disabled'
  | 'already_sent'
  | 'already_claimed'
  | 'superseded'
  | 'sent'
  | 'skipped'
  | 'failed';

export async function sendAdoptedEventGroupHint(input: {
  context: PluginCommandContext;
  db: ReturnType<typeof eventsDatabase>;
  activeTransport?: EventTextTransport | undefined;
  event: StoredEventRecord;
  profile: EventProfile;
  announcementGroupWid?: string | undefined;
  locale: string;
  creatorDisplayName: string;
}): Promise<AdoptedEventGroupHintResult> {
  const persistedDelivery = persistedEventAnnouncementDisposition(
    input.db,
    input.event.id,
    'event_group_hint',
    'initial'
  );
  if (persistedDelivery) {
    return persistedDelivery;
  }
  if (!eventGroupHintEnabled(input.profile, 'adopted')) {
    return 'disabled';
  }
  if (!input.event.subgroupChatId) {
    await appendAdoptedAnnouncementSkipped(input.context, input.event, 'no_event_group');
    return 'skipped';
  }
  if (!input.announcementGroupWid) {
    await appendAdoptedAnnouncementSkipped(input.context, input.event, 'announcement_group_missing', {
      subgroupChatId: input.event.subgroupChatId
    });
    return 'skipped';
  }
  if (!input.activeTransport) {
    await appendAdoptedAnnouncementSkipped(input.context, input.event, 'transport_unavailable', {
      subgroupChatId: input.event.subgroupChatId,
      announcementGroupWid: input.announcementGroupWid
    });
    return 'skipped';
  }
  const template = input.profile.eventGroupHint.template.trim();
  if (!template) {
    await appendAdoptedAnnouncementSkipped(input.context, input.event, 'empty_template', {
      subgroupChatId: input.event.subgroupChatId,
      announcementGroupWid: input.announcementGroupWid
    });
    return 'skipped';
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
      return 'skipped';
    }
    const delivery = await sendClaimedEventAnnouncement({
      db: input.db,
      eventId: input.event.id,
      scopeId: input.event.scopeId,
      kind: 'event_group_hint',
      deliveryKey: 'initial',
      chatId: input.announcementGroupWid,
      text,
      sender: input.activeTransport
    });
    if (delivery.status !== 'sent') {
      return delivery.status;
    }
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
        messageId: delivery.messageId,
        groupJoinUrl
      }
    });
    return 'sent';
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
    return 'failed';
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

function requireAdoptionPollVoteIdentityResolver(
  context: PluginCommandContext
): NonNullable<PluginCommandContext['resolveIdentityAddress']> {
  if (!context.resolveIdentityAddress) {
    throw new Error('Authoritative poll-voter identity resolution is unavailable.');
  }
  return context.resolveIdentityAddress;
}

function normalizeAdoptionInput(input: EventAdoptionInput): EventAdoptionInput {
  return {
    ...input,
    eventId: input.eventId?.trim() || undefined,
    pollWaMsgId: input.pollWaMsgId?.trim() || undefined,
    subgroupChatId: input.subgroupChatId?.trim().toLowerCase() || undefined,
    actorIdentityId: input.actorIdentityId.trim()
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
