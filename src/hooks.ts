import { randomUUID } from 'node:crypto';
import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import type {
  PluginGroupDismantledEvent,
  PluginJobEvent,
  PluginParticipantChangeEvent,
  PluginPollVotePluginEvent,
  PluginRuntimeHooks
} from '../../../platform/pluginRuntime/types';
import {
  isManagedCommunitySubgroupPreCreateError,
  isManagedCommunitySubgroupProvisioningError,
  type ManagedCommunitySubgroupProvisioningError
} from '../../../platform/pluginRuntime/runtime/pluginCommunityOperations';
import {
  IncompletePollVoteReadbackError,
  requirePollVotesThroughCutoff
} from '../../../platform/transport/pollVoteReadback';
import type { CreatedGroupParticipantResult } from '../../../platform/transport/transportTypes';
import type { OfficialPluginCommandRuntime } from '../shared';
import type { PluginGroupDismantleResult, PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { resolvePluginPollVotes } from '../../../platform/pluginRuntime/runtime/pluginPollVoteIdentity';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import { parseEventsConfig, type EventProfile } from './config';
import { formatEventDateTime } from './datetime';
import { eventGroupHintEnabled, eventGroupJoinUrl, renderEventGroupAnnouncement } from './announcements';
import { voterWidsForResponseBehavior } from './attendance';
import {
  eventCalendarPublicationConfigFingerprint,
  writePublishAndRecordScopeCalendar
} from './calendarStatus';
import { publishEventCalendarBeforeCommunityLink } from './communityLinkCalendar';
import { eventCleanupJobRequest } from './cleanupScheduling';
import { repairEventEdit } from './editRepair';
import { deleteEventArtifacts } from './eventArtifactDeletion';
import {
  eventAnnouncementTransportIdempotencyKey,
  sendClaimedEventAnnouncement
} from './announcementDelivery';
import {
  authorizeEventCalendarHintTarget,
  resolveEventCalendarHintSubscriptionUrl,
  sendEventCalendarHint
} from './calendarHint';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import {
  releaseEligibleEventPollReplacementReceipts,
  runEventPollReplacement,
  type EventPollReceiptReleaseRetry
} from './pollReplacement';
import {
  completeEventCommunitySubgroup,
  configureEventCommunitySubgroup,
  createEventCommunitySubgroupCandidate,
  reconcileEventCommunitySubgroupCreator
} from './subgroups';
import {
  eventWeatherForecastJobAction,
  eventWeatherForecastJobRequests,
  eventWeatherForecastRecoveryJobRequest,
  handleEventWeatherForecastJob
} from './weather';
import {
  appendEventLog,
  bindClaimedInitialPlannedEventProvisioningChild,
  failClaimedBoundPlannedEventProvisioningChild,
  EVENT_CLEANUP_CLAIM_LEASE_MS,
  checkpointClaimedEventProvisioningChild,
  checkpointClaimedEventParticipantOutcomes,
  claimInitialBoundPlannedEventProvisioningAttempt,
  claimInitialEventPreCreateProvisioningAttempt,
  claimScheduledKnownChildEventProvisioningAttempt,
  claimScheduledEventPreCreateProvisioningAttempt,
  ensureEventCalendarPublicationConfiguration,
  eventsDatabase,
  expireKnownChildEventProvisioningForCleanup,
  freezeEventPollCloseCutoff,
  getEvent,
  getEventAnnouncementDeliveryClaim,
  getCalendarPublicationStatus,
  getEventRequiredCreatorReference,
  getUnplannedEventFinalization,
  getOpenEventByEquivalentPoll,
  getLiveEventBySubgroup,
  getEventCleanupClaim,
  getEventAnnouncementSendingLeaseExpiresAt,
  getEventEditRepairExecutionLeaseExpiresAt,
  getEventWeatherDelivery,
  confirmEventAnnouncementMessageDeleted,
  claimEventCancellationArtifactDeletion,
  listCreatedGroupParticipants,
  listDirtyEventCalendarPublications,
  listEventCalendarPublicationGenerations,
  listInterruptedEventPreCreateClaims,
  listOpenPollEvents,
  listFailedProvisioningEvents,
  listPendingUnplannedEventFinalizations,
  listPendingCleanupEvents,
  listPendingCompletionEvents,
  listDueEventCancellationArtifacts,
  listEventCancellationCleanupCandidates,
  listEventCancellationNoticeCandidates,
  listEventAnnouncementMessages,
  listPendingEventEditRepairs,
  listRecoverableEventAnnouncementDeliveries,
  listPendingEventPollReplacements,
  listPendingEventPollReplacementRetirements,
  listEligibleEventPollReplacementReceiptReleases,
  listRecoverableEventWeatherDeliveries,
  listUnassignedEventCalendarOwnership,
  listWeatherForecastCandidateEvents,
  advanceEventProvisioningRecovery,
  claimEventCleanup,
  completeUnplannedEventFinalization,
  initializeEventProvisioningRecovery,
  markClaimedEventCleaned,
  markClaimedEventCleanupFailed,
  markEventCleaned,
  markEventCompletedAtEnd,
  recordEventCancellationArtifactDeletionOutcome,
  recordEventAnnouncementMessage,
  markClaimedEventReadyForCommunityLink,
  nextEventRevisionTimestamp,
  completeClaimedEventCommunityLink,
  haltInterruptedEventPreCreateClaimAtStartup,
  markUnclaimedEventFailed,
  markUnclaimedEventPreCreateProvisioningMissed,
  replaceVotesForOpenPollGeneration,
  rearmClaimedEventPreCreateProvisioningAttempt,
  rearmClaimedKnownChildEventProvisioningForStartup,
  releaseEventCleanupClaim,
  releaseExpiredEventCleanupClaims,
  resolvedEventCalendarId,
  renewEventCleanupClaim,
  renewClaimedEventCommunityLinkLease,
  renewClaimedKnownChildEventProvisioningLease,
  haltClaimedEventPreCreateProvisioning,
  haltClaimedKnownChildEventProvisioning,
  markClaimedEventPreCreateProvisioningMissed,
  markScheduledEventPreCreateProvisioningMissed,
  supersedeEventWeatherDelivery,
  supersedeEventAnnouncementDelivery,
  updateEventCloseAt,
  hasActiveEventPollReplacement,
  upsertVoteForOpenPollGeneration,
  type EventCleanupClaim,
  type StoredEventAnnouncementDeliveryClaim,
  type StoredEventRecord
} from './store';
import {
  attemptUnplannedEventFinalization,
  eventCommunityLinkRecoveryRunAt,
  eventProvisioningProviderHealthRunAt,
  eventProvisioningRecoveryCursor,
  eventProvisioningRecoveryDedupeKey,
  eventProvisioningRecoveryRunAt,
  EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS,
  isBaileysEventPreCreateProviderUnavailableFailure,
  eventProvisioningResumeDedupeKey,
  retryEventProvisioningCreation,
  resumeEventProvisioning,
  scheduleUnplannedEventFinalizationRetry,
  unplannedEventFinalizationDedupeKey,
  type EventProvisioningRecoveryCursor,
  type EventProvisioningRecoveryPayload,
  type UnplannedEventFinalizationPayload
} from './provisioningRecovery';
import { notifyEventCreatorPreCreateTerminal } from './provisioningTerminalNotice';
import { recoverEventQuestionKeyRenames } from './questionKeyRenameRecovery';
import {
  handleEventSuggestionReconcileJob,
  recoverEventSuggestionConversionJobs
} from './suggestionConversion';
import { registerEventFlowCompletionHandlers } from './commands';
import { registerEventCreationFlowDefinitionResolver } from './eventCreationFlowStarter';
import {
  handleEventStartTimeAgreementJob,
  recoverEventStartTimeAgreementJobs
} from './startTimeAgreement';
import { wakeEventStartTimeAgreementForParticipant } from './startTimeAgreementStore';
import {
  eventCreatorMembershipPauseKindForFailure,
  notifyEventCreatorMembershipPaused
} from './creatorMembershipNotice';

type PluginEnqueueJobAction = Extract<PluginAction, { type: 'plugin.enqueueJob' }>;

const EVENT_EDIT_REPAIR_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
const EVENT_ANNOUNCEMENT_DELIVERY_RETRY_MS = 60_000;
export const EVENT_CALENDAR_PUBLICATION_RECOVERY_SWEEP_MS = 30_000;
export const EVENT_QUEUE_HANDOFF_RECOVERY_SWEEP_MS = 30_000;

interface EventRecoveryOptions {
  now?: Date | undefined;
  startupBeforeWorker?: boolean | undefined;
}

interface EventsHooksOptions {
  recoverJobs?: boolean | undefined;
  recoverCalendarPublications?: boolean | undefined;
  recoverJobHandoffs?: boolean | undefined;
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
  if (options.recoverJobHandoffs === true) {
    startEventQueueHandoffRecovery(context);
  }
  return {
    async onMessage(event) {
      if (event.message.type !== 'message_deleted' || !event.message.replyTo?.messageId) {
        return [];
      }
      const confirmed = confirmEventAnnouncementMessageDeleted(
        eventsDatabase(context.databases),
        event.message.replyTo.messageId,
        event.receivedAt.toISOString()
      );
      return [...new Map(confirmed
        .filter((artifact) => artifact.deletionStatus === 'confirmed')
        .map((artifact) => [artifact.eventId, artifact])).values()].map((artifact) => ({
          type: 'plugin.enqueueJob' as const,
          pluginId: EVENTS_PLUGIN_ID,
          jobName: EVENTS_JOBS.cancellationCleanup,
          scopeId: artifact.scopeId,
          runAt: event.receivedAt,
          payload: { eventId: artifact.eventId },
          dedupeKey: `${EVENTS_JOBS.cancellationCleanup}:${artifact.eventId}:confirmation:${artifact.id}`
        }));
    },
    async onPollVote(event) {
      await handlePollVote(context, event);
    },
    async onParticipantChange(event) {
      return wakeStartTimeAgreementForParticipant(context, event);
    },
    async onPluginJob(event) {
      return handleEventJob(context, event);
    },
    async onGroupDismantled(event) {
      await handleGroupDismantled(context, event);
    }
  };
}

export function wakeStartTimeAgreementForParticipant(
  context: PluginRuntimeContext,
  event: PluginParticipantChangeEvent
): PluginAction[] {
  if (!['join', 'add', 'membership_approved'].includes(event.action)) {
    return [];
  }
  const db = eventsDatabase(context.databases);
  const record = getLiveEventBySubgroup(db, event.chatId);
  if (!record || record.scopeId !== event.scopeId || !record.actorIdentityId) {
    return [];
  }
  const excludedIdentityIds = new Set([...event.botIdentityIds, record.actorIdentityId]);
  if (!event.affectedIdentities.some((identity) => !excludedIdentityIds.has(identity.identityId))) {
    return [];
  }
  const agreement = wakeEventStartTimeAgreementForParticipant(db, {
    eventId: record.id,
    wokenAt: event.receivedAt.toISOString()
  });
  if (!agreement) {
    return [];
  }
  const leaseExpiresAt = agreement.leaseExpiresAt
    ? new Date(agreement.leaseExpiresAt)
    : undefined;
  const runAt = leaseExpiresAt && Number.isFinite(leaseExpiresAt.getTime())
    && leaseExpiresAt.getTime() > event.receivedAt.getTime()
    ? new Date(leaseExpiresAt.getTime() + 1_000)
    : event.receivedAt;
  return [
    {
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.startTimeAgreement,
      scopeId: record.scopeId,
      ...(record.groupId ? { groupId: record.groupId } : {}),
      ...(record.groupWid ? { groupWid: record.groupWid } : {}),
      runAt,
      payload: { eventId: record.id },
      dedupeKey: `${EVENTS_JOBS.startTimeAgreement}:${record.id}:${agreement.generation}:participant:${event.eventId}`
    },
    audit('events.start_time_agreement.participant_wakeup', {
      eventId: record.id,
      participantEventId: event.eventId,
      runAt: runAt.toISOString()
    })
  ];
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
      await recoverReadyEventCalendarHintDeliveryJobs(context);
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

function startEventQueueHandoffRecovery(context: PluginRuntimeContext): void {
  let running = false;
  const sweep = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      await recoverEventQueueHandoffs(context);
    } catch (error) {
      context.logger.error({ error }, 'official.community-events queue handoff recovery failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void sweep();
  }, EVENT_QUEUE_HANDOFF_RECOVERY_SWEEP_MS);
  timer.unref();
}

export async function recoverEventQueueHandoffs(
  context: PluginRuntimeContext,
  options: EventRecoveryOptions = {}
): Promise<number> {
  const pollReplacementJobs = await recoverEventPollReplacementJobs(context, options.now);
  const closeJobs = await recoverEventCloseJobs(context, options);
  const startTimeAgreementJobs = await recoverEventStartTimeAgreementJobs(context, options.now);
  return pollReplacementJobs + closeJobs + startTimeAgreementJobs;
}

export async function recoverEventJobs(
  context: PluginRuntimeContext,
  options: EventRecoveryOptions = {}
): Promise<number> {
  const interruptedPreCreateClaims = options.startupBeforeWorker === true
    ? await reconcileInterruptedEventPreCreateClaimsAtStartup(context, options.now)
    : 0;
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
  const announcementDeliveryJobs = await recoverEventAnnouncementDeliveryJobs(context, options);
  const pollReplacementJobs = await recoverEventPollReplacementJobs(context, options.now);
  const closeJobs = await recoverEventCloseJobs(context, options);
  const completionJobs = await recoverEventCompletionJobs(context, options);
  const startTimeAgreementJobs = await recoverEventStartTimeAgreementJobs(context, options.now);
  const cleanupJobs = await recoverEventCleanupJobs(context);
  const cancellationCleanupJobs = await recoverEventCancellationArtifactJobs(context, options);
  const weatherForecastJobs = await recoverEventWeatherForecastJobs(context);
  const provisioningJobs = await recoverEventProvisioningJobs(context, options);
  const unplannedFinalizationJobs = await recoverUnplannedEventFinalizationJobs(context);
  const suggestionReconcileJobs = await recoverEventSuggestionConversionJobs(context, options.now);
  const enqueued = questionKeyRenames.scheduled + editRepairJobs + announcementDeliveryJobs + pollReplacementJobs + closeJobs + completionJobs + startTimeAgreementJobs + cleanupJobs + cancellationCleanupJobs + weatherForecastJobs + provisioningJobs + unplannedFinalizationJobs + suggestionReconcileJobs;
  if (
    enqueued > 0 ||
    interruptedPreCreateClaims > 0 ||
    calendarPublications > 0 ||
    questionKeyRenames.settled > 0 ||
    questionKeyRenames.unresolved > 0
  ) {
    context.logger.info(
      { enqueued, calendarPublications, questionKeyRenames, editRepairJobs, announcementDeliveryJobs, pollReplacementJobs, interruptedPreCreateClaims, closeJobs, completionJobs, startTimeAgreementJobs, cleanupJobs, cancellationCleanupJobs, weatherForecastJobs, provisioningJobs, unplannedFinalizationJobs, suggestionReconcileJobs },
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
        ...(context.services ? { services: context.services } : {}),
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
    if (record.subgroupChatId) {
      // Repair the deadline job independently of whether provisioning itself
      // is scheduled, claimed, or durably halted. This is what makes a lost
      // initial Redis enqueue recoverable without reopening provisioning.
      await enqueuePluginJob(context.queue, {
        pluginId: EVENTS_PLUGIN_ID,
        ...eventCleanupJobRequest(record)
      });
    }
    if (record.subgroupChatId && !eventProvisioningRecoveryCursor(record)) {
      const initialized = initializeEventProvisioningRecovery(db, {
        eventId: record.id,
        scopeId: record.scopeId,
        subgroupChatId: record.subgroupChatId,
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
    let cursor = eventProvisioningRecoveryCursor(record);
    if (
      record.subgroupChatId &&
      cursor &&
      !cursor.nextRunAt &&
      !record.provisioningRecoveryHaltedAt
    ) {
      const rearmedAt = now.toISOString();
      const rearmed = rearmClaimedKnownChildEventProvisioningForStartup(db, {
        eventId: record.id,
        scopeId: record.scopeId,
        subgroupChatId: record.subgroupChatId,
        generation: cursor.generation,
        attempt: cursor.attempt,
        nextRunAt: rearmedAt,
        rearmedAt
      });
      record = getEvent(db, record.id) ?? record;
      cursor = eventProvisioningRecoveryCursor(record);
      if (rearmed) {
        appendEventLog(db, {
          eventId: record.id,
          action: 'events.provisioning.known_child_startup_rearmed',
          metadata: {
            subgroupChatId: record.subgroupChatId,
            generation: cursor?.generation,
            attempt: cursor?.attempt,
            runAt: cursor?.nextRunAt
          }
        });
      }
    }
    if (record.subgroupChatId) {
      const cleanupTransfer = transferKnownChildProvisioningToCleanup(db, record, now);
      if (cleanupTransfer.status === 'expired') {
        enqueued += 1;
        continue;
      }
      if (cleanupTransfer.status === 'deferred') {
        await enqueuePluginJob(context.queue, {
          pluginId: EVENTS_PLUGIN_ID,
          jobName: EVENTS_JOBS.cleanup,
          scopeId: record.scopeId,
          runAt: cleanupTransfer.runAt,
          payload: { eventId: record.id, attempt: 0 },
          dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:provisioning-lease:${cleanupTransfer.runAt.toISOString()}`
        });
        enqueued += 1;
        continue;
      }
      if (cleanupTransfer.status === 'changed') {
        continue;
      }
    }
    if (!cursor?.nextRunAt) {
      continue;
    }
    if (!record.subgroupChatId && !eventPreCreateEligibleBeforeCleanup(record, now)) {
      const missed = markScheduledEventPreCreateProvisioningMissed(db, {
        eventId: record.id,
        scopeId: record.scopeId,
        generation: cursor.generation,
        expectedAttempt: cursor.attempt,
        expectedNextRunAt: cursor.nextRunAt,
        expectedCleanupAt: record.cleanupAt,
        reason: 'Event subgroup creation retries reached the cleanup deadline.',
        missedAt: now.toISOString()
      });
      if (missed) {
        const failedEvent = getEvent(db, record.id);
        if (failedEvent) {
          await notifyEventCreatorPreCreateTerminal(context, failedEvent, 'cleanup_expired');
        }
        const receiptReleaseRetries = failedEvent
          ? await releaseEligibleEventPollReplacementReceipts({
              context,
              db,
              eventId: failedEvent.id,
              now
            })
          : [];
        for (const retry of receiptReleaseRetries) {
          await enqueuePluginJob(context.queue, {
            pluginId: EVENTS_PLUGIN_ID,
            jobName: EVENTS_JOBS.pollReplacement,
            scopeId: retry.scopeId,
            ...(record.groupId ? { groupId: record.groupId } : {}),
            ...(record.groupWid ? { groupWid: record.groupWid } : {}),
            runAt: retry.retryAt,
            payload: { operationId: retry.operationId },
            dedupeKey: `${EVENTS_JOBS.pollReplacement}:${retry.operationId}:receipt-release:${retry.failureCount}`
          });
        }
      }
      continue;
    }
    if (
      !record.subgroupChatId &&
      cursor.attempt > EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS
    ) {
      const claimedAt = now.toISOString();
      const claimed = claimScheduledEventPreCreateProvisioningAttempt(db, {
        eventId: record.id,
        scopeId: record.scopeId,
        generation: cursor.generation,
        attempt: cursor.attempt,
        expectedNextRunAt: cursor.nextRunAt,
        claimedAt
      });
      const halted = claimed && haltClaimedEventPreCreateProvisioning(db, {
        eventId: record.id,
        scopeId: record.scopeId,
        generation: cursor.generation,
        expectedAttempt: cursor.attempt,
        reason: `Event subgroup creation exceeded the maximum of ${EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS} deterministic attempts.`,
        haltedAt: claimedAt
      });
      if (halted) {
        appendEventLog(db, {
          eventId: record.id,
          action: 'events.provisioning.precreate_retry_limit_reached',
          metadata: {
            generation: cursor.generation,
            attempt: cursor.attempt,
            maxAttempts: EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS,
            source: 'recovery_scan'
          }
        });
        const failedEvent = getEvent(db, record.id);
        if (failedEvent) {
          await notifyEventCreatorPreCreateTerminal(context, failedEvent, 'attempts_exhausted');
        }
      }
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
        ...(record.subgroupChatId ? { subgroupChatId: record.subgroupChatId } : {}),
        generation: cursor.generation,
        attempt: cursor.attempt
      } satisfies EventProvisioningRecoveryPayload,
      dedupeKey: eventProvisioningRecoveryDedupeKey(record, {
        ...cursor,
        nextRunAt: cursor.nextRunAt
      })
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
  for (const candidate of records) {
    if (hasActiveEventPollReplacement(db, candidate.id)) {
      continue;
    }
    const candidateCursor = eventProvisioningRecoveryCursor(candidate);
    if (!candidate.subgroupChatId && candidateCursor && !candidateCursor.nextRunAt) {
      // A partial cursor is a permanent one-shot ownership fence. Ordinary
      // recovery must neither replay creation nor keep enqueueing a close job
      // that cannot safely determine whether groupCreate already succeeded.
      continue;
    }
    const config = parseEventsConfig(await context.configFor(candidate.scopeId));
    const closeAt = effectiveCloseAt(candidate, config);
    const record = persistEffectiveCloseAt(db, candidate, closeAt, now);
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
      payload: {
        eventId: record.id,
        pollGeneration: record.pollGeneration,
        pollWaMsgId: record.pollWaMsgId
      },
      dedupeKey: record.subgroupChatId
        ? eventProvisioningResumeDedupeKey(record.id, record.subgroupChatId)
        : `${EVENTS_JOBS.close}:${record.id}:${due ? 'startup-due' : 'startup'}:${closeAtIso}:${record.updatedAt}`
    });
    enqueued += 1;
  }
  return enqueued;
}

export async function recoverEventPollReplacementJobs(
  context: PluginRuntimeContext,
  now: Date = new Date()
): Promise<number> {
  const db = eventsDatabase(context.databases);
  const allThrough = new Date('9999-12-31T23:59:59.999Z');
  const recoveries = [
    ...listPendingEventPollReplacements(db, allThrough).map((replacement) => ({
      replacement,
      kind: 'core' as const,
      nextAttemptAt: replacement.publicationLeaseExpiresAt ?? replacement.nextAttemptAt
    })),
    ...listPendingEventPollReplacementRetirements(db, allThrough).map((replacement) => ({
      replacement,
      kind: 'retire' as const,
      nextAttemptAt: replacement.nextAttemptAt
    })),
    ...listEligibleEventPollReplacementReceiptReleases(db, allThrough).map((replacement) => ({
      replacement,
      kind: 'receipt-release' as const,
      nextAttemptAt: replacement.receiptReleaseNextAttemptAt
    }))
  ];
  let enqueued = 0;
  for (const recovery of recoveries) {
    const { replacement } = recovery;
    const event = getEvent(db, replacement.eventId);
    if (!event || event.scopeId !== replacement.scopeId) {
      continue;
    }
    const persistedNextAttemptAt = recovery.nextAttemptAt
      ? new Date(recovery.nextAttemptAt)
      : now;
    const closeAt = new Date(replacement.target.closeAt);
    const nextAttemptAt = recovery.kind === 'core' && Number.isFinite(closeAt.getTime())
      ? closeAt.getTime() <= now.getTime()
        ? now
        : persistedNextAttemptAt.getTime() > closeAt.getTime()
          ? closeAt
          : persistedNextAttemptAt
      : persistedNextAttemptAt;
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.pollReplacement,
      scopeId: replacement.scopeId,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.groupWid ? { groupWid: event.groupWid } : {}),
      ...(nextAttemptAt.getTime() > now.getTime() ? { runAt: nextAttemptAt } : {}),
      payload: { operationId: replacement.operationId },
      dedupeKey: `${EVENTS_JOBS.pollReplacement}:${replacement.operationId}:startup:${recovery.kind}:${replacement.updatedAt}`
    });
    enqueued += 1;
  }
  return enqueued;
}

async function reconcileInterruptedEventPreCreateClaimsAtStartup(
  context: PluginRuntimeContext,
  now: Date = new Date()
): Promise<number> {
  const db = eventsDatabase(context.databases);
  let reconciled = 0;
  for (const record of listInterruptedEventPreCreateClaims(db)) {
    const cursor = eventProvisioningRecoveryCursor(record);
    if (!cursor || cursor.nextRunAt) {
      continue;
    }
    const failedAt = now.toISOString();
    const reason = 'Runtime startup found an interrupted subgroup creation attempt with an unknown outcome. Automatic creation is halted pending operator reconciliation.';
    const persisted = haltInterruptedEventPreCreateClaimAtStartup(db, {
      eventId: record.id,
      scopeId: record.scopeId,
      expectedUpdatedAt: record.updatedAt,
      generation: cursor.generation,
      expectedAttempt: cursor.attempt,
      reason,
      failedAt
    });
    if (!persisted) {
      continue;
    }
    appendEventLog(db, {
      eventId: record.id,
      action: 'events.provisioning.precreate_interrupted_at_startup',
      metadata: {
        generation: cursor.generation,
        attempt: cursor.attempt,
        outcome: 'unknown',
        automaticRetry: false
      }
    });
    try {
      await context.audit.record({
        scopeId: record.scopeId,
        ...(record.groupId ? { groupId: record.groupId } : {}),
        action: 'official.community-events.provisioning.precreate_interrupted_at_startup',
        targetJson: { eventId: record.id },
        metadataJson: {
          expectedUpdatedAt: record.updatedAt,
          generation: cursor.generation,
          attempt: cursor.attempt,
          status: 'halted_ambiguous',
          automaticRetry: false
        }
      });
    } catch (error) {
      context.logger.warn(
        { error, eventId: record.id, scopeId: record.scopeId },
        'Unable to audit interrupted event subgroup creation claim found at startup'
      );
    }
    context.logger.error(
      {
        eventId: record.id,
        scopeId: record.scopeId,
        generation: cursor.generation,
        attempt: cursor.attempt
      },
      'Halted interrupted event subgroup creation claim with an unknown provider outcome'
    );
    reconciled += 1;
  }
  return reconciled;
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

export async function recoverEventCompletionJobs(
  context: PluginRuntimeContext,
  options: EventRecoveryOptions = {}
): Promise<number> {
  const now = options.now ?? new Date();
  const records = listPendingCompletionEvents(eventsDatabase(context.databases));
  for (const record of records) {
    const endsAt = new Date(record.lifecycleCompleteAt);
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.complete,
      scopeId: record.scopeId,
      ...(record.groupId ? { groupId: record.groupId } : {}),
      ...(record.groupWid ? { groupWid: record.groupWid } : {}),
      ...(Number.isFinite(endsAt.getTime()) && endsAt.getTime() > now.getTime() ? { runAt: endsAt } : {}),
      payload: { eventId: record.id },
      dedupeKey: `${EVENTS_JOBS.complete}:${record.id}:startup:${record.lifecycleCompleteAt}`
    });
  }
  return records.length;
}

export async function recoverEventCancellationArtifactJobs(
  context: PluginRuntimeContext,
  options: EventRecoveryOptions = {}
): Promise<number> {
  const db = eventsDatabase(context.databases);
  const now = options.now ?? new Date();
  const candidates = new Map([
    ...listEventCancellationCleanupCandidates(db),
    ...listEventCancellationNoticeCandidates(db, now.toISOString())
  ].map((event) => [event.id, event]));
  for (const event of candidates.values()) {
    const nextAttemptAt = listEventAnnouncementMessages(db, event.id)
      .map((artifact) => artifact.deletionNextAttemptAt ? new Date(artifact.deletionNextAttemptAt) : undefined)
      .filter((date): date is Date => Boolean(date && Number.isFinite(date.getTime())))
      .sort((left, right) => left.getTime() - right.getTime())[0];
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.cancellationCleanup,
      scopeId: event.scopeId,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.groupWid ? { groupWid: event.groupWid } : {}),
      ...(nextAttemptAt && nextAttemptAt.getTime() > now.getTime() ? { runAt: nextAttemptAt } : {}),
      payload: { eventId: event.id },
      dedupeKey: `${EVENTS_JOBS.cancellationCleanup}:${event.id}:startup:${nextAttemptAt?.toISOString() ?? 'notice'}`
    });
  }
  return candidates.size;
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

export async function recoverEventAnnouncementDeliveryJobs(
  context: PluginRuntimeContext,
  options: EventRecoveryOptions = {}
): Promise<number> {
  const eventGroupHints = await enqueueRecoverableEventAnnouncementDeliveryJobs(
    context,
    options,
    'event_group_hint'
  );
  const calendarHints = await enqueueRecoverableEventAnnouncementDeliveryJobs(
    context,
    options,
    'calendar_hint',
    true
  );
  return eventGroupHints + calendarHints;
}

async function recoverReadyEventCalendarHintDeliveryJobs(
  context: PluginRuntimeContext,
  options: EventRecoveryOptions = {}
): Promise<number> {
  return enqueueRecoverableEventAnnouncementDeliveryJobs(
    context,
    options,
    'calendar_hint',
    true
  );
}

async function enqueueRecoverableEventAnnouncementDeliveryJobs(
  context: PluginRuntimeContext,
  options: EventRecoveryOptions,
  kind: StoredEventAnnouncementDeliveryClaim['kind'],
  requireResolvableCalendarSubscription = false
): Promise<number> {
  const db = eventsDatabase(context.databases);
  const now = options.now ?? new Date();
  let enqueued = 0;
  for (const delivery of listRecoverableEventAnnouncementDeliveries(db, { kind })) {
    const event = getEvent(db, delivery.eventId);
    if (!event || event.scopeId !== delivery.scopeId) {
      continue;
    }
    const leaseExpiresAt = delivery.leaseExpiresAt
      ? new Date(delivery.leaseExpiresAt)
      : undefined;
    const activeDeliveryLease = delivery.status === 'sending' &&
      leaseExpiresAt &&
      leaseExpiresAt > now;
    if (delivery.kind === 'calendar_hint' && !activeDeliveryLease) {
      const targetAuthorization = await authorizeEventCalendarHintTarget(context, {
        scopeId: delivery.scopeId,
        chatId: delivery.chatId
      });
      if (!targetAuthorization.ok) {
        if (targetAuthorization.permanent) {
          supersedeEventAnnouncementDelivery(db, {
            eventId: delivery.eventId,
            kind: delivery.kind,
            deliveryKey: delivery.deliveryKey
          });
        }
        continue;
      }
    }
    if (
      requireResolvableCalendarSubscription &&
      delivery.kind === 'calendar_hint' &&
      !delivery.text
    ) {
      let calendarId = delivery.calendarHintIntent?.calendarId;
      if (!calendarId) {
        try {
          calendarId = resolvedEventCalendarId(event);
        } catch {
          continue;
        }
      }
      if (!calendarId) {
        continue;
      }
      let subscriptionUrl = '';
      try {
        const config = parseEventsConfig(await context.configFor(event.scopeId));
        const calendar = config.calendars.find((candidate) => candidate.id === calendarId);
        subscriptionUrl = calendar
          ? resolveEventCalendarHintSubscriptionUrl({
              config: context.config,
              scopeId: event.scopeId,
              calendar,
              publicationStatus: getCalendarPublicationStatus(
                db,
                event.scopeId,
                calendarId
              )
            })
          : '';
      } catch {
        // Recovery remains dormant until the persisted scope configuration is readable.
      }
      if (!subscriptionUrl) {
        continue;
      }
    }
    const runAt = delivery.status === 'sending' && leaseExpiresAt && leaseExpiresAt > now
      ? leaseExpiresAt
      : now;
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      ...eventAnnouncementDeliveryJobRequest(event, delivery, 0, runAt),
      dedupeKey: `${EVENTS_JOBS.announcementDelivery}:${delivery.eventId}:${delivery.kind}:${delivery.deliveryKey}:startup:${delivery.updatedAt}`
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
  const record = getOpenEventByEquivalentPoll(db, event.vote.pollWaMsgId);
  if (!record) {
    return;
  }
  if (!record.pollWaMsgId || !upsertVoteForOpenPollGeneration(db, {
    eventId: record.id,
    pollWaMsgId: record.pollWaMsgId,
    pollGeneration: record.pollGeneration,
    vote: event.vote
  })) {
    return;
  }
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
  if (event.jobName === EVENTS_JOBS.announcementDelivery) {
    return retryEventAnnouncementDelivery(context, event);
  }
  if (event.jobName === EVENTS_JOBS.pollReplacement) {
    return replaceEventPollJob(context, event);
  }
  if (event.jobName === EVENTS_JOBS.close) {
    return closeEvent(context, event);
  }
  if (event.jobName === EVENTS_JOBS.complete) {
    return completeEventAtEnd(context, event);
  }
  if (event.jobName === EVENTS_JOBS.startTimeAgreement) {
    return handleEventStartTimeAgreementJob(context, event);
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
  if (event.jobName === EVENTS_JOBS.cancellationCleanup) {
    return cleanupCancelledEventArtifacts(context, event);
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

async function completeEventAtEnd(context: PluginRuntimeContext, job: PluginJobEvent): Promise<PluginAction[]> {
  const eventId = jobPayloadEventId(job.payload);
  if (!eventId) {
    return [audit('events.job.skipped', { jobName: job.jobName, reason: 'missing eventId' })];
  }
  const db = eventsDatabase(context.databases);
  const record = getEvent(db, eventId);
  if (!record || record.eventStatus !== 'active') {
    return [audit('events.job.skipped', { jobName: job.jobName, eventId, reason: 'event missing or no longer active' })];
  }
  const endsAt = new Date(record.lifecycleCompleteAt);
  const now = new Date();
  if (Number.isFinite(endsAt.getTime()) && endsAt.getTime() > now.getTime()) {
    return [{
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.complete,
      scopeId: record.scopeId,
      runAt: endsAt,
      payload: { eventId: record.id },
      dedupeKey: `${EVENTS_JOBS.complete}:${record.id}:deferred:${record.lifecycleCompleteAt}`
    }];
  }
  const completedAt = nextEventRevisionTimestamp(record.updatedAt, now);
  if (!markEventCompletedAtEnd(db, { eventId: record.id, completedAt })) {
    return [audit('events.job.skipped', { jobName: job.jobName, eventId, reason: 'event changed before completion' })];
  }
  appendEventLog(db, {
    eventId: record.id,
    action: 'events.completed_at_end',
    metadata: { endsAt: record.endsAt, lifecycleCompleteAt: record.lifecycleCompleteAt, spanKind: record.spanKind }
  });
  return [audit('events.completed_at_end', {
    eventId: record.id,
    endsAt: record.endsAt,
    lifecycleCompleteAt: record.lifecycleCompleteAt,
    spanKind: record.spanKind
  })];
}

async function replaceEventPollJob(
  context: PluginRuntimeContext,
  job: PluginJobEvent
): Promise<PluginAction[]> {
  const operationId = jobPayloadOperationId(job.payload);
  if (!operationId) {
    return [audit('events.job.skipped', {
      jobName: job.jobName,
      reason: 'missing operationId'
    })];
  }
  const db = eventsDatabase(context.databases);
  const run = await runEventPollReplacement({
    context,
    db,
    operationId,
    ...(context.deleteMessage
      ? { deleteMessage: (messageId: string) => context.deleteMessage!(messageId) }
      : {})
  });
  if (run.status === 'pending') {
    return [{
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.pollReplacement,
      scopeId: run.replacement.scopeId,
      runAt: run.retryAt,
      payload: { operationId },
      dedupeKey: `${EVENTS_JOBS.pollReplacement}:${operationId}:core:${run.replacement.failureCount}:${run.retryAt.toISOString()}`
    }, audit('events.poll_replacement.pending', {
      eventId: run.replacement.eventId,
      operationId,
      reason: run.error,
      retryAt: run.retryAt.toISOString()
    })];
  }
  const event = getEvent(db, run.replacement.eventId);
  if (run.status === 'aborted' || !event) {
    const actions: PluginAction[] = [audit('events.poll_replacement.aborted', {
      eventId: run.replacement.eventId,
      operationId,
      reason: run.status === 'aborted' ? run.error : 'event disappeared'
    })];
    if (run.status === 'aborted' && run.retirementPending) {
      const retryAt = run.replacement.nextAttemptAt
        ? new Date(run.replacement.nextAttemptAt)
        : new Date(Date.now() + 5_000);
      actions.unshift(eventPollReplacementRetryAction(event, {
        operationId,
        scopeId: run.replacement.scopeId,
        retryAt,
        kind: 'retire',
        attempt: run.replacement.retirementFailureCount
      }));
    }
    if (run.status === 'aborted') {
      actions.unshift(...run.receiptReleaseRetries.map((retry) =>
        eventPollReceiptReleaseRetryAction(event, retry)
      ));
    }
    if (event?.eventStatus === 'active' && event.groupLifecycleStatus === 'poll_open') {
      const closeAt = new Date(event.closeAt);
      actions.unshift(eventCloseAction(event, closeAt));
    }
    return actions;
  }

  let presentationRepairPending = false;
  let presentationRepairActions: PluginAction[] = [];
  if (!context.sendText || !context.setGroupSubject) {
    presentationRepairPending = true;
    presentationRepairActions = eventEditRepairRetryActions(job, operationId, 0, [
      'plugin runtime does not expose durable text/group-subject delivery'
    ]);
  } else {
    try {
      const repair = await repairEventEdit({
        appConfig: context.config,
        db,
        operationId,
        ...(context.services ? { services: context.services } : {}),
        configFor: (scopeId) => context.configFor(scopeId),
        sender: {
          sendText: context.sendText,
          setGroupSubject: context.setGroupSubject
        },
        ...(context.getGroupInviteCode
          ? { getGroupInviteCode: context.getGroupInviteCode }
          : {})
      });
      if (repair.status === 'pending') {
        presentationRepairPending = true;
        presentationRepairActions = eventEditRepairRetryActions(
          job,
          operationId,
          0,
          repair.failures,
          repair.retryAt
        );
      }
    } catch (error) {
      presentationRepairPending = true;
      const reason = error instanceof Error ? error.message : String(error);
      presentationRepairActions = eventEditRepairRetryActions(job, operationId, 0, [reason]);
      context.logger.warn(
        { error, eventId: run.event.id, operationId },
        'Event poll replacement presentation repair failed'
      );
    }
  }

  const replacementIsCurrentOpen =
    event.eventStatus === 'active' &&
    event.groupLifecycleStatus === 'poll_open' &&
    event.pollGeneration === run.replacement.oldPollGeneration + 1 &&
    event.pollWaMsgId === run.replacement.newPollWaMsgId;
  if (!replacementIsCurrentOpen) {
    const actions: PluginAction[] = [
      ...presentationRepairActions,
      ...run.receiptReleaseRetries.map((retry) => eventPollReceiptReleaseRetryAction(event, retry))
    ];
    if (run.retirementPending) {
      const retryAt = run.replacement.nextAttemptAt
        ? new Date(run.replacement.nextAttemptAt)
        : new Date(Date.now() + 5_000);
      actions.push(eventPollReplacementRetryAction(event, {
        operationId,
        scopeId: run.replacement.scopeId,
        retryAt,
        kind: 'retire',
        attempt: run.replacement.retirementFailureCount
      }));
    }
    actions.push(audit('events.poll_replacement.recovered', {
      eventId: event.id,
      operationId,
      pollGeneration: event.pollGeneration,
      retirementPending: run.retirementPending,
      receiptReleasePending: run.receiptReleaseRetries.length > 0,
      presentationRepairPending
    }));
    return actions;
  }

  const closeAt = new Date(run.event.closeAt);
  const actions: PluginAction[] = [
    eventCloseAction(run.event, closeAt),
    eventCompleteAction(run.event)
  ];
  actions.push(...presentationRepairActions);
  actions.push(...run.receiptReleaseRetries.map((retry) =>
    eventPollReceiptReleaseRetryAction(run.event, retry)
  ));
  if (run.retirementPending) {
    const retryAt = run.replacement.nextAttemptAt
      ? new Date(run.replacement.nextAttemptAt)
      : new Date(Date.now() + 5_000);
    actions.push({
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.pollReplacement,
      scopeId: run.event.scopeId,
      runAt: retryAt,
      payload: { operationId },
      dedupeKey: `${EVENTS_JOBS.pollReplacement}:${operationId}:retire:${run.replacement.retirementFailureCount}`
    });
  }
  actions.push(audit('events.poll_replacement.completed', {
    eventId: run.event.id,
    operationId,
    pollGeneration: run.event.pollGeneration,
    retirementPending: run.retirementPending,
    presentationRepairPending
  }));
  return actions;
}

function eventPollReplacementRetryAction(
  event: StoredEventRecord | undefined,
  input: {
    operationId: string;
    scopeId: string;
    retryAt: Date;
    kind: 'retire';
    attempt: number;
  }
): PluginEnqueueJobAction {
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.pollReplacement,
    scopeId: event?.scopeId ?? input.scopeId,
    ...(event?.groupId ? { groupId: event.groupId } : {}),
    ...(event?.groupWid ? { groupWid: event.groupWid } : {}),
    runAt: input.retryAt,
    payload: { operationId: input.operationId },
    dedupeKey: `${EVENTS_JOBS.pollReplacement}:${input.operationId}:${input.kind}:${input.attempt}`
  };
}

function eventCompleteAction(event: StoredEventRecord): PluginEnqueueJobAction {
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.complete,
    scopeId: event.scopeId,
    ...(event.groupId ? { groupId: event.groupId } : {}),
    ...(event.groupWid ? { groupWid: event.groupWid } : {}),
    runAt: new Date(event.lifecycleCompleteAt),
    payload: { eventId: event.id },
    dedupeKey: `${EVENTS_JOBS.complete}:${event.id}:${event.lifecycleCompleteAt}`
  };
}

function eventPollReceiptReleaseRetryAction(
  event: StoredEventRecord | undefined,
  retry: EventPollReceiptReleaseRetry
): PluginEnqueueJobAction {
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.pollReplacement,
    scopeId: retry.scopeId,
    ...(event?.groupId ? { groupId: event.groupId } : {}),
    ...(event?.groupWid ? { groupWid: event.groupWid } : {}),
    runAt: retry.retryAt,
    payload: { operationId: retry.operationId },
    dedupeKey: `${EVENTS_JOBS.pollReplacement}:${retry.operationId}:receipt-release:${retry.failureCount}`
  };
}

function eventCloseAction(record: StoredEventRecord, closeAt: Date): PluginEnqueueJobAction {
  const now = Date.now();
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.close,
    scopeId: record.scopeId,
    ...(record.groupId ? { groupId: record.groupId } : {}),
    ...(record.groupWid ? { groupWid: record.groupWid } : {}),
    runAt: Number.isFinite(closeAt.getTime()) && closeAt.getTime() > now
      ? closeAt
      : new Date(now),
    payload: {
      eventId: record.id,
      pollGeneration: record.pollGeneration,
      pollWaMsgId: record.pollWaMsgId
    },
    dedupeKey: `${EVENTS_JOBS.close}:${record.id}:poll-generation:${record.pollGeneration}`
  };
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
    ...(context.services ? { services: context.services } : {}),
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

async function retryEventAnnouncementDelivery(
  context: PluginRuntimeContext,
  job: PluginJobEvent
): Promise<PluginAction[]> {
  const eventId = jobPayloadEventId(job.payload);
  const payload = job.payload && typeof job.payload === 'object'
    ? job.payload as Record<string, unknown>
    : {};
  const deliveryKey = typeof payload.deliveryKey === 'string'
    ? payload.deliveryKey.trim()
    : '';
  const kind = payload.kind === 'event_group_hint' || payload.kind === 'calendar_hint'
    ? payload.kind
    : undefined;
  const attempt = jobPayloadAttempt(job.payload);
  if (!eventId || !kind || !deliveryKey) {
    return [audit('events.job.skipped', {
      jobName: job.jobName,
      reason: 'missing event announcement delivery identity'
    })];
  }

  const db = eventsDatabase(context.databases);
  const delivery = getEventAnnouncementDeliveryClaim(db, eventId, kind, deliveryKey);
  if (!delivery || delivery.status === 'sent' || delivery.status === 'superseded') {
    return [audit('events.announcement_delivery.settled', {
      eventId,
      kind,
      deliveryKey,
      status: delivery?.status ?? 'missing'
    })];
  }
  const record = getEvent(db, eventId);
  const invalidLifecycle =
    !record ||
    record.scopeId !== delivery.scopeId ||
    record.eventStatus !== 'active' ||
    record.groupLifecycleStatus === 'cleaned' ||
    (kind === 'event_group_hint' && record.groupLifecycleStatus !== 'poll_closed');
  const staleCalendarHint = Boolean(
    record &&
    kind === 'calendar_hint' &&
    delivery.calendarHintIntent &&
    record.updatedAt !== delivery.calendarHintIntent.expectedEventUpdatedAt
  );
  if (invalidLifecycle || staleCalendarHint) {
    supersedeEventAnnouncementDelivery(db, { eventId, kind, deliveryKey });
    return [audit('events.announcement_delivery.superseded', {
      eventId,
      kind,
      deliveryKey,
      reason: staleCalendarHint
        ? 'event changed after the calendar-hint intent was prepared'
        : kind === 'event_group_hint'
          ? 'event is no longer an active closed poll'
          : 'event is no longer active'
    })];
  }
  if (!record) {
    return [];
  }

  const now = new Date();
  const cleanupClaim = getEventCleanupClaim(db, eventId);
  const activeDeliveryLease = delivery.status === 'sending' && delivery.leaseExpiresAt
    ? new Date(delivery.leaseExpiresAt)
    : undefined;
  if (cleanupClaim || (activeDeliveryLease && activeDeliveryLease > now)) {
    const retryAt = cleanupClaim ? new Date(cleanupClaim.leaseExpiresAt) : activeDeliveryLease!;
    return eventAnnouncementDeliveryRetryActions(
      record,
      delivery,
      attempt,
      Number.isFinite(retryAt.getTime()) ? retryAt : undefined,
      'delivery is fenced by an active mutation or send lease'
    );
  }
  if (kind === 'calendar_hint') {
    const targetAuthorization = await authorizeEventCalendarHintTarget(
      context,
      { scopeId: delivery.scopeId, chatId: delivery.chatId }
    );
    if (!targetAuthorization.ok) {
      if (targetAuthorization.permanent) {
        supersedeEventAnnouncementDelivery(db, { eventId, kind, deliveryKey });
        return [audit('events.announcement_delivery.superseded', {
          eventId,
          kind,
          deliveryKey,
          reason: targetAuthorization.reason
        })];
      }
      return eventAnnouncementDeliveryRetryActions(
        record,
        delivery,
        attempt,
        undefined,
        targetAuthorization.reason
      );
    }
  }
  if (kind === 'calendar_hint' && !delivery.text) {
    return retryPreparedEventCalendarHint(context, record, delivery, attempt);
  }
  if (!context.sendText || !delivery.text || !delivery.idempotencyKey) {
    return eventAnnouncementDeliveryRetryActions(
      record,
      delivery,
      attempt,
      undefined,
      'plugin runtime does not expose the persisted durable text delivery intent'
    );
  }

  try {
    const result = await sendClaimedEventAnnouncement({
      db,
      eventId,
      scopeId: delivery.scopeId,
      kind,
      deliveryKey,
      chatId: delivery.chatId,
      text: delivery.text,
      idempotencyKey: delivery.idempotencyKey,
      ...(kind === 'calendar_hint' && delivery.calendarHintIntent
        ? { expectedEventUpdatedAt: delivery.calendarHintIntent.expectedEventUpdatedAt }
        : {}),
      sender: { sendText: context.sendText }
    });
    if (result.status === 'already_claimed') {
      const current = getEventAnnouncementDeliveryClaim(db, eventId, kind, deliveryKey) ?? delivery;
      const retryAt = current.leaseExpiresAt ? new Date(current.leaseExpiresAt) : undefined;
      return eventAnnouncementDeliveryRetryActions(
        record,
        current,
        attempt,
        retryAt,
        'delivery claim remains in progress'
      );
    }
    return [audit('events.announcement_delivery.settled', {
      eventId,
      kind,
      deliveryKey,
      status: result.status
    })];
  } catch (error) {
    return eventAnnouncementDeliveryRetryActions(
      record,
      getEventAnnouncementDeliveryClaim(db, eventId, kind, deliveryKey) ?? delivery,
      attempt,
      undefined,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function retryPreparedEventCalendarHint(
  context: PluginRuntimeContext,
  event: StoredEventRecord,
  delivery: StoredEventAnnouncementDeliveryClaim,
  attempt: number
): Promise<PluginAction[]> {
  const intent = delivery.calendarHintIntent;
  const db = eventsDatabase(context.databases);
  if (!intent) {
    supersedeEventAnnouncementDelivery(db, {
      eventId: event.id,
      kind: 'calendar_hint',
      deliveryKey: delivery.deliveryKey
    });
    return [audit('events.announcement_delivery.superseded', {
      eventId: event.id,
      kind: 'calendar_hint',
      deliveryKey: delivery.deliveryKey,
      reason: 'persisted calendar-hint delivery is missing its retry intent'
    })];
  }
  if (!context.sendText) {
    return eventAnnouncementDeliveryRetryActions(
      event,
      delivery,
      attempt,
      undefined,
      'plugin runtime does not expose text delivery'
    );
  }

  try {
    if (!await context.enabledFor(event.scopeId)) {
      supersedeEventAnnouncementDelivery(db, {
        eventId: event.id,
        kind: 'calendar_hint',
        deliveryKey: delivery.deliveryKey
      });
      return [audit('events.announcement_delivery.superseded', {
        eventId: event.id,
        kind: 'calendar_hint',
        deliveryKey: delivery.deliveryKey,
        reason: 'community events is disabled for the delivery scope'
      })];
    }
    const currentCalendarId = resolvedEventCalendarId(event);
    if (currentCalendarId !== intent.calendarId) {
      supersedeEventAnnouncementDelivery(db, {
        eventId: event.id,
        kind: 'calendar_hint',
        deliveryKey: delivery.deliveryKey
      });
      return [audit('events.announcement_delivery.superseded', {
        eventId: event.id,
        kind: 'calendar_hint',
        deliveryKey: delivery.deliveryKey,
        reason: 'event calendar ownership no longer matches the prepared hint'
      })];
    }
    const config = parseEventsConfig(await context.configFor(event.scopeId));
    const profile = config.eventProfiles.find((candidate) => candidate.id === event.profileId);
    if (!profile) {
      supersedeEventAnnouncementDelivery(db, {
        eventId: event.id,
        kind: 'calendar_hint',
        deliveryKey: delivery.deliveryKey
      });
      return [audit('events.announcement_delivery.superseded', {
        eventId: event.id,
        kind: 'calendar_hint',
        deliveryKey: delivery.deliveryKey,
        reason: 'event profile is no longer configured'
      })];
    }
    const result = await sendEventCalendarHint({
      context,
      runtime: { config: context.config, databases: context.databases },
      db,
      activeTransport: {
        sendText: (chatId, text, options) => context.sendText!(chatId, text, options)
      },
      trigger: intent.trigger,
      scopeId: event.scopeId,
      announcementGroupWid: delivery.chatId,
      event,
      profile,
      calendars: config.calendars,
      timezone: intent.timezone,
      locale: intent.locale,
      creatorDisplayName: intent.creatorDisplayName,
      ...(intent.groupJoinUrl ? { groupJoinUrl: intent.groupJoinUrl } : {}),
      ...(intent.subgroupChatId ? { subgroupChatId: intent.subgroupChatId } : {}),
      expectedEventUpdatedAt: intent.expectedEventUpdatedAt,
      deliveryKey: delivery.deliveryKey
    });
    const current = getEventAnnouncementDeliveryClaim(
      db,
      event.id,
      'calendar_hint',
      delivery.deliveryKey
    ) ?? delivery;
    if (
      result === 'sent' ||
      result === 'already_sent' ||
      result === 'superseded' ||
      result === 'disabled' ||
      current.status === 'sent' ||
      current.status === 'superseded'
    ) {
      return [audit('events.announcement_delivery.settled', {
        eventId: event.id,
        kind: 'calendar_hint',
        deliveryKey: delivery.deliveryKey,
        status: current.status
      })];
    }
    if (result === 'skipped') {
      return [audit('events.announcement_delivery.pending', {
        eventId: event.id,
        kind: 'calendar_hint',
        deliveryKey: delivery.deliveryKey,
        attempt,
        reason: 'calendar subscription URL remains unavailable'
      })];
    }
    const retryAt = current.leaseExpiresAt ? new Date(current.leaseExpiresAt) : undefined;
    return eventAnnouncementDeliveryRetryActions(
      event,
      current,
      attempt,
      result === 'already_claimed' ? retryAt : undefined,
      result === 'failed'
        ? current.error || 'calendar-hint delivery failed'
        : 'calendar-hint delivery remains pending'
    );
  } catch (error) {
    return eventAnnouncementDeliveryRetryActions(
      event,
      getEventAnnouncementDeliveryClaim(
        db,
        event.id,
        'calendar_hint',
        delivery.deliveryKey
      ) ?? delivery,
      attempt,
      undefined,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function eventAnnouncementDeliveryRetryActions(
  event: StoredEventRecord,
  delivery: StoredEventAnnouncementDeliveryClaim,
  attempt: number,
  requestedRunAt: Date | undefined,
  reason: string
): PluginAction[] {
  const runAt = requestedRunAt && Number.isFinite(requestedRunAt.getTime()) && requestedRunAt > new Date()
    ? new Date(requestedRunAt.getTime() + 1)
    : new Date(Date.now() + EVENT_ANNOUNCEMENT_DELIVERY_RETRY_MS);
  const nextAttempt = attempt + 1;
  return [
    audit('events.announcement_delivery.pending', {
      eventId: event.id,
      kind: delivery.kind,
      deliveryKey: delivery.deliveryKey,
      attempt,
      reason,
      retryAt: runAt.toISOString()
    }),
    {
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      ...eventAnnouncementDeliveryJobRequest(event, delivery, nextAttempt, runAt),
      dedupeKey: `${EVENTS_JOBS.announcementDelivery}:${event.id}:${delivery.kind}:${delivery.deliveryKey}:retry:${nextAttempt}:${runAt.toISOString()}`
    }
  ];
}

function eventAnnouncementDeliveryJobRequest(
  event: StoredEventRecord,
  delivery: StoredEventAnnouncementDeliveryClaim,
  attempt: number,
  runAt: Date
): Omit<PluginEnqueueJobAction, 'type' | 'pluginId' | 'dedupeKey'> {
  return {
    jobName: EVENTS_JOBS.announcementDelivery,
    scopeId: event.scopeId,
    ...(event.groupId ? { groupId: event.groupId } : {}),
    ...(event.groupWid ? { groupWid: event.groupWid } : {}),
    runAt,
    payload: {
      eventId: event.id,
      kind: delivery.kind,
      deliveryKey: delivery.deliveryKey,
      attempt
    }
  };
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
    const current = getEvent(db, record.id);
    const retryAt = current
      ? externalDismantleRetryAt(db, current, event.chatId, event.receivedAt)
      : undefined;
    if (current && retryAt) {
      appendEventLog(db, {
        eventId: record.id,
        action: 'events.cleaned.external_deferred',
        metadata: { retryAt: retryAt.toISOString() }
      });
      await enqueuePluginJob(context.queue, {
        pluginId: EVENTS_PLUGIN_ID,
        jobName: EVENTS_JOBS.cleanup,
        scopeId: current.scopeId,
        ...(current.groupId ? { groupId: current.groupId } : {}),
        ...(current.groupWid ? { groupWid: current.groupWid } : {}),
        runAt: retryAt,
        payload: { eventId: current.id, attempt: 0, externalDismantledChatId: event.chatId },
        dedupeKey: `${EVENTS_JOBS.cleanup}:${current.id}:external-deferred:${retryAt.toISOString()}`
      });
    }
    return;
  }
  const announcementMessageDeletion = await deleteEventArtifacts({
    db,
    event: record,
    ...(context.deleteMessage
      ? { deleteMessage: (messageId) => context.deleteMessage!(messageId) }
      : {})
  });
  const receiptReleaseRetries = await releaseEligibleEventPollReplacementReceipts({
    context,
    db,
    eventId: record.id
  });
  const receiptReleaseEnqueueFailures: Array<{ operationId: string; reason: string }> = [];
  for (const retry of receiptReleaseRetries) {
    try {
      await enqueuePluginJob(context.queue, {
        pluginId: EVENTS_PLUGIN_ID,
        jobName: EVENTS_JOBS.pollReplacement,
        scopeId: retry.scopeId,
        ...(record.groupId ? { groupId: record.groupId } : {}),
        ...(record.groupWid ? { groupWid: record.groupWid } : {}),
        runAt: retry.retryAt,
        payload: { operationId: retry.operationId },
        dedupeKey: `${EVENTS_JOBS.pollReplacement}:${retry.operationId}:receipt-release:${retry.failureCount}`
      });
    } catch (error) {
      receiptReleaseEnqueueFailures.push({
        operationId: retry.operationId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  await setCleanupFailureStatus(context, record.scopeId, null);
  appendEventLog(db, {
    eventId: record.id,
    action: 'events.cleaned.external',
    metadata: {
      source: event.source,
      dismantleResult: event.result,
      announcementMessageDeletion,
      pollReceiptReleasePending: receiptReleaseRetries.length > 0,
      receiptReleaseEnqueueFailures
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
      dismantleResult: event.result,
      announcementMessageDeletion,
      pollReceiptReleasePending: receiptReleaseRetries.length > 0,
      receiptReleaseEnqueueFailures
    }
  });
}

async function closeEvent(context: PluginRuntimeContext, job: PluginJobEvent): Promise<PluginAction[]> {
  const db = eventsDatabase(context.databases);
  const eventId = jobPayloadEventId(job.payload);
  if (!eventId) {
    return [audit('events.job.skipped', { jobName: job.jobName, reason: 'missing eventId' })];
  }
  let record = getEvent(db, eventId);
  if (!record || record.eventStatus !== 'active' || record.groupLifecycleStatus !== 'poll_open') {
    return [audit('events.job.skipped', { jobName: job.jobName, eventId, reason: 'event missing or poll not open' })];
  }
  const expectedPollGeneration = jobPayloadPollGeneration(job.payload);
  const expectedPollWaMsgId = jobPayloadPollWaMsgId(job.payload);
  if (
    (expectedPollGeneration !== undefined && expectedPollGeneration !== record.pollGeneration) ||
    (expectedPollGeneration === undefined && record.pollGeneration > 1) ||
    (expectedPollWaMsgId !== undefined && expectedPollWaMsgId !== record.pollWaMsgId)
  ) {
    return [audit('events.job.skipped', {
      jobName: job.jobName,
      eventId,
      reason: 'stale poll generation',
      expectedPollGeneration,
      pollGeneration: record.pollGeneration,
      expectedPollWaMsgId,
      pollWaMsgId: record.pollWaMsgId
    })];
  }
  if (hasActiveEventPollReplacement(db, record.id)) {
    const retryAt = new Date(Date.now() + 5_000);
    return [{
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.close,
      scopeId: record.scopeId,
      runAt: retryAt,
      payload: {
        eventId: record.id,
        pollGeneration: record.pollGeneration,
        pollWaMsgId: record.pollWaMsgId
      },
      dedupeKey: `${EVENTS_JOBS.close}:${record.id}:replacement-fence:${record.pollGeneration}:${retryAt.toISOString()}`
    }, audit('events.close.replacement_fenced', {
      eventId: record.id,
      pollGeneration: record.pollGeneration,
      retryAt: retryAt.toISOString()
    })];
  }
  if (!record.pollWaMsgId) {
    return [audit('events.job.skipped', { jobName: job.jobName, eventId, reason: 'event has no poll' })];
  }
  // A close job owns exactly the poll generation it observed before its first await. Every
  // later mutation is fenced against these values so a replacement cannot turn an old close
  // invocation into an early close/failure of the successor poll.
  const closingPollGeneration = record.pollGeneration;
  const closingPollWaMsgId = record.pollWaMsgId;

  let closePersisted = false;
  let pollReceiptReleaseActions: PluginAction[] = [];
  const persistedCloseCursor = eventProvisioningRecoveryCursor(record);
  if (!record.subgroupChatId && persistedCloseCursor && !persistedCloseCursor.nextRunAt) {
    return [audit('events.provisioning.precreate_skipped', {
      eventId: record.id,
      reason: 'an earlier one-shot subgroup creation attempt has an unknown outcome'
    })];
  }
  let preCreateClaim: { generation: string; attempt: number; cleanupAt: string } | undefined =
    (record.origin === 'created' || record.origin === 'adopted_poll') &&
    record.subgroupChatId && persistedCloseCursor && !persistedCloseCursor.nextRunAt
      ? {
          generation: persistedCloseCursor.generation,
          attempt: persistedCloseCursor.attempt,
          cleanupAt: record.cleanupAt
        }
      : undefined;
  let createdSubgroupLog: {
    chatId: string;
    title: string;
    attendeeWids: string[];
    participants: Record<string, CreatedGroupParticipantResult>;
  } | undefined;
  try {
    const config = parseEventsConfig(await context.configFor(record.scopeId));
    const closeAt = effectiveCloseAt(record, config);
    record = persistEffectiveCloseAt(db, record, closeAt);
    if (
      record.eventStatus !== 'active' ||
      record.groupLifecycleStatus !== 'poll_open' ||
      record.pollGeneration !== closingPollGeneration ||
      record.pollWaMsgId !== closingPollWaMsgId ||
      hasActiveEventPollReplacement(db, record.id)
    ) {
      return [audit('events.close.poll_generation_changed', {
        eventId: record.id,
        pollGeneration: closingPollGeneration,
        pollWaMsgId: closingPollWaMsgId
      })];
    }
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
          payload: {
            eventId: record.id,
            pollGeneration: record.pollGeneration,
            pollWaMsgId: record.pollWaMsgId
          },
          dedupeKey: `${EVENTS_JOBS.close}:${record.id}:deferred:${closeAt.toISOString()}`
        }
      ];
    }
    const cutoffWasAlreadyFrozen = Boolean(record.pollCloseCutoffAt);
    const frozenRecord = freezeEventPollCloseCutoff(db, {
      eventId: record.id,
      scopeId: record.scopeId,
      expectedPollWaMsgId: closingPollWaMsgId,
      expectedPollGeneration: closingPollGeneration,
      cutoffAt: closeAt.toISOString(),
      frozenAt: now.toISOString()
    });
    if (!frozenRecord?.pollCloseCutoffAt) {
      return [audit('events.close.poll_generation_changed', {
        eventId: record.id,
        pollGeneration: closingPollGeneration,
        pollWaMsgId: closingPollWaMsgId,
        reason: 'attendance cutoff could not be frozen'
      })];
    }
    const pollCloseCutoffValue = frozenRecord.pollCloseCutoffAt;
    record = frozenRecord;
    const pollCloseCutoff = new Date(pollCloseCutoffValue);
    if (!Number.isFinite(pollCloseCutoff.getTime())) {
      throw new Error(`Event ${record.id} has an invalid immutable poll close cutoff.`);
    }
    if (!cutoffWasAlreadyFrozen) {
      appendEventLog(db, {
        eventId: record.id,
        action: 'events.close.cutoff_frozen',
        metadata: {
          pollWaMsgId: closingPollWaMsgId,
          pollGeneration: closingPollGeneration,
          pollCloseCutoffAt: pollCloseCutoff.toISOString()
        }
      });
    }
    const pollWaMsgId = closingPollWaMsgId;
    if (!context.pollVoteReadbackFor) {
      throw new IncompletePollVoteReadbackError({
        pollWaMsgId,
        coverage: 'incomplete',
        source: 'plugin-runtime',
        votes: [],
        reason: 'poll_readback_not_configured'
      });
    }
    const liveVotes = await resolvePluginPollVotes(
      requirePollVotesThroughCutoff({
        readback: await context.pollVoteReadbackFor(pollWaMsgId, { asOf: pollCloseCutoff }),
        expectedPollWaMsgId: pollWaMsgId,
        cutoff: pollCloseCutoff
      }),
      requirePollVoteIdentityResolver(context)
    );
    const postReadbackRecord = getEvent(db, record.id);
    if (
      !postReadbackRecord ||
      postReadbackRecord.eventStatus !== 'active' ||
      postReadbackRecord.groupLifecycleStatus !== 'poll_open' ||
      postReadbackRecord.pollGeneration !== closingPollGeneration ||
      postReadbackRecord.pollWaMsgId !== closingPollWaMsgId ||
      postReadbackRecord.pollCloseCutoffAt !== pollCloseCutoff.toISOString() ||
      hasActiveEventPollReplacement(db, record.id) ||
      !replaceVotesForOpenPollGeneration(db, {
        eventId: record.id,
        pollWaMsgId: closingPollWaMsgId,
        pollGeneration: closingPollGeneration,
        pollCloseCutoffAt: pollCloseCutoff.toISOString(),
        votes: liveVotes
      })
    ) {
      return [audit('events.close.poll_generation_changed', {
        eventId: record.id,
        pollGeneration: closingPollGeneration,
        pollWaMsgId: closingPollWaMsgId
      })];
    }
    record = getEvent(db, record.id)!;
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

    let parentCommunityWid: string | undefined;
    if (subgroupChatId && !preCreateClaim) {
      const claimRecord = getEvent(db, record.id);
      const claimedAt = new Date();
      if (
        !claimRecord ||
        claimRecord.pollGeneration !== closingPollGeneration ||
        claimRecord.pollWaMsgId !== closingPollWaMsgId ||
        hasActiveEventPollReplacement(db, record.id)
      ) {
        return [audit('events.provisioning.known_child_skipped', {
          eventId: record.id,
          subgroupChatId,
          reason: 'event changed or subgroup linking is already claimed'
        })];
      }
      const generation = randomUUID();
      const attempt = 1;
      const claimed = claimInitialBoundPlannedEventProvisioningAttempt(db, {
        eventId: claimRecord.id,
        scopeId: claimRecord.scopeId,
        subgroupChatId,
        expectedUpdatedAt: claimRecord.updatedAt,
        generation,
        attempt,
        claimedAt: claimedAt.toISOString()
      });
      if (!claimed) {
        return [audit('events.provisioning.known_child_skipped', {
          eventId: record.id,
          subgroupChatId,
          reason: 'known-child attempt is already claimed or event state changed'
        })];
      }
      preCreateClaim = { generation, attempt, cleanupAt: claimRecord.cleanupAt };
      appendEventLog(db, {
        eventId: record.id,
        action: 'events.provisioning.known_child_claimed',
        metadata: {
          subgroupChatId,
          generation,
          attempt,
          claimedAt: claimedAt.toISOString(),
          source: 'poll_close'
        }
      });
    }
    if (!subgroupChatId) {
        const claimRecord = getEvent(db, record.id);
        const claimedAt = new Date();
        if (!claimRecord) {
          return [audit('events.provisioning.precreate_skipped', {
            eventId: record.id,
            reason: 'event changed or subgroup creation is already claimed'
          })];
        }
        if (
          claimRecord.pollGeneration !== closingPollGeneration ||
          claimRecord.pollWaMsgId !== closingPollWaMsgId ||
          hasActiveEventPollReplacement(db, record.id)
        ) {
          return [audit('events.close.poll_generation_changed', {
            eventId: record.id,
            pollGeneration: closingPollGeneration,
            pollWaMsgId: closingPollWaMsgId
          })];
        }
        if (!eventPreCreateEligibleBeforeCleanup(claimRecord, claimedAt)) {
          const missed = markUnclaimedEventPreCreateProvisioningMissed(db, {
            eventId: claimRecord.id,
            scopeId: claimRecord.scopeId,
            expectedUpdatedAt: claimRecord.updatedAt,
            expectedCleanupAt: claimRecord.cleanupAt,
            reason: 'Event subgroup creation was not started before its cleanup deadline.',
            missedAt: claimedAt.toISOString()
          });
          const failedEvent = missed ? getEvent(db, record.id) : undefined;
          if (failedEvent) {
            await notifyEventCreatorPreCreateTerminal(context, failedEvent, 'cleanup_expired');
          }
          const receiptReleaseRetries = failedEvent
            ? await releaseEligibleEventPollReplacementReceipts({
                context,
                db,
                eventId: failedEvent.id,
                now: claimedAt
              })
            : [];
          return [
            ...receiptReleaseRetries.map((retry) =>
              eventPollReceiptReleaseRetryAction(failedEvent, retry)
            ),
            audit(missed
            ? 'events.provisioning.precreate_missed'
            : 'events.provisioning.precreate_skipped', {
            eventId: record.id,
            reason: missed
              ? 'cleanup deadline reached or invalid'
              : 'event state changed or subgroup creation is already claimed'
          })];
        }
        const generation = randomUUID();
        const attempt = 1;
        const claimed = claimInitialEventPreCreateProvisioningAttempt(db, {
          eventId: claimRecord.id,
          scopeId: claimRecord.scopeId,
          expectedUpdatedAt: claimRecord.updatedAt,
          generation,
          attempt,
          claimedAt: claimedAt.toISOString()
        });
        if (!claimed) {
          return [audit('events.provisioning.precreate_skipped', {
            eventId: record.id,
            reason: 'pre-create attempt is already claimed or event state changed'
          })];
        }
        preCreateClaim = { generation, attempt, cleanupAt: claimRecord.cleanupAt };
        appendEventLog(db, {
          eventId: record.id,
          action: 'events.provisioning.precreate_claimed',
          metadata: { generation, attempt, claimedAt: claimedAt.toISOString(), origin: record.origin }
        });
        const candidateResult = await createEventCommunitySubgroupCandidate({
          context,
          scopeId: record.scopeId,
          actorIdentityId: requireHookEventActorIdentityId(record),
          title: record.groupTitle
        });
        const candidate = candidateResult.created;
        subgroupChatId = candidate.chatId;
        subgroupTitle = candidate.title;
        parentCommunityWid = candidate.intendedParentCommunityJid;
        const checkpointedAt = new Date().toISOString();
        const checkpointed = bindClaimedInitialPlannedEventProvisioningChild(db, {
          eventId: record.id,
          scopeId: record.scopeId,
          generation,
          expectedAttempt: attempt,
          subgroupChatId: candidate.chatId,
          subgroupTitle: candidate.title,
          participants: candidate.participants,
          creator: candidate.requiredCreator,
          boundAt: checkpointedAt
        });
        if (!checkpointed) {
          throw new Error(
            `Event ${record.id} rejected the exact child checkpoint ${candidate.chatId} after creation.`
          );
        }
    }
    if (!subgroupChatId || !subgroupTitle || !preCreateClaim) {
      throw new Error(`Event ${record.id} has no exact claimed subgroup candidate.`);
    }
    const checkpointedEvent = getEvent(db, record.id);
    if (!checkpointedEvent || checkpointedEvent.subgroupChatId !== subgroupChatId) {
      throw new Error(`Event ${record.id} lost its exact claimed subgroup candidate ${subgroupChatId}.`);
    }
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      ...eventCleanupJobRequest(checkpointedEvent)
    });
    parentCommunityWid ??= await context.communityGroupWidForScope?.(record.scopeId);
    if (!parentCommunityWid) {
      throw new Error(`No parent community is mapped for scope ${record.scopeId}.`);
    }
    const creatorLeaseEvent = getEvent(db, record.id);
    if (!creatorLeaseEvent || creatorLeaseEvent.subgroupChatId !== subgroupChatId) {
      throw new Error(`Event ${record.id} lost its exact claimed subgroup before creator reconciliation.`);
    }
    const creatorLeaseRenewedAt = nextEventRevisionTimestamp(creatorLeaseEvent.updatedAt);
    if (!renewClaimedKnownChildEventProvisioningLease(db, {
      eventId: creatorLeaseEvent.id,
      scopeId: creatorLeaseEvent.scopeId,
      subgroupChatId,
      expectedEventStatus: creatorLeaseEvent.eventStatus,
      expectedGroupLifecycleStatus: creatorLeaseEvent.groupLifecycleStatus,
      expectedUpdatedAt: creatorLeaseEvent.updatedAt,
      generation: preCreateClaim.generation,
      attempt: preCreateClaim.attempt,
      renewedAt: creatorLeaseRenewedAt
    })) {
      throw new Error(
        `Event ${record.id} lost its claimed creator-reconciliation lease before provider reconciliation.`
      );
    }
    let participantOutcomes = storedParticipantOutcomes(db, record.id);
    const persistedRequiredCreator = getEventRequiredCreatorReference(
      db,
      record.id,
      requireHookEventActorIdentityId(record)
    );
    if (!persistedRequiredCreator) {
      throw new Error(`Event ${record.id} has no authoritative required creator checkpoint.`);
    }
    const creatorResult = await reconcileEventCommunitySubgroupCreator({
      context,
      scopeId: record.scopeId,
      actorIdentityId: requireHookEventActorIdentityId(record),
      subgroupChatId,
      subgroupTitle,
      requiredCreator: persistedRequiredCreator,
      participants: participantOutcomes,
      parentCommunityWid
    });
    if (creatorResult.created.chatId.trim().toLowerCase() !== subgroupChatId.trim().toLowerCase()) {
      throw new Error(
        `Event ${record.id} creator reconciliation returned ${creatorResult.created.chatId}; expected ${subgroupChatId}.`
      );
    }
    subgroupTitle = creatorResult.created.title.trim() || subgroupTitle;
    participantOutcomes = creatorResult.created.participants;
    const creatorCheckpointed = checkpointClaimedEventParticipantOutcomes(db, {
      eventId: record.id,
      scopeId: record.scopeId,
      subgroupChatId,
      subgroupTitle,
      participants: participantOutcomes,
      creator: creatorResult.created.requiredCreator,
      recoveryGeneration: preCreateClaim.generation,
      recoveryAttempt: preCreateClaim.attempt,
      checkpointedAt: nextEventRevisionTimestamp(creatorLeaseRenewedAt)
    });
    if (!creatorCheckpointed) {
      throw new Error(
        `Event ${record.id} changed before creator membership was checkpointed.`
      );
    }
    await configureEventCommunitySubgroup({
      context,
      scopeId: record.scopeId,
      actorIdentityId: requireHookEventActorIdentityId(record),
      subgroupChatId,
      subgroupTitle,
      requiredCreator: creatorResult.created.requiredCreator,
      participants: participantOutcomes,
      parentCommunityWid
    });
    const preparedAt = new Date().toISOString();
    const fenced = markClaimedEventReadyForCommunityLink(db, {
      eventId: record.id,
      scopeId: record.scopeId,
      subgroupChatId,
      subgroupTitle,
      recoveryGeneration: preCreateClaim.generation,
      recoveryAttempt: preCreateClaim.attempt,
      closedAt: preparedAt,
      preparedAt
    });
    if (!fenced) {
      throw new Error(`Event ${record.id} changed before its community-link fence was persisted.`);
    }
    const linkReadyEvent = getEvent(db, record.id);
    if (!linkReadyEvent) {
      throw new Error(`Event ${record.id} disappeared after its community-link fence was persisted.`);
    }
    await publishEventCalendarBeforeCommunityLink({
      context,
      config,
      event: linkReadyEvent
    });
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      ...eventCleanupJobRequest(linkReadyEvent)
    });
    const linkLeaseRenewedAt = nextEventRevisionTimestamp(linkReadyEvent.updatedAt);
    if (!renewClaimedEventCommunityLinkLease(db, {
      eventId: linkReadyEvent.id,
      scopeId: linkReadyEvent.scopeId,
      subgroupChatId,
      expectedUpdatedAt: linkReadyEvent.updatedAt,
      generation: preCreateClaim.generation,
      attempt: preCreateClaim.attempt,
      renewedAt: linkLeaseRenewedAt
    })) {
      throw new Error(
        `Event ${record.id} lost its claimed community-link lease before provider completion.`
      );
    }
    const result = await completeEventCommunitySubgroup({
      context,
      scopeId: record.scopeId,
      actorIdentityId: requireHookEventActorIdentityId(record),
      subgroupChatId,
      subgroupTitle,
      requiredCreator: creatorResult.created.requiredCreator,
      participantWids: attendeeWids,
      participants: participantOutcomes,
      parentCommunityWid
    });
    subgroupTitle = result.created.title.trim() || subgroupTitle;
    participantOutcomes = result.created.participants;
    const completedAt = new Date().toISOString();
    const activated = completeClaimedEventCommunityLink(db, {
      eventId: record.id,
      scopeId: record.scopeId,
      subgroupChatId,
      subgroupTitle,
      participants: participantOutcomes,
      creator: result.created.requiredCreator,
      recoveryGeneration: preCreateClaim.generation,
      recoveryAttempt: preCreateClaim.attempt,
      completedAt
    });
    if (!activated) {
      throw new Error(`Event ${record.id} changed after its community subgroup was linked.`);
    }
    createdSubgroupLog = {
      chatId: subgroupChatId,
      title: subgroupTitle,
      attendeeWids,
      participants: participantOutcomes
    };

    const recordProfileId = record.profileId;
    const calendarProfile = config.eventProfiles.find((profile) => profile.id === recordProfileId);
    closePersisted = true;
    const closedEvent = getEvent(db, record.id);
    if (
      !closedEvent ||
      closedEvent.groupLifecycleStatus !== 'poll_closed' ||
      closedEvent.subgroupChatId !== subgroupChatId
    ) {
      throw new Error(`Event ${record.id} changed while its poll closure was being persisted.`);
    }
    const receiptReleaseRetries = await releaseEligibleEventPollReplacementReceipts({
      context,
      db,
      eventId: closedEvent.id
    });
    pollReceiptReleaseActions = receiptReleaseRetries.map((retry) =>
      eventPollReceiptReleaseRetryAction(closedEvent, retry)
    );
    if (createdSubgroupLog) {
      await appendJsonLog(context, {
        action: 'subgroup.created',
        scopeId: record.scopeId,
        eventId: record.id,
        profileId: record.profileId,
        pollWaMsgId: record.pollWaMsgId,
        subgroupChatId: createdSubgroupLog.chatId,
        metadata: {
          title: createdSubgroupLog.title,
          attendeeWids: createdSubgroupLog.attendeeWids,
          participants: createdSubgroupLog.participants
        }
      });
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
      ...(weatherForecastAction ? [weatherForecastAction] : []),
      ...plannedAnnouncementActions,
      closeCleanupAction(closedEvent),
      ...(calendarFailureAudit ? [calendarFailureAudit] : []),
      ...pollReceiptReleaseActions,
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
        ...pollReceiptReleaseActions,
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
          payload: {
            eventId: record.id,
            pollGeneration: record.pollGeneration,
            pollWaMsgId: record.pollWaMsgId
          },
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
    let cleanupDeadlineAction: PluginEnqueueJobAction | undefined;
    let failurePersisted = true;
    if (isManagedCommunitySubgroupPreCreateError(error)) {
      const { provisioning, stage } = error;
      const nextAttempt = (preCreateClaim?.attempt ?? 0) + 1;
      const providerHealthDeferral = isBaileysEventPreCreateProviderUnavailableFailure(error);
      const recoveryAttempt = providerHealthDeferral
        ? preCreateClaim?.attempt ?? 1
        : nextAttempt;
      const recoveryRunAt = providerHealthDeferral
        ? eventProvisioningProviderHealthRunAt(new Date(failedAt))
        : eventProvisioningRecoveryRunAt(nextAttempt, new Date(failedAt));
      const claimedCleanupRecord = { ...record, cleanupAt: preCreateClaim?.cleanupAt ?? record.cleanupAt };
      const retryWithinCleanup = eventPreCreateEligibleBeforeCleanup(claimedCleanupRecord, recoveryRunAt);
      const retryAttemptsRemain = providerHealthDeferral ||
        nextAttempt <= EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS;
      const checkpointPersisted = Boolean(preCreateClaim) && (
        error.retryableWithoutCheckpoint && retryWithinCleanup && retryAttemptsRemain
          ? rearmClaimedEventPreCreateProvisioningAttempt(db, {
              eventId: record.id,
              scopeId: record.scopeId,
              generation: preCreateClaim!.generation,
              expectedAttempt: preCreateClaim!.attempt,
              nextAttempt: recoveryAttempt,
              nextRunAt: recoveryRunAt.toISOString(),
              reason,
              rearmedAt: failedAt
            })
          : error.retryableWithoutCheckpoint && !retryWithinCleanup
            ? markClaimedEventPreCreateProvisioningMissed(db, {
                eventId: record.id,
                scopeId: record.scopeId,
                generation: preCreateClaim!.generation,
                expectedAttempt: preCreateClaim!.attempt,
                expectedCleanupAt: preCreateClaim!.cleanupAt,
                reason: 'Event subgroup creation retries reached the cleanup deadline.',
                missedAt: failedAt
              })
            : haltClaimedEventPreCreateProvisioning(db, {
                eventId: record.id,
                scopeId: record.scopeId,
                generation: preCreateClaim!.generation,
                expectedAttempt: preCreateClaim!.attempt,
                reason: error.retryableWithoutCheckpoint && !retryAttemptsRemain
                  ? `Event subgroup creation reached the maximum of ${EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS} deterministic attempts: ${reason}`
                  : reason,
                haltedAt: failedAt
              })
      );
      failurePersisted = checkpointPersisted;
      failureMetadata = {
        reason,
        parentCommunityWid: provisioning.parentCommunityWid,
        stage,
        providerId: provisioning.providerId,
        certainty: provisioning.certainty,
        details: provisioning.details,
        creatorIdentityId: provisioning.creatorIdentityId,
        claimGeneration: preCreateClaim?.generation,
        claimAttempt: preCreateClaim?.attempt,
        recoveryAttempt,
        providerHealthDeferral,
        retryWithinCleanup,
        retryAttemptsRemain,
        maxAttempts: EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS,
        checkpointPersisted
      };
      if (
        checkpointPersisted &&
        error.retryableWithoutCheckpoint &&
        retryWithinCleanup &&
        retryAttemptsRemain
      ) {
        const failedRecord = getEvent(db, record.id);
        const cursor = failedRecord
          ? eventProvisioningRecoveryCursor(failedRecord)
          : undefined;
        if (failedRecord && cursor?.nextRunAt) {
          provisioningRecoveryAction = eventProvisioningRecoveryAction(failedRecord, {
            ...cursor,
            nextRunAt: cursor.nextRunAt
          });
          appendEventLog(db, {
            eventId: record.id,
            action: 'events.provisioning.recovery_scheduled',
            metadata: {
              generation: preCreateClaim?.generation,
              attempt: recoveryAttempt,
              runAt: recoveryRunAt.toISOString(),
              stage,
              checkpointKind: 'no_child',
              providerHealthDeferral
            }
          });
        }
      } else if (
        checkpointPersisted &&
        error.retryableWithoutCheckpoint &&
        (!retryWithinCleanup || !retryAttemptsRemain)
      ) {
        const failedRecord = getEvent(db, record.id);
        if (failedRecord) {
          await notifyEventCreatorPreCreateTerminal(
            context,
            failedRecord,
            retryWithinCleanup ? 'attempts_exhausted' : 'cleanup_expired'
          );
        }
      }
    } else if (isManagedCommunitySubgroupProvisioningError(error)) {
      const { created, provisioning, stage } = error;
      const retryableDisposition = error.recoveryDisposition === 'verify_only' ||
        error.recoveryDisposition === 'creator_membership_verify_only' ||
        error.recoveryDisposition === 'mutation_allowed';
      const operatorRequired = !retryableDisposition;
      failedSubgroupChatId = created.chatId;
      const nextAttempt = (preCreateClaim?.attempt ?? 0) + 1;
      const recoveryRunAt = eventCommunityLinkRecoveryRunAt(
        error.recoveryDisposition,
        new Date(failedAt),
        nextAttempt
      );
      const progress = {
        standaloneRegistered: provisioning.standaloneRegistered,
        attendeesReconciled: provisioning.attendeesReconciled,
        communityLinkConfirmed: provisioning.communityLinkConfirmed,
        linkedChildRegistered: provisioning.linkedChildRegistered
      };
      const latest = getEvent(db, record.id);
      let checkpointPersisted = false;
      if (
        preCreateClaim &&
        latest?.eventStatus === 'active' &&
        latest.groupLifecycleStatus === 'poll_open' &&
        !latest.subgroupChatId
      ) {
        checkpointPersisted = checkpointClaimedEventProvisioningChild(db, {
          eventId: record.id,
          scopeId: record.scopeId,
          generation: preCreateClaim.generation,
          expectedAttempt: preCreateClaim.attempt,
          nextAttempt: operatorRequired ? preCreateClaim.attempt : nextAttempt,
          ...(operatorRequired
            ? { haltedAt: failedAt }
            : { nextRunAt: recoveryRunAt.toISOString() }),
          subgroupChatId: created.chatId,
          subgroupTitle: created.title,
          participants: created.participants,
          creator: created.requiredCreator,
          checkpointedAt: failedAt,
          reason
        });
      } else if (
        preCreateClaim &&
        latest?.subgroupChatId === created.chatId &&
        latest.eventStatus === 'active' &&
        latest.groupLifecycleStatus === 'poll_open'
      ) {
        checkpointPersisted = failClaimedBoundPlannedEventProvisioningChild(db, {
          eventId: record.id,
          scopeId: record.scopeId,
          subgroupChatId: created.chatId,
          subgroupTitle: created.title,
          participants: created.participants,
          creator: created.requiredCreator,
          generation: preCreateClaim.generation,
          expectedAttempt: preCreateClaim.attempt,
          nextAttempt: operatorRequired ? preCreateClaim.attempt : nextAttempt,
          ...(operatorRequired
            ? { haltedAt: failedAt }
            : { nextRunAt: recoveryRunAt.toISOString() }),
          reason,
          failedAt
        });
      } else if (
        preCreateClaim &&
        latest?.subgroupChatId === created.chatId &&
        latest.eventStatus === 'failed' &&
        latest.groupLifecycleStatus === 'poll_closed'
      ) {
        const outcomesCheckpointed = checkpointClaimedEventParticipantOutcomes(db, {
          eventId: record.id,
          scopeId: record.scopeId,
          subgroupChatId: created.chatId,
          subgroupTitle: created.title,
          participants: created.participants,
          creator: created.requiredCreator,
          recoveryGeneration: preCreateClaim.generation,
          recoveryAttempt: preCreateClaim.attempt,
          checkpointedAt: failedAt,
          reason
        });
        checkpointPersisted = outcomesCheckpointed && (operatorRequired
          ? haltClaimedKnownChildEventProvisioning(db, {
              eventId: record.id,
              scopeId: record.scopeId,
              subgroupChatId: created.chatId,
              generation: preCreateClaim.generation,
              expectedAttempt: preCreateClaim.attempt,
              reason,
              haltedAt: failedAt
            })
          : advanceEventProvisioningRecovery(db, {
              eventId: record.id,
              scopeId: record.scopeId,
              subgroupChatId: created.chatId,
              generation: preCreateClaim.generation,
              expectedAttempt: preCreateClaim.attempt,
              expectedNextRunAt: null,
              nextAttempt,
              nextRunAt: recoveryRunAt.toISOString(),
              updatedAt: failedAt
            }));
      }
      if (checkpointPersisted) {
        const checkpointedEvent = getEvent(db, record.id);
        if (checkpointedEvent?.subgroupChatId === created.chatId) {
          await enqueuePluginJob(context.queue, {
            pluginId: EVENTS_PLUGIN_ID,
            ...eventCleanupJobRequest(checkpointedEvent)
          });
        }
      }
      failurePersisted = checkpointPersisted;
      failureMetadata = {
        reason,
        subgroupChatId: created.chatId,
        subgroupTitle: created.title,
        parentCommunityWid: provisioning.parentCommunityWid,
        stage,
        progress,
        participants: created.participants,
        recoveryDisposition: error.recoveryDisposition,
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
          if (!operatorRequired && cursor?.nextRunAt) {
            provisioningRecoveryAction = eventProvisioningRecoveryAction(failedRecord, {
              ...cursor,
              nextRunAt: cursor.nextRunAt
            });
          }
          appendEventLog(db, {
            eventId: record.id,
            action: operatorRequired
              ? 'events.provisioning.operator_required'
              : 'events.provisioning.recovery_scheduled',
            metadata: {
              subgroupChatId: created.chatId,
              generation: preCreateClaim?.generation,
              attempt: operatorRequired ? preCreateClaim?.attempt : nextAttempt,
              ...(!operatorRequired
                ? { runAt: recoveryRunAt.toISOString() }
                : {}),
              recoveryDisposition: error.recoveryDisposition,
              stage
            }
          });
        }
      }
    } else {
      if (preCreateClaim) {
        const latest = getEvent(db, record.id);
        const latestCursor = latest ? eventProvisioningRecoveryCursor(latest) : undefined;
        if (
          latest?.subgroupChatId &&
          latest.eventStatus === 'active' &&
          latest.groupLifecycleStatus === 'poll_open' &&
          latestCursor &&
          !latestCursor.nextRunAt &&
          latestCursor.generation === preCreateClaim.generation &&
          latestCursor.attempt === preCreateClaim.attempt
        ) {
          failedSubgroupChatId = latest.subgroupChatId;
          const requiredCreator = getEventRequiredCreatorReference(
            db,
            latest.id,
            requireHookEventActorIdentityId(latest)
          );
          failurePersisted = failClaimedBoundPlannedEventProvisioningChild(db, {
            eventId: latest.id,
            scopeId: latest.scopeId,
            subgroupChatId: latest.subgroupChatId,
            subgroupTitle: latest.subgroupTitle ?? latest.groupTitle,
            participants: storedParticipantOutcomes(db, latest.id),
            ...(requiredCreator ? { creator: requiredCreator } : {}),
            generation: preCreateClaim.generation,
            expectedAttempt: preCreateClaim.attempt,
            nextAttempt: preCreateClaim.attempt,
            haltedAt: failedAt,
            reason,
            failedAt
          });
          if (failurePersisted) {
            const failedRecord = getEvent(db, latest.id);
            if (failedRecord?.subgroupChatId === latest.subgroupChatId) {
              cleanupDeadlineAction = closeCleanupAction(failedRecord);
            }
          }
        } else if (
          latest?.subgroupChatId &&
          latest.eventStatus === 'failed' &&
          ['none', 'poll_closed'].includes(latest.groupLifecycleStatus) &&
          latestCursor &&
          !latestCursor.nextRunAt &&
          latestCursor.generation === preCreateClaim.generation &&
          latestCursor.attempt === preCreateClaim.attempt
        ) {
          failedSubgroupChatId = latest.subgroupChatId;
          failurePersisted = haltClaimedKnownChildEventProvisioning(db, {
            eventId: latest.id,
            scopeId: latest.scopeId,
            subgroupChatId: latest.subgroupChatId,
            generation: preCreateClaim.generation,
            expectedAttempt: preCreateClaim.attempt,
            reason,
            haltedAt: failedAt
          });
        } else if (latest?.subgroupChatId && latestCursor?.nextRunAt) {
          failedSubgroupChatId = latest.subgroupChatId;
          provisioningRecoveryAction = eventProvisioningRecoveryAction(latest, {
            ...latestCursor,
            nextRunAt: latestCursor.nextRunAt
          });
        } else {
          failurePersisted = haltClaimedEventPreCreateProvisioning(db, {
            eventId: record.id,
            scopeId: record.scopeId,
            generation: preCreateClaim.generation,
            expectedAttempt: preCreateClaim.attempt,
            reason,
            haltedAt: failedAt
          });
        }
        failureMetadata = {
          reason,
          claimGeneration: preCreateClaim.generation,
          claimAttempt: preCreateClaim.attempt,
          ambiguousPreCreateOutcome: !latest?.subgroupChatId,
          ...(latest?.subgroupChatId
            ? { subgroupChatId: latest.subgroupChatId, automaticRetryHalted: true }
            : {})
        };
      } else {
        const current = getEvent(db, record.id);
        failurePersisted = Boolean(
          current &&
          current.eventStatus === 'active' &&
          current.groupLifecycleStatus === 'poll_open' &&
          current.pollGeneration === closingPollGeneration &&
          current.pollWaMsgId === closingPollWaMsgId
        ) && markUnclaimedEventFailed(db, {
          eventId: current!.id,
          scopeId: current!.scopeId,
          expectedUpdatedAt: current!.updatedAt,
          expectedPollGeneration: closingPollGeneration,
          expectedPollWaMsgId: closingPollWaMsgId,
          reason,
          failedAt
        });
      }
    }
    if (!failurePersisted) {
      return [audit('events.close.failure_stale', {
        eventId: record.id,
        reason: 'event state changed or subgroup creation is already claimed'
      })];
    }
    await notifyCreatorAboutMembershipPause(context, db, record.id, error);
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
    const failedEvent = getEvent(db, record.id);
    const receiptReleaseRetries = failedEvent
      ? await releaseEligibleEventPollReplacementReceipts({
          context,
          db,
          eventId: failedEvent.id,
          now: new Date(failedAt)
        })
      : [];
    return [
      ...(cleanupDeadlineAction ? [cleanupDeadlineAction] : []),
      ...(provisioningRecoveryAction ? [provisioningRecoveryAction] : []),
      ...receiptReleaseRetries.map((retry) =>
        eventPollReceiptReleaseRetryAction(failedEvent, retry)
      ),
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
  const runtime: Pick<
    OfficialPluginCommandRuntime,
    'config' | 'databases' | 'enqueuePluginJob' | 'services'
  > = {
    config: context.config,
    ...(context.databases ? { databases: context.databases } : {}),
    ...(context.services ? { services: context.services } : {}),
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
      notifyRecoveryCreator: true,
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
      ...(payload.subgroupChatId ? { subgroupChatId: payload.subgroupChatId } : {}),
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
  const recoveryTargetMatches = payload.subgroupChatId
    ? record.subgroupChatId === payload.subgroupChatId
    : !record.subgroupChatId;
  if (!recoveryTargetMatches) {
    return [audit('events.provisioning.recovery_rejected', {
      eventId: record.id,
      ...(payload.subgroupChatId ? { subgroupChatId: payload.subgroupChatId } : {}),
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
      ...(payload.subgroupChatId ? { subgroupChatId: payload.subgroupChatId } : {}),
      generation: payload.generation,
      attempt: payload.attempt,
      reason: 'stale provisioning recovery cursor'
    })];
  }
  const claimedAt = job.receivedAt;
  if (payload.subgroupChatId) {
    const cleanupTransfer = transferKnownChildProvisioningToCleanup(db, record, claimedAt);
    if (cleanupTransfer.status === 'expired') {
      await enqueuePluginJob(context.queue, {
        pluginId: EVENTS_PLUGIN_ID,
        ...eventCleanupJobRequest(cleanupTransfer.event)
      });
      return [audit('events.provisioning.cleanup_deadline_reached', {
        eventId: record.id,
        subgroupChatId: payload.subgroupChatId,
        generation: payload.generation,
        attempt: payload.attempt,
        cleanupAt: record.cleanupAt
      })];
    }
    if (cleanupTransfer.status === 'deferred') {
      await enqueuePluginJob(context.queue, {
        pluginId: EVENTS_PLUGIN_ID,
        jobName: EVENTS_JOBS.cleanup,
        scopeId: record.scopeId,
        runAt: cleanupTransfer.runAt,
        payload: { eventId: record.id, attempt: 0 },
        dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:provisioning-lease:${cleanupTransfer.runAt.toISOString()}`
      });
      return [audit('events.provisioning.cleanup_waiting_for_claim', {
        eventId: record.id,
        subgroupChatId: payload.subgroupChatId,
        generation: payload.generation,
        attempt: payload.attempt,
        runAt: cleanupTransfer.runAt.toISOString()
      })];
    }
    if (cleanupTransfer.status === 'changed') {
      return [audit('events.provisioning.recovery_skipped', {
        eventId: record.id,
        subgroupChatId: payload.subgroupChatId,
        generation: payload.generation,
        attempt: payload.attempt,
        reason: 'event changed while transferring expired provisioning to cleanup'
      })];
    }
    const claimed = claimScheduledKnownChildEventProvisioningAttempt(db, {
      eventId: record.id,
      scopeId: record.scopeId,
      subgroupChatId: payload.subgroupChatId,
      generation: payload.generation,
      attempt: payload.attempt,
      expectedNextRunAt: cursor.nextRunAt,
      claimedAt: claimedAt.toISOString()
    });
    if (!claimed) {
      return [audit('events.provisioning.recovery_skipped', {
        eventId: record.id,
        subgroupChatId: payload.subgroupChatId,
        generation: payload.generation,
        attempt: payload.attempt,
        reason: 'known-child recovery attempt is already claimed or stale'
      })];
    }
    appendEventLog(db, {
      eventId: record.id,
      action: 'events.provisioning.known_child_claimed',
      metadata: {
        subgroupChatId: payload.subgroupChatId,
        generation: payload.generation,
        attempt: payload.attempt,
        claimedAt: claimedAt.toISOString(),
        source: 'recovery'
      }
    });
  } else {
    if (!eventPreCreateEligibleBeforeCleanup(record, claimedAt)) {
      const missed = markScheduledEventPreCreateProvisioningMissed(db, {
        eventId: record.id,
        scopeId: record.scopeId,
        generation: payload.generation,
        expectedAttempt: payload.attempt,
        expectedNextRunAt: cursor.nextRunAt,
        expectedCleanupAt: record.cleanupAt,
        reason: 'Event subgroup creation retries reached the cleanup deadline.',
        missedAt: claimedAt.toISOString()
      });
      const failedEvent = missed ? getEvent(db, record.id) : undefined;
      if (failedEvent) {
        await notifyEventCreatorPreCreateTerminal(context, failedEvent, 'cleanup_expired');
      }
      const receiptReleaseRetries = failedEvent
        ? await releaseEligibleEventPollReplacementReceipts({
            context,
            db,
            eventId: failedEvent.id,
            now: claimedAt
          })
        : [];
      return [
        ...receiptReleaseRetries.map((retry) =>
          eventPollReceiptReleaseRetryAction(failedEvent, retry)
        ),
        audit('events.provisioning.precreate_missed', {
        eventId: record.id,
        generation: payload.generation,
        attempt: payload.attempt,
        cleanupAt: record.cleanupAt
      })];
    }
    const claimed = claimScheduledEventPreCreateProvisioningAttempt(db, {
      eventId: record.id,
      scopeId: record.scopeId,
      generation: payload.generation,
      attempt: payload.attempt,
      expectedNextRunAt: cursor.nextRunAt,
      claimedAt: claimedAt.toISOString()
    });
    if (!claimed) {
      return [audit('events.provisioning.precreate_skipped', {
        eventId: record.id,
        generation: payload.generation,
        attempt: payload.attempt,
        reason: 'pre-create attempt is already claimed or stale'
      })];
    }
    if (payload.attempt > EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS) {
      const reason = `Event subgroup creation exceeded the maximum of ${EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS} deterministic attempts.`;
      const halted = haltClaimedEventPreCreateProvisioning(db, {
        eventId: record.id,
        scopeId: record.scopeId,
        generation: payload.generation,
        expectedAttempt: payload.attempt,
        reason,
        haltedAt: claimedAt.toISOString()
      });
      if (halted) {
        appendEventLog(db, {
          eventId: record.id,
          action: 'events.provisioning.precreate_retry_limit_reached',
          metadata: {
            generation: payload.generation,
            attempt: payload.attempt,
            maxAttempts: EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS,
            source: 'recovery_job'
          }
        });
        const failedEvent = getEvent(db, record.id);
        if (failedEvent) {
          await notifyEventCreatorPreCreateTerminal(context, failedEvent, 'attempts_exhausted');
        }
      }
      return [audit(halted
        ? 'events.provisioning.precreate_retry_limit_reached'
        : 'events.provisioning.precreate_skipped', {
        eventId: record.id,
        generation: payload.generation,
        attempt: payload.attempt,
        maxAttempts: EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS,
        reason: halted ? reason : 'event state changed while enforcing the retry limit'
      })];
    }
    appendEventLog(db, {
      eventId: record.id,
      action: 'events.provisioning.precreate_claimed',
      metadata: {
        generation: payload.generation,
        attempt: payload.attempt,
        claimedAt: claimedAt.toISOString(),
        source: 'recovery'
      }
    });
  }

  try {
    const result = payload.subgroupChatId
      ? await resumeEventProvisioning({
          context,
          scopeId: record.scopeId,
          eventId: record.id,
          subgroupChatId: payload.subgroupChatId,
          ...(record.subgroupTitle ? { subgroupTitle: record.subgroupTitle } : {}),
          actorWid: 'plugin-recovery@system',
          actorLabel: 'Plugin provisioning recovery',
          claimAlreadyHeld: true
        })
      : await retryEventProvisioningCreation({
          context,
          scopeId: record.scopeId,
          eventId: record.id,
          actorWid: 'plugin-recovery@system',
          actorLabel: 'Plugin provisioning recovery'
        });
    if (result.status === 'rejected' || result.status === 'not_found') {
      const failedAt = new Date();
      let retry: Awaited<ReturnType<typeof enqueueAndRearmClaimedEventProvisioningRecoveryCursor>> = undefined;
      if (payload.subgroupChatId) {
        const halted = haltClaimedKnownChildEventProvisioning(db, {
          eventId: record.id,
          scopeId: record.scopeId,
          subgroupChatId: payload.subgroupChatId,
          generation: payload.generation,
          expectedAttempt: payload.attempt,
          reason: result.reason,
          haltedAt: failedAt.toISOString()
        });
        if (halted) {
          appendEventLog(db, {
            eventId: record.id,
            action: 'events.provisioning.operator_required',
            metadata: {
              subgroupChatId: payload.subgroupChatId,
              generation: payload.generation,
              attempt: payload.attempt,
              recoveryDisposition: 'operator_required',
              reason: result.reason
            }
          });
        }
      }
      if (!payload.subgroupChatId) {
        const latest = getEvent(db, record.id);
        const latestCursor = latest ? eventProvisioningRecoveryCursor(latest) : undefined;
        if (
          latest?.subgroupChatId &&
          latestCursor?.nextRunAt &&
          latestCursor.generation === payload.generation &&
          latestCursor.attempt === payload.attempt + 1
        ) {
          const runAt = await enqueuePersistedEventProvisioningRecovery(
            context,
            latest,
            { ...latestCursor, nextRunAt: latestCursor.nextRunAt }
          );
          retry = {
            record: latest,
            cursor: { ...latestCursor, nextRunAt: latestCursor.nextRunAt },
            runAt
          };
        } else if (
          latest?.subgroupChatId &&
          latest.eventStatus === 'failed' &&
          ['none', 'poll_closed'].includes(latest.groupLifecycleStatus) &&
          latestCursor &&
          !latestCursor.nextRunAt &&
          latestCursor.generation === payload.generation &&
          latestCursor.attempt === payload.attempt
        ) {
          const halted = haltClaimedKnownChildEventProvisioning(db, {
            eventId: latest.id,
            scopeId: latest.scopeId,
            subgroupChatId: latest.subgroupChatId,
            generation: payload.generation,
            expectedAttempt: payload.attempt,
            reason: result.reason,
            haltedAt: failedAt.toISOString()
          });
          if (halted) {
            appendEventLog(db, {
              eventId: latest.id,
              action: 'events.provisioning.operator_required',
              metadata: {
                subgroupChatId: latest.subgroupChatId,
                generation: payload.generation,
                attempt: payload.attempt,
                recoveryDisposition: 'operator_required',
                reason: result.reason
              }
            });
          }
        } else {
          haltClaimedEventPreCreateProvisioning(db, {
            eventId: record.id,
            scopeId: record.scopeId,
            generation: payload.generation,
            expectedAttempt: payload.attempt,
            reason: result.reason,
            haltedAt: failedAt.toISOString()
          });
        }
      }
      appendEventLog(db, {
        eventId: record.id,
        action: retry
          ? 'events.provisioning.recovery_scheduled'
          : 'events.provisioning.recovery_rejected',
        metadata: {
          ...(payload.subgroupChatId ? { subgroupChatId: payload.subgroupChatId } : {}),
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
            ...(payload.subgroupChatId ? { subgroupChatId: payload.subgroupChatId } : {}),
            generation: payload.generation,
            failedAttempt: payload.attempt,
            attempt: retry.cursor.attempt,
            runAt: retry.runAt.toISOString(),
            reason: result.reason
          })
        ];
      }
      if (payload.subgroupChatId) {
        return [audit('events.provisioning.recovery_failed', {
          eventId: record.id,
          subgroupChatId: payload.subgroupChatId,
          generation: payload.generation,
          attempt: payload.attempt,
          reason: result.reason,
          recoveryDisposition: 'operator_required',
          automaticRetryHalted: true,
          retryable: false
        })];
      }
    }
    return [audit(
      result.status === 'completed'
        ? 'events.provisioning.recovery_completed'
        : result.status === 'already_completed'
          ? 'events.provisioning.recovery_already_completed'
          : 'events.provisioning.recovery_rejected',
      {
        eventId: record.id,
        ...(payload.subgroupChatId ? { subgroupChatId: payload.subgroupChatId } : {}),
        generation: payload.generation,
        attempt: payload.attempt,
        status: result.status,
        ...('reason' in result ? { reason: result.reason } : {})
      }
    )];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failedAt = new Date();
    const preCreateError = isManagedCommunitySubgroupPreCreateError(error)
      ? error
      : undefined;
    const postCreateError = isManagedCommunitySubgroupProvisioningError(error)
      ? error
      : undefined;
    const retryableLinkDisposition = postCreateError?.recoveryDisposition === 'verify_only' ||
      postCreateError?.recoveryDisposition === 'creator_membership_verify_only' ||
      postCreateError?.recoveryDisposition === 'mutation_allowed';
    let operatorRequired = Boolean(payload.subgroupChatId) && !retryableLinkDisposition;
    let recoverySubgroupChatId = payload.subgroupChatId;
    let retry: Awaited<ReturnType<typeof enqueueAndRearmClaimedEventProvisioningRecoveryCursor>> = undefined;
    let preCreateRetryLimitReached = false;
    if (payload.subgroupChatId) {
      if (operatorRequired) {
        const halted = haltClaimedKnownChildEventProvisioning(db, {
          eventId: record.id,
          scopeId: record.scopeId,
          subgroupChatId: payload.subgroupChatId,
          generation: payload.generation,
          expectedAttempt: payload.attempt,
          reason,
          haltedAt: failedAt.toISOString()
        });
        if (halted) {
          appendEventLog(db, {
            eventId: record.id,
            action: 'events.provisioning.operator_required',
            metadata: {
              subgroupChatId: payload.subgroupChatId,
              generation: payload.generation,
              attempt: payload.attempt,
              ...(postCreateError?.stage ? { stage: postCreateError.stage } : {}),
              recoveryDisposition: postCreateError?.recoveryDisposition ?? 'operator_required',
              reason
            }
          });
        }
      } else {
        retry = await enqueueAndRearmClaimedEventProvisioningRecoveryCursor(
          context,
          db,
          record,
          payload,
          failedAt,
          postCreateError?.recoveryDisposition
        );
      }
    } else {
      const latestAfterAttempt = getEvent(db, record.id);
      const checkpointedCursor = latestAfterAttempt
        ? eventProvisioningRecoveryCursor(latestAfterAttempt)
        : undefined;
      const exactCheckpointedChild = Boolean(
        latestAfterAttempt?.subgroupChatId &&
        latestAfterAttempt.eventStatus === 'failed' &&
        ['none', 'poll_closed'].includes(latestAfterAttempt.groupLifecycleStatus) &&
        checkpointedCursor &&
        checkpointedCursor.generation === payload.generation
      );
      if (
        exactCheckpointedChild &&
        checkpointedCursor?.nextRunAt &&
        checkpointedCursor.attempt === payload.attempt + 1
      ) {
        recoverySubgroupChatId = latestAfterAttempt!.subgroupChatId!;
        const runAt = await enqueuePersistedEventProvisioningRecovery(
          context,
          latestAfterAttempt!,
          { ...checkpointedCursor, nextRunAt: checkpointedCursor.nextRunAt }
        );
        retry = {
          record: latestAfterAttempt!,
          cursor: { ...checkpointedCursor, nextRunAt: checkpointedCursor.nextRunAt },
          runAt
        };
      } else if (
        exactCheckpointedChild &&
        !checkpointedCursor?.nextRunAt &&
        checkpointedCursor?.attempt === payload.attempt
      ) {
        const subgroupChatId = latestAfterAttempt!.subgroupChatId!;
        recoverySubgroupChatId = subgroupChatId;
        const sameCreatedChild = postCreateError?.created.chatId.trim().toLowerCase() ===
          subgroupChatId.trim().toLowerCase();
        if (retryableLinkDisposition && sameCreatedChild) {
          retry = await enqueueAndRearmClaimedEventProvisioningRecoveryCursor(
            context,
            db,
            latestAfterAttempt!,
            { ...payload, subgroupChatId },
            failedAt,
            postCreateError.recoveryDisposition
          );
        } else {
          operatorRequired = true;
          const halted = haltClaimedKnownChildEventProvisioning(db, {
            eventId: latestAfterAttempt!.id,
            scopeId: latestAfterAttempt!.scopeId,
            subgroupChatId,
            generation: payload.generation,
            expectedAttempt: payload.attempt,
            reason,
            haltedAt: failedAt.toISOString()
          });
          if (halted) {
            appendEventLog(db, {
              eventId: latestAfterAttempt!.id,
              action: 'events.provisioning.operator_required',
              metadata: {
                subgroupChatId,
                generation: payload.generation,
                attempt: payload.attempt,
                ...(postCreateError?.stage ? { stage: postCreateError.stage } : {}),
                recoveryDisposition: postCreateError?.recoveryDisposition ?? 'operator_required',
                reason
              }
            });
          }
        }
      } else if (preCreateError?.retryableWithoutCheckpoint) {
        const nextAttempt = payload.attempt + 1;
        const providerHealthDeferral = isBaileysEventPreCreateProviderUnavailableFailure(preCreateError);
        const recoveryAttempt = providerHealthDeferral ? payload.attempt : nextAttempt;
        const runAt = providerHealthDeferral
          ? eventProvisioningProviderHealthRunAt(failedAt)
          : eventProvisioningRecoveryRunAt(nextAttempt, failedAt);
        const retryWithinCleanup = eventPreCreateEligibleBeforeCleanup(record, runAt);
        preCreateRetryLimitReached = !providerHealthDeferral &&
          nextAttempt > EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS;
        if (retryWithinCleanup && !preCreateRetryLimitReached) {
          const rearmed = rearmClaimedEventPreCreateProvisioningAttempt(db, {
            eventId: record.id,
            scopeId: record.scopeId,
            generation: payload.generation,
            expectedAttempt: payload.attempt,
            nextAttempt: recoveryAttempt,
            nextRunAt: runAt.toISOString(),
            reason,
            rearmedAt: failedAt.toISOString()
          });
          const rearmedRecord = rearmed ? getEvent(db, record.id) : undefined;
          const rearmedCursor = rearmedRecord
            ? eventProvisioningRecoveryCursor(rearmedRecord)
            : undefined;
          if (rearmedRecord && rearmedCursor?.nextRunAt) {
            await enqueuePersistedEventProvisioningRecovery(
              context,
              rearmedRecord,
              { ...rearmedCursor, nextRunAt: rearmedCursor.nextRunAt }
            );
            retry = {
              record: rearmedRecord,
              cursor: { ...rearmedCursor, nextRunAt: rearmedCursor.nextRunAt },
              runAt
            };
          }
        } else if (!retryWithinCleanup) {
          const missed = markClaimedEventPreCreateProvisioningMissed(db, {
            eventId: record.id,
            scopeId: record.scopeId,
            generation: payload.generation,
            expectedAttempt: payload.attempt,
            expectedCleanupAt: record.cleanupAt,
            reason: 'Event subgroup creation retries reached the cleanup deadline.',
            missedAt: failedAt.toISOString()
          });
          const failedRecord = missed ? getEvent(db, record.id) : undefined;
          if (failedRecord) {
            await notifyEventCreatorPreCreateTerminal(context, failedRecord, 'cleanup_expired');
          }
        } else {
          const halted = haltClaimedEventPreCreateProvisioning(db, {
            eventId: record.id,
            scopeId: record.scopeId,
            generation: payload.generation,
            expectedAttempt: payload.attempt,
            reason: `Event subgroup creation reached the maximum of ${EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS} deterministic attempts: ${reason}`,
            haltedAt: failedAt.toISOString()
          });
          const failedRecord = halted ? getEvent(db, record.id) : undefined;
          if (failedRecord) {
            await notifyEventCreatorPreCreateTerminal(context, failedRecord, 'attempts_exhausted');
          }
        }
      } else {
        haltClaimedEventPreCreateProvisioning(db, {
          eventId: record.id,
          scopeId: record.scopeId,
          generation: payload.generation,
          expectedAttempt: payload.attempt,
          reason,
          haltedAt: failedAt.toISOString()
        });
      }
    }
    await notifyCreatorAboutMembershipPause(context, db, record.id, error);
    const receiptEvent = getEvent(db, record.id);
    const receiptReleaseRetries = receiptEvent
      ? await releaseEligibleEventPollReplacementReceipts({
          context,
          db,
          eventId: receiptEvent.id,
          now: failedAt
        })
      : [];
    const receiptReleaseActions = receiptReleaseRetries.map((receiptRetry) =>
      eventPollReceiptReleaseRetryAction(receiptEvent, receiptRetry)
    );
    if (retry) {
      const stage = postCreateError?.stage ?? preCreateError?.stage;
      appendEventLog(db, {
        eventId: record.id,
        action: 'events.provisioning.recovery_scheduled',
        metadata: {
          ...(retry.record.subgroupChatId
            ? { subgroupChatId: retry.record.subgroupChatId }
            : {}),
          generation: payload.generation,
          failedAttempt: payload.attempt,
          attempt: retry.cursor.attempt,
          runAt: retry.runAt.toISOString(),
          reason,
          ...(stage ? { stage } : {}),
          ...(postCreateError?.recoveryDisposition
            ? { recoveryDisposition: postCreateError.recoveryDisposition }
            : {})
        }
      });
      return [
        ...receiptReleaseActions,
        audit('events.provisioning.recovery_retry_scheduled', {
          eventId: record.id,
          ...(retry.record.subgroupChatId
            ? { subgroupChatId: retry.record.subgroupChatId }
            : {}),
          generation: payload.generation,
          failedAttempt: payload.attempt,
          attempt: retry.cursor.attempt,
          runAt: retry.runAt.toISOString(),
          reason,
          ...(stage ? { stage } : {}),
          ...(postCreateError?.recoveryDisposition
            ? { recoveryDisposition: postCreateError.recoveryDisposition }
            : {})
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
      return [...receiptReleaseActions, audit('events.provisioning.recovery_finalization_forwarded', {
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
        ...(recoverySubgroupChatId ? { subgroupChatId: recoverySubgroupChatId } : {}),
        generation: payload.generation,
        attempt: payload.attempt,
        reason,
        retryable: !operatorRequired && (
          Boolean(payload.subgroupChatId) ||
          (preCreateError?.retryableWithoutCheckpoint === true && !preCreateRetryLimitReached) ||
          Boolean(postCreateError)
        ),
        ...(preCreateRetryLimitReached ? {
          retryLimitReached: true,
          maxAttempts: EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS
        } : {}),
        ...(operatorRequired ? {
          recoveryDisposition: 'operator_required',
          automaticRetryHalted: true
        } : {})
      }
    });
    return [...receiptReleaseActions, audit('events.provisioning.recovery_failed', {
      eventId: record.id,
      ...(recoverySubgroupChatId ? { subgroupChatId: recoverySubgroupChatId } : {}),
      generation: payload.generation,
      attempt: payload.attempt,
      reason,
      ...(operatorRequired ? {
        recoveryDisposition: 'operator_required',
        automaticRetryHalted: true,
        retryable: false
      } : {})
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

async function enqueueAndRearmClaimedEventProvisioningRecoveryCursor(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  record: StoredEventRecord,
  payload: EventProvisioningRecoveryPayload,
  now: Date,
  recoveryDisposition?: ManagedCommunitySubgroupProvisioningError['recoveryDisposition']
): Promise<{
  record: StoredEventRecord;
  cursor: EventProvisioningRecoveryCursor & { nextRunAt: string };
  runAt: Date;
} | undefined> {
  const latest = getEvent(db, record.id) ?? record;
  const retrySubgroupChatId = payload.subgroupChatId;
  if (
    latest.eventStatus !== 'failed' ||
    !['none', 'poll_closed'].includes(latest.groupLifecycleStatus) ||
    (retrySubgroupChatId
      ? latest.subgroupChatId !== retrySubgroupChatId
      : Boolean(latest.subgroupChatId))
  ) {
    return undefined;
  }
  const currentCursor = eventProvisioningRecoveryCursor(latest);
  if (
    !currentCursor ||
    currentCursor.nextRunAt ||
    currentCursor.generation !== payload.generation ||
    currentCursor.attempt !== payload.attempt
  ) {
    return undefined;
  }
  const nextAttempt = payload.attempt + 1;
  const runAt = eventCommunityLinkRecoveryRunAt(
    recoveryDisposition,
    now,
    nextAttempt
  );
  const nextCursor = {
    generation: payload.generation,
    attempt: nextAttempt,
    nextRunAt: runAt.toISOString()
  };
  const advanced = advanceEventProvisioningRecovery(db, {
    eventId: latest.id,
    scopeId: latest.scopeId,
    ...(retrySubgroupChatId ? { subgroupChatId: retrySubgroupChatId } : {}),
    generation: payload.generation,
    expectedAttempt: payload.attempt,
    expectedNextRunAt: null,
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
  await enqueuePluginJob(context.queue, {
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.provisioningRecovery,
    scopeId: advancedRecord.scopeId,
    ...(advancedRecord.groupId ? { groupId: advancedRecord.groupId } : {}),
    ...(advancedRecord.groupWid ? { groupWid: advancedRecord.groupWid } : {}),
    runAt,
    payload: {
      eventId: advancedRecord.id,
      ...(retrySubgroupChatId ? { subgroupChatId: retrySubgroupChatId } : {}),
      generation: payload.generation,
      attempt: nextAttempt
    } satisfies EventProvisioningRecoveryPayload,
    dedupeKey: eventProvisioningRecoveryDedupeKey(advancedRecord, nextCursor)
  });
  return {
    record: advancedRecord,
    cursor: {
      ...advancedCursor,
      nextRunAt: advancedCursor.nextRunAt
    },
    runAt
  };
}

async function enqueuePersistedEventProvisioningRecovery(
  context: PluginRuntimeContext,
  record: StoredEventRecord,
  cursor: EventProvisioningRecoveryCursor & { nextRunAt: string }
): Promise<Date> {
  const runAt = new Date(cursor.nextRunAt);
  if (!Number.isFinite(runAt.getTime())) {
    throw new Error(`Event ${record.id} has an invalid persisted provisioning retry time.`);
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
      ...(record.subgroupChatId ? { subgroupChatId: record.subgroupChatId } : {}),
      generation: cursor.generation,
      attempt: cursor.attempt
    } satisfies EventProvisioningRecoveryPayload,
    dedupeKey: eventProvisioningRecoveryDedupeKey(record, cursor)
  });
  return runAt;
}

function eventProvisioningRecoveryPayload(payload: unknown): EventProvisioningRecoveryPayload | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const candidate = payload as Record<string, unknown>;
  const eventId = typeof candidate.eventId === 'string' ? candidate.eventId.trim() : '';
  const hasSubgroupChatId = Object.prototype.hasOwnProperty.call(candidate, 'subgroupChatId');
  const subgroupChatId = hasSubgroupChatId && typeof candidate.subgroupChatId === 'string'
    ? candidate.subgroupChatId.trim().toLowerCase()
    : undefined;
  const generation = typeof candidate.generation === 'string' ? candidate.generation.trim() : '';
  const attempt = candidate.attempt;
  if (
    !eventId ||
    (hasSubgroupChatId && !subgroupChatId?.endsWith('@g.us')) ||
    !generation ||
    !Number.isInteger(attempt) ||
    Number(attempt) < 1
  ) {
    return undefined;
  }
  return {
    eventId,
    ...(subgroupChatId ? { subgroupChatId } : {}),
    generation,
    attempt: Number(attempt)
  };
}

function eventPreCreateEligibleBeforeCleanup(record: StoredEventRecord, now: Date): boolean {
  const cleanupAt = new Date(record.cleanupAt);
  return Number.isFinite(now.getTime()) &&
    Number.isFinite(cleanupAt.getTime()) &&
    now.getTime() < cleanupAt.getTime();
}

const EVENT_PROVISIONING_CLEANUP_DEADLINE_REASON =
  'Event subgroup provisioning reached its cleanup deadline before the community link completed.';

type KnownChildCleanupTransfer =
  | { status: 'not_applicable' | 'not_due' | 'changed' }
  | { status: 'deferred'; runAt: Date }
  | { status: 'expired'; event: StoredEventRecord };

function transferKnownChildProvisioningToCleanup(
  db: ReturnType<typeof eventsDatabase>,
  record: StoredEventRecord,
  now: Date
): KnownChildCleanupTransfer {
  const cleanupAt = new Date(record.cleanupAt);
  if (!Number.isFinite(cleanupAt.getTime()) || cleanupAt.getTime() > now.getTime()) {
    return { status: 'not_due' };
  }
  const cursor = eventProvisioningRecoveryCursor(record);
  if (
    record.eventStatus !== 'failed' ||
    (record.groupLifecycleStatus !== 'none' && record.groupLifecycleStatus !== 'poll_closed') ||
    !record.subgroupChatId ||
    !cursor
  ) {
    return { status: 'not_applicable' };
  }
  if (!cursor.nextRunAt && !record.provisioningRecoveryHaltedAt) {
    const claimedAt = new Date(record.updatedAt);
    const runAt = Number.isFinite(claimedAt.getTime())
      ? new Date(claimedAt.getTime() + EVENT_CLEANUP_CLAIM_LEASE_MS)
      : now;
    if (runAt.getTime() > now.getTime()) {
      return { status: 'deferred', runAt };
    }
  }
  const expiredAt = now.toISOString();
  const expired = expireKnownChildEventProvisioningForCleanup(db, {
    eventId: record.id,
    scopeId: record.scopeId,
    subgroupChatId: record.subgroupChatId,
    expectedUpdatedAt: record.updatedAt,
    expectedCleanupAt: record.cleanupAt,
    generation: cursor.generation,
    attempt: cursor.attempt,
    expectedNextRunAt: cursor.nextRunAt ?? null,
    expectedHaltedAt: record.provisioningRecoveryHaltedAt ?? null,
    reason: EVENT_PROVISIONING_CLEANUP_DEADLINE_REASON,
    expiredAt
  });
  if (!expired) {
    return { status: 'changed' };
  }
  const event = getEvent(db, record.id);
  if (!event) {
    return { status: 'changed' };
  }
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.provisioning.cleanup_deadline_reached',
    metadata: {
      subgroupChatId: event.subgroupChatId,
      generation: cursor.generation,
      attempt: cursor.attempt,
      cleanupAt: event.cleanupAt
    }
  });
  return { status: 'expired', event };
}

function cleanupDeferAction(record: StoredEventRecord, runAt: Date, reason: string): PluginEnqueueJobAction {
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.cleanup,
    scopeId: record.scopeId,
    runAt,
    payload: { eventId: record.id, attempt: 0 },
    dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:${reason}:${runAt.toISOString()}`
  };
}

function externalDismantleRetryAt(
  db: ReturnType<typeof eventsDatabase>,
  record: StoredEventRecord,
  subgroupChatId: string,
  observedAt: Date
): Date | undefined {
  const eligible = (
    (record.eventStatus === 'active' || record.eventStatus === 'completed') &&
    (record.groupLifecycleStatus === 'poll_closed' || record.groupLifecycleStatus === 'cleanup_failed')
  ) || (
    record.eventStatus === 'failed' &&
    record.groupLifecycleStatus === 'cleanup_failed' &&
    Boolean(record.subgroupChatId)
  );
  if (!eligible || record.subgroupChatId?.toLowerCase() !== subgroupChatId.toLowerCase()) {
    return undefined;
  }
  const candidateTimes = [observedAt.getTime() + 1_000];
  const cleanupClaim = getEventCleanupClaim(db, record.id);
  const cleanupLeaseMs = cleanupClaim ? Date.parse(cleanupClaim.leaseExpiresAt) : Number.NaN;
  if (Number.isFinite(cleanupLeaseMs) && cleanupLeaseMs > observedAt.getTime()) {
    candidateTimes.push(cleanupLeaseMs + 1);
  }
  const sendingLease = getEventAnnouncementSendingLeaseExpiresAt(db, record.id);
  const sendingLeaseMs = sendingLease ? Date.parse(sendingLease) : Number.NaN;
  if (Number.isFinite(sendingLeaseMs) && sendingLeaseMs > observedAt.getTime()) {
    candidateTimes.push(sendingLeaseMs + 1);
  }
  const editRepairLease = getEventEditRepairExecutionLeaseExpiresAt(
    db,
    record.id,
    observedAt.toISOString()
  );
  const editRepairLeaseMs = editRepairLease ? Date.parse(editRepairLease) : Number.NaN;
  if (Number.isFinite(editRepairLeaseMs) && editRepairLeaseMs > observedAt.getTime()) {
    candidateTimes.push(editRepairLeaseMs + 1);
  }
  return new Date(Math.max(...candidateTimes));
}

function externalDismantleCleanupAction(
  record: StoredEventRecord,
  subgroupChatId: string,
  runAt: Date,
  attempt: number
): PluginEnqueueJobAction {
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.cleanup,
    scopeId: record.scopeId,
    ...(record.groupId ? { groupId: record.groupId } : {}),
    ...(record.groupWid ? { groupWid: record.groupWid } : {}),
    runAt,
    payload: {
      eventId: record.id,
      attempt,
      externalDismantledChatId: subgroupChatId
    },
    dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:external-dismantled:${record.updatedAt}:${runAt.toISOString()}`
  };
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
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.provisioningRecovery,
    scopeId: record.scopeId,
    runAt: new Date(cursor.nextRunAt),
    payload: {
      eventId: record.id,
      ...(subgroupChatId ? { subgroupChatId } : {}),
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
      calendarId: input.calendarId,
      ...(context.services ? { services: context.services } : {}),
      requestGeneration: false
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
  const request = eventCleanupJobRequest(record);
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    ...request
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
    if (!context.sendText) {
      throw new Error('Plugin runtime does not expose durable text delivery.');
    }
    const deliveryKey = 'initial';
    const delivery = await sendClaimedEventAnnouncement({
      db: eventsDatabase(context.databases),
      eventId: record.id,
      scopeId: record.scopeId,
      kind: 'event_group_hint',
      deliveryKey,
      chatId: record.announcementGroupWid,
      text,
      idempotencyKey: eventAnnouncementTransportIdempotencyKey({
        eventId: record.id,
        kind: 'event_group_hint',
        deliveryKey
      }),
      expectedEventUpdatedAt: record.updatedAt,
      sender: { sendText: context.sendText }
    });
    await appendJsonLog(context, {
      action: 'event.planned_announcement_sent',
      scopeId: record.scopeId,
      eventId: record.id,
      actorWid: record.actorWid,
      profileId: record.profileId,
      ...(record.pollWaMsgId ? { pollWaMsgId: record.pollWaMsgId } : {}),
      subgroupChatId,
      metadata: {
        announcementGroupWid: record.announcementGroupWid,
        groupJoinUrl,
        delivery: delivery.status
      }
    });
    return [];
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
    const delivery = getEventAnnouncementDeliveryClaim(
      eventsDatabase(context.databases),
      record.id,
      'event_group_hint',
      'initial'
    );
    return delivery && ['pending', 'sending', 'uncertain'].includes(delivery.status)
      ? eventAnnouncementDeliveryRetryActions(
          record,
          delivery,
          0,
          undefined,
          error instanceof Error ? error.message : String(error)
        )
      : [];
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
  const externalDismantledChatId = jobPayloadExternalDismantledChatId(job.payload);
  const externalDismantled = Boolean(externalDismantledChatId);
  if (!eventId) {
    return [audit('events.job.skipped', { jobName: job.jobName, reason: 'missing eventId' })];
  }
  let record = getEvent(db, eventId);
  if (!record || record.groupLifecycleStatus === 'cleaned') {
    return [audit('events.job.skipped', { jobName: job.jobName, eventId, reason: 'event missing or already cleaned' })];
  }
  const ordinaryCleanup = (record.eventStatus === 'active' || record.eventStatus === 'completed') &&
    (record.groupLifecycleStatus === 'poll_closed' || record.groupLifecycleStatus === 'cleanup_failed');
  const pausedKnownChild = record.eventStatus === 'failed' &&
    (record.groupLifecycleStatus === 'none' || record.groupLifecycleStatus === 'poll_closed') &&
    Boolean(record.subgroupChatId) &&
    Boolean(eventProvisioningRecoveryCursor(record));
  const expiredKnownChild = record.eventStatus === 'failed' &&
    record.groupLifecycleStatus === 'cleanup_failed' &&
    Boolean(record.subgroupChatId) &&
    !eventProvisioningRecoveryCursor(record) &&
    !record.provisioningRecoveryHaltedAt;
  if (!ordinaryCleanup && !pausedKnownChild && !expiredKnownChild) {
    return [audit('events.job.skipped', { jobName: job.jobName, eventId, reason: `event lifecycle is ${record.eventStatus}/${record.groupLifecycleStatus}` })];
  }
  if (externalDismantledChatId &&
      record.subgroupChatId?.toLowerCase() !== externalDismantledChatId.toLowerCase()) {
    return [audit('events.job.skipped', {
      jobName: job.jobName,
      eventId,
      reason: 'external dismantle subgroup no longer matches the event'
    })];
  }

  const cleanupAt = new Date(record.cleanupAt);
  const now = new Date();
  if (!externalDismantled && Number.isFinite(cleanupAt.getTime()) && cleanupAt.getTime() > now.getTime()) {
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

  if (pausedKnownChild) {
    let cleanupTransfer = transferKnownChildProvisioningToCleanup(db, record, now);
    if (cleanupTransfer.status === 'changed') {
      record = getEvent(db, eventId);
      if (!record || record.groupLifecycleStatus === 'cleaned') {
        return [audit('events.job.skipped', {
          jobName: job.jobName,
          eventId,
          reason: 'event changed while cleanup claimed expired provisioning'
        })];
      }
      cleanupTransfer = transferKnownChildProvisioningToCleanup(db, record, now);
    }
    if (cleanupTransfer.status === 'deferred') {
      return [audit('events.cleanup.provisioning_claim_active', {
        eventId: record.id,
        subgroupChatId: record.subgroupChatId,
        runAt: cleanupTransfer.runAt.toISOString()
      }), cleanupDeferAction(record, cleanupTransfer.runAt, 'provisioning-lease')];
    }
    if (cleanupTransfer.status === 'expired') {
      record = cleanupTransfer.event;
    } else if (cleanupTransfer.status !== 'not_applicable') {
      return [audit('events.job.skipped', {
        jobName: job.jobName,
        eventId,
        reason: `expired provisioning cleanup transfer ${cleanupTransfer.status}`
      })];
    }
  }

  const cleanupEligibleAfterTransfer = (
    (record.eventStatus === 'active' || record.eventStatus === 'completed') &&
    (record.groupLifecycleStatus === 'poll_closed' || record.groupLifecycleStatus === 'cleanup_failed')
  ) || (
    record.eventStatus === 'failed' &&
    record.groupLifecycleStatus === 'cleanup_failed' &&
    Boolean(record.subgroupChatId) &&
    !eventProvisioningRecoveryCursor(record) &&
    !record.provisioningRecoveryHaltedAt
  );
  if (!cleanupEligibleAfterTransfer) {
    return [audit('events.job.skipped', {
      jobName: job.jobName,
      eventId,
      reason: `event lifecycle changed to ${record.eventStatus}/${record.groupLifecycleStatus}`
    })];
  }

  const config = parseEventsConfig(await context.configFor(record.scopeId));
  const attempt = cleanupAttempt(job.payload);
  releaseExpiredEventCleanupClaims(db, now.toISOString());
  const claim = claimEventCleanup(db, {
    eventId: record.id,
    expectedUpdatedAt: record.updatedAt,
    expectedCleanupAt: record.cleanupAt,
    claimedAt: now.toISOString(),
    ...(externalDismantled ? { allowBeforeDeadline: true } : {})
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
        payload: {
          eventId: record.id,
          attempt,
          ...(externalDismantledChatId ? { externalDismantledChatId } : {})
        },
        dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:claim-expiry:${claimExpiresAt.toISOString()}`
      }];
    }
    const sendingLease = getEventAnnouncementSendingLeaseExpiresAt(db, record.id);
    const sendingLeaseAt = sendingLease ? new Date(sendingLease) : undefined;
    if (sendingLeaseAt && Number.isFinite(sendingLeaseAt.getTime()) && sendingLeaseAt > now) {
      const retryAt = new Date(sendingLeaseAt.getTime() + 1);
      return [audit('events.cleanup.delivery_claimed', {
        eventId,
        claimExpiresAt: sendingLeaseAt.toISOString()
      }), {
        type: 'plugin.enqueueJob',
        pluginId: EVENTS_PLUGIN_ID,
        jobName: EVENTS_JOBS.cleanup,
        scopeId: record.scopeId,
        ...(record.groupId ? { groupId: record.groupId } : {}),
        ...(record.groupWid ? { groupWid: record.groupWid } : {}),
        runAt: retryAt,
        payload: {
          eventId: record.id,
          attempt,
          ...(externalDismantledChatId ? { externalDismantledChatId } : {})
        },
        dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:delivery-expiry:${retryAt.toISOString()}`
      }];
    }
    const editRepairLease = getEventEditRepairExecutionLeaseExpiresAt(
      db,
      record.id,
      now.toISOString()
    );
    const editRepairLeaseAt = editRepairLease ? new Date(editRepairLease) : undefined;
    if (editRepairLeaseAt && Number.isFinite(editRepairLeaseAt.getTime()) && editRepairLeaseAt > now) {
      const retryAt = new Date(editRepairLeaseAt.getTime() + 1);
      return [audit('events.cleanup.edit_repair_claimed', {
        eventId,
        claimExpiresAt: editRepairLeaseAt.toISOString()
      }), {
        type: 'plugin.enqueueJob',
        pluginId: EVENTS_PLUGIN_ID,
        jobName: EVENTS_JOBS.cleanup,
        scopeId: record.scopeId,
        ...(record.groupId ? { groupId: record.groupId } : {}),
        ...(record.groupWid ? { groupWid: record.groupWid } : {}),
        runAt: retryAt,
        payload: {
          eventId: record.id,
          attempt,
          ...(externalDismantledChatId ? { externalDismantledChatId } : {})
        },
        dedupeKey: `${EVENTS_JOBS.cleanup}:${record.id}:edit-repair-expiry:${retryAt.toISOString()}`
      }];
    }
    if (externalDismantledChatId) {
      const current = getEvent(db, record.id);
      const retryAt = current
        ? externalDismantleRetryAt(db, current, externalDismantledChatId, now)
        : undefined;
      if (current && retryAt) {
        return [audit('events.cleanup.external_revision_changed', {
          eventId,
          retryAt: retryAt.toISOString()
        }), externalDismantleCleanupAction(current, externalDismantledChatId, retryAt, attempt)];
      }
    }
    return [audit('events.job.skipped', {
      jobName: job.jobName,
      eventId,
      reason: 'cleanup deadline or lifecycle changed'
    })];
  }

  try {
    let dismantleResult: PluginGroupDismantleResult | undefined;
    if (record.subgroupChatId && !externalDismantled) {
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
      if (externalDismantledChatId) {
        const current = getEvent(db, record.id);
        const retryAt = current
          ? externalDismantleRetryAt(db, current, externalDismantledChatId, new Date())
          : undefined;
        if (current && retryAt) {
          return [audit('events.cleanup.external_revision_changed', {
            eventId,
            retryAt: retryAt.toISOString()
          }), externalDismantleCleanupAction(current, externalDismantledChatId, retryAt, attempt)];
        }
      }
      return [audit('events.job.skipped', {
        jobName: job.jobName,
        eventId,
        reason: 'event lifecycle changed while cleanup was running'
      })];
    }
    const announcementMessageDeletion = await deleteEventArtifacts({
      db,
      event: record,
      ...(context.deleteMessage
        ? { deleteMessage: (messageId) => context.deleteMessage!(messageId) }
        : {})
    });
    const receiptReleaseRetries = await releaseEligibleEventPollReplacementReceipts({
      context,
      db,
      eventId: record.id
    });
    await setCleanupFailureStatus(context, record.scopeId, null);
    appendEventLog(db, {
      eventId: record.id,
      action: 'events.cleaned',
      metadata: {
        dismantleResult,
        announcementMessageDeletion,
        pollReceiptReleasePending: receiptReleaseRetries.length > 0
      }
    });
    await appendJsonLog(context, {
      action: 'event.cleaned',
      scopeId: record.scopeId,
      eventId: record.id,
      profileId: record.profileId,
      ...(record.pollWaMsgId ? { pollWaMsgId: record.pollWaMsgId } : {}),
      ...(record.subgroupChatId ? { subgroupChatId: record.subgroupChatId } : {}),
      metadata: {
        dismantleResult,
        announcementMessageDeletion,
        pollReceiptReleasePending: receiptReleaseRetries.length > 0
      }
    });
    return [
      ...receiptReleaseRetries.map((retry) => eventPollReceiptReleaseRetryAction(record, retry)),
      audit('events.cleaned', {
      eventId: record.id,
      dismantleResult,
      announcementMessageDeletion,
      pollReceiptReleasePending: receiptReleaseRetries.length > 0
    })];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return cleanupFailed(context, db, record, config, attempt, reason, { retryable: true }, claim.claimId);
  }
}

async function cleanupCancelledEventArtifacts(
  context: PluginRuntimeContext,
  job: PluginJobEvent
): Promise<PluginAction[]> {
  const eventId = jobPayloadEventId(job.payload);
  if (!eventId) {
    return [audit('events.cancellation_artifact_cleanup.skipped', { reason: 'missing eventId' })];
  }
  const db = eventsDatabase(context.databases);
  const event = getEvent(db, eventId);
  const supportedLifecycle = event?.eventStatus === 'cancelled' || event?.origin === 'unplanned';
  if (!event || event.scopeId !== job.scopeId || !supportedLifecycle) {
    return [audit('events.cancellation_artifact_cleanup.skipped', {
      eventId,
      reason: 'event missing, scope mismatch, or not cancelled'
    })];
  }
  const now = new Date();
  const due = listDueEventCancellationArtifacts(db, now.toISOString(), event.id);
  for (const artifact of due) {
    const attemptedAt = new Date().toISOString();
    const claimExpiresAt = new Date(new Date(attemptedAt).getTime() + 60_000).toISOString();
    if (!artifact.deletionNextAttemptAt || !claimEventCancellationArtifactDeletion(db, {
      artifactId: artifact.id,
      expectedNextAttemptAt: artifact.deletionNextAttemptAt,
      claimedAt: attemptedAt,
      claimedUntil: claimExpiresAt
    })) {
      continue;
    }
    try {
      const result = context.deleteMessage
        ? await context.deleteMessage(artifact.messageId)
        : { status: 'error' as const, reason: 'Plugin runtime does not expose message deletion.' };
      recordEventCancellationArtifactDeletionOutcome(db, {
        artifactId: artifact.id,
        result,
        attemptedAt,
        claimExpiresAt
      });
    } catch (error) {
      recordEventCancellationArtifactDeletionOutcome(db, {
        artifactId: artifact.id,
        result: { status: 'error', reason: error instanceof Error ? error.message : String(error) },
        attemptedAt,
        claimExpiresAt
      });
    }
  }

  const artifacts = listEventAnnouncementMessages(db, event.id);
  const nextAttemptAt = artifacts
    .map((artifact) => artifact.deletionNextAttemptAt ? new Date(artifact.deletionNextAttemptAt) : undefined)
    .filter((date): date is Date => Boolean(date && Number.isFinite(date.getTime())))
    .sort((left, right) => left.getTime() - right.getTime())[0];
  if (nextAttemptAt) {
    return [audit('events.cancellation_artifact_cleanup.pending', {
      eventId: event.id,
      nextAttemptAt: nextAttemptAt.toISOString()
    }), {
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.cancellationCleanup,
      scopeId: event.scopeId,
      runAt: nextAttemptAt,
      payload: { eventId: event.id },
      dedupeKey: `${EVENTS_JOBS.cancellationCleanup}:${event.id}:retry:${nextAttemptAt.toISOString()}`
    }];
  }

  const unresolved = artifacts.filter((artifact) =>
    artifact.deletionStatus === 'rejected' || artifact.deletionStatus === 'failed' ||
    artifact.deletionStatus === 'unconfirmed'
  );
  const allArtifacts = listEventAnnouncementMessages(db, event.id, { includeDeleted: true });
  const existingNotice = allArtifacts.find((artifact) => artifact.kind === 'cancellation_notice');
  const ended = new Date(event.lifecycleCompleteAt).getTime() <= now.getTime();
  if (event.eventStatus === 'cancelled' && unresolved.length > 0 && !existingNotice && !ended) {
    const announcementChatId = event.announcementGroupWid || event.groupWid;
    if (!announcementChatId || !context.sendText || !event.actorIdentityId) {
      return [cancellationNoticeRetryAction(event, now, 'notice delivery unavailable')];
    }
    try {
      const t = await context.i18n.translatorForIdentity(event.actorIdentityId, event.scopeId);
      const poll = unresolved.find((artifact) => artifact.kind === 'poll')
        ?? artifacts.find((artifact) => artifact.kind === 'poll');
      const receipt = await context.sendText(
        announcementChatId,
        t('official.community-events.cancel.staleArtifactNotice', {
          title: event.subgroupTitle || event.groupTitle || event.pollQuestion || event.id,
          startsAt: formatEventDateTime(new Date(event.startsAt), event.timezone),
          endsAt: formatEventDateTime(new Date(event.endsAt), event.timezone),
          eventId: event.id
        }),
        {
          idempotencyKey: `community-events:${event.id}:cancellation-notice`,
          ...(poll ? { quotedMessageId: poll.messageId } : {})
        }
      );
      if (!receipt.messageId) {
        throw new Error('Cancellation notice send returned no WhatsApp message id.');
      }
      recordEventAnnouncementMessage(db, {
        eventId: event.id,
        scopeId: event.scopeId,
        kind: 'cancellation_notice',
        deliveryKey: 'cancellation',
        chatId: announcementChatId,
        messageId: receipt.messageId,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      context.logger.warn({ error, eventId: event.id }, 'Unable to publish event cancellation stale-artifact notice');
      return [cancellationNoticeRetryAction(event, now, error instanceof Error ? error.message : String(error))];
    }
  }
  return [audit('events.cancellation_artifact_cleanup.completed', {
    eventId: event.id,
    confirmed: allArtifacts.filter((artifact) => artifact.deletionStatus === 'confirmed').length,
    unconfirmed: allArtifacts.filter((artifact) => artifact.deletionStatus === 'unconfirmed').length,
    rejected: allArtifacts.filter((artifact) => artifact.deletionStatus === 'rejected').length,
    failed: allArtifacts.filter((artifact) => artifact.deletionStatus === 'failed').length,
    noticePublished: Boolean(existingNotice || (unresolved.length > 0 && !ended))
  })];
}

function cancellationNoticeRetryAction(
  event: StoredEventRecord,
  now: Date,
  reason: string
): PluginEnqueueJobAction {
  const retryAt = new Date(now.getTime() + 60_000);
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.cancellationCleanup,
    scopeId: event.scopeId,
    runAt: retryAt,
    payload: { eventId: event.id },
    dedupeKey: `${EVENTS_JOBS.cancellationCleanup}:${event.id}:notice:${retryAt.toISOString()}:${reason}`
  };
}

async function withEventCleanupClaimHeartbeat<T>(
  db: ReturnType<typeof eventsDatabase>,
  claim: EventCleanupClaim,
  operation: () => Promise<T>
): Promise<T> {
  let ownershipLost = false;
  let renewalError: unknown;
  const renew = (): boolean => {
    try {
      const renewed = renewEventCleanupClaim(db, {
        eventId: claim.eventId,
        claimId: claim.claimId,
        expectedUpdatedAt: claim.expectedEventUpdatedAt,
        leaseExpiresAt: new Date(Date.now() + EVENT_CLEANUP_CLAIM_LEASE_MS).toISOString()
      });
      ownershipLost ||= !renewed;
      return renewed;
    } catch (error) {
      renewalError ??= error;
      ownershipLost = true;
      return false;
    }
  };
  const timer = setInterval(() => { renew(); }, Math.max(1_000, Math.floor(EVENT_CLEANUP_CLAIM_LEASE_MS / 3)));
  timer.unref();
  try {
    const result = await operation();
    const renewed = renew();
    if (renewalError) {
      throw new Error(
        `Cleanup claim ${claim.claimId} renewal failed for event ${claim.eventId}: ` +
        (renewalError instanceof Error ? renewalError.message : String(renewalError))
      );
    }
    if (ownershipLost || !renewed) {
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
  metadata: Record<string, unknown>,
  cleanupClaimId: string
): Promise<PluginAction[]> {
  const failedAt = new Date().toISOString();
  const failed = markClaimedEventCleanupFailed(db, {
    eventId: record.id,
    claimId: cleanupClaimId,
    expectedUpdatedAt: record.updatedAt,
    reason,
    failedAt
  });
  if (!failed) {
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
  if (record.pollCloseCutoffAt) {
    return validDateOrNow(record.pollCloseCutoffAt);
  }
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
  closeAt: Date,
  now: Date = new Date()
): StoredEventRecord {
  if (!Number.isFinite(closeAt.getTime())) {
    return record;
  }
  const closeAtIso = closeAt.toISOString();
  if (record.closeAt === closeAtIso) {
    return record;
  }
  const updatedAt = now.toISOString();
  const updated = updateEventCloseAt(db, {
    eventId: record.id,
    scopeId: record.scopeId,
    expectedUpdatedAt: record.updatedAt,
    closeAt: closeAtIso,
    updatedAt
  });
  const refreshed = getEvent(db, record.id) ?? record;
  if (updated) {
    appendEventLog(db, {
      eventId: record.id,
      action: 'events.close.rescheduled',
      metadata: {
        previousCloseAt: record.closeAt,
        effectiveCloseAt: closeAtIso
      }
    });
  }
  return refreshed;
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
  const missed = markUnclaimedEventPreCreateProvisioningMissed(db, {
    eventId: record.id,
    scopeId: record.scopeId,
    expectedUpdatedAt: record.updatedAt,
    expectedCleanupAt: record.cleanupAt,
    reason,
    missedAt
  });
  if (!missed) {
    return;
  }
  const failedEvent = getEvent(db, record.id);
  const receiptReleaseRetries = failedEvent
    ? await releaseEligibleEventPollReplacementReceipts({
        context,
        db,
        eventId: failedEvent.id,
        now
      })
    : [];
  for (const retry of receiptReleaseRetries) {
    await enqueuePluginJob(context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.pollReplacement,
      scopeId: retry.scopeId,
      ...(record.groupId ? { groupId: record.groupId } : {}),
      ...(record.groupWid ? { groupWid: record.groupWid } : {}),
      runAt: retry.retryAt,
      payload: { operationId: retry.operationId },
      dedupeKey: `${EVENTS_JOBS.pollReplacement}:${retry.operationId}:receipt-release:${retry.failureCount}`
    });
  }
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
      calendarId,
      ...(context.services ? { services: context.services } : {})
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

function jobPayloadExternalDismantledChatId(payload: unknown): string | undefined {
  const value = payload && typeof payload === 'object'
    ? (payload as { externalDismantledChatId?: unknown }).externalDismantledChatId
    : undefined;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function jobPayloadPollGeneration(payload: unknown): number | undefined {
  const value = payload && typeof payload === 'object'
    ? (payload as { pollGeneration?: unknown }).pollGeneration
    : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function jobPayloadPollWaMsgId(payload: unknown): string | undefined {
  const value = payload && typeof payload === 'object'
    ? (payload as { pollWaMsgId?: unknown }).pollWaMsgId
    : undefined;
  return typeof value === 'string' && value.trim() ? value : undefined;
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
      isInviteV4Sent: participant.isInviteV4Sent,
      ...(participant.requiredCreatorMembershipStatus
        ? { requiredCreatorMembershipStatus: participant.requiredCreatorMembershipStatus }
        : {})
    }
  ]));
}

async function notifyCreatorAboutMembershipPause(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  eventId: string,
  error: unknown
): Promise<void> {
  const kind = eventCreatorMembershipPauseKindForFailure(error);
  if (!kind) {
    return;
  }
  const event = getEvent(db, eventId);
  if (!event?.subgroupChatId) {
    return;
  }
  try {
    const notice = await notifyEventCreatorMembershipPaused({ context, event, kind });
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.creator_membership_notice_sent',
      metadata: {
        subgroupChatId: event.subgroupChatId,
        kind,
        idempotencyKey: notice.idempotencyKey,
        groupJoinUrlIncluded: Boolean(notice.groupJoinUrl)
      }
    });
  } catch (noticeError) {
    const reason = noticeError instanceof Error ? noticeError.message : String(noticeError);
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.creator_membership_notice_failed',
      metadata: {
        subgroupChatId: event.subgroupChatId,
        kind,
        reason
      }
    });
    context.logger.warn(
      { error: noticeError, eventId: event.id, subgroupChatId: event.subgroupChatId, kind },
      'Unable to deliver event creator membership pause notice'
    );
  }
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
