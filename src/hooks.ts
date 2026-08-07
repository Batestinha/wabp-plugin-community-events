import { randomUUID } from 'node:crypto';
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
import type { OfficialPluginCommandRuntime } from '../shared';
import type { PluginGroupDismantleResult, PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { resolvePluginPollVotes } from '../../../platform/pluginRuntime/runtime/pluginPollVoteIdentity';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import { parseEventsConfig, type EventProfile } from './config';
import { eventGroupHintEnabled, eventGroupJoinUrl, renderEventGroupAnnouncement } from './announcements';
import {
  eventSubgroupAttendeeCoverage,
  voterWidsForResponseBehavior
} from './attendance';
import {
  eventCalendarPublicationConfigFingerprint,
  writePublishAndRecordScopeCalendar
} from './calendarStatus';
import { repairEventEdit } from './editRepair';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import { createEventCommunitySubgroup } from './subgroups';
import {
  eventWeatherForecastJobAction,
  eventWeatherForecastJobRequests,
  eventWeatherForecastRecoveryJobRequest,
  handleEventWeatherForecastJob
} from './weather';
import {
  appendEventLog,
  EVENT_CLEANUP_CLAIM_LEASE_MS,
  ensureEventCalendarPublicationConfiguration,
  eventsDatabase,
  getEvent,
  getUnplannedEventFinalization,
  getEventByEquivalentPoll,
  getLiveEventBySubgroup,
  getEventCleanupClaim,
  getEventWeatherDelivery,
  listCreatedGroupParticipants,
  listDirtyEventCalendarPublications,
  listEventCalendarPublicationGenerations,
  listOpenPollEvents,
  listFailedProvisioningEvents,
  listPendingUnplannedEventFinalizations,
  listPendingCleanupEvents,
  listPendingEventEditRepairs,
  listRecoverableEventWeatherDeliveries,
  listUnassignedEventCalendarOwnership,
  listWeatherForecastCandidateEvents,
  advanceEventProvisioningRecovery,
  claimEventCleanup,
  completeUnplannedEventFinalization,
  initializeEventProvisioningRecovery,
  markEventCleanupFailed,
  markClaimedEventCleaned,
  markEventCleaned,
  markEventClosed,
  markEventFailed,
  markEventProvisioningFailed,
  markEventMissed,
  replaceVotes,
  releaseEventCleanupClaim,
  releaseExpiredEventCleanupClaims,
  resolvedEventCalendarId,
  renewEventCleanupClaim,
  saveCreatedGroupParticipants,
  supersedeEventWeatherDelivery,
  updateEventCloseAt,
  upsertVote,
  type EventCleanupClaim,
  type StoredEventRecord
} from './store';
import {
  attemptUnplannedEventFinalization,
  eventProvisioningRecoveryCursor,
  eventProvisioningRecoveryDedupeKey,
  eventProvisioningRecoveryRunAt,
  eventProvisioningResumeDedupeKey,
  resumeEventProvisioning,
  scheduleUnplannedEventFinalizationRetry,
  unplannedEventFinalizationDedupeKey,
  type EventProvisioningRecoveryCursor,
  type EventProvisioningRecoveryPayload,
  type UnplannedEventFinalizationPayload
} from './provisioningRecovery';
import { recoverEventQuestionKeyRenames } from './questionKeyRenameRecovery';
import {
  handleEventSuggestionReconcileJob,
  recoverEventSuggestionConversionJobs
} from './suggestionConversion';
import { registerEventFlowCompletionHandlers } from './commands';
import { registerEventCreationFlowDefinitionResolver } from './eventCreationFlowStarter';

type PluginEnqueueJobAction = Extract<PluginAction, { type: 'plugin.enqueueJob' }>;

const EVENT_EDIT_REPAIR_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
export const EVENT_CALENDAR_PUBLICATION_RECOVERY_SWEEP_MS = 30_000;

interface EventRecoveryOptions {
  now?: Date | undefined;
}

interface EventsHooksOptions {
  recoverJobs?: boolean | undefined;
  recoverCalendarPublications?: boolean | undefined;
}

export function createEventsHooks(context: PluginRuntimeContext, options: EventsHooksOptions = {}): PluginRuntimeHooks {
  if (context.flowEngine) {
    registerEventCreationFlowDefinitionResolver({
      flowEngine: context.flowEngine,
      dataStore: context.dataStore,
      i18n: context.i18n
    }, (flowType, profiles, t) => {
      registerEventFlowCompletionHandlers(context, flowType, profiles, t);
    });
  }
  if (options.recoverJobs !== false) {
    void recoverEventJobs(context).catch((error) => {
      context.logger.error({ error }, 'official.community-events job recovery failed');
    });
  }
  if (options.recoverCalendarPublications === true) {
    startEventCalendarPublicationRecovery(context);
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

function startEventCalendarPublicationRecovery(context: PluginRuntimeContext): void {
  let running = false;
  const sweep = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      await recoverDirtyEventCalendarPublications(context);
    } catch (error) {
      context.logger.error({ error }, 'official.community-events calendar publication recovery failed');
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(() => {
    void sweep();
  }, EVENT_CALENDAR_PUBLICATION_RECOVERY_SWEEP_MS);
  timer.unref();
}

export async function recoverEventJobs(
  context: PluginRuntimeContext,
  options: EventRecoveryOptions = {}
): Promise<number> {
  const unresolvedCalendarOwnership = listUnassignedEventCalendarOwnership(
    eventsDatabase(context.databases)
  );
  if (unresolvedCalendarOwnership.length > 0) {
    context.logger.warn(
      { unresolvedCalendarOwnership },
      'Community events require explicit authoritative calendar ownership assignment'
    );
  }
  const calendarPublications = await recoverDirtyEventCalendarPublications(context, options);
  const questionKeyRenames = await recoverEventQuestionKeyRenames(context, options);
  const editRepairJobs = await recoverEventEditRepairJobs(context);
  const closeJobs = await recoverEventCloseJobs(context, options);
  const cleanupJobs = await recoverEventCleanupJobs(context);
  const weatherForecastJobs = await recoverEventWeatherForecastJobs(context);
  const provisioningJobs = await recoverEventProvisioningJobs(context, options);
  const unplannedFinalizationJobs = await recoverUnplannedEventFinalizationJobs(context);
  const suggestionReconcileJobs = await recoverEventSuggestionConversionJobs(context, options.now);
  const enqueued = questionKeyRenames.scheduled + editRepairJobs + closeJobs + cleanupJobs + weatherForecastJobs + provisioningJobs + unplannedFinalizationJobs + suggestionReconcileJobs;
  if (
    enqueued > 0 ||
    calendarPublications > 0 ||
    questionKeyRenames.settled > 0 ||
    questionKeyRenames.unresolved > 0
  ) {
    context.logger.info(
      { enqueued, calendarPublications, questionKeyRenames, editRepairJobs, closeJobs, cleanupJobs, weatherForecastJobs, provisioningJobs, unplannedFinalizationJobs, suggestionReconcileJobs },
      'Recovered official.community-events jobs'
    );
  }
  return enqueued;
}

export async function recoverDirtyEventCalendarPublications(
  context: PluginRuntimeContext,
  options: EventRecoveryOptions = {}
): Promise<number> {
  const db = eventsDatabase(context.databases);
  const now = options.now ?? new Date();
  const unresolvedScopeIds = new Set(
    listUnassignedEventCalendarOwnership(db).map((event) => event.scopeId)
  );
  const configByScope = new Map<string, ReturnType<typeof parseEventsConfig> | null>();
  const configForEnabledScope = async (
    scopeId: string
  ): Promise<ReturnType<typeof parseEventsConfig> | null> => {
    if (configByScope.has(scopeId)) {
      return configByScope.get(scopeId) ?? null;
    }
    const config = await context.enabledFor(scopeId)
      ? parseEventsConfig(await context.configFor(scopeId))
      : null;
    configByScope.set(scopeId, config);
    return config;
  };
  for (const state of listEventCalendarPublicationGenerations(db)) {
    if (unresolvedScopeIds.has(state.scopeId)) {
      continue;
    }
    try {
      const config = await configForEnabledScope(state.scopeId);
      const calendar = config?.calendars.find((candidate) => candidate.id === state.calendarId);
      if (!config || !calendar?.enabled) {
        continue;
      }
      ensureEventCalendarPublicationConfiguration(db, {
        scopeId: state.scopeId,
        calendarId: state.calendarId,
        fingerprint: eventCalendarPublicationConfigFingerprint(config, state.calendarId),
        updatedAt: now.toISOString()
      });
    } catch (error) {
      context.logger.warn(
        { error, scopeId: state.scopeId, calendarId: state.calendarId },
        'Unable to reconcile event calendar publication configuration'
      );
    }
  }
  let recovered = 0;
  for (const dirty of listDirtyEventCalendarPublications(db, { readyAt: now.toISOString() })) {
    if (unresolvedScopeIds.has(dirty.scopeId)) {
      continue;
    }
    try {
      const config = await configForEnabledScope(dirty.scopeId);
      if (!config) {
        continue;
      }
      const calendar = config.calendars.find((candidate) => candidate.id === dirty.calendarId);
      if (!calendar?.enabled) {
        continue;
      }
      const publication = await writePublishAndRecordScopeCalendar({
        appConfig: context.config,
        db,
        config,
        scopeId: dirty.scopeId,
        calendarId: dirty.calendarId,
        requestGeneration: false
      });
      if (publication && !publication.ok) {
        context.logger.warn(
          { scopeId: dirty.scopeId, calendarId: dirty.calendarId, error: publication.error },
          'Unable to recover dirty event calendar publication'
        );
        continue;
      }
      recovered += 1;
    } catch (error) {
      context.logger.warn(
        { error, scopeId: dirty.scopeId, calendarId: dirty.calendarId },
        'Unable to recover dirty event calendar publication'
      );
    }
  }
  return recovered;
}

export async function recoverUnplannedEventFinalizationJobs(
  context: PluginRuntimeContext
): Promise<number> {
  const db = eventsDatabase(context.databases);
  let enqueued = 0;
  for (const finalization of listPendingUnplannedEventFinalizations(db)) {
    const event = getEvent(db, finalization.eventId);
    if (!event || event.scopeId !== finalization.scopeId || !finalization.nextRunAt) {
      continue;
    }
    const runAt = new Date(finalization.nextRunAt);
    if (!Number.isFinite(runAt.getTime())) {
      continue;
    }
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.unplannedFinalization,
      scopeId: finalization.scopeId,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.groupWid ? { groupWid: event.groupWid } : {}),
      runAt,
      payload: {
        eventId: finalization.eventId,
        generation: finalization.generation,
        attempt: finalization.attempt
      } satisfies UnplannedEventFinalizationPayload,
      dedupeKey: unplannedEventFinalizationDedupeKey(finalization)
    });
    enqueued += 1;
  }
  return enqueued;
}

export async function recoverEventProvisioningJobs(
  context: PluginRuntimeContext,
  options: EventRecoveryOptions = {}
): Promise<number> {
  const db = eventsDatabase(context.databases);
  const records = listFailedProvisioningEvents(db);
  const now = options.now ?? new Date();
  let enqueued = 0;
  for (const candidate of records) {
    let record = candidate;
    const subgroupChatId = record.subgroupChatId;
    if (!subgroupChatId) {
      continue;
    }
    if (!eventProvisioningRecoveryCursor(record)) {
      const initialized = initializeEventProvisioningRecovery(db, {
        eventId: record.id,
        scopeId: record.scopeId,
        subgroupChatId,
        generation: randomUUID(),
        attempt: 1,
        nextRunAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
      record = getEvent(db, record.id) ?? record;
      if (!initialized && !eventProvisioningRecoveryCursor(record)) {
        continue;
      }
    }
    const cursor = eventProvisioningRecoveryCursor(record);
    if (!cursor?.nextRunAt) {
      continue;
    }
    const runAt = new Date(cursor.nextRunAt);
    if (!Number.isFinite(runAt.getTime())) {
      continue;
    }
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.provisioningRecovery,
      scopeId: record.scopeId,
      ...(record.groupId ? { groupId: record.groupId } : {}),
      ...(record.groupWid ? { groupWid: record.groupWid } : {}),
      runAt,
      payload: {
        eventId: record.id,
        subgroupChatId,
        generation: cursor.generation,
        attempt: cursor.attempt
      } satisfies EventProvisioningRecoveryPayload,
      dedupeKey: eventProvisioningRecoveryDedupeKey(record, cursor)
    });
    enqueued += 1;
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
  const now = new Date();
  const releasedClaims = releaseExpiredEventCleanupClaims(db, now.toISOString());
  if (releasedClaims > 0) {
    context.logger.warn({ releasedClaims }, 'Recovered expired community-event cleanup claims');
  }
  const records = listPendingCleanupEvents(db);
  let enqueued = 0;
  for (const record of records) {
    const cleanupAt = new Date(record.cleanupAt);
    const activeClaim = getEventCleanupClaim(db, record.id);
    const claimExpiresAt = activeClaim ? new Date(activeClaim.leaseExpiresAt) : undefined;
    const runAt = latestFiniteDate(cleanupAt, claimExpiresAt, now);
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.cleanup,
      scopeId: record.scopeId,
      ...(record.groupId ? { groupId: record.groupId } : {}),
      ...(record.groupWid ? { groupWid: record.groupWid } : {}),
      ...(runAt ? { runAt } : {}),
      payload: { eventId: record.id, attempt: 0 },
      dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:startup:${record.cleanupAt}:${record.updatedAt}`
    });
    enqueued += 1;
  }
  return enqueued;
}

export async function recoverEventEditRepairJobs(context: PluginRuntimeContext): Promise<number> {
  const db = eventsDatabase(context.databases);
  const repairs = listPendingEventEditRepairs(db);
  let enqueued = 0;
  for (const repair of repairs) {
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.editRepair,
      scopeId: repair.scopeId,
      payload: { operationId: repair.operationId, attempt: 0 },
      dedupeKey: `${EVENTS_JOBS.editRepair}:${repair.operationId}:startup:${repair.updatedAt}`
    });
    enqueued += 1;
  }
  return enqueued;
}

export async function recoverEventWeatherForecastJobs(context: PluginRuntimeContext): Promise<number> {
  const db = eventsDatabase(context.databases);
  const records = listWeatherForecastCandidateEvents(db);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const scheduled = new Set<string>();
  let enqueued = 0;
  const now = new Date();
  for (const delivery of listRecoverableEventWeatherDeliveries(db)) {
    const record = recordsById.get(delivery.eventId) ?? getEvent(db, delivery.eventId);
    if (!record) {
      continue;
    }
    if (record.updatedAt !== delivery.eventUpdatedAt) {
      supersedeEventWeatherDelivery(db, {
        eventId: delivery.eventId,
        eventUpdatedAt: delivery.eventUpdatedAt,
        kind: delivery.kind,
        reason: 'event_version_changed'
      });
      continue;
    }
    const request = eventWeatherForecastRecoveryJobRequest({ event: record, delivery, now });
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: request.jobName,
      scopeId: request.scopeId,
      ...(request.groupId ? { groupId: request.groupId } : {}),
      ...(request.groupWid ? { groupWid: request.groupWid } : {}),
      ...(request.runAt ? { runAt: request.runAt } : {}),
      payload: request.payload,
      dedupeKey: `${request.dedupeKey}:startup-recovery:${delivery.updatedAt}`
    });
    scheduled.add(`${delivery.eventId}\u0000${delivery.kind}\u0000${delivery.eventUpdatedAt}`);
    enqueued += 1;
  }
  for (const record of records) {
    const config = parseEventsConfig(await context.configFor(record.scopeId));
    const profile = config.eventProfiles.find((candidate) => candidate.id === record.profileId);
    for (const request of eventWeatherForecastJobRequests({ event: record, profile, now })) {
      const deliveryKind = request.payload.deliveryKind;
      if (
        scheduled.has(`${record.id}\u0000${deliveryKind}\u0000${record.updatedAt}`) ||
        getEventWeatherDelivery(db, record.id, deliveryKind, record.updatedAt)
      ) {
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
    actorIdentityId: event.vote.voterIdentityId,
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
  if (event.jobName === EVENTS_JOBS.suggestionReconcile) {
    await handleEventSuggestionReconcileJob(context, event);
    return [];
  }
  if (event.jobName === EVENTS_JOBS.questionKeyRenameRecovery) {
    const operationId = jobPayloadQuestionKeyRenameOperationId(event.payload);
    if (operationId) {
      await recoverEventQuestionKeyRenames(context, { operationId });
    }
    return [];
  }
  if (event.jobName === EVENTS_JOBS.editRepair) {
    return repairEventEditJob(context, event);
  }
  if (event.jobName === EVENTS_JOBS.close) {
    return closeEvent(context, event);
  }
  if (event.jobName === EVENTS_JOBS.provisioningRecovery) {
    return recoverFailedEventProvisioning(context, event);
  }
  if (event.jobName === EVENTS_JOBS.unplannedFinalization) {
    return finalizeUnplannedEventJob(context, event);
  }
  if (event.jobName === EVENTS_JOBS.cleanup) {
    return cleanupEvent(context, event);
  }
  if (event.jobName === EVENTS_JOBS.weatherForecast) {
    const db = eventsDatabase(context.databases);
    const eventId = jobPayloadEventId(event.payload);
    const record = eventId ? getEvent(db, eventId) : undefined;
    const config = record && record.scopeId === event.scopeId
      ? parseEventsConfig(await context.configFor(record.scopeId))
      : undefined;
    const profile = record && config
      ? config.eventProfiles.find((candidate) => candidate.id === record.profileId)
      : undefined;
    return handleEventWeatherForecastJob(context, db, event, profile);
  }
  return [];
}

async function repairEventEditJob(
  context: PluginRuntimeContext,
  event: PluginJobEvent
): Promise<PluginAction[]> {
  const operationId = jobPayloadOperationId(event.payload);
  if (!operationId) {
    return [audit('events.job.skipped', {
      jobName: event.jobName,
      reason: 'missing operationId'
    })];
  }
  const attempt = jobPayloadAttempt(event.payload);
  if (!context.sendText || !context.setGroupSubject) {
    return eventEditRepairRetryActions(event, operationId, attempt, [
      'plugin runtime does not expose durable text/group-subject delivery'
    ]);
  }
  const result = await repairEventEdit({
    appConfig: context.config,
    db: eventsDatabase(context.databases),
    operationId,
    configFor: (scopeId) => context.configFor(scopeId),
    sender: {
      sendText: context.sendText,
      setGroupSubject: context.setGroupSubject
    }
  });
  if (result.status !== 'pending') {
    return [audit('events.edit_repair.completed', {
      operationId,
      status: result.status
    })];
  }
  return eventEditRepairRetryActions(
    event,
    operationId,
    attempt,
    result.failures,
    result.retryAt
  );
}

function eventEditRepairRetryActions(
  event: PluginJobEvent,
  operationId: string,
  attempt: number,
  failures: string[],
  retryAt?: Date | undefined
): PluginAction[] {
  const nextAttempt = attempt + 1;
  const delay = EVENT_EDIT_REPAIR_DELAYS_MS[
    Math.min(attempt, EVENT_EDIT_REPAIR_DELAYS_MS.length - 1)
  ]!;
  const runAt = retryAt && Number.isFinite(retryAt.getTime()) && retryAt.getTime() > Date.now()
    ? retryAt
    : new Date(Date.now() + delay);
  return [
    audit('events.edit_repair.pending', {
      operationId,
      attempt,
      failures,
      retryAt: runAt.toISOString()
    }),
    {
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.editRepair,
      scopeId: event.scopeId,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.groupWid ? { groupWid: event.groupWid } : {}),
      runAt,
      payload: { operationId, attempt: nextAttempt },
      dedupeKey: `${EVENTS_JOBS.editRepair}:${operationId}:retry:${nextAttempt}:${runAt.toISOString()}`
    }
  ];
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
  const record = getLiveEventBySubgroup(db, event.chatId);
  if (!record || (record.eventStatus !== 'active' && record.eventStatus !== 'completed') ||
      (record.groupLifecycleStatus !== 'poll_closed' && record.groupLifecycleStatus !== 'cleanup_failed')) {
    return;
  }

  const cleanedAt = event.receivedAt.toISOString();
  if (!markEventCleaned(db, {
    eventId: record.id,
    expectedUpdatedAt: record.updatedAt,
    cleanedAt
  })) {
    return;
  }
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
    const liveVotes = await resolvePluginPollVotes(
      requireCompletePollVotes(await context.pollVoteReadbackFor(record.pollWaMsgId)),
      requirePollVoteIdentityResolver(context)
    );
    replaceVotes(db, record.id, liveVotes);
    for (const vote of liveVotes) {
      await appendJsonLog(context, {
        action: 'poll.vote.snapshot',
        scopeId: record.scopeId,
        eventId: record.id,
        actorIdentityId: vote.voterIdentityId,
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
        actorIdentityId: requireHookEventActorIdentityId(record),
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
    const closedAt = new Date().toISOString();
    markEventClosed(db, {
      eventId: record.id,
      ...(subgroupChatId ? { subgroupChatId } : {}),
      ...(subgroupTitle ? { subgroupTitle } : {}),
      closedAt
    });
    closePersisted = true;
    const closedEvent = getEvent(db, record.id);
    if (
      !closedEvent ||
      closedEvent.groupLifecycleStatus !== 'poll_closed' ||
      closedEvent.updatedAt !== closedAt ||
      closedEvent.subgroupChatId !== subgroupChatId
    ) {
      throw new Error(`Event ${record.id} changed while its poll closure was being persisted.`);
    }
    const plannedAnnouncementActions = await plannedEventAnnouncementActions(context, {
      record: closedEvent,
      profile: calendarProfile,
      subgroupChatId,
      subgroupTitle
    });
    const weatherForecastAction = eventWeatherForecastJobAction({
      event: closedEvent,
      profile: calendarProfile
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
    let calendarFailureAudit: PluginAction | undefined;
    try {
      const calendarId = resolvedEventCalendarId(closedEvent);
      const calendar = config.calendars.find((candidate) => candidate.id === calendarId);
      calendarFailureAudit = calendarId
        ? await publishClosedEventCalendar(context, {
          db,
          config,
          record: closedEvent,
          calendarId,
          calendarEnabled: calendar?.enabled === true
        })
        : undefined;
    } catch (error) {
      calendarFailureAudit = await recordCalendarPublicationFailure(
        context,
        db,
        closedEvent,
        error instanceof Error ? error.message : String(error)
      );
    }
    return [
      ...plannedAnnouncementActions,
      ...(weatherForecastAction ? [weatherForecastAction] : []),
      closeCleanupAction(closedEvent),
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
    let provisioningRecoveryAction: PluginEnqueueJobAction | undefined;
    if (isManagedCommunitySubgroupProvisioningError(error)) {
      const { created, provisioning, stage } = error;
      failedSubgroupChatId = created.chatId;
      const recoveryGeneration = randomUUID();
      const recoveryAttempt = 1;
      const recoveryRunAt = eventProvisioningRecoveryRunAt(
        recoveryAttempt,
        new Date(failedAt)
      );
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
        failedAt,
        recoveryGeneration,
        recoveryAttempt,
        recoveryNextRunAt: recoveryRunAt.toISOString()
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
      } else {
        const failedRecord = getEvent(db, record.id);
        if (failedRecord?.subgroupChatId === created.chatId) {
          const cursor = eventProvisioningRecoveryCursor(failedRecord);
          if (cursor?.nextRunAt) {
            provisioningRecoveryAction = eventProvisioningRecoveryAction(failedRecord, {
              ...cursor,
              nextRunAt: cursor.nextRunAt
            });
          }
          appendEventLog(db, {
            eventId: record.id,
            action: 'events.provisioning.recovery_scheduled',
            metadata: {
              subgroupChatId: created.chatId,
              generation: recoveryGeneration,
              attempt: recoveryAttempt,
              runAt: recoveryRunAt.toISOString(),
              stage
            }
          });
        }
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
    return [
      ...(provisioningRecoveryAction ? [provisioningRecoveryAction] : []),
      audit('events.close.failed', { eventId: record.id, ...failureMetadata })
    ];
  }
}

function requireHookEventActorIdentityId(event: StoredEventRecord): string {
  const actorIdentityId = event.actorIdentityId?.trim();
  if (!actorIdentityId) {
    throw new Error(`Event ${event.id} has no authoritative creator identity.`);
  }
  return actorIdentityId;
}

function requirePollVoteIdentityResolver(
  context: PluginRuntimeContext
): NonNullable<PluginRuntimeContext['resolveIdentityAddress']> {
  if (!context.resolveIdentityAddress) {
    throw new Error('Authoritative poll-voter identity resolution is unavailable.');
  }
  return context.resolveIdentityAddress;
}

async function finalizeUnplannedEventJob(
  context: PluginRuntimeContext,
  job: PluginJobEvent
): Promise<PluginAction[]> {
  const payload = unplannedEventFinalizationPayload(job.payload);
  if (!payload) {
    return [audit('events.unplanned.finalization_skipped', { reason: 'invalid payload' })];
  }
  const db = eventsDatabase(context.databases);
  const event = getEvent(db, payload.eventId);
  const finalization = getUnplannedEventFinalization(db, payload.eventId);
  if (
    !event ||
    event.scopeId !== job.scopeId ||
    event.origin !== 'unplanned' ||
    !finalization ||
    finalization.scopeId !== job.scopeId ||
    finalization.status !== 'pending' ||
    finalization.generation !== payload.generation ||
    finalization.attempt !== payload.attempt
  ) {
    return [audit('events.unplanned.finalization_skipped', {
      eventId: payload.eventId,
      generation: payload.generation,
      attempt: payload.attempt,
      reason: 'event missing, completed, or stale finalization cursor'
    })];
  }
  const runtime: Pick<OfficialPluginCommandRuntime, 'config' | 'databases' | 'enqueuePluginJob'> = {
    config: context.config,
    ...(context.databases ? { databases: context.databases } : {}),
    enqueuePluginJob: (request) => enqueuePluginJob(
      context.queue,
      { pluginId: EVENTS_PLUGIN_ID, ...request }
    )
  };
  try {
    const config = parseEventsConfig(await context.configFor(event.scopeId));
    const profile = config.eventProfiles.find((candidate) => candidate.id === event.profileId);
    if (!profile) {
      const resolvedAt = new Date().toISOString();
      const resolved = completeUnplannedEventFinalization(db, {
        eventId: finalization.eventId,
        scopeId: finalization.scopeId,
        generation: finalization.generation,
        attempt: finalization.attempt,
        completedAt: resolvedAt
      });
      appendEventLog(db, {
        eventId: event.id,
        action: resolved
          ? 'events.unplanned.finalization_resolved'
          : 'events.unplanned.finalization_resolution_stale',
        metadata: {
          reason: 'profile_removed',
          profileId: event.profileId,
          generation: payload.generation,
          attempt: payload.attempt
        }
      });
      return [audit(
        resolved
          ? 'events.unplanned.finalization_completed'
          : 'events.unplanned.finalization_skipped',
        {
          eventId: event.id,
          generation: payload.generation,
          attempt: payload.attempt,
          status: resolved ? 'resolved_profile_removed' : 'stale'
        }
      )];
    }
    const actorIdentityId = requireHookEventActorIdentityId(event);
    const locale = await context.i18n.resolveIdentityLocale(actorIdentityId, event.scopeId);
    const result = await attemptUnplannedEventFinalization({
      context,
      runtime,
      activeTransport: {
        async sendText(chatId, text, options) {
          if (!context.sendText) {
            throw new Error('Plugin runtime does not expose durable text delivery.');
          }
          return context.sendText(chatId, text, options);
        }
      },
      event,
      profile,
      config,
      locale: locale.locale,
      creatorDisplayName: event.actorLabel || event.actorWid,
      trigger: 'unplanned_recovery',
      expected: payload
    });
    return [audit(
      result.status === 'completed' ||
        result.status === 'superseded' ||
        result.status === 'already_completed'
        ? 'events.unplanned.finalization_completed'
        : result.status === 'retry_scheduled'
          ? 'events.unplanned.finalization_retry_scheduled'
          : 'events.unplanned.finalization_skipped',
      {
        eventId: event.id,
        generation: payload.generation,
        attempt: payload.attempt,
        status: result.status
      }
    )];
  } catch (error) {
    const result = await scheduleUnplannedEventFinalizationRetry({
      runtime,
      event,
      expected: payload,
      reason: error instanceof Error ? error.message : String(error)
    });
    return [audit('events.unplanned.finalization_retry_scheduled', {
      eventId: event.id,
      generation: payload.generation,
      attempt: payload.attempt,
      status: result.status,
      reason: error instanceof Error ? error.message : String(error)
    })];
  }
}

async function recoverFailedEventProvisioning(
  context: PluginRuntimeContext,
  job: PluginJobEvent
): Promise<PluginAction[]> {
  const payload = eventProvisioningRecoveryPayload(job.payload);
  if (!payload) {
    return [audit('events.provisioning.recovery_skipped', {
      reason: 'invalid payload'
    })];
  }
  const db = eventsDatabase(context.databases);
  const record = getEvent(db, payload.eventId);
  if (!record || record.scopeId !== job.scopeId) {
    return [audit('events.provisioning.recovery_skipped', {
      eventId: payload.eventId,
      subgroupChatId: payload.subgroupChatId,
      generation: payload.generation,
      attempt: payload.attempt,
      reason: 'event missing or scope mismatch'
    })];
  }
  const pendingFinalization = getUnplannedEventFinalization(db, record.id);
  if (
    record.origin === 'unplanned' &&
    record.eventStatus === 'active' &&
    record.groupLifecycleStatus === 'poll_closed' &&
    pendingFinalization?.status === 'pending' &&
    pendingFinalization.scopeId === record.scopeId
  ) {
    const runAt = await enqueuePendingUnplannedEventFinalization(
      context,
      record,
      pendingFinalization
    );
    return [audit('events.provisioning.recovery_finalization_forwarded', {
      eventId: record.id,
      subgroupChatId: record.subgroupChatId,
      generation: pendingFinalization.generation,
      attempt: pendingFinalization.attempt,
      runAt: runAt.toISOString()
    })];
  }
  if (record.subgroupChatId !== payload.subgroupChatId) {
    return [audit('events.provisioning.recovery_rejected', {
      eventId: record.id,
      subgroupChatId: payload.subgroupChatId,
      generation: payload.generation,
      attempt: payload.attempt,
      reason: `Event is bound to subgroup ${record.subgroupChatId ?? 'none'}.`
    })];
  }
  const cursor = eventProvisioningRecoveryCursor(record);
  if (
    !cursor?.nextRunAt ||
    cursor.generation !== payload.generation ||
    cursor.attempt !== payload.attempt
  ) {
    return [audit('events.provisioning.recovery_skipped', {
      eventId: record.id,
      subgroupChatId: payload.subgroupChatId,
      generation: payload.generation,
      attempt: payload.attempt,
      reason: 'stale provisioning recovery cursor'
    })];
  }

  try {
    const result = await resumeEventProvisioning({
      context,
      scopeId: record.scopeId,
      eventId: record.id,
      subgroupChatId: payload.subgroupChatId,
      ...(record.subgroupTitle ? { subgroupTitle: record.subgroupTitle } : {}),
      actorWid: 'plugin-recovery@system',
      actorLabel: 'Plugin provisioning recovery'
    });
    if (result.status === 'rejected' || result.status === 'not_found') {
      const retry = await enqueueAndAdvanceEventProvisioningRecoveryCursor(
        context,
        db,
        record,
        payload,
        new Date()
      );
      appendEventLog(db, {
        eventId: record.id,
        action: retry
          ? 'events.provisioning.recovery_scheduled'
          : 'events.provisioning.recovery_rejected',
        metadata: {
          subgroupChatId: payload.subgroupChatId,
          generation: payload.generation,
          failedAttempt: payload.attempt,
          ...(retry ? {
            attempt: retry.cursor.attempt,
            runAt: retry.runAt.toISOString()
          } : {}),
          reason: result.reason
        }
      });
      if (retry) {
        return [
          audit('events.provisioning.recovery_retry_scheduled', {
            eventId: record.id,
            subgroupChatId: payload.subgroupChatId,
            generation: payload.generation,
            failedAttempt: payload.attempt,
            attempt: retry.cursor.attempt,
            runAt: retry.runAt.toISOString(),
            reason: result.reason
          })
        ];
      }
    }
    return [audit(
      result.status === 'queued'
        ? 'events.provisioning.recovery_queued'
        : result.status === 'completed'
          ? 'events.provisioning.recovery_completed'
        : result.status === 'already_completed'
          ? 'events.provisioning.recovery_already_completed'
          : 'events.provisioning.recovery_rejected',
      {
        eventId: record.id,
        subgroupChatId: payload.subgroupChatId,
        generation: payload.generation,
        attempt: payload.attempt,
        status: result.status,
        ...('reason' in result ? { reason: result.reason } : {})
      }
    )];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const retry = await enqueueAndAdvanceEventProvisioningRecoveryCursor(
      context,
      db,
      record,
      payload,
      new Date()
    );
    if (retry) {
      const stage = isManagedCommunitySubgroupProvisioningError(error)
        ? error.stage
        : undefined;
      appendEventLog(db, {
        eventId: record.id,
        action: 'events.provisioning.recovery_scheduled',
        metadata: {
          subgroupChatId: payload.subgroupChatId,
          generation: payload.generation,
          failedAttempt: payload.attempt,
          attempt: retry.cursor.attempt,
          runAt: retry.runAt.toISOString(),
          reason,
          ...(stage ? { stage } : {})
        }
      });
      return [
        audit('events.provisioning.recovery_retry_scheduled', {
          eventId: record.id,
          subgroupChatId: payload.subgroupChatId,
          generation: payload.generation,
          failedAttempt: payload.attempt,
          attempt: retry.cursor.attempt,
          runAt: retry.runAt.toISOString(),
          reason,
          ...(stage ? { stage } : {})
        })
      ];
    }
    const latest = getEvent(db, record.id);
    const latestFinalization = latest
      ? getUnplannedEventFinalization(db, latest.id)
      : undefined;
    if (
      latest?.origin === 'unplanned' &&
      latest.eventStatus === 'active' &&
      latest.groupLifecycleStatus === 'poll_closed' &&
      latestFinalization?.status === 'pending' &&
      latestFinalization.scopeId === latest.scopeId
    ) {
      const runAt = await enqueuePendingUnplannedEventFinalization(
        context,
        latest,
        latestFinalization
      );
      appendEventLog(db, {
        eventId: latest.id,
        action: 'events.provisioning.recovery_finalization_forwarded',
        metadata: {
          subgroupChatId: latest.subgroupChatId,
          generation: latestFinalization.generation,
          attempt: latestFinalization.attempt,
          runAt: runAt.toISOString(),
          recoveryReason: reason
        }
      });
      return [audit('events.provisioning.recovery_finalization_forwarded', {
        eventId: latest.id,
        subgroupChatId: latest.subgroupChatId,
        generation: latestFinalization.generation,
        attempt: latestFinalization.attempt,
        runAt: runAt.toISOString(),
        recoveryReason: reason
      })];
    }
    appendEventLog(db, {
      eventId: record.id,
      action: 'events.provisioning.recovery_failed',
      metadata: {
        subgroupChatId: payload.subgroupChatId,
        generation: payload.generation,
        attempt: payload.attempt,
        reason,
        retryable: isManagedCommunitySubgroupProvisioningError(error)
      }
    });
    return [audit('events.provisioning.recovery_failed', {
      eventId: record.id,
      subgroupChatId: payload.subgroupChatId,
      generation: payload.generation,
      attempt: payload.attempt,
      reason
    })];
  }
}

async function enqueuePendingUnplannedEventFinalization(
  context: PluginRuntimeContext,
  record: StoredEventRecord,
  finalization: NonNullable<ReturnType<typeof getUnplannedEventFinalization>>
): Promise<Date> {
  const persistedRunAt = finalization.nextRunAt
    ? new Date(finalization.nextRunAt)
    : undefined;
  const runAt = persistedRunAt && Number.isFinite(persistedRunAt.getTime())
    ? persistedRunAt
    : new Date();
  await enqueuePluginJob(context.queue, {
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.unplannedFinalization,
    scopeId: record.scopeId,
    ...(record.groupId ? { groupId: record.groupId } : {}),
    ...(record.groupWid ? { groupWid: record.groupWid } : {}),
    runAt,
    payload: {
      eventId: finalization.eventId,
      generation: finalization.generation,
      attempt: finalization.attempt
    } satisfies UnplannedEventFinalizationPayload,
    dedupeKey: unplannedEventFinalizationDedupeKey(finalization)
  });
  return runAt;
}

async function enqueueAndAdvanceEventProvisioningRecoveryCursor(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  record: StoredEventRecord,
  payload: EventProvisioningRecoveryPayload,
  now: Date
): Promise<{
  record: StoredEventRecord;
  cursor: EventProvisioningRecoveryCursor & { nextRunAt: string };
  runAt: Date;
} | undefined> {
  const latest = getEvent(db, record.id) ?? record;
  if (
    latest.eventStatus !== 'failed' ||
    latest.groupLifecycleStatus !== 'none' ||
    latest.subgroupChatId !== payload.subgroupChatId
  ) {
    return undefined;
  }
  const currentCursor = eventProvisioningRecoveryCursor(latest);
  if (
    !currentCursor?.nextRunAt ||
    currentCursor.generation !== payload.generation ||
    currentCursor.attempt !== payload.attempt
  ) {
    return undefined;
  }
  const nextAttempt = payload.attempt + 1;
  const runAt = eventProvisioningRecoveryRunAt(nextAttempt, now);
  const nextCursor = {
    generation: payload.generation,
    attempt: nextAttempt,
    nextRunAt: runAt.toISOString()
  };
  await enqueuePluginJob(context.queue, {
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.provisioningRecovery,
    scopeId: latest.scopeId,
    ...(latest.groupId ? { groupId: latest.groupId } : {}),
    ...(latest.groupWid ? { groupWid: latest.groupWid } : {}),
    runAt,
    payload: {
      eventId: latest.id,
      subgroupChatId: payload.subgroupChatId,
      generation: payload.generation,
      attempt: nextAttempt
    } satisfies EventProvisioningRecoveryPayload,
    dedupeKey: eventProvisioningRecoveryDedupeKey(latest, nextCursor)
  });
  const advanced = advanceEventProvisioningRecovery(db, {
    eventId: latest.id,
    scopeId: latest.scopeId,
    subgroupChatId: payload.subgroupChatId,
    generation: payload.generation,
    expectedAttempt: payload.attempt,
    nextAttempt,
    nextRunAt: runAt.toISOString(),
    updatedAt: now.toISOString()
  });
  if (!advanced) {
    return undefined;
  }
  const advancedRecord = getEvent(db, latest.id);
  const advancedCursor = advancedRecord
    ? eventProvisioningRecoveryCursor(advancedRecord)
    : undefined;
  if (
    !advancedRecord ||
    !advancedCursor?.nextRunAt ||
    advancedCursor.generation !== payload.generation ||
    advancedCursor.attempt !== nextAttempt
  ) {
    return undefined;
  }
  return {
    record: advancedRecord,
    cursor: {
      ...advancedCursor,
      nextRunAt: advancedCursor.nextRunAt
    },
    runAt
  };
}

function eventProvisioningRecoveryPayload(payload: unknown): EventProvisioningRecoveryPayload | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const candidate = payload as Record<string, unknown>;
  const eventId = typeof candidate.eventId === 'string' ? candidate.eventId.trim() : '';
  const subgroupChatId = typeof candidate.subgroupChatId === 'string'
    ? candidate.subgroupChatId.trim().toLowerCase()
    : '';
  const generation = typeof candidate.generation === 'string' ? candidate.generation.trim() : '';
  const attempt = candidate.attempt;
  if (
    !eventId ||
    !subgroupChatId.endsWith('@g.us') ||
    !generation ||
    !Number.isInteger(attempt) ||
    Number(attempt) < 1
  ) {
    return undefined;
  }
  return { eventId, subgroupChatId, generation, attempt: Number(attempt) };
}

function unplannedEventFinalizationPayload(
  payload: unknown
): UnplannedEventFinalizationPayload | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const candidate = payload as Record<string, unknown>;
  const eventId = typeof candidate.eventId === 'string' ? candidate.eventId.trim() : '';
  const generation = typeof candidate.generation === 'string' ? candidate.generation.trim() : '';
  const attempt = candidate.attempt;
  if (!eventId || !generation || !Number.isInteger(attempt) || Number(attempt) < 1) {
    return undefined;
  }
  return { eventId, generation, attempt: Number(attempt) };
}

function eventProvisioningRecoveryAction(
  record: StoredEventRecord,
  cursor: EventProvisioningRecoveryCursor & { nextRunAt: string }
): PluginEnqueueJobAction {
  const subgroupChatId = record.subgroupChatId;
  if (!subgroupChatId) {
    throw new Error(`Event ${record.id} does not have an exact subgroup recovery target.`);
  }
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.provisioningRecovery,
    scopeId: record.scopeId,
    runAt: new Date(cursor.nextRunAt),
    payload: {
      eventId: record.id,
      subgroupChatId,
      generation: cursor.generation,
      attempt: cursor.attempt
    } satisfies EventProvisioningRecoveryPayload,
    dedupeKey: eventProvisioningRecoveryDedupeKey(record, cursor)
  };
}

async function publishClosedEventCalendar(
  context: PluginRuntimeContext,
  input: {
    db: ReturnType<typeof eventsDatabase>;
    config: ReturnType<typeof parseEventsConfig>;
    record: StoredEventRecord;
    calendarId: string;
    calendarEnabled: boolean;
  }
): Promise<PluginAction | undefined> {
  try {
    const publication = await writePublishAndRecordScopeCalendar({
      appConfig: context.config,
      db: input.db,
      config: input.config,
      scopeId: input.record.scopeId,
      calendarId: input.calendarId
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
  if ((record.eventStatus !== 'active' && record.eventStatus !== 'completed') ||
      (record.groupLifecycleStatus !== 'poll_closed' && record.groupLifecycleStatus !== 'cleanup_failed')) {
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
  releaseExpiredEventCleanupClaims(db, now.toISOString());
  const claim = claimEventCleanup(db, {
    eventId: record.id,
    expectedUpdatedAt: record.updatedAt,
    expectedCleanupAt: record.cleanupAt,
    claimedAt: now.toISOString()
  });
  if (!claim) {
    const activeClaim = getEventCleanupClaim(db, record.id);
    const claimExpiresAt = activeClaim ? new Date(activeClaim.leaseExpiresAt) : undefined;
    if (claimExpiresAt && Number.isFinite(claimExpiresAt.getTime()) && claimExpiresAt > now) {
      return [audit('events.cleanup.claimed', {
        eventId,
        claimExpiresAt: claimExpiresAt.toISOString()
      }), {
        type: 'plugin.enqueueJob',
        pluginId: EVENTS_PLUGIN_ID,
        jobName: EVENTS_JOBS.cleanup,
        scopeId: record.scopeId,
        ...(record.groupId ? { groupId: record.groupId } : {}),
        ...(record.groupWid ? { groupWid: record.groupWid } : {}),
        runAt: claimExpiresAt,
        payload: { eventId: record.id, attempt },
        dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:claim-expiry:${claimExpiresAt.toISOString()}`
      }];
    }
    return [audit('events.job.skipped', {
      jobName: job.jobName,
      eventId,
      reason: 'cleanup deadline or lifecycle changed'
    })];
  }

  try {
    let dismantleResult: PluginGroupDismantleResult | undefined;
    if (record.subgroupChatId) {
      if (!context.dismantleManagedGroup) {
        throw new Error('Plugin runtime does not expose dismantleManagedGroup.');
      }
      dismantleResult = await withEventCleanupClaimHeartbeat(db, claim, () =>
        context.dismantleManagedGroup!({
          scopeId: record.scopeId,
          chatId: record.subgroupChatId!,
          reason: 'event cleanup'
        })
      );
      if (!dismantleCompleted(dismantleResult)) {
        return cleanupFailed(context, db, record, config, attempt, dismantleIncompleteReason(dismantleResult), {
          dismantleResult,
          retryable: true
        }, claim.claimId);
      }
    }
    const cleanedAt = new Date().toISOString();
    if (!markClaimedEventCleaned(db, {
      eventId: record.id,
      claimId: claim.claimId,
      expectedUpdatedAt: record.updatedAt,
      cleanedAt
    })) {
      releaseEventCleanupClaim(db, { eventId: record.id, claimId: claim.claimId });
      return [audit('events.job.skipped', {
        jobName: job.jobName,
        eventId,
        reason: 'event lifecycle changed while cleanup was running'
      })];
    }
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
    return cleanupFailed(context, db, record, config, attempt, reason, { retryable: true }, claim.claimId);
  }
}

async function withEventCleanupClaimHeartbeat<T>(
  db: ReturnType<typeof eventsDatabase>,
  claim: EventCleanupClaim,
  operation: () => Promise<T>
): Promise<T> {
  let ownershipLost = false;
  const renew = (): boolean => {
    const renewed = renewEventCleanupClaim(db, {
      eventId: claim.eventId,
      claimId: claim.claimId,
      expectedUpdatedAt: claim.expectedEventUpdatedAt,
      leaseExpiresAt: new Date(Date.now() + EVENT_CLEANUP_CLAIM_LEASE_MS).toISOString()
    });
    ownershipLost ||= !renewed;
    return renewed;
  };
  const timer = setInterval(renew, Math.max(1_000, Math.floor(EVENT_CLEANUP_CLAIM_LEASE_MS / 3)));
  timer.unref();
  try {
    const result = await operation();
    if (ownershipLost || !renew()) {
      throw new Error(`Cleanup claim ${claim.claimId} was lost while dismantling event ${claim.eventId}.`);
    }
    return result;
  } finally {
    clearInterval(timer);
  }
}

async function cleanupFailed(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  record: StoredEventRecord,
  config: ReturnType<typeof parseEventsConfig>,
  attempt: number,
  reason: string,
  metadata: Record<string, unknown> = {},
  cleanupClaimId?: string | undefined
): Promise<PluginAction[]> {
  if (cleanupClaimId && !releaseEventCleanupClaim(db, {
    eventId: record.id,
    claimId: cleanupClaimId
  })) {
    return [audit('events.job.skipped', {
      jobName: EVENTS_JOBS.cleanup,
      eventId: record.id,
      reason: 'cleanup claim changed while recording cleanup failure'
    })];
  }
  const failedAt = new Date().toISOString();
  if (!markEventCleanupFailed(db, {
    eventId: record.id,
    expectedUpdatedAt: record.updatedAt,
    reason,
    failedAt
  })) {
    return [audit('events.job.skipped', {
      jobName: EVENTS_JOBS.cleanup,
      eventId: record.id,
      reason: 'event lifecycle changed while cleanup was running'
    })];
  }
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
    dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:retry:${record.cleanupAt}:${nextAttempt}`
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
  try {
    const calendarId = resolvedEventCalendarId(record);
    if (!calendarId) {
      return;
    }
    await writePublishAndRecordScopeCalendar({
      appConfig: context.config,
      db,
      config,
      scopeId: record.scopeId,
      calendarId
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

function jobPayloadQuestionKeyRenameOperationId(payload: unknown): string | undefined {
  return payload && typeof payload === 'object' &&
    typeof (payload as { operationId?: unknown }).operationId === 'string'
    ? (payload as { operationId: string }).operationId
    : undefined;
}

function jobPayloadOperationId(payload: unknown): string | undefined {
  return payload && typeof payload === 'object' &&
    typeof (payload as { operationId?: unknown }).operationId === 'string'
    ? (payload as { operationId: string }).operationId
    : undefined;
}

function jobPayloadAttempt(payload: unknown): number {
  const attempt = payload && typeof payload === 'object'
    ? (payload as { attempt?: unknown }).attempt
    : undefined;
  return typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
}

function latestFiniteDate(
  ...candidates: Array<Date | undefined>
): Date | undefined {
  const finite = candidates.filter((candidate): candidate is Date =>
    Boolean(candidate && Number.isFinite(candidate.getTime()))
  );
  return finite.length > 0
    ? new Date(Math.max(...finite.map((candidate) => candidate.getTime())))
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
