import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import type {
  PluginGroupDismantledEvent,
  PluginJobEvent,
  PluginPollVotePluginEvent,
  PluginRuntimeHooks
} from '../../../platform/pluginRuntime/types';
import { isManagedCommunitySubgroupProvisioningError } from '../../../platform/pluginRuntime/runtime/pluginCommunityOperations';
import {
  IncompletePollVoteReadbackError,
  requireCompletePollVotes
} from '../../../platform/transport/pollVoteReadback';
import type { CreatedGroupParticipantResult } from '../../../platform/transport/transportTypes';
import type { PluginGroupDismantleResult, PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import { parseEventsConfig, type EventProfile } from './config';
import { eventGroupHintEnabled, eventGroupJoinUrl, renderEventGroupAnnouncement } from './announcements';
import {
  eventSubgroupAttendeeCoverage,
  voterWidsForResponseBehavior
} from './attendance';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import { createEventCommunitySubgroup } from './subgroups';
import {
  eventWeatherForecastJobAction,
  eventWeatherForecastJobRequest,
  handleEventWeatherForecastJob
} from './weather';
import {
  appendEventLog,
  eventsDatabase,
  getEvent,
  getEventByEquivalentPoll,
  getActiveEventBySubgroup,
  listCreatedGroupParticipants,
  listOpenPollEvents,
  listFailedProvisioningEvents,
  listPendingCleanupEvents,
  listCalendarEvents,
  listWeatherForecastCandidateEvents,
  markEventCleanupFailed,
  markEventCleaned,
  markEventClosed,
  markEventFailed,
  markEventProvisioningFailed,
  markEventMissed,
  replaceVotes,
  saveCreatedGroupParticipants,
  updateEventCloseAt,
  upsertVote,
  type StoredEventRecord
} from './store';
import {
  eventProvisioningResumeDedupeKey,
  resumeEventProvisioning
} from './provisioningRecovery';

type PluginEnqueueJobAction = Extract<PluginAction, { type: 'plugin.enqueueJob' }>;

interface EventRecoveryOptions {
  now?: Date | undefined;
}

interface EventsHooksOptions {
  recoverJobs?: boolean | undefined;
}

export function createEventsHooks(context: PluginRuntimeContext, options: EventsHooksOptions = {}): PluginRuntimeHooks {
  if (options.recoverJobs !== false) {
    void recoverEventJobs(context).catch((error) => {
      context.logger.error({ error }, 'official.community-events job recovery failed');
    });
  }
  return {
    async onPollVote(event) {
      await handlePollVote(context, event);
    },
    async onPluginJob(event) {
      return handleEventJob(context, event);
    },
    async onGroupDismantled(event) {
      await handleGroupDismantled(context, event);
    }
  };
}

export async function recoverEventJobs(
  context: PluginRuntimeContext,
  options: EventRecoveryOptions = {}
): Promise<number> {
  const closeJobs = await recoverEventCloseJobs(context, options);
  const cleanupJobs = await recoverEventCleanupJobs(context);
  const weatherForecastJobs = await recoverEventWeatherForecastJobs(context);
  const provisioningJobs = await recoverEventProvisioningJobs(context, options);
  const enqueued = closeJobs + cleanupJobs + weatherForecastJobs + provisioningJobs;
  if (enqueued > 0) {
    context.logger.info(
      { enqueued, closeJobs, cleanupJobs, weatherForecastJobs, provisioningJobs },
      'Recovered official.community-events jobs'
    );
  }
  return enqueued;
}

export async function recoverEventProvisioningJobs(
  context: PluginRuntimeContext,
  options: EventRecoveryOptions = {}
): Promise<number> {
  const db = eventsDatabase(context.databases);
  const records = listFailedProvisioningEvents(db);
  let enqueued = 0;
  for (const record of records) {
    try {
      const result = await resumeEventProvisioning({
        context,
        scopeId: record.scopeId,
        eventId: record.id,
        subgroupChatId: record.subgroupChatId!,
        ...(record.subgroupTitle ? { subgroupTitle: record.subgroupTitle } : {}),
        actorWid: 'plugin-startup@system',
        actorLabel: 'Plugin startup recovery',
        ...(options.now ? { now: options.now } : {})
      });
      if (result.status === 'queued') {
        enqueued += 1;
      } else if (result.status === 'rejected') {
        context.logger.warn(
          { eventId: record.id, scopeId: record.scopeId, reason: result.reason },
          'Unable to resume failed official.community-events subgroup provisioning'
        );
      }
    } catch (error) {
      context.logger.warn(
        { error, eventId: record.id, scopeId: record.scopeId },
        'Failed to recover official.community-events subgroup provisioning'
      );
    }
  }
  return enqueued;
}

export async function recoverEventCloseJobs(context: PluginRuntimeContext, options: EventRecoveryOptions = {}): Promise<number> {
  const db = eventsDatabase(context.databases);
  const records = listOpenPollEvents(db);
  const now = options.now ?? new Date();
  let enqueued = 0;
  for (const record of records) {
    const config = parseEventsConfig(await context.configFor(record.scopeId));
    const closeAt = effectiveCloseAt(record, config);
    persistEffectiveCloseAt(db, record, closeAt);
    const closeAtIso = Number.isFinite(closeAt.getTime()) ? closeAt.toISOString() : 'invalid';
    const due = Boolean(record.subgroupChatId) ||
      (Number.isFinite(closeAt.getTime()) && closeAt.getTime() <= now.getTime());
    if (due && !record.subgroupChatId && eventScheduledDateHasPassed(record, now)) {
      await markStartupEventMissed(context, db, record, config, closeAt, now);
      continue;
    }
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.close,
      scopeId: record.scopeId,
      ...(record.groupId ? { groupId: record.groupId } : {}),
      ...(record.groupWid ? { groupWid: record.groupWid } : {}),
      ...(!due && Number.isFinite(closeAt.getTime()) ? { runAt: closeAt } : {}),
      payload: { eventId: record.id },
      dedupeKey: record.subgroupChatId
        ? eventProvisioningResumeDedupeKey(record.id, record.subgroupChatId)
        : `${EVENTS_JOBS.close}:${record.id}:${due ? 'startup-due' : 'startup'}:${closeAtIso}:${record.updatedAt}`
    });
    enqueued += 1;
  }
  return enqueued;
}

export async function recoverEventCleanupJobs(context: PluginRuntimeContext): Promise<number> {
  const db = eventsDatabase(context.databases);
  const records = listPendingCleanupEvents(db);
  let enqueued = 0;
  for (const record of records) {
    const cleanupAt = new Date(record.cleanupAt);
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.cleanup,
      scopeId: record.scopeId,
      ...(record.groupId ? { groupId: record.groupId } : {}),
      ...(record.groupWid ? { groupWid: record.groupWid } : {}),
      ...(Number.isFinite(cleanupAt.getTime()) ? { runAt: cleanupAt } : {}),
      payload: { eventId: record.id, attempt: 0 },
      dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:startup:${record.cleanupAt}:${record.updatedAt}`
    });
    enqueued += 1;
  }
  return enqueued;
}

export async function recoverEventWeatherForecastJobs(context: PluginRuntimeContext): Promise<number> {
  const db = eventsDatabase(context.databases);
  const records = listWeatherForecastCandidateEvents(db);
  let enqueued = 0;
  const now = new Date();
  for (const record of records) {
    const config = parseEventsConfig(await context.configFor(record.scopeId));
    const profile = config.eventProfiles.find((candidate) => candidate.id === record.profileId);
    const request = eventWeatherForecastJobRequest({ event: record, profile, now });
    if (!request) {
      continue;
    }
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: request.jobName,
      scopeId: request.scopeId,
      ...(request.groupId ? { groupId: request.groupId } : {}),
      ...(request.groupWid ? { groupWid: request.groupWid } : {}),
      ...(request.runAt ? { runAt: request.runAt } : {}),
      payload: request.payload,
      dedupeKey: `${request.dedupeKey}:startup:${record.updatedAt}`
    });
    enqueued += 1;
  }
  return enqueued;
}

async function handlePollVote(context: PluginRuntimeContext, event: PluginPollVotePluginEvent): Promise<void> {
  const db = eventsDatabase(context.databases);
  const record = getEventByEquivalentPoll(db, event.vote.pollWaMsgId);
  if (!record) {
    return;
  }
  upsertVote(db, record.id, event.vote);
  await appendJsonLog(context, {
    action: 'poll.vote',
    scopeId: record.scopeId,
    eventId: record.id,
    actorWid: event.vote.voterWid,
    profileId: record.profileId,
    pollWaMsgId: event.vote.pollWaMsgId,
    metadata: {
      selectedOptionIds: event.vote.selectedOptionIds,
      selectedOptionNames: event.vote.selectedOptionNames,
      selectedOptionNumbers: event.vote.selectedOptionNumbers
    }
  });
}

async function handleEventJob(context: PluginRuntimeContext, event: PluginJobEvent): Promise<PluginAction[]> {
  if (event.jobName === EVENTS_JOBS.close) {
    return closeEvent(context, event);
  }
  if (event.jobName === EVENTS_JOBS.cleanup) {
    return cleanupEvent(context, event);
  }
  if (event.jobName === EVENTS_JOBS.weatherForecast) {
    const db = eventsDatabase(context.databases);
    const eventId = jobPayloadEventId(event.payload);
    const record = eventId ? getEvent(db, eventId) : undefined;
    const config = record ? parseEventsConfig(await context.configFor(record.scopeId)) : undefined;
    const profile = record && config
      ? config.eventProfiles.find((candidate) => candidate.id === record.profileId)
      : undefined;
    return handleEventWeatherForecastJob(context, db, event, profile);
  }
  return [];
}

async function handleGroupDismantled(
  context: PluginRuntimeContext,
  event: PluginGroupDismantledEvent
): Promise<void> {
  if (event.source?.kind === 'plugin_action' && event.source.pluginId === EVENTS_PLUGIN_ID) {
    return;
  }
  if (!dismantleCompleted(event.result)) {
    return;
  }
  const db = eventsDatabase(context.databases);
  const record = getActiveEventBySubgroup(db, event.chatId);
  if (!record || record.eventStatus !== 'active' ||
      (record.groupLifecycleStatus !== 'poll_closed' && record.groupLifecycleStatus !== 'cleanup_failed')) {
    return;
  }

  const cleanedAt = event.receivedAt.toISOString();
  markEventCleaned(db, record.id, cleanedAt);
  await setCleanupFailureStatus(context, record.scopeId, null);
  appendEventLog(db, {
    eventId: record.id,
    action: 'events.cleaned.external',
    metadata: {
      source: event.source,
      dismantleResult: event.result
    }
  });
  await appendJsonLog(context, {
    action: 'event.cleaned_external',
    scopeId: record.scopeId,
    eventId: record.id,
    profileId: record.profileId,
    ...(record.pollWaMsgId ? { pollWaMsgId: record.pollWaMsgId } : {}),
    ...(record.subgroupChatId ? { subgroupChatId: record.subgroupChatId } : {}),
    metadata: {
      source: event.source,
      dismantleResult: event.result
    }
  });
}

async function closeEvent(context: PluginRuntimeContext, job: PluginJobEvent): Promise<PluginAction[]> {
  const db = eventsDatabase(context.databases);
  const eventId = jobPayloadEventId(job.payload);
  if (!eventId) {
    return [audit('events.job.skipped', { jobName: job.jobName, reason: 'missing eventId' })];
  }
  const record = getEvent(db, eventId);
  if (!record || record.eventStatus !== 'active' || record.groupLifecycleStatus !== 'poll_open') {
    return [audit('events.job.skipped', { jobName: job.jobName, eventId, reason: 'event missing or poll not open' })];
  }
  if (!record.pollWaMsgId) {
    return [audit('events.job.skipped', { jobName: job.jobName, eventId, reason: 'event has no poll' })];
  }

  let closePersisted = false;
  try {
    const config = parseEventsConfig(await context.configFor(record.scopeId));
    const closeAt = effectiveCloseAt(record, config);
    persistEffectiveCloseAt(db, record, closeAt);
    const now = new Date();
    if (!record.subgroupChatId && Number.isFinite(closeAt.getTime()) && closeAt.getTime() > now.getTime()) {
      return [
        audit('events.close.deferred', {
          eventId: record.id,
          effectiveCloseAt: closeAt.toISOString(),
          storedCloseAt: record.closeAt
        }),
        {
          type: 'plugin.enqueueJob',
          pluginId: EVENTS_PLUGIN_ID,
          jobName: EVENTS_JOBS.close,
          scopeId: record.scopeId,
          runAt: closeAt,
          payload: { eventId: record.id },
          dedupeKey: `${EVENTS_JOBS.close}:${record.id}:deferred:${closeAt.toISOString()}`
        }
      ];
    }
    if (!context.pollVoteReadbackFor) {
      throw new IncompletePollVoteReadbackError({
        pollWaMsgId: record.pollWaMsgId,
        coverage: 'incomplete',
        source: 'plugin-runtime',
        votes: [],
        reason: 'poll_readback_not_configured'
      });
    }
    const liveVotes = requireCompletePollVotes(
      await context.pollVoteReadbackFor(record.pollWaMsgId)
    );
    replaceVotes(db, record.id, liveVotes);
    for (const vote of liveVotes) {
      await appendJsonLog(context, {
        action: 'poll.vote.snapshot',
        scopeId: record.scopeId,
        eventId: record.id,
        actorWid: vote.voterWid,
        profileId: record.profileId,
        pollWaMsgId: record.pollWaMsgId,
        metadata: {
          selectedOptionIds: vote.selectedOptionIds,
          selectedOptionNames: vote.selectedOptionNames,
          selectedOptionNumbers: vote.selectedOptionNumbers
        }
      });
    }
    const votes = liveVotes;
    const attendeeWids = voterWidsForResponseBehavior(record, votes, 'includeInEventGroup');
    let subgroupChatId = record.subgroupChatId;
    let subgroupTitle = record.subgroupTitle ?? (subgroupChatId ? record.groupTitle : undefined);

    if (attendeeWids.length > 0 && subgroupChatId) {
      const coverage = await eventSubgroupAttendeeCoverage(
        context,
        subgroupChatId,
        attendeeWids,
        storedParticipantOutcomes(db, record.id)
      );
      if (coverage.missingAttendeeWids.length > 0) {
        throw new Error(
          `Subgroup ${subgroupChatId} is missing attendee(s): ${coverage.missingAttendeeWids.join(', ')}`
        );
      }
      await appendJsonLog(context, {
        action: 'subgroup.reused',
        scopeId: record.scopeId,
        eventId: record.id,
        profileId: record.profileId,
        pollWaMsgId: record.pollWaMsgId,
        subgroupChatId,
        metadata: {
          title: subgroupTitle,
          attendeeWids,
          presentAttendeeWids: coverage.presentAttendeeWids,
          pendingInviteWids: coverage.pendingInviteWids
        }
      });
    } else if (attendeeWids.length > 0) {
      const result = await createEventCommunitySubgroup({
        context,
        scopeId: record.scopeId,
        actorWid: record.actorWid,
        title: record.groupTitle,
        participantWids: attendeeWids
      });
      const created = result.created;
      subgroupChatId = created.chatId;
      subgroupTitle = created.title;
      saveCreatedGroupParticipants(db, record.id, created.participants);
      await appendJsonLog(context, {
        action: 'subgroup.created',
        scopeId: record.scopeId,
        eventId: record.id,
        profileId: record.profileId,
        pollWaMsgId: record.pollWaMsgId,
        subgroupChatId: created.chatId,
        metadata: {
          title: created.title,
          attendeeWids,
          participants: created.participants
        }
      });
    }

    const calendarProfile = config.eventProfiles.find((profile) => profile.id === record.profileId);
    const plannedAnnouncementActions = await plannedEventAnnouncementActions(context, {
      record,
      profile: calendarProfile,
      subgroupChatId,
      subgroupTitle
    });
    const closedEvent: StoredEventRecord = {
      ...record,
      groupLifecycleStatus: 'poll_closed',
      ...(subgroupChatId ? { subgroupChatId } : {}),
      ...(subgroupTitle ? { subgroupTitle } : {})
    };
    const weatherForecastAction = eventWeatherForecastJobAction({
      event: closedEvent,
      profile: calendarProfile
    });
    const closedAt = new Date().toISOString();
    markEventClosed(db, {
      eventId: record.id,
      ...(subgroupChatId ? { subgroupChatId } : {}),
      ...(subgroupTitle ? { subgroupTitle } : {}),
      closedAt
    });
    closePersisted = true;
    appendEventLog(db, {
      eventId: record.id,
      action: 'events.closed',
      metadata: { attendeeCount: attendeeWids.length, subgroupChatId }
    });
    await appendJsonLog(context, {
      action: 'event.closed',
      scopeId: record.scopeId,
      eventId: record.id,
      profileId: record.profileId,
      pollWaMsgId: record.pollWaMsgId,
      ...(subgroupChatId ? { subgroupChatId } : {}),
      metadata: { attendeeCount: attendeeWids.length, subgroupTitle }
    });
    const calendar = calendarProfile
      ? config.calendars.find((candidate) => candidate.id === calendarProfile.calendar.calendarId)
      : undefined;
    const calendarEvents = listCalendarEvents(db, record.scopeId);
    const calendarFailureAudit = await publishClosedEventCalendar(context, {
      db,
      config,
      record,
      calendarId: calendarProfile?.calendar.calendarId ?? '',
      calendarEnabled: calendar?.enabled === true,
      events: calendarEvents
    });
    return [
      ...plannedAnnouncementActions,
      ...(weatherForecastAction ? [weatherForecastAction] : []),
      closeCleanupAction(record),
      ...(calendarFailureAudit ? [calendarFailureAudit] : []),
      audit('events.closed', { eventId: record.id, attendeeCount: attendeeWids.length, subgroupChatId })
    ];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (closePersisted) {
      context.logger.error(
        { error, eventId: record.id, scopeId: record.scopeId },
        'Event close side effect failed after poll closure was persisted'
      );
      await recordPostCloseFailure(context, db, record, reason);
      return [
        closeCleanupAction(record),
        audit('events.close.side_effect_failed', { eventId: record.id, reason })
      ];
    }
    if (error instanceof IncompletePollVoteReadbackError) {
      const retryAt = new Date(Date.now() + 60_000);
      appendEventLog(db, {
        eventId: record.id,
        action: 'events.close.readback_incomplete',
        metadata: {
          reason,
          source: error.readback.source,
          retryAt: retryAt.toISOString()
        }
      });
      await appendJsonLog(context, {
        action: 'event.close_readback_incomplete',
        scopeId: record.scopeId,
        eventId: record.id,
        profileId: record.profileId,
        pollWaMsgId: record.pollWaMsgId,
        metadata: {
          reason,
          source: error.readback.source,
          retryAt: retryAt.toISOString()
        }
      });
      return [
        {
          type: 'plugin.enqueueJob',
          pluginId: EVENTS_PLUGIN_ID,
          jobName: EVENTS_JOBS.close,
          scopeId: record.scopeId,
          runAt: retryAt,
          payload: { eventId: record.id },
          dedupeKey: `${EVENTS_JOBS.close}:${record.id}:readback:${retryAt.toISOString()}`
        },
        audit('events.close.readback_incomplete', {
          eventId: record.id,
          reason,
          source: error.readback.source,
          retryAt: retryAt.toISOString()
        })
      ];
    }
    const failedAt = new Date().toISOString();
    let failureMetadata: Record<string, unknown> = { reason };
    let failedSubgroupChatId: string | undefined;
    if (isManagedCommunitySubgroupProvisioningError(error)) {
      const { created, provisioning, stage } = error;
      failedSubgroupChatId = created.chatId;
      const progress = {
        standaloneRegistered: provisioning.standaloneRegistered,
        attendeesVerified: provisioning.attendeesVerified,
        communityLinkConfirmed: provisioning.communityLinkConfirmed,
        linkedChildRegistered: provisioning.linkedChildRegistered
      };
      const checkpointPersisted = markEventProvisioningFailed(db, {
        eventId: record.id,
        scopeId: record.scopeId,
        subgroupChatId: created.chatId,
        subgroupTitle: created.title,
        participants: created.participants,
        reason,
        failedAt
      });
      failureMetadata = {
        reason,
        subgroupChatId: created.chatId,
        subgroupTitle: created.title,
        parentCommunityWid: provisioning.parentCommunityWid,
        stage,
        progress,
        participants: created.participants,
        checkpointPersisted
      };
      if (!checkpointPersisted) {
        context.logger.error(
          {
            eventId: record.id,
            scopeId: record.scopeId,
            subgroupChatId: created.chatId,
            stage,
            progress
          },
          'Event subgroup provisioning failure checkpoint was rejected by the event state guard'
        );
      }
    } else {
      markEventFailed(db, record.id, reason, failedAt);
    }
    appendEventLog(db, {
      eventId: record.id,
      action: 'events.close.failed',
      metadata: failureMetadata
    });
    await appendJsonLog(context, {
      action: 'event.close_failed',
      scopeId: record.scopeId,
      eventId: record.id,
      profileId: record.profileId,
      pollWaMsgId: record.pollWaMsgId,
      ...(failedSubgroupChatId ? { subgroupChatId: failedSubgroupChatId } : {}),
      metadata: failureMetadata
    });
    return [audit('events.close.failed', { eventId: record.id, ...failureMetadata })];
  }
}

async function publishClosedEventCalendar(
  context: PluginRuntimeContext,
  input: {
    db: ReturnType<typeof eventsDatabase>;
    config: ReturnType<typeof parseEventsConfig>;
    record: StoredEventRecord;
    calendarId: string;
    calendarEnabled: boolean;
    events: StoredEventRecord[];
  }
): Promise<PluginAction | undefined> {
  try {
    const publication = await writePublishAndRecordScopeCalendar({
      appConfig: context.config,
      db: input.db,
      config: input.config,
      scopeId: input.record.scopeId,
      calendarId: input.calendarId,
      events: input.events
    });
    if (publication && !publication.ok) {
      return recordCalendarPublicationFailure(
        context,
        input.db,
        input.record,
        publication.error || 'Calendar publisher rejected the event update.',
        { publication }
      );
    }
    await appendJsonLog(context, {
      action: 'calendar.exported',
      scopeId: input.record.scopeId,
      eventId: input.record.id,
      profileId: input.record.profileId,
      pollWaMsgId: input.record.pollWaMsgId,
      metadata: {
        calendarEnabled: input.calendarEnabled,
        calendarId: input.calendarId,
        ...(publication ? { publication } : {})
      }
    });
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return recordCalendarPublicationFailure(context, input.db, input.record, reason);
  }
}

async function recordCalendarPublicationFailure(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  record: StoredEventRecord,
  reason: string,
  metadata: Record<string, unknown> = {}
): Promise<PluginAction> {
  context.logger.warn(
    { reason, eventId: record.id, scopeId: record.scopeId },
    'Event calendar publication failed after poll closure was persisted'
  );
  try {
    appendEventLog(db, {
      eventId: record.id,
      action: 'events.calendar.publication.failed',
      metadata: { reason, ...metadata }
    });
  } catch (error) {
    context.logger.warn(
      { error, eventId: record.id, scopeId: record.scopeId },
      'Unable to persist event calendar publication failure log'
    );
  }
  await appendJsonLog(context, {
    action: 'calendar.publication_failed',
    scopeId: record.scopeId,
    eventId: record.id,
    profileId: record.profileId,
    ...(record.pollWaMsgId ? { pollWaMsgId: record.pollWaMsgId } : {}),
    metadata: { reason, ...metadata }
  });
  return audit('events.calendar.publication.failed', {
    eventId: record.id,
    reason,
    ...metadata
  });
}

async function recordPostCloseFailure(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  record: StoredEventRecord,
  reason: string
): Promise<void> {
  try {
    appendEventLog(db, {
      eventId: record.id,
      action: 'events.close.side_effect_failed',
      metadata: { reason }
    });
  } catch (error) {
    context.logger.warn(
      { error, eventId: record.id, scopeId: record.scopeId },
      'Unable to persist post-close event side-effect failure log'
    );
  }
  await appendJsonLog(context, {
    action: 'event.close_side_effect_failed',
    scopeId: record.scopeId,
    eventId: record.id,
    profileId: record.profileId,
    ...(record.pollWaMsgId ? { pollWaMsgId: record.pollWaMsgId } : {}),
    metadata: { reason }
  });
}

function closeCleanupAction(record: StoredEventRecord): PluginEnqueueJobAction {
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.cleanup,
    scopeId: record.scopeId,
    ...(record.groupId ? { groupId: record.groupId } : {}),
    ...(record.groupWid ? { groupWid: record.groupWid } : {}),
    runAt: new Date(record.cleanupAt),
    payload: { eventId: record.id, attempt: 0 }
  };
}

async function plannedEventAnnouncementActions(
  context: PluginRuntimeContext,
  input: {
    record: StoredEventRecord;
    profile?: EventProfile | undefined;
    subgroupChatId?: string | undefined;
    subgroupTitle?: string | undefined;
  }
): Promise<PluginAction[]> {
  const { record, profile, subgroupChatId } = input;
  if (!profile || !eventGroupHintEnabled(profile, 'planned')) {
    return [];
  }
  if (!subgroupChatId) {
    await appendPlannedAnnouncementSkipped(context, record, 'no_event_group');
    return [];
  }
  if (!record.announcementGroupWid) {
    await appendPlannedAnnouncementSkipped(context, record, 'announcement_group_missing', { subgroupChatId });
    return [];
  }
  const template = profile.eventGroupHint.template.trim();
  if (!template) {
    await appendPlannedAnnouncementSkipped(context, record, 'empty_template', { subgroupChatId });
    return [];
  }

  try {
    const groupJoinUrl = await eventGroupJoinUrl(context, template, subgroupChatId);
    const text = renderEventGroupAnnouncement({
      template,
      profile,
      event: record,
      groupDisplayName: input.subgroupTitle || record.groupTitle,
      groupJoinUrl,
      subgroupChatId
    });
    if (!text) {
      await appendPlannedAnnouncementSkipped(context, record, 'empty_rendered_text', { subgroupChatId });
      return [];
    }
    await appendJsonLog(context, {
      action: 'event.planned_announcement_queued',
      scopeId: record.scopeId,
      eventId: record.id,
      actorWid: record.actorWid,
      profileId: record.profileId,
      ...(record.pollWaMsgId ? { pollWaMsgId: record.pollWaMsgId } : {}),
      subgroupChatId,
      metadata: {
        announcementGroupWid: record.announcementGroupWid,
        groupJoinUrl
      }
    });
    return [{
      type: 'message.sendText',
      chatId: record.announcementGroupWid,
      text
    }];
  } catch (error) {
    await appendJsonLog(context, {
      action: 'event.planned_announcement_failed',
      scopeId: record.scopeId,
      eventId: record.id,
      actorWid: record.actorWid,
      profileId: record.profileId,
      ...(record.pollWaMsgId ? { pollWaMsgId: record.pollWaMsgId } : {}),
      subgroupChatId,
      metadata: {
        announcementGroupWid: record.announcementGroupWid,
        reason: error instanceof Error ? error.message : String(error)
      }
    });
    return [];
  }
}

async function appendPlannedAnnouncementSkipped(
  context: PluginRuntimeContext,
  record: StoredEventRecord,
  reason: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await appendJsonLog(context, {
    action: 'event.planned_announcement_skipped',
    scopeId: record.scopeId,
    eventId: record.id,
    actorWid: record.actorWid,
    profileId: record.profileId,
    ...(record.pollWaMsgId ? { pollWaMsgId: record.pollWaMsgId } : {}),
    metadata: {
      reason,
      ...metadata
    }
  });
}

async function cleanupEvent(context: PluginRuntimeContext, job: PluginJobEvent): Promise<PluginAction[]> {
  const db = eventsDatabase(context.databases);
  const eventId = jobPayloadEventId(job.payload);
  if (!eventId) {
    return [audit('events.job.skipped', { jobName: job.jobName, reason: 'missing eventId' })];
  }
  const record = getEvent(db, eventId);
  if (!record || record.groupLifecycleStatus === 'cleaned') {
    return [audit('events.job.skipped', { jobName: job.jobName, eventId, reason: 'event missing or already cleaned' })];
  }
  if (record.eventStatus !== 'active' || (record.groupLifecycleStatus !== 'poll_closed' && record.groupLifecycleStatus !== 'cleanup_failed')) {
    return [audit('events.job.skipped', { jobName: job.jobName, eventId, reason: `event lifecycle is ${record.eventStatus}/${record.groupLifecycleStatus}` })];
  }

  const cleanupAt = new Date(record.cleanupAt);
  const now = new Date();
  if (Number.isFinite(cleanupAt.getTime()) && cleanupAt.getTime() > now.getTime()) {
    return [audit('events.cleanup.deferred', {
      eventId: record.id,
      cleanupAt: record.cleanupAt
    }), {
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.cleanup,
      scopeId: record.scopeId,
      runAt: cleanupAt,
      payload: { eventId: record.id, attempt: 0 },
      dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:deferred:${record.cleanupAt}`
    }];
  }

  const config = parseEventsConfig(await context.configFor(record.scopeId));
  const attempt = cleanupAttempt(job.payload);

  try {
    let dismantleResult: PluginGroupDismantleResult | undefined;
    if (record.subgroupChatId) {
      if (!context.dismantleManagedGroup) {
        throw new Error('Plugin runtime does not expose dismantleManagedGroup.');
      }
      dismantleResult = await context.dismantleManagedGroup({
        scopeId: record.scopeId,
        chatId: record.subgroupChatId,
        reason: 'event cleanup'
      });
      if (!dismantleCompleted(dismantleResult)) {
        return cleanupFailed(context, db, record, config, attempt, dismantleIncompleteReason(dismantleResult), {
          dismantleResult,
          retryable: true
        });
      }
    }
    const cleanedAt = new Date().toISOString();
    markEventCleaned(db, record.id, cleanedAt);
    await setCleanupFailureStatus(context, record.scopeId, null);
    appendEventLog(db, {
      eventId: record.id,
      action: 'events.cleaned',
      metadata: { dismantleResult }
    });
    await appendJsonLog(context, {
      action: 'event.cleaned',
      scopeId: record.scopeId,
      eventId: record.id,
      profileId: record.profileId,
      ...(record.pollWaMsgId ? { pollWaMsgId: record.pollWaMsgId } : {}),
      ...(record.subgroupChatId ? { subgroupChatId: record.subgroupChatId } : {}),
      metadata: { dismantleResult }
    });
    return [audit('events.cleaned', { eventId: record.id, dismantleResult })];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return cleanupFailed(context, db, record, config, attempt, reason, { retryable: true });
  }
}

async function cleanupFailed(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  record: StoredEventRecord,
  config: ReturnType<typeof parseEventsConfig>,
  attempt: number,
  reason: string,
  metadata: Record<string, unknown> = {}
): Promise<PluginAction[]> {
  const failedAt = new Date().toISOString();
  markEventCleanupFailed(db, record.id, reason, failedAt);
  const retryAction = cleanupRetryAction(record, config, attempt);
  await setCleanupFailureStatus(context, record.scopeId, {
    message: record.subgroupChatId
      ? `Event subgroup ${record.subgroupChatId} transcript cleanup or deletion failed: ${reason}`
      : `Event cleanup failed: ${reason}`,
    at: failedAt
  });
  appendEventLog(db, {
    eventId: record.id,
    action: 'events.cleanup.failed',
    metadata: {
      reason,
      attempt,
      nextRetryAt: retryAction?.runAt.toISOString(),
      ...metadata
    }
  });
  await appendJsonLog(context, {
    action: 'event.cleanup_failed',
    scopeId: record.scopeId,
    eventId: record.id,
    profileId: record.profileId,
    ...(record.pollWaMsgId ? { pollWaMsgId: record.pollWaMsgId } : {}),
    ...(record.subgroupChatId ? { subgroupChatId: record.subgroupChatId } : {}),
    metadata: {
      reason,
      attempt,
      nextRetryAt: retryAction?.runAt.toISOString(),
      ...metadata
    }
  });
  return [
    ...(retryAction ? [retryAction] : []),
    audit('events.cleanup.failed', {
      eventId: record.id,
      reason,
      attempt,
      nextRetryAt: retryAction?.runAt.toISOString()
    })
  ];
}

function cleanupRetryAction(
  record: StoredEventRecord,
  config: ReturnType<typeof parseEventsConfig>,
  attempt: number
): PluginEnqueueJobAction | undefined {
  const delayMinutes = config.cleanup.retryDelaysMinutes[attempt];
  if (!delayMinutes) {
    return undefined;
  }
  const nextAttempt = attempt + 1;
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.cleanup,
    scopeId: record.scopeId,
    ...(record.groupId ? { groupId: record.groupId } : {}),
    ...(record.groupWid ? { groupWid: record.groupWid } : {}),
    runAt: new Date(Date.now() + delayMinutes * 60_000),
    payload: { eventId: record.id, attempt: nextAttempt },
    dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:retry:${nextAttempt}`
  };
}

async function setCleanupFailureStatus(
  context: PluginRuntimeContext,
  scopeId: string,
  failure: { message: string; at: string } | null
): Promise<void> {
  if (!context.setConfig) {
    return;
  }
  try {
    const config = parseEventsConfig(await context.configFor(scopeId));
    await context.setConfig(scopeId, {
      cleanup: {
        ...config.cleanup,
        lastFailureMessage: failure?.message ?? '',
        lastFailureAt: failure?.at ?? ''
      }
    });
  } catch (error) {
    context.logger.warn({ error, scopeId }, 'Unable to persist official.community-events cleanup failure status');
  }
}

function effectiveCloseAt(record: StoredEventRecord, config: ReturnType<typeof parseEventsConfig>): Date {
  const startsAt = new Date(record.startsAtUtc || record.startsAt);
  const profile = config.eventProfiles.find((candidate) => candidate.id === record.profileId);
  if (!profile || !Number.isFinite(startsAt.getTime())) {
    return validDateOrNow(record.closeAt);
  }
  return new Date(startsAt.getTime() - profile.poll.closeOffsetHoursBeforeStart * 3_600_000);
}

function persistEffectiveCloseAt(
  db: ReturnType<typeof eventsDatabase>,
  record: StoredEventRecord,
  closeAt: Date
): void {
  if (!Number.isFinite(closeAt.getTime())) {
    return;
  }
  const closeAtIso = closeAt.toISOString();
  if (record.closeAt === closeAtIso) {
    return;
  }
  const updatedAt = new Date().toISOString();
  updateEventCloseAt(db, {
    eventId: record.id,
    closeAt: closeAtIso,
    updatedAt
  });
  appendEventLog(db, {
    eventId: record.id,
    action: 'events.close.rescheduled',
    metadata: {
      previousCloseAt: record.closeAt,
      effectiveCloseAt: closeAtIso
    }
  });
}

async function markStartupEventMissed(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  record: StoredEventRecord,
  config: ReturnType<typeof parseEventsConfig>,
  closeAt: Date,
  now: Date
): Promise<void> {
  const missedAt = now.toISOString();
  const scheduledLocalDate = eventScheduledLocalDate(record) ?? 'unknown';
  const closeAtIso = Number.isFinite(closeAt.getTime()) ? closeAt.toISOString() : record.closeAt;
  const reason = `Startup recovery found the poll close due at ${closeAtIso} after the scheduled event date ${scheduledLocalDate}.`;
  markEventMissed(db, record.id, reason, missedAt);
  appendEventLog(db, {
    eventId: record.id,
    action: 'events.close.missed',
    metadata: {
      reason,
      effectiveCloseAt: closeAtIso,
      scheduledLocalDate
    }
  });
  await appendJsonLog(context, {
    action: 'event.close_missed',
    scopeId: record.scopeId,
    eventId: record.id,
    profileId: record.profileId,
    ...(record.pollWaMsgId ? { pollWaMsgId: record.pollWaMsgId } : {}),
    metadata: {
      reason,
      effectiveCloseAt: closeAtIso,
      scheduledLocalDate
    }
  });
  await refreshCalendarAfterStartupMiss(context, db, config, record);
}

async function refreshCalendarAfterStartupMiss(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  config: ReturnType<typeof parseEventsConfig>,
  record: StoredEventRecord
): Promise<void> {
  const profile = config.eventProfiles.find((candidate) => candidate.id === record.profileId);
  try {
    await writePublishAndRecordScopeCalendar({
      appConfig: context.config,
      db,
      config,
      scopeId: record.scopeId,
      calendarId: profile?.calendar.calendarId ?? '',
      events: listCalendarEvents(db, record.scopeId)
    });
  } catch (error) {
    context.logger.warn({ error, eventId: record.id, scopeId: record.scopeId }, 'Unable to refresh event calendar after marking startup event missed');
  }
}

function eventScheduledDateHasPassed(record: StoredEventRecord, now: Date): boolean {
  const scheduledLocalDate = eventScheduledLocalDate(record);
  const currentLocalDate = localDateKey(now, record.timezone);
  return Boolean(scheduledLocalDate && currentLocalDate && currentLocalDate > scheduledLocalDate);
}

function eventScheduledLocalDate(record: StoredEventRecord): string | undefined {
  const stored = record.localDate?.trim();
  if (stored && /^\d{4}-\d{2}-\d{2}$/.test(stored)) {
    return stored;
  }
  const startsAt = new Date(record.startsAtUtc || record.startsAt);
  return localDateKey(startsAt, record.timezone);
}

function localDateKey(date: Date, timezone: string): string | undefined {
  if (!Number.isFinite(date.getTime())) {
    return undefined;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    const year = value('year');
    const month = value('month');
    const day = value('day');
    return year && month && day ? `${year}-${month}-${day}` : undefined;
  } catch {
    return undefined;
  }
}

function validDateOrNow(value: string): Date {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function jobPayloadEventId(payload: unknown): string | undefined {
  return payload && typeof payload === 'object' && typeof (payload as { eventId?: unknown }).eventId === 'string'
    ? (payload as { eventId: string }).eventId
    : undefined;
}

function cleanupAttempt(payload: unknown): number {
  const value = payload && typeof payload === 'object'
    ? (payload as { attempt?: unknown }).attempt
    : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function partialCleanupReason(result: PluginGroupDismantleResult): string {
  return `failed to remove ${result.failedRemovals.length} subgroup participant${result.failedRemovals.length === 1 ? '' : 's'}: ${
    result.failedRemovals.map((failure) => `${failure.wid} (${failure.reason})`).join(', ')
  }`;
}

function dismantleIncompleteReason(result: PluginGroupDismantleResult): string {
  const reasons = [
    ...(result.failedRemovals.length > 0 ? [partialCleanupReason(result)] : []),
    ...(result.leaveFailed ? [`failed to leave subgroup: ${result.leaveFailed}`] : []),
    ...(result.chatDeleteFailed ? [`failed to delete subgroup chat: ${result.chatDeleteFailed}`] : []),
    ...(result.managementMarkLeftFailed ? [`failed to mark subgroup left: ${result.managementMarkLeftFailed}`] : [])
  ];
  return reasons.length > 0
    ? reasons.join('; ')
    : 'subgroup was not left, deleted, or marked left after dismantle';
}

function dismantleCompleted(result: {
  alreadyAbsent?: boolean | undefined;
  left: boolean;
  chatDeleted: boolean;
  managementMarkedLeft?: boolean | undefined;
}): boolean {
  return result.alreadyAbsent === true || result.left || result.chatDeleted || result.managementMarkedLeft === true;
}

function storedParticipantOutcomes(
  db: ReturnType<typeof eventsDatabase>,
  eventId: string
): Record<string, CreatedGroupParticipantResult> {
  return Object.fromEntries(listCreatedGroupParticipants(db, eventId).map((participant) => [
    participant.wid,
    {
      ...(participant.statusCode !== undefined ? { statusCode: participant.statusCode } : {}),
      ...(participant.message ? { message: participant.message } : {}),
      isGroupCreator: participant.isGroupCreator,
      isInviteV4Sent: participant.isInviteV4Sent
    }
  ]));
}

async function appendJsonLog(
  context: PluginRuntimeContext,
  entry: Parameters<typeof appendScopeEventJsonLog>[0]['entry']
): Promise<void> {
  try {
    await appendScopeEventJsonLog({ appConfig: context.config, entry });
  } catch (error) {
    context.logger.warn({ error, action: entry.action, scopeId: entry.scopeId }, 'Unable to append official.community-events JSONL log');
  }
}

function audit(action: string, metadataJson: unknown): PluginAction {
  return {
    type: 'audit.record',
    action,
    metadataJson
  };
}
