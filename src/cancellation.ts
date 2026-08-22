import type { PluginCommandContext, PluginGroupDismantleResult } from '../../../platform/pluginRuntime/types';
import { parseEventsConfig } from './config';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import { appendScopeEventJsonLog } from './log';
import {
  appendEventLog,
  claimEventCancellationCleanup,
  EVENT_CLEANUP_CLAIM_LEASE_MS,
  hasActiveEventPollReplacement,
  markClaimedEventCancelled,
  markEventCancelled,
  releaseEventCleanupClaim,
  renewEventCleanupClaim,
  resolvedEventCalendarId,
  listEventAnnouncementMessages,
  type EventCalendarStatus,
  type EventCleanupClaim,
  type StoredEventRecord
} from './store';
import type { OfficialPluginCommandRuntime } from '../shared';
import type { MessageDeletionResult } from '../../../platform/transport/transportTypes';
import type { EventArtifactDeletionResult } from './eventArtifactDeletion';
import { EVENTS_JOBS } from './manifest';
import { releaseEligibleEventPollReplacementReceipts } from './pollReplacement';

export interface EventCancellationActor {
  wid: string;
  label: string;
}

export type EventCancellationCalendarDisposition = Extract<EventCalendarStatus, 'cancelled' | 'hidden'>;

export type EventAnnouncementMessageDeletionResult = EventArtifactDeletionResult;

export type EventCancellationResult =
  | {
      status: 'cancelled';
      cancelledAt: string;
      calendarDisposition: EventCancellationCalendarDisposition;
      dismantleResult?: PluginGroupDismantleResult | undefined;
      announcementMessageDeletion?: EventAnnouncementMessageDeletionResult | undefined;
      pollReceiptReleasePending?: boolean | undefined;
    }
  | { status: 'not_cancellable'; reason: string }
  | { status: 'cleanup_failed'; reason: string; dismantleResult?: PluginGroupDismantleResult | undefined };

export async function cancelEventLifecycle(input: {
  context: PluginCommandContext;
  runtime: OfficialPluginCommandRuntime;
  db: Parameters<typeof markEventCancelled>[0];
  event: StoredEventRecord;
  actor: EventCancellationActor;
  calendarDisposition?: EventCancellationCalendarDisposition | undefined;
  deleteAnnouncementMessages?: boolean | undefined;
  deleteMessage?: ((messageId: string) => Promise<MessageDeletionResult | void>) | undefined;
  reason?: string | undefined;
  now?: Date | undefined;
}): Promise<EventCancellationResult> {
  const { context, runtime, db, event, actor } = input;
  const calendarDisposition = input.calendarDisposition ?? 'cancelled';
  if (event.eventStatus !== 'active' ||
      (event.groupLifecycleStatus !== 'poll_open' && event.groupLifecycleStatus !== 'poll_closed' && event.groupLifecycleStatus !== 'cleanup_failed')) {
    return { status: 'not_cancellable', reason: `event lifecycle is ${event.eventStatus}/${event.groupLifecycleStatus}` };
  }
  if (
    event.provisioningRecoveryGeneration !== undefined ||
    event.provisioningRecoveryAttempt !== undefined ||
    event.provisioningRecoveryNextRunAt !== undefined
  ) {
    return { status: 'not_cancellable', reason: 'event subgroup provisioning is in progress' };
  }
  if (hasActiveEventPollReplacement(db, event.id)) {
    return { status: 'not_cancellable', reason: 'event poll replacement is in progress' };
  }

  const now = input.now ?? new Date();
  if (new Date(event.endsAt).getTime() <= now.getTime()) {
    return { status: 'not_cancellable', reason: 'event has already ended' };
  }
  const cancelledAt = now.toISOString();
  let cancelled = false;
  const cancellationClaim = event.groupLifecycleStatus === 'poll_closed' ||
    event.groupLifecycleStatus === 'cleanup_failed'
    ? claimEventCancellationCleanup(db, {
        eventId: event.id,
        expectedUpdatedAt: event.updatedAt,
        claimedAt: cancelledAt
      })
    : undefined;
  if (event.groupLifecycleStatus !== 'poll_open' && !cancellationClaim) {
    return { status: 'not_cancellable', reason: 'event lifecycle changed during cancellation claim' };
  }
  // Poll-open cancellation wins its CAS before any awaited destructive work.
  // beginEventPollReplacement uses the inverse active/open fence, so exactly
  // one of cancellation or replacement can become authoritative.
  if (event.groupLifecycleStatus === 'poll_open') {
    cancelled = markEventCancelled(db, {
      eventId: event.id,
      expectedUpdatedAt: event.updatedAt,
      cancelledAt,
      cancelledByWid: actor.wid,
      cancelledByLabel: actor.label,
      calendarStatus: calendarDisposition,
      deleteAnnouncementMessages: input.deleteAnnouncementMessages !== false,
      ...(input.reason ? { reason: input.reason } : {})
    });
    if (!cancelled) {
      return { status: 'not_cancellable', reason: 'event lifecycle changed during cancellation' };
    }
  }

  let dismantleResult: PluginGroupDismantleResult | undefined;
  if ((event.groupLifecycleStatus === 'poll_closed' || event.groupLifecycleStatus === 'cleanup_failed') && event.subgroupChatId) {
    if (!context.dismantleManagedGroup) {
      const reason = 'Plugin runtime does not expose dismantleManagedGroup.';
      try {
        await recordCancellationFailure(context, runtime, db, event, actor, reason);
      } finally {
        releaseCancellationClaim(db, cancellationClaim);
      }
      return { status: 'cleanup_failed', reason };
    }
    try {
      dismantleResult = await withCancellationClaimHeartbeat(db, cancellationClaim!, () =>
        context.dismantleManagedGroup!({
          scopeId: event.scopeId,
          chatId: event.subgroupChatId!,
          reason: 'event cancellation'
        })
      );
      if (!cancellationDismantleCompleted(dismantleResult)) {
        const reason = cancellationDismantleIncompleteReason(dismantleResult);
        try {
          await recordCancellationFailure(context, runtime, db, event, actor, reason, dismantleResult);
        } finally {
          releaseCancellationClaim(db, cancellationClaim);
        }
        return { status: 'cleanup_failed', reason, dismantleResult };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        await recordCancellationFailure(context, runtime, db, event, actor, reason);
      } finally {
        releaseCancellationClaim(db, cancellationClaim);
      }
      return { status: 'cleanup_failed', reason };
    }
  }

  if (!cancelled) {
    if (!renewEventCleanupClaim(db, {
      eventId: cancellationClaim!.eventId,
      claimId: cancellationClaim!.claimId,
      expectedUpdatedAt: cancellationClaim!.expectedEventUpdatedAt,
      leaseExpiresAt: new Date(Date.now() + EVENT_CLEANUP_CLAIM_LEASE_MS).toISOString()
    })) {
      releaseCancellationClaim(db, cancellationClaim);
      return { status: 'not_cancellable', reason: 'event cancellation claim was lost' };
    }
    try {
      cancelled = markClaimedEventCancelled(db, {
        eventId: event.id,
        claimId: cancellationClaim!.claimId,
        expectedUpdatedAt: event.updatedAt,
        cancelledAt,
        cancelledByWid: actor.wid,
        cancelledByLabel: actor.label,
        calendarStatus: calendarDisposition,
        deleteAnnouncementMessages: input.deleteAnnouncementMessages !== false,
        ...(input.reason ? { reason: input.reason } : {})
      });
    } catch (error) {
      releaseCancellationClaim(db, cancellationClaim);
      throw error;
    }
    if (!cancelled) {
      releaseCancellationClaim(db, cancellationClaim);
      return { status: 'not_cancellable', reason: 'event lifecycle changed during cancellation' };
    }
  }
  const cancellationArtifacts = input.deleteAnnouncementMessages !== false
    ? listEventAnnouncementMessages(db, event.id).filter((artifact) => artifact.deletionStatus === 'pending')
    : [];
  const announcementMessageDeletion = input.deleteAnnouncementMessages !== false
    ? {
        requested: true as const,
        attempted: 0,
        deleted: [],
        unconfirmed: cancellationArtifacts.map((artifact) => ({
          id: artifact.id,
          kind: artifact.kind,
          chatId: artifact.chatId,
          messageId: artifact.messageId
        })),
        failed: []
      }
    : undefined;
  if (cancellationArtifacts.length > 0) {
    try {
      await runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.cancellationCleanup,
        scopeId: event.scopeId,
        ...(event.groupId ? { groupId: event.groupId } : {}),
        ...(event.groupWid ? { groupWid: event.groupWid } : {}),
        payload: { eventId: event.id },
        dedupeKey: `${EVENTS_JOBS.cancellationCleanup}:${event.id}:initial:${cancelledAt}`
      });
    } catch (error) {
      appendEventLog(db, {
        eventId: event.id,
        action: 'events.cancellation_artifact_cleanup_enqueue_failed',
        metadata: { reason: error instanceof Error ? error.message : String(error) }
      });
    }
  }
  const receiptReleaseRetries = await releaseEligibleEventPollReplacementReceipts({
    context,
    db,
    eventId: event.id,
    now: new Date(cancelledAt)
  });
  const receiptReleaseEnqueueFailures: Array<{ operationId: string; reason: string }> = [];
  for (const retry of receiptReleaseRetries) {
    try {
      await runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.pollReplacement,
        scopeId: retry.scopeId,
        ...(event.groupId ? { groupId: event.groupId } : {}),
        ...(event.groupWid ? { groupWid: event.groupWid } : {}),
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
  await setCleanupFailureStatus(runtime, event.scopeId, null);
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.cancelled',
    metadata: {
      previousEventStatus: event.eventStatus,
      previousGroupLifecycleStatus: event.groupLifecycleStatus,
      calendarDisposition,
      actorWid: actor.wid,
      actorLabel: actor.label,
      reason: input.reason,
      dismantleResult,
      announcementMessageDeletion,
      pollReceiptReleasePending: receiptReleaseRetries.length > 0,
      receiptReleaseEnqueueFailures
    }
  });
  await appendEventJsonLog(context, {
    action: 'event.cancelled',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: actor.wid,
    profileId: event.profileId,
    ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
    ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
    metadata: {
      previousEventStatus: event.eventStatus,
      previousGroupLifecycleStatus: event.groupLifecycleStatus,
      calendarDisposition,
      actorLabel: actor.label,
      reason: input.reason,
      dismantleResult,
      announcementMessageDeletion,
      pollReceiptReleasePending: receiptReleaseRetries.length > 0,
      receiptReleaseEnqueueFailures
    }
  });
  try {
    await refreshCalendar(runtime, db, event);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.cancel.calendar_refresh_failed',
      metadata: { reason }
    });
    await appendEventJsonLog(context, {
      action: 'event.cancel_calendar_refresh_failed',
      scopeId: event.scopeId,
      eventId: event.id,
      actorWid: actor.wid,
      profileId: event.profileId,
      ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
      ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
      metadata: { reason }
    });
  }
  return {
    status: 'cancelled',
    cancelledAt,
    calendarDisposition,
    ...(announcementMessageDeletion ? { announcementMessageDeletion } : {}),
    ...(dismantleResult ? { dismantleResult } : {}),
    ...(receiptReleaseRetries.length > 0 ? { pollReceiptReleasePending: true } : {})
  };
}

async function withCancellationClaimHeartbeat<T>(
  db: Parameters<typeof markEventCancelled>[0],
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
        `Cancellation claim ${claim.claimId} renewal failed for event ${claim.eventId}: ` +
        (renewalError instanceof Error ? renewalError.message : String(renewalError))
      );
    }
    if (ownershipLost || !renewed) {
      throw new Error(`Cancellation claim ${claim.claimId} was lost for event ${claim.eventId}.`);
    }
    return result;
  } finally {
    clearInterval(timer);
  }
}

function releaseCancellationClaim(
  db: Parameters<typeof markEventCancelled>[0],
  claim: ReturnType<typeof claimEventCancellationCleanup>
): void {
  if (claim) {
    releaseEventCleanupClaim(db, { eventId: claim.eventId, claimId: claim.claimId });
  }
}

async function recordCancellationFailure(
  context: PluginCommandContext,
  runtime: OfficialPluginCommandRuntime,
  db: Parameters<typeof markEventCancelled>[0],
  event: StoredEventRecord,
  actor: EventCancellationActor,
  reason: string,
  dismantleResult?: PluginGroupDismantleResult | undefined
): Promise<void> {
  const failedAt = new Date().toISOString();
  await setCleanupFailureStatus(runtime, event.scopeId, {
    message: event.subgroupChatId
      ? `Event subgroup ${event.subgroupChatId} cancellation cleanup failed: ${reason}`
      : `Event cancellation cleanup failed: ${reason}`,
    at: failedAt
  });
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.cancel.failed',
    metadata: {
      reason,
      actorWid: actor.wid,
      actorLabel: actor.label,
      dismantleResult
    }
  });
  await appendEventJsonLog(context, {
    action: 'event.cancel_failed',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: actor.wid,
    profileId: event.profileId,
    ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
    ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
    metadata: {
      reason,
      actorLabel: actor.label,
      dismantleResult
    }
  });
}

async function refreshCalendar(
  runtime: OfficialPluginCommandRuntime,
  db: Parameters<typeof markEventCancelled>[0],
  event: StoredEventRecord
): Promise<void> {
  const config = parseEventsConfig(await runtime.configFor(event.scopeId));
  const calendarId = resolvedEventCalendarId(event);
  if (!calendarId) {
    return;
  }
  await writePublishAndRecordScopeCalendar({
    appConfig: runtime.config,
    db,
    config,
    scopeId: event.scopeId,
    calendarId
  });
}

async function setCleanupFailureStatus(
  runtime: OfficialPluginCommandRuntime,
  scopeId: string,
  failure: { message: string; at: string } | null
): Promise<void> {
  try {
    const config = parseEventsConfig(await runtime.configFor(scopeId));
    await runtime.setConfig(scopeId, {
      cleanup: {
        ...config.cleanup,
        lastFailureMessage: failure?.message ?? '',
        lastFailureAt: failure?.at ?? ''
      }
    });
  } catch {
    // Cancellation should not fail just because cleanup status could not be refreshed.
  }
}

async function appendEventJsonLog(
  context: PluginCommandContext,
  entry: Parameters<typeof appendScopeEventJsonLog>[0]['entry']
): Promise<void> {
  try {
    await appendScopeEventJsonLog({ appConfig: context.config, entry });
  } catch {
    // Do not fail event cancellation just because the append-only operator log is unavailable.
  }
}

function partialCancellationCleanupReason(result: PluginGroupDismantleResult): string {
  return `failed to remove ${result.failedRemovals.length} subgroup participant${result.failedRemovals.length === 1 ? '' : 's'}: ${
    result.failedRemovals.map((failure) => `${failure.wid} (${failure.reason})`).join(', ')
  }`;
}

function cancellationDismantleIncompleteReason(result: PluginGroupDismantleResult): string {
  const reasons = [
    ...(result.failedRemovals.length > 0 ? [partialCancellationCleanupReason(result)] : []),
    ...(result.leaveFailed ? [`failed to leave subgroup: ${result.leaveFailed}`] : []),
    ...(result.chatDeleteFailed ? [`failed to delete subgroup chat: ${result.chatDeleteFailed}`] : []),
    ...(result.managementMarkLeftFailed
      ? [`failed to mark subgroup left: ${result.managementMarkLeftFailed}`]
      : [])
  ];
  return reasons.length > 0
    ? reasons.join('; ')
    : 'subgroup was not left, deleted, or marked left after dismantle';
}

function cancellationDismantleCompleted(result: PluginGroupDismantleResult): boolean {
  return result.alreadyAbsent === true ||
    result.left ||
    result.chatDeleted ||
    result.managementMarkedLeft === true;
}
