import { randomUUID } from 'node:crypto';
import { enqueuePluginJob } from '@wabs/plugin-sdk/jobs';
import type { PluginRuntimeContext } from './runtime';
import type { PluginGroupDismantleResult } from './runtime';
import type { CommunitySubgroupLinkProbe } from '@wabs/plugin-sdk/transport';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import {
  EVENT_CLEANUP_CLAIM_LEASE_MS,
  abortClaimedRejectedEventChildReplacementBeforeDismantle,
  appendEventLog,
  authorizeClaimedRejectedEventChildDismantle,
  claimRejectedEventChildReplacement,
  completeClaimedRejectedEventChildReplacement,
  eventsDatabase,
  failClaimedRejectedEventChildReplacement,
  getEvent,
  getRejectedEventChildReplacementOperationStatus,
  renewEventCleanupClaim,
  type EventCleanupClaim,
  type RejectedEventChildReplacementExpectation,
  type StoredEventRecord
} from './store';
import {
  eventProvisioningRecoveryCursor,
  eventProvisioningRecoveryDedupeKey
} from './provisioningRecovery';

export interface ReplaceRejectedEventChildInput extends RejectedEventChildReplacementExpectation {
  context: PluginRuntimeContext;
  confirm: true;
  expectedParentCommunityJid: string;
  probeRejectedChildLink(): Promise<CommunitySubgroupLinkProbe>;
  now?: Date | undefined;
}

export type ReplaceRejectedEventChildResult =
  | {
      status: 'replacement_scheduled';
      event: StoredEventRecord;
      rejectedSubgroupChatId: string;
      replacementGeneration: string;
      enqueued: boolean;
      replayed: boolean;
    }
  | {
      status: 'replacement_in_progress';
      event: StoredEventRecord;
      claimExpiresAt: string;
    }
  | {
      status: 'dismantle_failed';
      event: StoredEventRecord;
      reason: string;
      dismantleResult?: PluginGroupDismantleResult | undefined;
    }
  | {
      status: 'expired_cleaned';
      event: StoredEventRecord;
    }
  | {
      status: 'not_found' | 'rejected';
      reason: string;
      event?: StoredEventRecord | undefined;
    };

/**
 * Retires one exact WhatsApp-rejected legacy child and restarts the same event
 * through the ordinary candidate pipeline. This action never retries or links
 * the rejected child: the recovery cursor is consumed before dismantling and
 * a successful reset has no subgroup ID at all.
 */
export async function replaceRejectedEventChildFromOperator(
  input: ReplaceRejectedEventChildInput
): Promise<ReplaceRejectedEventChildResult> {
  const now = input.now ?? new Date();
  const db = eventsDatabase(input.context.databases);
  const expectation = replacementExpectation(input);
  let latestProbe: CommunitySubgroupLinkProbe | undefined;
  const finish = async <T extends ReplaceRejectedEventChildResult>(result: T): Promise<T> => {
    try {
      await input.context.audit.record({
        scopeId: expectation.scopeId,
        action: 'official.community-events.provisioning.replace_rejected_child',
        targetJson: {
          eventId: expectation.eventId,
          rejectedSubgroupChatId: expectation.rejectedSubgroupChatId
        },
        metadataJson: {
          operationId: expectation.operationId,
          failureKind: expectation.failureKind,
          reason: expectation.reason,
          actorWid: expectation.actorWid,
          actorLabel: expectation.actorLabel,
          status: result.status,
          ...(latestProbe ? { linkProbe: linkProbeAudit(latestProbe) } : {}),
          ...('enqueued' in result ? { enqueued: result.enqueued } : {})
        }
      });
    } catch (error) {
      input.context.logger.warn(
        { error, eventId: expectation.eventId, operationId: expectation.operationId },
        'Unable to audit rejected event child replacement'
      );
    }
    return result;
  };

  const existingOperation = getRejectedEventChildReplacementOperationStatus(
    db,
    expectation,
    now.toISOString()
  );
  if (existingOperation?.status === 'already_scheduled') {
    const enqueued = await enqueueReplacementRecovery(input.context, existingOperation.event, db);
    return finish({
      status: 'replacement_scheduled',
      event: existingOperation.event,
      rejectedSubgroupChatId: expectation.rejectedSubgroupChatId,
      replacementGeneration: existingOperation.replacementGeneration,
      enqueued,
      replayed: true
    });
  }
  if (existingOperation?.status === 'already_expired') {
    return finish({ status: 'expired_cleaned', event: existingOperation.event });
  }
  if (existingOperation?.status === 'in_progress') {
    return finish({
      status: 'replacement_in_progress',
      event: existingOperation.event,
      claimExpiresAt: existingOperation.claim.leaseExpiresAt
    });
  }
  if (existingOperation?.status === 'aborted') {
    return finish({
      status: 'rejected',
      reason: existingOperation.reason,
      event: existingOperation.event
    });
  }
  const dismantleAlreadyAuthorized = existingOperation?.status === 'dismantle_authorized';

  if (!dismantleAlreadyAuthorized) {
    try {
      latestProbe = await input.probeRejectedChildLink();
      assertRejectedChildUnlinkedProbe(input, latestProbe);
    } catch (error) {
      return finish({
        status: 'rejected',
        reason: `Rejected subgroup safety probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      });
    }
  }

  const claimed = claimRejectedEventChildReplacement(db, {
    ...expectation,
    claimedAt: now.toISOString()
  });
  if (claimed.status === 'not_found' || claimed.status === 'rejected') {
    return finish(claimed);
  }
  if (claimed.status === 'in_progress') {
    return finish({
      status: 'replacement_in_progress',
      event: claimed.event,
      claimExpiresAt: claimed.claim.leaseExpiresAt
    });
  }
  if (claimed.status === 'already_expired') {
    return finish({ status: 'expired_cleaned', event: claimed.event });
  }
  if (claimed.status === 'already_scheduled') {
    const enqueued = await enqueueReplacementRecovery(input.context, claimed.event, db);
    return finish({
      status: 'replacement_scheduled',
      event: claimed.event,
      rejectedSubgroupChatId: expectation.rejectedSubgroupChatId,
      replacementGeneration: claimed.replacementGeneration,
      enqueued,
      replayed: true
    });
  }
  if (claimed.status !== 'claimed') {
    return finish({
      status: 'rejected',
      reason: `Unexpected rejected-child replacement claim state ${claimed.status}.`,
      ...('event' in claimed && claimed.event ? { event: claimed.event } : {})
    });
  }

  if (!dismantleAlreadyAuthorized) {
    try {
      latestProbe = await input.probeRejectedChildLink();
      assertRejectedChildUnlinkedProbe(input, latestProbe);
      const authorized = authorizeClaimedRejectedEventChildDismantle(db, {
        ...expectation,
        claim: claimed.claim,
        authorizedAt: (input.now ?? new Date()).toISOString(),
        probe: linkProbeAudit(latestProbe)
      });
      if (!authorized) {
        throw new Error('event changed before dismantle authorization was persisted');
      }
    } catch (error) {
      const reason = `Final rejected subgroup safety probe failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      const aborted = abortClaimedRejectedEventChildReplacementBeforeDismantle(db, {
        ...expectation,
        claim: claimed.claim,
        abortReason: reason,
        abortedAt: (input.now ?? new Date()).toISOString()
      });
      return finish({
        status: 'rejected',
        reason: aborted
          ? reason
          : `${reason}; the replacement claim also changed before it could be restored.`,
        ...(getEvent(db, expectation.eventId)
          ? { event: getEvent(db, expectation.eventId)! }
          : {})
      });
    }
  }

  let dismantleResult: PluginGroupDismantleResult | undefined;
  try {
    if (!input.context.dismantleManagedGroup) {
      throw new Error('Plugin runtime does not expose dismantleManagedGroup.');
    }
    dismantleResult = await withReplacementClaimHeartbeat(db, claimed.claim, () =>
      input.context.dismantleManagedGroup!({
        scopeId: expectation.scopeId,
        chatId: expectation.rejectedSubgroupChatId,
        reason: `replace rejected event subgroup (${expectation.operationId})`
      })
    );
    if (!dismantleCompleted(dismantleResult)) {
      const reason = dismantleIncompleteReason(dismantleResult);
      return finish(recordDismantleFailure({
        input,
        expectation,
        claim: claimed.claim,
        reason,
        dismantleResult
      }));
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return finish(recordDismantleFailure({
      input,
      expectation,
      claim: claimed.claim,
      reason
    }));
  }

  const replacementGeneration = randomUUID();
  const completed = completeClaimedRejectedEventChildReplacement(db, {
    ...expectation,
    claim: claimed.claim,
    replacementGeneration,
    completedAt: (input.now ?? new Date()).toISOString()
  });
  if (completed.status === 'stale') {
    return finish({
      status: 'rejected',
      reason: `Event ${expectation.eventId} changed after its rejected child was dismantled.`,
      ...(completed.event ? { event: completed.event } : {})
    });
  }
  if (completed.status === 'expired_cleaned') {
    return finish({ status: 'expired_cleaned', event: completed.event });
  }
  const enqueued = await enqueueReplacementRecovery(input.context, completed.event, db);
  return finish({
    status: 'replacement_scheduled',
    event: completed.event,
    rejectedSubgroupChatId: expectation.rejectedSubgroupChatId,
    replacementGeneration,
    enqueued,
    replayed: claimed.replayed
  });
}

function replacementExpectation(
  input: ReplaceRejectedEventChildInput
): RejectedEventChildReplacementExpectation {
  if (input.confirm !== true) {
    throw new Error('Rejected-child replacement requires explicit confirmation.');
  }
  return {
    eventId: input.eventId.trim(),
    scopeId: input.scopeId.trim(),
    rejectedSubgroupChatId: input.rejectedSubgroupChatId.trim().toLowerCase(),
    expectedUpdatedAt: input.expectedUpdatedAt,
    expectedProvisioningGeneration: input.expectedProvisioningGeneration.trim(),
    expectedProvisioningAttempt: input.expectedProvisioningAttempt,
    expectedProvisioningHaltedAt: input.expectedProvisioningHaltedAt,
    operationId: input.operationId.trim(),
    failureKind: input.failureKind,
    reason: input.reason.trim(),
    actorWid: input.actorWid.trim(),
    actorLabel: input.actorLabel.trim()
  };
}

function assertRejectedChildUnlinkedProbe(
  input: ReplaceRejectedEventChildInput,
  probe: CommunitySubgroupLinkProbe
): void {
  const child = input.rejectedSubgroupChatId.trim().toLowerCase();
  const parent = input.expectedParentCommunityJid.trim().toLowerCase();
  if (
    probe.childGroupJid.trim().toLowerCase() !== child ||
    probe.parentCommunityJid.trim().toLowerCase() !== parent ||
    probe.child.requestedJid.trim().toLowerCase() !== child ||
    probe.parent.requestedJid.trim().toLowerCase() !== parent
  ) {
    throw new Error('probe target does not match the exact rejected child and scope parent');
  }
  if (probe.child.linkedParent !== null) {
    throw new Error(`child is already linked to ${probe.child.linkedParent}`);
  }
  // Creator absence is one legacy defect this action can safely repair. Every
  // structural, addressing, and bot-authority blocker remains fatal; the
  // replacement pipeline will establish the creator invariant on the new child.
  const unsafeBlockers = probe.blockers.filter(
    (blocker) => blocker.code !== 'required_participant_missing'
  );
  const expectedIdentityIds = new Set(
    probe.expectedParticipantIdentities.map((participant) => participant.identityId)
  );
  const onlyExpectedCreatorMissing =
    probe.blockers.length > 0 &&
    unsafeBlockers.length === 0 &&
    probe.missingExpectedParticipantIdentityIds.length > 0 &&
    probe.missingExpectedParticipantIdentityIds.every((identityId) =>
      expectedIdentityIds.has(identityId)
    );
  const structurallyReady = probe.readyForMutation && probe.blockers.length === 0;
  if (
    (!structurallyReady && !onlyExpectedCreatorMissing) ||
    probe.child.metadataError !== null ||
    probe.parent.metadataError !== null
  ) {
    throw new Error(
      `child/parent structure is not safely readable and mutation-ready (${unsafeBlockers
        .map((blocker) => blocker.code)
        .join(', ') || 'metadata unreadable'})`
    );
  }
}

function linkProbeAudit(probe: CommunitySubgroupLinkProbe): Record<string, unknown> {
  return {
    observedAt: probe.observedAt,
    childGroupJid: probe.childGroupJid,
    parentCommunityJid: probe.parentCommunityJid,
    readyForMutation: probe.readyForMutation,
    blockerCodes: probe.blockers.map((blocker) => blocker.code),
    childObservedJid: probe.child.observedJid,
    childLinkedParent: probe.child.linkedParent,
    childBotIsAdmin: probe.child.botIsAdmin,
    parentObservedJid: probe.parent.observedJid,
    parentBotIsAdmin: probe.parent.botIsAdmin,
    expectedParticipantIdentityIds: probe.expectedParticipantIdentities.map(
      (participant) => participant.identityId
    ),
    missingExpectedParticipantIdentityIds: probe.missingExpectedParticipantIdentityIds
  };
}

async function enqueueReplacementRecovery(
  context: PluginRuntimeContext,
  event: StoredEventRecord,
  db: ReturnType<typeof eventsDatabase>
): Promise<boolean> {
  const cursor = eventProvisioningRecoveryCursor(event);
  if (!cursor?.nextRunAt || event.subgroupChatId) {
    return false;
  }
  try {
    await enqueuePluginJob(context, {
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
      },
      dedupeKey: eventProvisioningRecoveryDedupeKey(event, {
        ...cursor,
        nextRunAt: cursor.nextRunAt
      })
    });
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.provisioning.legacy_child_replacement_enqueue_failed',
      metadata: {
        generation: cursor.generation,
        attempt: cursor.attempt,
        runAt: cursor.nextRunAt,
        reason
      }
    });
    context.logger.error(
      { error, eventId: event.id, generation: cursor.generation, attempt: cursor.attempt },
      'Unable to enqueue durable replacement event subgroup recovery'
    );
    return false;
  }
}

function recordDismantleFailure(input: {
  input: ReplaceRejectedEventChildInput;
  expectation: RejectedEventChildReplacementExpectation;
  claim: Parameters<typeof failClaimedRejectedEventChildReplacement>[1]['claim'];
  reason: string;
  dismantleResult?: PluginGroupDismantleResult | undefined;
}):
  | Extract<ReplaceRejectedEventChildResult, { status: 'dismantle_failed' }>
  | {
      status: 'rejected';
      reason: string;
      event?: StoredEventRecord | undefined;
    } {
  const db = eventsDatabase(input.input.context.databases);
  const failed = failClaimedRejectedEventChildReplacement(db, {
    ...input.expectation,
    claim: input.claim,
    failureReason: input.reason,
    failedAt: (input.input.now ?? new Date()).toISOString()
  });
  const event = getEvent(db, input.expectation.eventId);
  if (!failed || !event) {
    return {
      status: 'rejected',
      reason: `Event ${input.expectation.eventId} changed while dismantle failure was recorded.`,
      ...(event ? { event } : {})
    };
  }
  return {
    status: 'dismantle_failed',
    event,
    reason: input.reason,
    ...(input.dismantleResult ? { dismantleResult: input.dismantleResult } : {})
  };
}

async function withReplacementClaimHeartbeat<T>(
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
      throw new Error(
        `Replacement claim ${claim.claimId} was lost while dismantling event ${claim.eventId}.`
      );
    }
    return result;
  } finally {
    clearInterval(timer);
  }
}

function dismantleCompleted(result: PluginGroupDismantleResult): boolean {
  return result.alreadyAbsent === true ||
    result.left ||
    result.chatDeleted ||
    result.managementMarkedLeft === true;
}

function dismantleIncompleteReason(result: PluginGroupDismantleResult): string {
  const reasons = [
    ...(result.failedRemovals.length > 0
      ? [`failed to remove ${result.failedRemovals.length} subgroup participants`]
      : []),
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
