import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import type {
  PluginGroupDecommissionedEvent,
  PluginJobEvent,
  PluginPollVotePluginEvent,
  PluginRuntimeHooks
} from '../../../platform/pluginRuntime/types';
import type { PollVoteUpdate } from '../../../platform/transport/transportTypes';
import type { PluginGroupDecommissionResult, PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import { parseEventsConfig } from './config';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import { createEventCommunitySubgroup } from './subgroups';
import {
  appendEventLog,
  eventsDatabase,
  getEvent,
  getActiveEventBySubgroup,
  getEventByPoll,
  listPendingCleanupEvents,
  listCalendarEvents,
  listVotes,
  markEventCleanupFailed,
  markEventCleaned,
  markEventClosed,
  markEventFailed,
  saveCreatedGroupParticipants,
  upsertVote,
  type StoredEventRecord,
  type StoredEventVote
} from './store';

type PluginEnqueueJobAction = Extract<PluginAction, { type: 'plugin.enqueueJob' }>;

export function createEventsHooks(context: PluginRuntimeContext): PluginRuntimeHooks {
  void recoverEventCleanupJobs(context).catch((error) => {
    context.logger.error({ error }, 'official.community-events cleanup recovery failed');
  });
  return {
    async onPollVote(event) {
      await handlePollVote(context, event);
    },
    async onPluginJob(event) {
      return handleEventJob(context, event);
    },
    async onGroupDecommissioned(event) {
      await handleGroupDecommissioned(context, event);
    }
  };
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
  if (enqueued > 0) {
    context.logger.info({ enqueued }, 'Recovered official.community-events cleanup jobs');
  }
  return enqueued;
}

async function handlePollVote(context: PluginRuntimeContext, event: PluginPollVotePluginEvent): Promise<void> {
  const db = eventsDatabase(context.databases);
  const record = getEventByPoll(db, event.vote.pollWaMsgId);
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
  return [];
}

async function handleGroupDecommissioned(
  context: PluginRuntimeContext,
  event: PluginGroupDecommissionedEvent
): Promise<void> {
  if (event.source?.kind === 'plugin_action' && event.source.pluginId === EVENTS_PLUGIN_ID) {
    return;
  }
  if (!decommissionCompleted(event.result)) {
    return;
  }
  const db = eventsDatabase(context.databases);
  const record = getActiveEventBySubgroup(db, event.chatId);
  if (!record || record.eventStatus !== 'scheduled' ||
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
      decommissionResult: event.result
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
      decommissionResult: event.result
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
  if (!record || record.eventStatus !== 'scheduled' || record.groupLifecycleStatus !== 'poll_open') {
    return [audit('events.job.skipped', { jobName: job.jobName, eventId, reason: 'event missing or poll not open' })];
  }
  if (!record.pollWaMsgId) {
    return [audit('events.job.skipped', { jobName: job.jobName, eventId, reason: 'event has no poll' })];
  }

  try {
    const liveVotes = context.pollVotesFor ? await context.pollVotesFor(record.pollWaMsgId) : [];
    for (const vote of liveVotes) {
      upsertVote(db, record.id, vote);
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
    const votes = liveVotes.length > 0 ? liveVotes : votesFromStore(listVotes(db, record.id), record);
    const attendeeWids = voterWidsForResponseBehavior(record, votes, 'includeInEventGroup');
    let subgroupChatId: string | undefined;
    let subgroupTitle: string | undefined;

    if (attendeeWids.length > 0) {
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

    const closedAt = new Date().toISOString();
    markEventClosed(db, {
      eventId: record.id,
      ...(subgroupChatId ? { subgroupChatId } : {}),
      ...(subgroupTitle ? { subgroupTitle } : {}),
      closedAt
    });
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
    const config = parseEventsConfig(await context.configFor(record.scopeId));
    const calendarProfile = config.eventProfiles.find((profile) => profile.id === record.profileId);
    const calendar = calendarProfile
      ? config.calendars.find((candidate) => candidate.id === calendarProfile.calendar.calendarId)
      : undefined;
    const calendarEvents = listCalendarEvents(db, record.scopeId);
    const publication = await writePublishAndRecordScopeCalendar({
      appConfig: context.config,
      db,
      config,
      scopeId: record.scopeId,
      calendarId: calendarProfile?.calendar.calendarId ?? '',
      events: calendarEvents
    });
    await appendJsonLog(context, {
      action: 'calendar.exported',
      scopeId: record.scopeId,
      eventId: record.id,
      profileId: record.profileId,
      pollWaMsgId: record.pollWaMsgId,
      metadata: {
        calendarEnabled: calendar?.enabled === true,
        calendarId: calendar?.id ?? '',
        ...(publication ? { publication } : {})
      }
    });
    return [
      {
        type: 'plugin.enqueueJob',
        pluginId: EVENTS_PLUGIN_ID,
        jobName: EVENTS_JOBS.cleanup,
        scopeId: record.scopeId,
        runAt: new Date(record.cleanupAt),
        payload: { eventId: record.id, attempt: 0 }
      },
      audit('events.closed', { eventId: record.id, attendeeCount: attendeeWids.length, subgroupChatId })
    ];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    markEventFailed(db, record.id, reason, new Date().toISOString());
    appendEventLog(db, { eventId: record.id, action: 'events.close.failed', metadata: { reason } });
    await appendJsonLog(context, {
      action: 'event.close_failed',
      scopeId: record.scopeId,
      eventId: record.id,
      profileId: record.profileId,
      pollWaMsgId: record.pollWaMsgId,
      metadata: { reason }
    });
    return [audit('events.close.failed', { eventId: record.id, reason })];
  }
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
  if (record.eventStatus !== 'scheduled' || (record.groupLifecycleStatus !== 'poll_closed' && record.groupLifecycleStatus !== 'cleanup_failed')) {
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
    let decommissionResult: PluginGroupDecommissionResult | undefined;
    if (record.subgroupChatId) {
      if (!context.decommissionManagedGroup) {
        throw new Error('Plugin runtime does not expose decommissionManagedGroup.');
      }
      decommissionResult = await context.decommissionManagedGroup({
        scopeId: record.scopeId,
        chatId: record.subgroupChatId,
        reason: 'event cleanup'
      });
      if (!decommissionCompleted(decommissionResult)) {
        return cleanupFailed(context, db, record, config, attempt, decommissionIncompleteReason(decommissionResult), {
          decommissionResult,
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
      metadata: { decommissionResult }
    });
    await appendJsonLog(context, {
      action: 'event.cleaned',
      scopeId: record.scopeId,
      eventId: record.id,
      profileId: record.profileId,
      ...(record.pollWaMsgId ? { pollWaMsgId: record.pollWaMsgId } : {}),
      ...(record.subgroupChatId ? { subgroupChatId: record.subgroupChatId } : {}),
      metadata: { decommissionResult }
    });
    return [audit('events.cleaned', { eventId: record.id, decommissionResult })];
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

function voterWidsForResponseBehavior(
  record: StoredEventRecord,
  votes: PollVoteUpdate[],
  behavior: 'includeInEventGroup' | 'includeInAttendanceCount'
): string[] {
  const responseClassesById = new Map(record.responseClasses.map((responseClass) => [
    responseClass.id,
    responseClass
  ]));
  const optionsById = new Map(record.pollOptions.map((option) => [option.id, option]));
  const voters = new Set<string>();
  for (const vote of votes) {
    const selected = selectedEventOptionIds(record, vote);
    if (selected.some((optionId) => {
      const option = optionsById.get(optionId);
      const responseClass = option ? responseClassesById.get(option.responseClassId) : undefined;
      return responseClass?.[behavior] === true;
    })) {
      voters.add(vote.voterWid);
    }
  }
  return [...voters].sort();
}

function selectedEventOptionIds(record: StoredEventRecord, vote: PollVoteUpdate): string[] {
  const selected = new Set<string>();
  for (const name of vote.selectedOptionNames) {
    const option = record.pollOptions.find((candidate) => candidate.label === name);
    if (option) {
      selected.add(option.id);
    }
  }
  for (const number of vote.selectedOptionNumbers) {
    const option = record.pollOptions[number - 1];
    if (option) {
      selected.add(option.id);
    }
  }
  for (const id of vote.selectedOptionIds) {
    const direct = record.pollOptions.find((candidate) => candidate.id === id);
    if (direct) {
      selected.add(direct.id);
      continue;
    }
    const localId = Number(id);
    if (Number.isSafeInteger(localId) && localId >= 0) {
      const option = record.pollOptions[localId];
      if (option) {
        selected.add(option.id);
      }
    }
  }
  return [...selected];
}

function votesFromStore(votes: StoredEventVote[], record: StoredEventRecord): PollVoteUpdate[] {
  return votes.map((vote) => ({
    pollWaMsgId: record.pollWaMsgId ?? '',
    pollChatId: record.announcementGroupWid,
    voterWid: vote.voterWid,
    selectedOptions: [],
    selectedOptionIds: vote.selectedOptionIds,
    selectedOptionNames: vote.selectedOptionNames,
    selectedOptionNumbers: vote.selectedOptionNumbers,
    ...(vote.interactedAt ? { interactedAt: new Date(vote.interactedAt) } : {})
  }));
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

function partialCleanupReason(result: PluginGroupDecommissionResult): string {
  return `failed to remove ${result.failedRemovals.length} subgroup participant${result.failedRemovals.length === 1 ? '' : 's'}: ${
    result.failedRemovals.map((failure) => `${failure.wid} (${failure.reason})`).join(', ')
  }`;
}

function decommissionIncompleteReason(result: PluginGroupDecommissionResult): string {
  const reasons = [
    ...(result.failedRemovals.length > 0 ? [partialCleanupReason(result)] : []),
    ...(result.leaveFailed ? [`failed to leave subgroup: ${result.leaveFailed}`] : []),
    ...(result.chatDeleteFailed ? [`failed to delete subgroup chat: ${result.chatDeleteFailed}`] : []),
    ...(result.managementMarkLeftFailed ? [`failed to mark subgroup left: ${result.managementMarkLeftFailed}`] : [])
  ];
  return reasons.length > 0
    ? reasons.join('; ')
    : 'subgroup was not left, deleted, or marked left after decommission';
}

function decommissionCompleted(result: { left: boolean; chatDeleted: boolean; managementMarkedLeft?: boolean | undefined }): boolean {
  return result.left || result.chatDeleted || result.managementMarkedLeft === true;
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
