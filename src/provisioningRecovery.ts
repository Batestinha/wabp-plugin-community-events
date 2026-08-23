import { randomUUID } from 'node:crypto';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import {
  isManagedCommunitySubgroupProvisioningError,
  type ManagedCommunitySubgroupProvisioningError
} from '../../../platform/pluginRuntime/runtime/pluginCommunityOperations';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type {
  CreatedGroupParticipantResult,
  ManagedCommunitySubgroup,
  OutboundSendResult,
  RequiredCreatorBinding
} from '../../../platform/transport/transportTypes';
import type { TransportCommunityLinkRecoveryDisposition } from '../../../platform/transport/transportErrors';
import type { OfficialPluginCommandRuntime } from '../shared';
import { voterWidsForResponseBehavior } from './attendance';
import { parseEventsConfig, type EventProfile } from './config';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import {
  completeEventCommunitySubgroup,
  configureEventCommunitySubgroup,
  createEventCommunitySubgroupCandidate,
  reconcileEventCommunitySubgroupCreator
} from './subgroups';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import { publishEventCalendarBeforeCommunityLink } from './communityLinkCalendar';
import { eventCleanupJobRequest } from './cleanupScheduling';
import { eventGroupHintEnabled, eventGroupJoinUrl, renderEventGroupAnnouncement } from './announcements';
import { sendClaimedEventAnnouncement } from './announcementDelivery';
import { sendEventCalendarHint } from './calendarHint';
import { eventWeatherForecastJobRequest } from './weather';
import {
  eventCreatorMembershipPauseKindForFailure,
  notifyEventCreatorMembershipPaused
} from './creatorMembershipNotice';
import {
  appendEventLog,
  advanceEventProvisioningRecovery,
  advanceUnplannedEventFinalization,
  checkpointClaimedEventProvisioningChild,
  checkpointClaimedEventParticipantOutcomes,
  claimScheduledKnownChildEventProvisioningAttempt,
  completeUnplannedEventFinalization,
  completeUnplannedEventProvisioning,
  eventsDatabase,
  getLiveEventBySubgroup,
  getEvent,
  getEventRequiredCreatorReference,
  getUnplannedEventFinalization,
  haltClaimedKnownChildEventProvisioning,
  includeClaimedEventCalendarBeforeCommunityLink,
  initializeEventPreCreateProvisioningRecovery,
  listCreatedGroupParticipants,
  listVotes,
  markClaimedEventReadyForCommunityLink,
  nextEventRevisionTimestamp,
  renewClaimedEventCommunityLinkLease,
  renewClaimedKnownChildEventProvisioningLease,
  completeClaimedEventCommunityLink,
  resolvedEventCalendarId,
  resumeHaltedKnownChildEventProvisioning,
  type StoredEventRecord,
  type StoredUnplannedEventFinalization
} from './store';

export const EVENT_PROVISIONING_RECOVERY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
export const EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS = EVENT_PROVISIONING_RECOVERY_DELAYS_MS.length;
export const EVENT_PROVISIONING_LINK_VERIFY_ONLY_DELAY_MS = 15_000;
export const EVENT_PROVISIONING_CREATOR_MEMBERSHIP_DELAYS_MS = [60_000, 120_000, 300_000] as const;
export const EVENT_PROVISIONING_LINK_MUTATION_ALLOWED_DELAY_MS = 30_000;
export const UNPLANNED_EVENT_FINALIZATION_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;

export interface EventProvisioningRecoveryPayload {
  eventId: string;
  subgroupChatId?: string | undefined;
  generation: string;
  attempt: number;
}

export interface EventProvisioningRecoveryCursor {
  generation: string;
  attempt: number;
  nextRunAt?: string | undefined;
}

export type EnqueueEventPreCreateProvisioningRecoveryResult =
  | {
      status: 'enqueued';
      event: StoredEventRecord;
      cursor: EventProvisioningRecoveryCursor & { nextRunAt: string };
    }
  | {
      status: 'not_found' | 'rejected';
      reason: string;
      event?: StoredEventRecord | undefined;
    };

/**
 * Explicit repair entry point for a failed event that predates typed
 * pre-create failures. The caller must supply the exact observed event
 * revision; this function never infers retry safety from an error string.
 */
export async function enqueueEventPreCreateProvisioningRecovery(input: {
  context: PluginRuntimeContext;
  scopeId: string;
  eventId: string;
  expectedUpdatedAt: string;
  now?: Date | undefined;
}): Promise<EnqueueEventPreCreateProvisioningRecoveryResult> {
  const scopeId = input.scopeId.trim();
  const eventId = input.eventId.trim();
  const finish = async <T extends EnqueueEventPreCreateProvisioningRecoveryResult>(
    result: T
  ): Promise<T> => {
    try {
      await input.context.audit.record({
        scopeId,
        action: 'official.community-events.provisioning.precreate_recovery_requested',
        targetJson: { eventId },
        metadataJson: {
          expectedUpdatedAt: input.expectedUpdatedAt,
          status: result.status,
          ...('reason' in result ? { reason: result.reason } : {}),
          ...(result.status === 'enqueued' ? {
            generation: result.cursor.generation,
            attempt: result.cursor.attempt,
            runAt: result.cursor.nextRunAt
          } : {})
        }
      });
    } catch (error) {
      input.context.logger.warn(
        { error, scopeId, eventId, status: result.status },
        'Unable to audit explicit event pre-create provisioning recovery request'
      );
    }
    return result;
  };
  const db = eventsDatabase(input.context.databases);
  let event = getEvent(db, eventId);
  if (!event || event.scopeId !== scopeId) {
    return finish({
      status: 'not_found',
      reason: `Unknown event ${eventId} in scope ${scopeId}.`
    });
  }
  if (!isNoChildProvisioningRecoveryRecord(event)) {
    return finish({
      status: 'rejected',
      reason: `Event ${event.id} is not a failed no-child provisioning record.`,
      event
    });
  }
  const requestedAt = input.now ?? new Date();
  const cleanupAt = new Date(event.cleanupAt);
  if (
    !Number.isFinite(requestedAt.getTime()) ||
    !Number.isFinite(cleanupAt.getTime()) ||
    requestedAt.getTime() >= cleanupAt.getTime()
  ) {
    return finish({
      status: 'rejected',
      reason: `Event ${event.id} has reached or has an invalid cleanup deadline.`,
      event
    });
  }

  let cursor = eventProvisioningRecoveryCursor(event);
  if (!cursor) {
    if (event.updatedAt !== input.expectedUpdatedAt) {
      return finish({
        status: 'rejected',
        reason: `Event ${event.id} changed after revision ${input.expectedUpdatedAt}.`,
        event
      });
    }
    const runAt = requestedAt;
    const initialized = initializeEventPreCreateProvisioningRecovery(db, {
      eventId: event.id,
      scopeId: event.scopeId,
      expectedUpdatedAt: input.expectedUpdatedAt,
      generation: randomUUID(),
      attempt: 1,
      nextRunAt: runAt.toISOString(),
      updatedAt: runAt.toISOString()
    });
    event = getEvent(db, event.id) ?? event;
    cursor = eventProvisioningRecoveryCursor(event);
    if (!initialized || !cursor?.nextRunAt || event.subgroupChatId) {
      return finish({
        status: 'rejected',
        reason: `Event ${event.id} changed while its no-child recovery cursor was initialized.`,
        event
      });
    }
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.precreate_recovery_initialized',
      metadata: {
        expectedUpdatedAt: input.expectedUpdatedAt,
        generation: cursor.generation,
        attempt: cursor.attempt,
        runAt: cursor.nextRunAt
      }
    });
  }
  if (!cursor.nextRunAt) {
    return finish({
      status: 'rejected',
      reason: `Event ${event.id} has an incomplete provisioning recovery cursor.`,
      event
    });
  }
  if (cursor.attempt > EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS) {
    return finish({
      status: 'rejected',
      reason: `Event ${event.id} has exhausted its ${EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS} deterministic subgroup creation attempts.`,
      event
    });
  }

  try {
    await enqueuePluginJob(input.context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.provisioningRecovery,
      scopeId: event.scopeId,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.groupWid ? { groupWid: event.groupWid } : {}),
      runAt: new Date(cursor.nextRunAt),
      payload: {
        eventId: event.id,
        generation: cursor.generation,
        attempt: cursor.attempt
      } satisfies EventProvisioningRecoveryPayload,
      dedupeKey: eventProvisioningRecoveryDedupeKey(event, cursor)
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.precreate_recovery_enqueue_failed',
      metadata: {
        expectedUpdatedAt: input.expectedUpdatedAt,
        generation: cursor.generation,
        attempt: cursor.attempt,
        runAt: cursor.nextRunAt,
        reason
      }
    });
    try {
      await input.context.audit.record({
        scopeId,
        action: 'official.community-events.provisioning.precreate_recovery_requested',
        targetJson: { eventId },
        metadataJson: {
          expectedUpdatedAt: input.expectedUpdatedAt,
          status: 'enqueue_failed',
          generation: cursor.generation,
          attempt: cursor.attempt,
          runAt: cursor.nextRunAt,
          reason
        }
      });
    } catch (auditError) {
      input.context.logger.warn(
        { error: auditError, scopeId, eventId, reason },
        'Unable to audit failed explicit event pre-create recovery enqueue'
      );
    }
    throw error;
  }
  return finish({
    status: 'enqueued',
    event,
    cursor: {
      ...cursor,
      nextRunAt: cursor.nextRunAt
    }
  });
}

export interface UnplannedEventFinalizationPayload {
  eventId: string;
  generation: string;
  attempt: number;
}

class UnplannedEventFinalizationSupersededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnplannedEventFinalizationSupersededError';
  }
}

interface UnplannedEventFinalizationContext {
  config: PluginRuntimeContext['config'];
  i18n?: PluginRuntimeContext['i18n'] | undefined;
  resolveStableIdentityById?: PluginRuntimeContext['resolveStableIdentityById'] | undefined;
  getGroupInviteCode?(groupWid: string): Promise<string | null>;
}

interface UnplannedEventFinalizationTransport {
  sendText(
    chatId: string,
    text: string,
    options?: { idempotencyKey?: string | undefined }
  ): Promise<OutboundSendResult>;
}

type UnplannedEventFinalizationRuntime = Pick<
  OfficialPluginCommandRuntime,
  'config' | 'databases' | 'enqueuePluginJob'
>;

export interface ResumeEventProvisioningInput {
  context: PluginRuntimeContext;
  scopeId: string;
  eventId: string;
  subgroupChatId: string;
  subgroupTitle?: string | undefined;
  participants?: Record<string, CreatedGroupParticipantResult> | undefined;
  actorWid?: string | undefined;
  actorLabel?: string | undefined;
  claimAlreadyHeld?: boolean | undefined;
  now?: Date | undefined;
}

export type ResumeEventProvisioningResult =
  | {
      status: 'completed';
      event: StoredEventRecord;
      resumed: true;
      attendeeCount: number;
      parentCommunityChatId: string;
    }
  | {
      status: 'already_completed';
      event: StoredEventRecord;
    }
  | {
      status: 'not_found';
      reason: string;
    }
  | {
      status: 'rejected';
      reason: string;
      event: StoredEventRecord;
    };

export type OperatorResumeEventProvisioningResult = ResumeEventProvisioningResult
  | {
      status: 'recovery_scheduled';
      event: StoredEventRecord;
      cursor: EventProvisioningRecoveryCursor & { nextRunAt: string };
      recoveryDisposition:
        | 'verify_only'
        | 'creator_membership_verify_only'
        | 'mutation_allowed';
      reason: string;
      enqueued: boolean;
    }
  | {
      status: 'operator_required';
      event: StoredEventRecord;
      reason: string;
    };

/**
 * Operator entry point for a known-child recovery. It acquires the exact
 * persisted claim before invoking the normal recovery path and always settles
 * that claim after a failed attempt: typed readback/mutation transitions are
 * durably scheduled, while every unclassified or terminal failure is halted
 * for another explicit operator decision.
 */
export async function resumeEventProvisioningFromOperator(
  input: Omit<ResumeEventProvisioningInput, 'claimAlreadyHeld'>
): Promise<OperatorResumeEventProvisioningResult> {
  const scopeId = input.scopeId.trim();
  const eventId = input.eventId.trim();
  const subgroupChatId = input.subgroupChatId.trim().toLowerCase();
  const db = eventsDatabase(input.context.databases);
  const before = getEvent(db, eventId);
  if (
    !before ||
    before.scopeId !== scopeId ||
    completedWithSubgroup(before, subgroupChatId) ||
    !recoverableWithSubgroup(before, subgroupChatId)
  ) {
    return resumeEventProvisioning(input);
  }
  const cursor = eventProvisioningRecoveryCursor(before);
  if (!cursor) {
    return resumeEventProvisioning(input);
  }

  const claimedAt = input.now ?? new Date();
  const claimed = before.provisioningRecoveryHaltedAt
    ? resumeHaltedKnownChildEventProvisioning(db, {
        eventId,
        scopeId,
        subgroupChatId,
        generation: cursor.generation,
        attempt: cursor.attempt,
        expectedHaltedAt: before.provisioningRecoveryHaltedAt,
        resumedAt: claimedAt.toISOString()
      })
    : cursor.nextRunAt
      ? claimScheduledKnownChildEventProvisioningAttempt(db, {
          eventId,
          scopeId,
          subgroupChatId,
          generation: cursor.generation,
          attempt: cursor.attempt,
          expectedNextRunAt: cursor.nextRunAt,
          claimedAt: claimedAt.toISOString()
        })
      : false;
  if (!claimed) {
    return rejected(
      getEvent(db, eventId) ?? before,
      `Event ${eventId} provisioning recovery is already claimed or changed.`
    );
  }

  try {
    const result = await resumeEventProvisioning({
      ...input,
      scopeId,
      eventId,
      subgroupChatId,
      claimAlreadyHeld: true
    });
    if (result.status !== 'rejected') {
      return result;
    }
    return settleOperatorKnownChildProvisioningClaim({
      context: input.context,
      before,
      cursor,
      subgroupChatId,
      reason: result.reason,
      failedAt: input.now ?? new Date()
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const managedFailure = isManagedCommunitySubgroupProvisioningError(error) &&
      error.created.chatId.trim().toLowerCase() === subgroupChatId
      ? error
      : undefined;
    if (managedFailure) {
      await notifyOperatorRecoveryCreatorAboutMembershipPause(
        input.context,
        getEvent(db, eventId) ?? before,
        managedFailure
      );
    }
    return settleOperatorKnownChildProvisioningClaim({
      context: input.context,
      before,
      cursor,
      subgroupChatId,
      reason,
      failedAt: input.now ?? new Date(),
      ...(managedFailure
        ? {
            recoveryDisposition: managedFailure.recoveryDisposition,
            stage: managedFailure.stage,
            mutationDisposition: managedFailure.mutationDisposition
          }
        : {})
    });
  }
}

async function notifyOperatorRecoveryCreatorAboutMembershipPause(
  context: PluginRuntimeContext,
  event: StoredEventRecord,
  error: ManagedCommunitySubgroupProvisioningError
): Promise<void> {
  const kind = eventCreatorMembershipPauseKindForFailure(error);
  if (!kind || !event.subgroupChatId) {
    return;
  }
  const db = eventsDatabase(context.databases);
  try {
    const notice = await notifyEventCreatorMembershipPaused({ context, event, kind });
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.creator_membership_notice_sent',
      metadata: {
        subgroupChatId: event.subgroupChatId,
        kind,
        idempotencyKey: notice.idempotencyKey,
        groupJoinUrlIncluded: Boolean(notice.groupJoinUrl),
        source: 'operator_resume'
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
        reason,
        source: 'operator_resume'
      }
    });
    context.logger.warn(
      { error: noticeError, eventId: event.id, subgroupChatId: event.subgroupChatId, kind },
      'Unable to deliver operator-recovery creator membership pause notice'
    );
  }
}

async function settleOperatorKnownChildProvisioningClaim(input: {
  context: PluginRuntimeContext;
  before: StoredEventRecord;
  cursor: EventProvisioningRecoveryCursor;
  subgroupChatId: string;
  reason: string;
  failedAt: Date;
  recoveryDisposition?: TransportCommunityLinkRecoveryDisposition | undefined;
  stage?: ManagedCommunitySubgroupProvisioningError['stage'] | undefined;
  mutationDisposition?: ManagedCommunitySubgroupProvisioningError['mutationDisposition'] | undefined;
}): Promise<OperatorResumeEventProvisioningResult> {
  const db = eventsDatabase(input.context.databases);
  const failedAt = input.failedAt.toISOString();
  const retryableDisposition = input.recoveryDisposition === 'verify_only' ||
    input.recoveryDisposition === 'creator_membership_verify_only' ||
    input.recoveryDisposition === 'mutation_allowed'
    ? input.recoveryDisposition
    : undefined;
  if (!retryableDisposition) {
    const halted = haltClaimedKnownChildEventProvisioning(db, {
      eventId: input.before.id,
      scopeId: input.before.scopeId,
      subgroupChatId: input.subgroupChatId,
      generation: input.cursor.generation,
      expectedAttempt: input.cursor.attempt,
      reason: input.reason,
      haltedAt: failedAt
    });
    const event = getEvent(db, input.before.id) ?? input.before;
    if (!halted) {
      return rejected(
        event,
        `Event ${input.before.id} changed while its failed operator recovery claim was being halted.`
      );
    }
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.operator_required',
      metadata: {
        subgroupChatId: input.subgroupChatId,
        generation: input.cursor.generation,
        attempt: input.cursor.attempt,
        source: 'operator_resume',
        ...(input.stage ? { stage: input.stage } : {}),
        ...(input.mutationDisposition
          ? { mutationDisposition: input.mutationDisposition }
          : {}),
        recoveryDisposition: input.recoveryDisposition ?? 'unclassified',
        reason: input.reason
      }
    });
    return { status: 'operator_required', event, reason: input.reason };
  }

  const nextAttempt = input.cursor.attempt + 1;
  const runAt = eventCommunityLinkRecoveryRunAt(
    retryableDisposition,
    input.failedAt,
    nextAttempt
  );
  const advanced = advanceEventProvisioningRecovery(db, {
    eventId: input.before.id,
    scopeId: input.before.scopeId,
    subgroupChatId: input.subgroupChatId,
    generation: input.cursor.generation,
    expectedAttempt: input.cursor.attempt,
    expectedNextRunAt: null,
    nextAttempt,
    nextRunAt: runAt.toISOString(),
    updatedAt: failedAt
  });
  const event = getEvent(db, input.before.id) ?? input.before;
  const advancedCursor = eventProvisioningRecoveryCursor(event);
  if (
    !advanced ||
    !advancedCursor?.nextRunAt ||
    advancedCursor.generation !== input.cursor.generation ||
    advancedCursor.attempt !== nextAttempt
  ) {
    return rejected(
      event,
      `Event ${input.before.id} changed while its operator recovery retry was being scheduled.`
    );
  }

  let enqueued = true;
  try {
    await enqueuePluginJob(input.context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.provisioningRecovery,
      scopeId: event.scopeId,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.groupWid ? { groupWid: event.groupWid } : {}),
      runAt,
      payload: {
        eventId: event.id,
        subgroupChatId: input.subgroupChatId,
        generation: advancedCursor.generation,
        attempt: advancedCursor.attempt
      } satisfies EventProvisioningRecoveryPayload,
      dedupeKey: eventProvisioningRecoveryDedupeKey(event, advancedCursor)
    });
  } catch (error) {
    enqueued = false;
    input.context.logger.error(
      {
        error,
        eventId: event.id,
        subgroupChatId: input.subgroupChatId,
        generation: advancedCursor.generation,
        attempt: advancedCursor.attempt,
        runAt: advancedCursor.nextRunAt
      },
      'Unable to enqueue a durably scheduled operator event provisioning recovery'
    );
  }
  appendEventLog(db, {
    eventId: event.id,
    action: enqueued
      ? 'events.provisioning.recovery_scheduled'
      : 'events.provisioning.recovery_enqueue_failed',
    metadata: {
      subgroupChatId: input.subgroupChatId,
      generation: advancedCursor.generation,
      attempt: advancedCursor.attempt,
      runAt: advancedCursor.nextRunAt,
      source: 'operator_resume',
      recoveryDisposition: retryableDisposition,
      reason: input.reason
    }
  });
  return {
    status: 'recovery_scheduled',
    event,
    cursor: { ...advancedCursor, nextRunAt: advancedCursor.nextRunAt },
    recoveryDisposition: retryableDisposition,
    reason: input.reason,
    enqueued
  };
}

export async function retryEventProvisioningCreation(input: {
  context: PluginRuntimeContext;
  scopeId: string;
  eventId: string;
  actorWid?: string | undefined;
  actorLabel?: string | undefined;
  now?: Date | undefined;
}): Promise<ResumeEventProvisioningResult> {
  const scopeId = input.scopeId.trim();
  const eventId = input.eventId.trim();
  const db = eventsDatabase(input.context.databases);
  const event = getEvent(db, eventId);
  if (!event || event.scopeId !== scopeId) {
    return {
      status: 'not_found',
      reason: `Unknown event ${eventId} in scope ${scopeId}.`
    };
  }
  if (!isNoChildProvisioningRecoveryRecord(event)) {
    return rejected(
      event,
      `Event ${event.id} cannot retry standalone subgroup creation from ` +
      `${event.eventStatus}/${event.groupLifecycleStatus} with subgroup ${event.subgroupChatId ?? 'none'}.`
    );
  }
  const claimedCursor = eventProvisioningRecoveryCursor(event);
  if (!claimedCursor || claimedCursor.nextRunAt) {
    return rejected(event, `Event ${event.id} does not have an exclusively claimed pre-create attempt.`);
  }

  let created: Awaited<ReturnType<typeof createEventCommunitySubgroupCandidate>>['created'];
  try {
    const result = await createEventCommunitySubgroupCandidate({
      context: input.context,
      scopeId,
      actorIdentityId: requireRecoveryActorIdentityId(event),
      title: event.groupTitle
    });
    created = result.created;
  } catch (error) {
    if (isManagedCommunitySubgroupProvisioningError(error)) {
      const checkpointedAt = (input.now ?? new Date()).toISOString();
      const checkpointed = checkpointClaimedEventProvisioningChild(db, {
        eventId: event.id,
        scopeId,
        generation: claimedCursor.generation,
        expectedAttempt: claimedCursor.attempt,
        nextAttempt: claimedCursor.attempt,
        subgroupChatId: error.created.chatId,
        subgroupTitle: error.created.title,
        participants: error.created.participants,
        creator: error.created.requiredCreator,
        checkpointedAt,
        reason: error.message
      });
      appendEventLog(db, {
        eventId: event.id,
        action: 'events.provisioning.candidate_checkpointed',
        metadata: {
          subgroupChatId: error.created.chatId,
          subgroupTitle: error.created.title,
          participantOutcomeCount: Object.keys(error.created.participants).length,
          stage: error.stage,
          recoveryDisposition: error.recoveryDisposition,
          checkpointPersisted: checkpointed,
          source: 'precreate_recovery'
        }
      });
      if (checkpointed) {
        const checkpointedEvent = getEvent(db, event.id);
        if (checkpointedEvent?.subgroupChatId === error.created.chatId) {
          await enqueuePluginJob(input.context.queue, {
            pluginId: EVENTS_PLUGIN_ID,
            ...eventCleanupJobRequest(checkpointedEvent)
          });
        }
      }
    }
    throw error;
  }

  const checkpointedAt = (input.now ?? new Date()).toISOString();
  const checkpointed = checkpointClaimedEventProvisioningChild(db, {
    eventId: event.id,
    scopeId,
    generation: claimedCursor.generation,
    expectedAttempt: claimedCursor.attempt,
    nextAttempt: claimedCursor.attempt,
    subgroupChatId: created.chatId,
    subgroupTitle: created.title,
    participants: created.participants,
    creator: created.requiredCreator,
    checkpointedAt
  });
  if (!checkpointed) {
    throw new Error(
      `Event ${event.id} changed state before newly created subgroup ${created.chatId} could be checkpointed.`
    );
  }
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.provisioning.candidate_checkpointed',
    metadata: {
      subgroupChatId: created.chatId,
      subgroupTitle: created.title,
      participantOutcomeCount: Object.keys(created.participants).length,
      source: 'precreate_recovery'
    }
  });
  const checkpointedEvent = getEvent(db, event.id);
  if (!checkpointedEvent || checkpointedEvent.subgroupChatId !== created.chatId) {
    throw new Error(
      `Event ${event.id} lost newly checkpointed subgroup ${created.chatId} before cleanup was scheduled.`
    );
  }
  await enqueuePluginJob(input.context.queue, {
    pluginId: EVENTS_PLUGIN_ID,
    ...eventCleanupJobRequest(checkpointedEvent)
  });
  return resumeEventProvisioning({
    context: input.context,
    scopeId,
    eventId: event.id,
    subgroupChatId: created.chatId,
    subgroupTitle: created.title,
    participants: created.participants,
    actorWid: input.actorWid,
    actorLabel: input.actorLabel,
    claimAlreadyHeld: true,
    now: input.now
  });
}

function isNoChildProvisioningRecoveryRecord(event: StoredEventRecord): boolean {
  if (
    event.eventStatus !== 'failed' ||
    event.groupLifecycleStatus !== 'none' ||
    (event.calendarStatus !== 'hidden' && event.calendarStatus !== 'included') ||
    event.subgroupChatId ||
    !event.actorIdentityId?.trim()
  ) {
    return false;
  }
  if (event.origin === 'unplanned') {
    return !event.pollWaMsgId;
  }
  return (
    (event.origin === 'created' || event.origin === 'adopted_poll') &&
    Boolean(event.pollWaMsgId)
  );
}

export async function finalizeUnplannedEventLifecycle(input: {
  context: UnplannedEventFinalizationContext;
  runtime: UnplannedEventFinalizationRuntime;
  activeTransport: UnplannedEventFinalizationTransport;
  event: StoredEventRecord;
  profile: EventProfile;
  config: ReturnType<typeof parseEventsConfig>;
  locale: string;
  creatorDisplayName: string;
  trigger: 'unplanned_created' | 'unplanned_recovery';
  notifyRecoveryCreator?: boolean | undefined;
  expectedEventUpdatedAt: string;
  now?: Date | undefined;
}): Promise<void> {
  const db = eventsDatabase(input.runtime.databases);
  const event = input.event;
  assertUnplannedEventFinalizationFence(db, event, input.expectedEventUpdatedAt);
  const subgroupChatId = event.subgroupChatId;
  if (!subgroupChatId) {
    throw new Error(`Unplanned event ${event.id} cannot finalize without its exact subgroup.`);
  }
  const announcementGroupWid = event.announcementGroupWid?.trim();
  if (!announcementGroupWid) {
    throw new Error(`Unplanned event ${event.id} cannot finalize without its announcement group.`);
  }
  const failures: string[] = [];
  try {
    const calendarId = resolvedEventCalendarId(event);
    if (calendarId) {
      const calendar = input.config.calendars.find((candidate) => candidate.id === calendarId);
      const publication = await writePublishAndRecordScopeCalendar({
        appConfig: input.runtime.config,
        db,
        config: input.config,
        scopeId: event.scopeId,
        calendarId,
        requestGeneration: false
      });
      await appendFinalizationJsonLog(input.context, {
        action: 'calendar.exported',
        scopeId: event.scopeId,
        eventId: event.id,
        actorWid: event.actorWid,
        profileId: event.profileId,
        subgroupChatId,
        metadata: {
          calendarEnabled: calendar?.enabled === true,
          calendarId,
          ...(publication ? { publication } : {})
        }
      });
      if (publication && !publication.ok) {
        failures.push(`calendar: ${publication.error || 'publication failed'}`);
      }
    }
  } catch (error) {
    if (error instanceof UnplannedEventFinalizationSupersededError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    failures.push(`calendar: ${reason}`);
    await appendFinalizationJsonLog(input.context, {
      action: 'calendar.export_failed',
      scopeId: event.scopeId,
      eventId: event.id,
      actorWid: event.actorWid,
      profileId: event.profileId,
      subgroupChatId,
      metadata: { reason }
    });
  }

  await appendFinalizationJsonLog(input.context, {
    action: 'event.created',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: event.actorWid,
    profileId: event.profileId,
    subgroupChatId,
    metadata: {
      origin: 'unplanned',
      recovery: input.trigger === 'unplanned_recovery',
      announcementGroupWid: event.announcementGroupWid,
      groupTitle: event.groupTitle,
      answers: event.answers,
      startsAt: event.startsAtUtc || event.startsAt,
      closeAt: event.closeAt,
      cleanupAt: event.cleanupAt
    }
  });

  try {
    assertUnplannedEventFinalizationFence(db, event, input.expectedEventUpdatedAt);
    await input.runtime.enqueuePluginJob({
      jobName: EVENTS_JOBS.cleanup,
      scopeId: event.scopeId,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.groupWid ? { groupWid: event.groupWid } : {}),
      runAt: new Date(event.cleanupAt),
      payload: { eventId: event.id, attempt: 0 },
      dedupeKey: `${EVENTS_JOBS.cleanup}:${event.id}:unplanned`
    });
  } catch (error) {
    if (error instanceof UnplannedEventFinalizationSupersededError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    failures.push(`cleanup job: ${reason}`);
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.unplanned.cleanup_enqueue_failed',
      metadata: { reason }
    });
  }

  try {
    assertUnplannedEventFinalizationFence(db, event, input.expectedEventUpdatedAt);
    await input.runtime.enqueuePluginJob({
      jobName: EVENTS_JOBS.complete,
      scopeId: event.scopeId,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.groupWid ? { groupWid: event.groupWid } : {}),
      runAt: new Date(event.lifecycleCompleteAt),
      payload: { eventId: event.id },
      dedupeKey: `${EVENTS_JOBS.complete}:${event.id}:${event.lifecycleCompleteAt}`
    });
  } catch (error) {
    if (error instanceof UnplannedEventFinalizationSupersededError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    failures.push(`completion job: ${reason}`);
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.unplanned.completion_enqueue_failed',
      metadata: { reason }
    });
  }

  const weatherRequest = eventWeatherForecastJobRequest({
    event,
    profile: input.profile,
    now: input.now
  });
  if (weatherRequest) {
    try {
      assertUnplannedEventFinalizationFence(db, event, input.expectedEventUpdatedAt);
      await input.runtime.enqueuePluginJob(weatherRequest);
    } catch (error) {
      if (error instanceof UnplannedEventFinalizationSupersededError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`weather job: ${reason}`);
      appendEventLog(db, {
        eventId: event.id,
        action: 'events.unplanned.weather_enqueue_failed',
        metadata: { reason }
      });
    }
  }

  let groupJoinUrl = '';
  if (eventGroupHintEnabled(input.profile, 'unplanned')) {
    try {
      assertUnplannedEventFinalizationFence(db, event, input.expectedEventUpdatedAt);
      groupJoinUrl = await eventGroupJoinUrl(
        input.context,
        input.profile.eventGroupHint.template,
        subgroupChatId
      );
      const announcementText = renderEventGroupAnnouncement({
        template: input.profile.eventGroupHint.template,
        profile: input.profile,
        event,
        groupDisplayName: event.subgroupTitle || event.groupTitle,
        groupJoinUrl,
        subgroupChatId,
        locale: input.locale,
        creatorDisplayName: input.creatorDisplayName
      });
      const delivery = await sendClaimedEventAnnouncement({
        db,
        eventId: event.id,
        scopeId: event.scopeId,
        kind: 'event_group_hint',
        deliveryKey: 'initial',
        chatId: announcementGroupWid,
        text: announcementText,
        expectedEventUpdatedAt: input.expectedEventUpdatedAt,
        sender: input.activeTransport
      });
      if (delivery.status === 'sent') {
        await appendFinalizationJsonLog(input.context, {
          action: 'event.unplanned_announcement_sent',
          scopeId: event.scopeId,
          eventId: event.id,
          actorWid: event.actorWid,
          profileId: event.profileId,
          subgroupChatId,
          metadata: {
            announcementGroupWid: event.announcementGroupWid,
            messageId: delivery.messageId,
            groupJoinUrl,
            trigger: input.trigger
          }
        });
      } else if (delivery.status === 'already_claimed') {
        failures.push('event group announcement: delivery already claimed');
      } else if (delivery.status === 'superseded') {
        throw new UnplannedEventFinalizationSupersededError(
          `Unplanned event ${event.id} changed before its event-group announcement could be sent.`
        );
      }
    } catch (error) {
      if (error instanceof UnplannedEventFinalizationSupersededError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`event group announcement: ${reason}`);
      appendEventLog(db, {
        eventId: event.id,
        action: 'events.unplanned.announcement_failed',
        metadata: {
          trigger: input.trigger,
          reason
        }
      });
    }
  }

  assertUnplannedEventFinalizationFence(db, event, input.expectedEventUpdatedAt);
  const calendarHint = await sendEventCalendarHint({
    context: input.context,
    runtime: input.runtime,
    activeTransport: input.activeTransport,
    trigger: input.trigger,
    scopeId: event.scopeId,
    announcementGroupWid,
    event,
    profile: input.profile,
    calendars: input.config.calendars,
    timezone: input.config.timezone,
    locale: input.locale,
    creatorDisplayName: input.creatorDisplayName,
    groupJoinUrl,
    subgroupChatId,
    expectedEventUpdatedAt: input.expectedEventUpdatedAt
  });
  if (calendarHint === 'failed' || calendarHint === 'already_claimed') {
    failures.push('calendar hint: delivery failed');
  } else if (calendarHint === 'superseded') {
    throw new UnplannedEventFinalizationSupersededError(
      `Unplanned event ${event.id} changed before its calendar hint could be sent.`
    );
  }
  assertUnplannedEventFinalizationFence(db, event, input.expectedEventUpdatedAt);
  if (
    failures.length === 0 &&
    input.trigger === 'unplanned_recovery' &&
    input.notifyRecoveryCreator
  ) {
    try {
      if (!input.context.resolveStableIdentityById || !input.context.i18n) {
        throw new Error('Plugin runtime does not expose authoritative creator notification services.');
      }
      const actorIdentityId = requireRecoveryActorIdentityId(event);
      const [creatorAddress, t] = await Promise.all([
        input.context.resolveStableIdentityById(actorIdentityId),
        input.context.i18n.translatorForIdentity(actorIdentityId, event.scopeId)
      ]);
      await input.activeTransport.sendText(
        creatorAddress.deliveryChatId,
        t('official.community-events.unplannedProvisioningRecovered', {
          title: event.subgroupTitle || event.groupTitle,
          eventId: event.id
        }),
        {
          idempotencyKey: `community-events:unplanned-provisioning-recovered:${event.id}`
        }
      );
      appendEventLog(db, {
        eventId: event.id,
        action: 'events.unplanned.recovery_creator_notified',
        metadata: {
          creatorIdentityId: actorIdentityId,
          creatorChatId: creatorAddress.deliveryChatId
        }
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`creator recovery notice: ${reason}`);
      appendEventLog(db, {
        eventId: event.id,
        action: 'events.unplanned.recovery_creator_notification_failed',
        metadata: { reason }
      });
    }
  }
  assertUnplannedEventFinalizationFence(db, event, input.expectedEventUpdatedAt);
  if (failures.length > 0) {
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.unplanned.finalization_pending',
      metadata: {
        trigger: input.trigger,
        subgroupChatId,
        failures
      }
    });
    throw new Error(`Unplanned event finalization remains pending: ${failures.join('; ')}`);
  }
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.unplanned.finalization_completed',
    metadata: {
      trigger: input.trigger,
      subgroupChatId
    }
  });
}

export type AttemptUnplannedEventFinalizationResult =
  | { status: 'completed'; finalization: StoredUnplannedEventFinalization }
  | { status: 'superseded'; finalization: StoredUnplannedEventFinalization }
  | { status: 'already_completed'; finalization: StoredUnplannedEventFinalization }
  | { status: 'retry_scheduled'; finalization: StoredUnplannedEventFinalization; enqueued: boolean }
  | { status: 'stale'; finalization?: StoredUnplannedEventFinalization | undefined };

export async function attemptUnplannedEventFinalization(input: {
  context: UnplannedEventFinalizationContext;
  runtime: UnplannedEventFinalizationRuntime;
  activeTransport: UnplannedEventFinalizationTransport;
  event: StoredEventRecord;
  profile: EventProfile;
  config: ReturnType<typeof parseEventsConfig>;
  locale: string;
  creatorDisplayName: string;
  trigger: 'unplanned_created' | 'unplanned_recovery';
  notifyRecoveryCreator?: boolean | undefined;
  expected?: Pick<StoredUnplannedEventFinalization, 'generation' | 'attempt'> | undefined;
  now?: Date | undefined;
}): Promise<AttemptUnplannedEventFinalizationResult> {
  const db = eventsDatabase(input.runtime.databases);
  const current = getUnplannedEventFinalization(db, input.event.id);
  if (!current) {
    return { status: 'stale' };
  }
  if (current.status === 'completed') {
    return { status: 'already_completed', finalization: current };
  }
  if (
    input.expected &&
    (current.generation !== input.expected.generation || current.attempt !== input.expected.attempt)
  ) {
    return { status: 'stale', finalization: current };
  }

  try {
    await finalizeUnplannedEventLifecycle({
      ...input,
      expectedEventUpdatedAt: current.eventUpdatedAt
    });
    const completedAt = (input.now ?? new Date()).toISOString();
    const completed = completeUnplannedEventFinalization(db, {
      eventId: current.eventId,
      scopeId: current.scopeId,
      generation: current.generation,
      attempt: current.attempt,
      completedAt
    });
    const finalization = getUnplannedEventFinalization(db, current.eventId);
    if (!completed || !finalization || finalization.status !== 'completed') {
      return { status: 'stale', ...(finalization ? { finalization } : {}) };
    }
    return { status: 'completed', finalization };
  } catch (error) {
    if (error instanceof UnplannedEventFinalizationSupersededError) {
      try {
        await repairSupersededUnplannedCalendar(input);
      } catch (repairError) {
        return scheduleUnplannedEventFinalizationRetry({
          runtime: input.runtime,
          event: input.event,
          expected: current,
          reason: `Superseded event calendar repair failed: ${
            repairError instanceof Error ? repairError.message : String(repairError)
          }`,
          now: input.now
        });
      }
      const completedAt = (input.now ?? new Date()).toISOString();
      const completed = completeUnplannedEventFinalization(db, {
        eventId: current.eventId,
        scopeId: current.scopeId,
        generation: current.generation,
        attempt: current.attempt,
        completedAt
      });
      const finalization = getUnplannedEventFinalization(db, current.eventId);
      if (!completed || !finalization || finalization.status !== 'completed') {
        return { status: 'stale', ...(finalization ? { finalization } : {}) };
      }
      appendEventLog(db, {
        eventId: input.event.id,
        action: 'events.unplanned.finalization_superseded',
        metadata: {
          reason: error.message,
          expectedEventUpdatedAt: current.eventUpdatedAt
        }
      });
      return { status: 'superseded', finalization };
    }
    return scheduleUnplannedEventFinalizationRetry({
      runtime: input.runtime,
      event: input.event,
      expected: current,
      reason: error instanceof Error ? error.message : String(error),
      now: input.now
    });
  }
}

async function repairSupersededUnplannedCalendar(input: {
  runtime: UnplannedEventFinalizationRuntime;
  event: StoredEventRecord;
  profile: EventProfile;
  config: ReturnType<typeof parseEventsConfig>;
}): Promise<void> {
  const db = eventsDatabase(input.runtime.databases);
  const currentBeforeRepair = getEvent(db, input.event.id);
  if (!currentBeforeRepair || currentBeforeRepair.scopeId !== input.event.scopeId) {
    return;
  }
  const calendarId = resolvedEventCalendarId(currentBeforeRepair);
  if (!calendarId) {
    return;
  }
  const publication = await writePublishAndRecordScopeCalendar({
    appConfig: input.runtime.config,
    db,
    config: input.config,
    scopeId: input.event.scopeId,
    calendarId
  });
  if (publication && !publication.ok) {
    throw new Error(publication.error || 'calendar publication failed');
  }
  const currentAfterRepair = getEvent(db, input.event.id);
  if (currentAfterRepair?.updatedAt !== currentBeforeRepair.updatedAt) {
    throw new Error(`Event ${input.event.id} changed again during calendar repair.`);
  }
}

export async function scheduleUnplannedEventFinalizationRetry(input: {
  runtime: UnplannedEventFinalizationRuntime;
  event: StoredEventRecord;
  expected: Pick<StoredUnplannedEventFinalization, 'generation' | 'attempt'>;
  reason: string;
  now?: Date | undefined;
}): Promise<AttemptUnplannedEventFinalizationResult> {
  const db = eventsDatabase(input.runtime.databases);
  const failedAt = input.now ?? new Date();
  const current = getUnplannedEventFinalization(db, input.event.id);
  if (
    !current ||
    current.status !== 'pending' ||
    current.scopeId !== input.event.scopeId ||
    current.generation !== input.expected.generation ||
    current.attempt !== input.expected.attempt
  ) {
    return { status: 'stale', ...(current ? { finalization: current } : {}) };
  }
  const nextAttempt = input.expected.attempt + 1;
  const runAt = unplannedEventFinalizationRunAt(nextAttempt, failedAt);
  try {
    await input.runtime.enqueuePluginJob({
      jobName: EVENTS_JOBS.unplannedFinalization,
      scopeId: input.event.scopeId,
      ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
      ...(input.event.groupWid ? { groupWid: input.event.groupWid } : {}),
      runAt,
      payload: {
        eventId: input.event.id,
        generation: current.generation,
        attempt: nextAttempt
      } satisfies UnplannedEventFinalizationPayload,
      dedupeKey: unplannedEventFinalizationDedupeKey({
        eventId: current.eventId,
        scopeId: current.scopeId,
        generation: current.generation,
        attempt: nextAttempt
      })
    });
  } catch (enqueueError) {
    appendEventLog(db, {
      eventId: input.event.id,
      action: 'events.unplanned.finalization_enqueue_failed',
      metadata: {
        reason: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
        generation: current.generation,
        attempt: nextAttempt,
        runAt: runAt.toISOString()
      }
    });
    throw enqueueError;
  }
  const advanced = advanceUnplannedEventFinalization(db, {
    eventId: input.event.id,
    scopeId: input.event.scopeId,
    generation: input.expected.generation,
    expectedAttempt: input.expected.attempt,
    nextAttempt,
    nextRunAt: runAt.toISOString(),
    reason: input.reason,
    updatedAt: failedAt.toISOString()
  });
  const finalization = getUnplannedEventFinalization(db, input.event.id);
  if (
    !advanced ||
    !finalization ||
    finalization.status !== 'pending' ||
    finalization.generation !== input.expected.generation ||
    finalization.attempt !== nextAttempt
  ) {
    return { status: 'stale', ...(finalization ? { finalization } : {}) };
  }
  appendEventLog(db, {
    eventId: input.event.id,
    action: 'events.unplanned.finalization_retry_scheduled',
    metadata: {
      reason: input.reason,
      generation: finalization.generation,
      attempt: finalization.attempt,
      runAt: finalization.nextRunAt,
      enqueued: true
    }
  });
  return { status: 'retry_scheduled', finalization, enqueued: true };
}

export async function resumeEventProvisioning(
  input: ResumeEventProvisioningInput
): Promise<ResumeEventProvisioningResult> {
  const scopeId = input.scopeId.trim();
  const eventId = input.eventId.trim();
  const subgroupChatId = input.subgroupChatId.trim().toLowerCase();
  const db = eventsDatabase(input.context.databases);
  const event = getEvent(db, eventId);
  if (!event || event.scopeId !== scopeId) {
    return {
      status: 'not_found',
      reason: `Unknown event ${eventId} in scope ${scopeId}.`
    };
  }

  if (completedWithSubgroup(event, subgroupChatId)) {
    return { status: 'already_completed', event };
  }
  if (!recoverableWithSubgroup(event, subgroupChatId)) {
    return rejected(
      event,
      `Event ${event.id} cannot resume from ${event.eventStatus}/${event.groupLifecycleStatus} with subgroup ${subgroupChatId}.`
    );
  }
  const recoveryCursor = eventProvisioningRecoveryCursor(event);
  if (
    event.eventStatus === 'failed' &&
    !recoveryCursor
  ) {
    return rejected(event, `Event ${event.id} has no durable provisioning recovery cursor.`);
  }
  if (event.provisioningRecoveryHaltedAt && recoveryCursor) {
    const resumedHalt = resumeHaltedKnownChildEventProvisioning(db, {
      eventId: event.id,
      scopeId,
      subgroupChatId,
      generation: recoveryCursor.generation,
      attempt: recoveryCursor.attempt,
      expectedHaltedAt: event.provisioningRecoveryHaltedAt,
      resumedAt: (input.now ?? new Date()).toISOString()
    });
    if (!resumedHalt) {
      return rejected(
        getEvent(db, event.id) ?? event,
        `Event ${event.id} changed while its operator recovery claim was being resumed.`
      );
    }
  } else if (recoveryCursor?.nextRunAt) {
    const claimed = claimScheduledKnownChildEventProvisioningAttempt(db, {
      eventId: event.id,
      scopeId,
      subgroupChatId,
      generation: recoveryCursor.generation,
      attempt: recoveryCursor.attempt,
      expectedNextRunAt: recoveryCursor.nextRunAt,
      claimedAt: (input.now ?? new Date()).toISOString()
    });
    if (!claimed) {
      return rejected(
        getEvent(db, event.id) ?? event,
        `Event ${event.id} provisioning recovery is already claimed or changed.`
      );
    }
  } else if (recoveryCursor && !input.claimAlreadyHeld) {
    return rejected(
      event,
      `Event ${event.id} provisioning recovery is already in flight.`
    );
  }

  const activeConflict = getLiveEventBySubgroup(db, subgroupChatId);
  if (activeConflict && activeConflict.id !== event.id) {
    return rejected(
      event,
      `Subgroup ${subgroupChatId} is already attached to active event ${activeConflict.id}.`
    );
  }

  const config = parseEventsConfig(await input.context.configFor(scopeId));
  const profile = config.eventProfiles.find((candidate) => candidate.id === event.profileId);
  if (!profile) {
    return rejected(event, `Event profile ${event.profileId} is no longer configured for scope ${scopeId}.`);
  }
  if (event.origin === 'unplanned' && !event.announcementGroupWid?.trim()) {
    return rejected(event, `Unplanned event ${event.id} has no persisted announcement group.`);
  }
  if (!input.context.communityGroupWidForScope) {
    return rejected(event, 'Plugin runtime does not expose the managed community mapping.');
  }
  const parentCommunityChatId = await input.context.communityGroupWidForScope(scopeId);
  if (!parentCommunityChatId) {
    return rejected(event, `No parent community is mapped for scope ${scopeId}.`);
  }

  let attendeeWids: string[];
  if (event.origin === 'unplanned') {
    attendeeWids = [];
  } else {
    attendeeWids = voterWidsForResponseBehavior(
      event,
      listVotes(db, event.id),
      'includeInEventGroup'
    );
  }
  if (!input.context.services) {
    return rejected(
      event,
      'Provisioning recovery requires the official community subgroup service.'
    );
  }
  let subgroupTitle = input.subgroupTitle?.trim() || event.subgroupTitle || event.groupTitle;
  let participantOutcomes = mergedParticipantOutcomes(
    listCreatedGroupParticipants(db, event.id),
    input.participants
  );
  const persistedRequiredCreator = getEventRequiredCreatorReference(
    db,
    event.id,
    requireRecoveryActorIdentityId(event)
  );
  if (!persistedRequiredCreator) {
    return rejected(
      event,
      `Event ${event.id} has no authoritative required creator checkpoint.`
    );
  }
  let requiredCreator: RequiredCreatorBinding | undefined;
  // poll_closed is the durable required-settings fence. calendar=included is
  // then persisted and published before COMPLETE may attempt the physical
  // link. Creator membership remains a hard precondition on every known-child
  // attempt, while settings are never replayed after poll_closed.
  try {
    const creatorLeaseEvent = getEvent(db, event.id);
    if (!creatorLeaseEvent || creatorLeaseEvent.subgroupChatId !== subgroupChatId) {
      return rejected(
        creatorLeaseEvent ?? event,
        `Event ${event.id} lost its exact claimed subgroup before creator reconciliation.`
      );
    }
    const creatorLeaseRenewedAt = nextEventRevisionTimestamp(creatorLeaseEvent.updatedAt);
    if (!renewClaimedKnownChildEventProvisioningLease(db, {
      eventId: creatorLeaseEvent.id,
      scopeId: creatorLeaseEvent.scopeId,
      subgroupChatId,
      expectedEventStatus: creatorLeaseEvent.eventStatus,
      expectedGroupLifecycleStatus: creatorLeaseEvent.groupLifecycleStatus,
      expectedUpdatedAt: creatorLeaseEvent.updatedAt,
      generation: recoveryCursor!.generation,
      attempt: recoveryCursor!.attempt,
      renewedAt: creatorLeaseRenewedAt
    })) {
      return rejected(
        getEvent(db, event.id) ?? event,
        `Event ${event.id} lost its claimed creator-reconciliation lease before provider reconciliation.`
      );
    }
    const configurationPending = creatorLeaseEvent.groupLifecycleStatus === 'poll_open' ||
      creatorLeaseEvent.groupLifecycleStatus === 'none';
    const creatorResult = await reconcileEventCommunitySubgroupCreator({
      context: input.context,
      scopeId,
      actorIdentityId: requireRecoveryActorIdentityId(event),
      subgroupChatId,
      subgroupTitle,
      requiredCreator: persistedRequiredCreator,
      participants: participantOutcomes,
      parentCommunityWid: parentCommunityChatId
    });
    const reconciledSubgroupChatId = creatorResult.created.chatId.trim().toLowerCase();
    if (reconciledSubgroupChatId !== subgroupChatId) {
      throw new Error(
        `Subgroup creator reconciliation returned ${reconciledSubgroupChatId}; expected ${subgroupChatId}.`
      );
    }
    subgroupTitle = creatorResult.created.title.trim() || subgroupTitle;
    requiredCreator = creatorResult.created.requiredCreator;
    participantOutcomes = mergeManagedParticipantOutcomeRecords(
      participantOutcomes,
      creatorResult.created
    );
    const creatorCheckpointed = checkpointClaimedEventParticipantOutcomes(db, {
      eventId: event.id,
      scopeId,
      subgroupChatId,
      subgroupTitle,
      participants: participantOutcomes,
      creator: requiredCreator,
      recoveryGeneration: recoveryCursor!.generation,
      recoveryAttempt: recoveryCursor!.attempt,
      checkpointedAt: nextEventRevisionTimestamp(creatorLeaseRenewedAt)
    });
    if (!creatorCheckpointed) {
      const changedEvent = getEvent(db, event.id) ?? event;
      return rejected(
        changedEvent,
        `Event ${event.id} changed before creator membership was checkpointed.`
      );
    }
    if (configurationPending) {
      await configureEventCommunitySubgroup({
        context: input.context,
        scopeId,
        actorIdentityId: requireRecoveryActorIdentityId(event),
        subgroupChatId,
        subgroupTitle,
        requiredCreator,
        participants: participantOutcomes,
        parentCommunityWid: parentCommunityChatId
      });
      const preparedAt = (input.now ?? new Date()).toISOString();
      const fenced = markClaimedEventReadyForCommunityLink(db, {
        eventId: event.id,
        scopeId,
        subgroupChatId,
        subgroupTitle,
        recoveryGeneration: recoveryCursor!.generation,
        recoveryAttempt: recoveryCursor!.attempt,
        closedAt: preparedAt,
        preparedAt
      });
      if (!fenced) {
        const changedEvent = getEvent(db, event.id) ?? event;
        return rejected(
          changedEvent,
          `Event ${event.id} changed before its community-link fence was persisted.`
        );
      }
    }
    const calendarIncluded = includeClaimedEventCalendarBeforeCommunityLink(db, {
      eventId: event.id,
      scopeId,
      subgroupChatId,
      recoveryGeneration: recoveryCursor!.generation,
      recoveryAttempt: recoveryCursor!.attempt,
      includedAt: (input.now ?? new Date()).toISOString()
    });
    const linkReadyEvent = getEvent(db, event.id);
    if (
      !calendarIncluded ||
      !linkReadyEvent ||
      linkReadyEvent.eventStatus !== 'failed' ||
      linkReadyEvent.groupLifecycleStatus !== 'poll_closed' ||
      linkReadyEvent.calendarStatus !== 'included' ||
      linkReadyEvent.subgroupChatId !== subgroupChatId
    ) {
      return rejected(
        linkReadyEvent ?? event,
        `Event ${event.id} changed before its calendar-visible community-link fence was verified.`
      );
    }
    await publishEventCalendarBeforeCommunityLink({
      context: input.context,
      config,
      event: linkReadyEvent
    });
    await enqueuePluginJob(input.context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      ...eventCleanupJobRequest(linkReadyEvent)
    });
    const linkLeaseRenewedAt = nextEventRevisionTimestamp(linkReadyEvent.updatedAt);
    if (!renewClaimedEventCommunityLinkLease(db, {
      eventId: linkReadyEvent.id,
      scopeId: linkReadyEvent.scopeId,
      subgroupChatId,
      expectedUpdatedAt: linkReadyEvent.updatedAt,
      generation: recoveryCursor!.generation,
      attempt: recoveryCursor!.attempt,
      renewedAt: linkLeaseRenewedAt
    })) {
      throw new Error(
        `Event ${event.id} lost its claimed community-link lease before provider completion.`
      );
    }
    const result = await completeEventCommunitySubgroup({
      context: input.context,
      scopeId,
      actorIdentityId: requireRecoveryActorIdentityId(event),
      subgroupChatId,
      subgroupTitle,
      requiredCreator,
      participantWids: attendeeWids,
      participants: participantOutcomes,
      parentCommunityWid: parentCommunityChatId
    });
    const resumedSubgroupChatId = result.created.chatId.trim().toLowerCase();
    if (resumedSubgroupChatId !== subgroupChatId) {
      throw new Error(
        `Subgroup resume returned ${resumedSubgroupChatId}; expected ${subgroupChatId}.`
      );
    }
    subgroupTitle = result.created.title.trim() || subgroupTitle;
    requiredCreator = result.created.requiredCreator;
    participantOutcomes = mergeManagedParticipantOutcomeRecords(
      participantOutcomes,
      result.created
    );
  } catch (error) {
    if (
      isManagedCommunitySubgroupProvisioningError(error) &&
      error.created.chatId.trim().toLowerCase() === subgroupChatId
    ) {
      subgroupTitle = error.created.title.trim() || subgroupTitle;
      requiredCreator = error.created.requiredCreator;
      participantOutcomes = mergeManagedParticipantOutcomeRecords(
        participantOutcomes,
        error.created
      );
      const checkpointed = checkpointClaimedEventParticipantOutcomes(db, {
        eventId: event.id,
        scopeId,
        subgroupChatId,
        subgroupTitle,
        participants: participantOutcomes,
        creator: error.created.requiredCreator,
        recoveryGeneration: recoveryCursor!.generation,
        recoveryAttempt: recoveryCursor!.attempt,
        checkpointedAt: new Date().toISOString(),
        reason: error.message
      });
      appendEventLog(db, {
        eventId: event.id,
        action: 'events.provisioning.resume_failed',
        metadata: {
          reason: error.message,
          subgroupChatId,
          subgroupTitle,
          stage: error.stage,
          progress: provisioningProgress(error.provisioning),
          participants: participantOutcomes,
          checkpointPersisted: checkpointed
        }
      });
    }
    throw error;
  }

  const resumedAt = new Date().toISOString();
  if (!requiredCreator) {
    throw new Error(`Event ${event.id} completed subgroup recovery without a strict creator binding.`);
  }
  if (event.origin === 'unplanned') {
    const actorIdentityId = requireRecoveryActorIdentityId(event);
    const resolvedLocale = await input.context.i18n.resolveIdentityLocale(
      actorIdentityId,
      event.scopeId
    );
    const completed = completeUnplannedEventProvisioning(db, {
      eventId: event.id,
      scopeId,
      subgroupChatId,
      subgroupTitle,
      participants: participantOutcomes,
      creator: requiredCreator,
      recoveryGeneration: recoveryCursor!.generation,
      recoveryAttempt: recoveryCursor!.attempt,
      recoveryNextRunAt: null,
      completedAt: resumedAt
    });
    if (!completed) {
      const changedEvent = getEvent(db, event.id) ?? event;
      return rejected(
        changedEvent,
        `Event ${event.id} changed state while its unplanned subgroup recovery was being completed.`
      );
    }
    const completedEvent = getEvent(db, event.id);
    if (
      !completedEvent ||
      completedEvent.eventStatus !== 'active' ||
      completedEvent.groupLifecycleStatus !== 'poll_closed' ||
      completedEvent.calendarStatus !== 'included' ||
      completedEvent.subgroupChatId !== subgroupChatId
    ) {
      return rejected(
        completedEvent ?? event,
        `Event ${event.id} changed state after its unplanned subgroup recovery completed.`
      );
    }

    await appendRecoveryJsonLog(input.context, {
      action: 'subgroup.created',
      scopeId: completedEvent.scopeId,
      eventId: completedEvent.id,
      actorWid: completedEvent.actorWid,
      profileId: completedEvent.profileId,
      subgroupChatId,
      metadata: {
        title: subgroupTitle,
        attendeeWids,
        participants: participantOutcomes,
        unplanned: true,
        recovery: true
      }
    });

    const activeTransport: UnplannedEventFinalizationTransport = {
      async sendText(chatId, text, options) {
        if (!input.context.sendText) {
          throw new Error('Plugin runtime does not expose durable text delivery.');
        }
        return input.context.sendText(chatId, text, options);
      }
    };
    const finalization = await attemptUnplannedEventFinalization({
      context: input.context,
      runtime: {
        config: input.context.config,
        ...(input.context.databases ? { databases: input.context.databases } : {}),
        enqueuePluginJob: (job) => enqueuePluginJob(input.context.queue, {
          pluginId: EVENTS_PLUGIN_ID,
          ...job
        })
      },
      activeTransport,
      event: completedEvent,
      profile,
      config,
      locale: resolvedLocale.locale,
      creatorDisplayName: completedEvent.actorLabel || completedEvent.actorWid,
      trigger: 'unplanned_recovery',
      notifyRecoveryCreator: true,
      now: input.now
    });
    await input.context.audit.record({
      scopeId: completedEvent.scopeId,
      ...(completedEvent.groupId ? { groupId: completedEvent.groupId } : {}),
      action: 'official.community-events.provisioning.recovered',
      targetJson: {
        eventId: completedEvent.id,
        subgroupChatId
      },
      metadataJson: {
        attendeeCount: attendeeWids.length,
        parentCommunityChatId,
        provisioningMode: 'service',
        origin: 'unplanned',
        finalizationStatus: finalization.status,
        actorWid: input.actorWid,
        actorLabel: input.actorLabel
      }
    });

    return {
      status: 'completed',
      event: completedEvent,
      resumed: true,
      attendeeCount: attendeeWids.length,
      parentCommunityChatId
    };
  }

  const completed = completeClaimedEventCommunityLink(db, {
    eventId: event.id,
    scopeId,
    subgroupChatId,
    subgroupTitle,
    participants: participantOutcomes,
    creator: requiredCreator,
    recoveryGeneration: recoveryCursor!.generation,
    recoveryAttempt: recoveryCursor!.attempt,
    completedAt: resumedAt
  });
  const completedEvent = getEvent(db, event.id);
  if (
    !completed ||
    !completedEvent ||
    completedEvent.eventStatus !== 'active' ||
    completedEvent.groupLifecycleStatus !== 'poll_closed' ||
    completedEvent.calendarStatus !== 'included' ||
    completedEvent.subgroupChatId !== subgroupChatId
  ) {
    return rejected(
      completedEvent ?? event,
      `Event ${event.id} changed state while its verified community link was being activated.`
    );
  }
  appendEventLog(db, {
    eventId: completedEvent.id,
    action: 'events.provisioning.resumed',
    metadata: {
      subgroupChatId,
      subgroupTitle,
      attendeeCount: attendeeWids.length,
      parentCommunityChatId,
      provisioningMode: 'service',
      actorWid: input.actorWid,
      actorLabel: input.actorLabel
    }
  });
  await finalizeRecoveredPlannedEventLifecycle({
    context: input.context,
    event: completedEvent,
    profile,
    config,
    now: input.now
  });
  await appendRecoveryJsonLog(input.context, {
    action: 'event.provisioning_resumed',
    scopeId: completedEvent.scopeId,
    eventId: completedEvent.id,
    actorWid: input.actorWid,
    profileId: completedEvent.profileId,
    ...(completedEvent.pollWaMsgId ? { pollWaMsgId: completedEvent.pollWaMsgId } : {}),
    subgroupChatId,
    metadata: {
      attendeeCount: attendeeWids.length,
      parentCommunityChatId,
      provisioningMode: 'service',
      actorLabel: input.actorLabel
    }
  });
  await input.context.audit.record({
    scopeId: completedEvent.scopeId,
    ...(completedEvent.groupId ? { groupId: completedEvent.groupId } : {}),
    action: 'official.community-events.provisioning.resumed',
    targetJson: {
      eventId: completedEvent.id,
      subgroupChatId
    },
    metadataJson: {
      attendeeCount: attendeeWids.length,
      parentCommunityChatId,
      provisioningMode: 'service',
      actorWid: input.actorWid,
      actorLabel: input.actorLabel
    }
  });

  return {
    status: 'completed',
    event: completedEvent,
    resumed: true,
    attendeeCount: attendeeWids.length,
    parentCommunityChatId
  };
}

async function finalizeRecoveredPlannedEventLifecycle(input: {
  context: PluginRuntimeContext;
  event: StoredEventRecord;
  profile: EventProfile;
  config: ReturnType<typeof parseEventsConfig>;
  now?: Date | undefined;
}): Promise<void> {
  const db = eventsDatabase(input.context.databases);
  const event = input.event;
  const failures: string[] = [];
  const calendarId = resolvedEventCalendarId(event);
  if (calendarId) {
    try {
      const publication = await writePublishAndRecordScopeCalendar({
        appConfig: input.context.config,
        db,
        config: input.config,
        scopeId: event.scopeId,
        calendarId,
        requestGeneration: false
      });
      if (publication && !publication.ok) {
        failures.push(`calendar: ${publication.error || 'publication failed'}`);
      }
    } catch (error) {
      failures.push(`calendar: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    await enqueuePluginJob(input.context.queue, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.cleanup,
      scopeId: event.scopeId,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.groupWid ? { groupWid: event.groupWid } : {}),
      runAt: new Date(event.cleanupAt),
      payload: { eventId: event.id, attempt: 0 },
      dedupeKey: `${EVENTS_JOBS.cleanup}:${event.id}:recovered`
    });
  } catch (error) {
    failures.push(`cleanup job: ${error instanceof Error ? error.message : String(error)}`);
  }
  const weatherRequest = eventWeatherForecastJobRequest({
    event,
    profile: input.profile,
    now: input.now
  });
  if (weatherRequest) {
    try {
      await enqueuePluginJob(input.context.queue, {
        pluginId: EVENTS_PLUGIN_ID,
        ...weatherRequest
      });
    } catch (error) {
      failures.push(`weather job: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (
    event.subgroupChatId &&
    event.announcementGroupWid &&
    eventGroupHintEnabled(input.profile, 'planned')
  ) {
    try {
      if (!input.context.sendText) {
        throw new Error('Plugin runtime does not expose durable text delivery.');
      }
      const template = input.profile.eventGroupHint.template.trim();
      const groupJoinUrl = await eventGroupJoinUrl(input.context, template, event.subgroupChatId);
      const text = renderEventGroupAnnouncement({
        template,
        profile: input.profile,
        event,
        groupDisplayName: event.subgroupTitle || event.groupTitle,
        groupJoinUrl,
        subgroupChatId: event.subgroupChatId
      });
      if (text) {
        await input.context.sendText(event.announcementGroupWid, text, {
          idempotencyKey: `event:${event.id}:planned-group-hint`
        });
      }
    } catch (error) {
      failures.push(`event group announcement: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  appendEventLog(db, {
    eventId: event.id,
    action: failures.length > 0
      ? 'events.provisioning.recovered_with_effect_failures'
      : 'events.provisioning.recovered_effects_completed',
    metadata: {
      subgroupChatId: event.subgroupChatId,
      failures
    }
  });
}

function requireRecoveryActorIdentityId(event: StoredEventRecord): string {
  const actorIdentityId = event.actorIdentityId?.trim();
  if (!actorIdentityId) {
    throw new Error(`Event ${event.id} has no authoritative creator identity for provisioning recovery.`);
  }
  return actorIdentityId;
}

export function eventProvisioningResumeDedupeKey(eventId: string, subgroupChatId: string): string {
  return `${EVENTS_JOBS.close}:${eventId}:resume:${subgroupChatId}`;
}

export function eventProvisioningRecoveryRunAt(attempt: number, now: Date): Date {
  const delay = EVENT_PROVISIONING_RECOVERY_DELAYS_MS[Math.min(
    EVENT_PROVISIONING_RECOVERY_DELAYS_MS.length - 1,
    Math.max(0, attempt - 1)
  )]!;
  return new Date(now.getTime() + delay);
}

export function eventCommunityLinkRecoveryRunAt(
  disposition: TransportCommunityLinkRecoveryDisposition | undefined,
  now: Date,
  fallbackAttempt: number
): Date {
  switch (disposition) {
    case 'verify_only':
      return new Date(now.getTime() + EVENT_PROVISIONING_LINK_VERIFY_ONLY_DELAY_MS);
    case 'creator_membership_verify_only': {
      const delay = EVENT_PROVISIONING_CREATOR_MEMBERSHIP_DELAYS_MS[Math.min(
        EVENT_PROVISIONING_CREATOR_MEMBERSHIP_DELAYS_MS.length - 1,
        Math.max(0, fallbackAttempt - 2)
      )]!;
      return new Date(now.getTime() + delay);
    }
    case 'mutation_allowed':
      return new Date(now.getTime() + EVENT_PROVISIONING_LINK_MUTATION_ALLOWED_DELAY_MS);
    case 'operator_required':
      return now;
    case undefined:
      return eventProvisioningRecoveryRunAt(fallbackAttempt, now);
  }
}

export function eventProvisioningRecoveryCursor(
  record: StoredEventRecord
): EventProvisioningRecoveryCursor | undefined {
  const generation = record.provisioningRecoveryGeneration?.trim();
  const attempt = record.provisioningRecoveryAttempt;
  if (!generation || !Number.isInteger(attempt) || Number(attempt) < 1) {
    return undefined;
  }
  return {
    generation,
    attempt: Number(attempt),
    ...(record.provisioningRecoveryNextRunAt
      ? { nextRunAt: record.provisioningRecoveryNextRunAt }
      : {})
  };
}

export function eventProvisioningRecoveryDedupeKey(
  record: StoredEventRecord,
  cursor: Pick<EventProvisioningRecoveryCursor, 'generation' | 'attempt'>
): string {
  const target = record.subgroupChatId ?? 'create_standalone';
  return `${EVENTS_JOBS.provisioningRecovery}:${record.scopeId}:${record.id}:${target}:${cursor.generation}:${cursor.attempt}`;
}

export function unplannedEventFinalizationRunAt(attempt: number, now: Date): Date {
  const delay = UNPLANNED_EVENT_FINALIZATION_DELAYS_MS[Math.min(
    UNPLANNED_EVENT_FINALIZATION_DELAYS_MS.length - 1,
    Math.max(0, attempt - 1)
  )]!;
  return new Date(now.getTime() + delay);
}

export function unplannedEventFinalizationDedupeKey(
  finalization: Pick<StoredUnplannedEventFinalization, 'eventId' | 'scopeId' | 'generation' | 'attempt'>
): string {
  return `${EVENTS_JOBS.unplannedFinalization}:${finalization.scopeId}:${finalization.eventId}:${finalization.generation}:${finalization.attempt}`;
}

function assertUnplannedEventFinalizationFence(
  db: ReturnType<typeof eventsDatabase>,
  expected: StoredEventRecord,
  expectedEventUpdatedAt: string
): void {
  const current = getEvent(db, expected.id);
  const remainsCreationLifecycle = current?.scopeId === expected.scopeId &&
    current.origin === 'unplanned' &&
    current.eventStatus === 'active' &&
    current.groupLifecycleStatus === 'poll_closed' &&
    current.calendarStatus === 'included' &&
    current.subgroupChatId === expected.subgroupChatId;
  if (!remainsCreationLifecycle || current?.updatedAt !== expectedEventUpdatedAt) {
    throw new UnplannedEventFinalizationSupersededError(
      `Unplanned event ${expected.id} changed from creation version ${expectedEventUpdatedAt}.`
    );
  }
}

function mergedParticipantOutcomes(
  stored: ReturnType<typeof listCreatedGroupParticipants>,
  supplied: Record<string, CreatedGroupParticipantResult> | undefined
): Record<string, CreatedGroupParticipantResult> {
  const persisted = Object.fromEntries(stored.map((participant) => [
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
  return mergeParticipantOutcomeRecords(persisted, supplied ?? {});
}

function mergeParticipantOutcomeRecords(
  ...records: Array<Record<string, CreatedGroupParticipantResult>>
): Record<string, CreatedGroupParticipantResult> {
  const merged: Record<string, CreatedGroupParticipantResult> = {};
  for (const record of records) {
    for (const [wid, outcome] of Object.entries(record)) {
      const previous = merged[wid];
      merged[wid] = {
        ...(outcome.statusCode !== undefined ? { statusCode: outcome.statusCode } : {}),
        ...(outcome.message ? { message: outcome.message } : {}),
        isGroupCreator: previous?.isGroupCreator === true || outcome.isGroupCreator,
        isInviteV4Sent: outcome.isInviteV4Sent,
        ...(outcome.requiredCreatorMembershipStatus ?? previous?.requiredCreatorMembershipStatus
          ? {
              requiredCreatorMembershipStatus:
                outcome.requiredCreatorMembershipStatus ?? previous?.requiredCreatorMembershipStatus
            }
          : {})
      };
    }
  }
  return merged;
}

function mergeManagedParticipantOutcomeRecords(
  previous: Record<string, CreatedGroupParticipantResult>,
  created: ManagedCommunitySubgroup
): Record<string, CreatedGroupParticipantResult> {
  const creatorWid = created.requiredCreator.participantWid.trim();
  const merged = mergeParticipantOutcomeRecords(previous, created.participants);
  const creatorOutcome = created.participants[creatorWid];
  if (!creatorWid || !creatorOutcome?.requiredCreatorMembershipStatus) {
    throw new Error(
      `Managed subgroup ${created.chatId} has no exact required creator outcome for ${creatorWid || 'missing WID'}.`
    );
  }
  return Object.fromEntries(Object.entries(merged).map(([wid, participant]) => {
    if (wid === creatorWid || participant.requiredCreatorMembershipStatus === undefined) {
      return [wid, participant];
    }
    const { requiredCreatorMembershipStatus: _discarded, ...ordinaryParticipant } = participant;
    return [wid, ordinaryParticipant];
  }));
}

function provisioningProgress(input: {
  standaloneRegistered: boolean;
  attendeesReconciled: boolean;
  communityLinkConfirmed: boolean;
  linkedChildRegistered: boolean;
}): Record<string, boolean> {
  return {
    standaloneRegistered: input.standaloneRegistered,
    attendeesReconciled: input.attendeesReconciled,
    communityLinkConfirmed: input.communityLinkConfirmed,
    linkedChildRegistered: input.linkedChildRegistered
  };
}

function recoverableWithSubgroup(event: StoredEventRecord, subgroupChatId: string): boolean {
  if (
    event.eventStatus === 'failed' &&
    (event.groupLifecycleStatus === 'none' || event.groupLifecycleStatus === 'poll_closed')
  ) {
    return event.subgroupChatId === subgroupChatId;
  }
  return event.eventStatus === 'active' &&
    event.groupLifecycleStatus === 'poll_open' &&
    event.subgroupChatId === subgroupChatId;
}

function completedWithSubgroup(event: StoredEventRecord, subgroupChatId: string): boolean {
  if (event.subgroupChatId !== subgroupChatId) {
    return false;
  }
  return (
    event.eventStatus === 'active' &&
    (event.groupLifecycleStatus === 'poll_closed' || event.groupLifecycleStatus === 'cleanup_failed')
  ) || (
    event.eventStatus === 'completed' &&
    (event.groupLifecycleStatus === 'poll_closed' ||
      event.groupLifecycleStatus === 'cleanup_failed' ||
      event.groupLifecycleStatus === 'cleaned')
  );
}

function rejected(event: StoredEventRecord, reason: string): Extract<
  ResumeEventProvisioningResult,
  { status: 'rejected' }
> {
  return { status: 'rejected', reason, event };
}

async function appendRecoveryJsonLog(
  context: PluginRuntimeContext,
  entry: Parameters<typeof appendScopeEventJsonLog>[0]['entry']
): Promise<void> {
  try {
    await appendScopeEventJsonLog({ appConfig: context.config, entry });
  } catch (error) {
    context.logger.warn(
      { error, action: entry.action, scopeId: entry.scopeId },
      'Unable to append official.community-events provisioning recovery JSONL log'
    );
  }
}

async function appendFinalizationJsonLog(
  context: UnplannedEventFinalizationContext,
  entry: Parameters<typeof appendScopeEventJsonLog>[0]['entry']
): Promise<void> {
  try {
    await appendScopeEventJsonLog({ appConfig: context.config, entry });
  } catch {
    // Durable event state and delivery claims remain authoritative when the operator JSONL is unavailable.
  }
}
