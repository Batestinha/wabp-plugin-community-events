import { createHash, randomUUID } from 'node:crypto';
import type { PluginCommandContext } from '../../../platform/pluginRuntime/types';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { PluginDatabase } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import { isPluginServiceNotInvokedError } from '../../../platform/pluginRuntime/pluginServices';
import {
  isDefinitelyNotSentTransportError,
  isTransportProviderUnavailableError
} from '../../../platform/transport/transportErrors';
import {
  DOAS_POLL_PUBLISH_METHOD,
  DOAS_POLL_RECONCILE_METHOD,
  DOAS_POLL_SERVICE_ID,
  type DoasPollPublishOutput,
  type DoasPollReconcileOutput
} from '../doas/serviceApi';
import { deleteEventArtifacts } from './eventArtifactDeletion';
import { EVENTS_PLUGIN_ID } from './manifest';
import {
  abortPublishedEventPollReplacement,
  abortEventPollReplacement,
  abortUnstartedEventPollReplacement,
  claimEventPollReplacementPublication,
  clearEventPollReplacementPublicationStarted,
  EventPollReplacementConflictError,
  eventPollReplacementReceiptReleaseEligible,
  failEventPollReplacement,
  getEvent,
  getEventPollReplacement,
  listEligibleEventPollReplacementReceiptReleases,
  markEventPollReplacementReceiptReleased,
  markEventPollReplacementReceiptReleaseFailed,
  markEventPollReplacementPublished,
  markEventPollReplacementPublicationStarted,
  markEventPollReplacementRetired,
  markEventPollReplacementRetirementFailed,
  renewEventPollReplacementPublicationClaim,
  resetEventPollReplacementAfterDefiniteNonDelivery,
  swapPublishedEventPollReplacement,
  type EventPollReplacementPublicationClaim,
  type StoredEventPollReplacement,
  type StoredEventRecord
} from './store';

export const EVENT_POLL_REPLACEMENT_RETRY_DELAYS_MS = [
  5_000,
  15_000,
  30_000,
  60_000,
  5 * 60_000
] as const;

export const EVENT_POLL_REPLACEMENT_PUBLICATION_LEASE_MS = 2 * 60_000;

class EventPollReplacementPublicationClaimLostError extends Error {
  override readonly name = 'EventPollReplacementPublicationClaimLostError';
}

export type EventPollReplacementRunResult =
  | {
      status: 'completed';
      replacement: StoredEventPollReplacement;
      event: StoredEventRecord;
      retirementPending: boolean;
      retirementError?: string | undefined;
      receiptReleaseRetries: EventPollReceiptReleaseRetry[];
    }
  | {
      status: 'pending';
      replacement: StoredEventPollReplacement;
      retryAt: Date;
      error: string;
    }
  | {
      status: 'aborted';
      replacement: StoredEventPollReplacement;
      error: string;
      retirementPending: boolean;
      retirementError?: string | undefined;
      receiptReleaseRetries: EventPollReceiptReleaseRetry[];
    };

export interface EventPollReceiptReleaseRetry {
  operationId: string;
  eventId: string;
  scopeId: string;
  retryAt: Date;
  failureCount: number;
  error: string;
}

type EventPollReplacementContext = {
  services?: PluginCommandContext['services'] | PluginRuntimeContext['services'] | undefined;
  releasePollSendReceipt?: PluginRuntimeContext['releasePollSendReceipt'] | undefined;
};

export function eventPollReplacementPublishIdempotencyKey(input: {
  eventId: string;
  operationId: string;
  nextPollGeneration: number;
}): string {
  const digest = createHash('sha256')
    .update(`${input.eventId}\0${input.operationId}\0${input.nextPollGeneration}`)
    .digest('hex')
    .slice(0, 24);
  return `community-events:poll-replacement:${input.eventId}:${input.nextPollGeneration}:${digest}`;
}

export async function runEventPollReplacement(input: {
  context: EventPollReplacementContext;
  db: PluginDatabase;
  operationId: string;
  deleteMessage?: ((messageId: string) => Promise<void>) | undefined;
  clock?: (() => Date) | undefined;
  now?: Date | undefined;
}): Promise<EventPollReplacementRunResult> {
  const clock = input.clock ?? (() => input.now ?? new Date());
  let replacement = getEventPollReplacement(input.db, input.operationId);
  if (!replacement) {
    throw new Error(`Event poll replacement ${input.operationId} does not exist.`);
  }
  if (replacement.status === 'aborted' && !replacement.newPollWaMsgId) {
    return {
      status: 'aborted',
      replacement,
      error: replacement.lastError ?? 'The event poll replacement was aborted.',
      retirementPending: false,
      receiptReleaseRetries: []
    };
  }
  let claim: EventPollReplacementPublicationClaim | undefined;
  let ownedPublicationStartedAt: string | undefined;
  let providerInvocationStarted = false;
  let providerInvocationCompleted = false;

  if (replacement.status === 'pending') {
    const claimedAt = clock();
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(
      claimedAt.getTime() + EVENT_POLL_REPLACEMENT_PUBLICATION_LEASE_MS
    ).toISOString();
    const claimed = claimEventPollReplacementPublication(input.db, {
      operationId: replacement.operationId,
      claimToken,
      now: claimedAt.toISOString(),
      leaseExpiresAt
    });
    if (!claimed) {
      replacement = getEventPollReplacement(input.db, replacement.operationId) ?? replacement;
      if (replacement.status === 'pending') {
        return pendingWithoutFailure(
          replacement,
          claimedAt,
          'Replacement poll publication is already leased or is waiting for its retry cursor.'
        );
      }
    } else {
      replacement = claimed;
      claim = { operationId: replacement.operationId, claimToken, leaseExpiresAt };
    }
  }

  const settlePublished = (candidate: StoredEventPollReplacement, observedAt: Date) => {
    try {
      return replacementDeadlinePassed(candidate, observedAt)
        ? abortPublishedEventPollReplacement(input.db, {
            operationId: candidate.operationId,
            reason: 'The published replacement poll passed its activation deadline before the swap completed.',
            abortedAt: observedAt.toISOString()
          })
        : swapPublishedEventPollReplacement(input.db, {
            operationId: candidate.operationId,
            swappedAt: observedAt.toISOString()
          }).replacement;
    } catch (error) {
      if (!(error instanceof EventPollReplacementConflictError)) {
        throw error;
      }
      return abortPublishedEventPollReplacement(input.db, {
        operationId: candidate.operationId,
        reason: error.message,
        abortedAt: observedAt.toISOString()
      });
    }
  };

  try {
    if (replacement.status === 'pending') {
      if (!claim) {
        throw new EventPollReplacementPublicationClaimLostError(
          `Event poll replacement ${replacement.operationId} has no publication claim.`
        );
      }
      if (!replacement.publicationStartedAt && replacementDeadlinePassed(replacement, clock())) {
        const reason = 'The replacement poll publication deadline passed before any provider attempt began.';
        const aborted = abortUnstartedEventPollReplacement(input.db, {
          operationId: replacement.operationId,
          claimToken: claim.claimToken,
          reason,
          abortedAt: clock().toISOString()
        });
        replacement = aborted.replacement;
        if (!aborted.aborted && replacement.status === 'pending') {
          throw new EventPollReplacementPublicationClaimLostError(
            `Event poll replacement ${replacement.operationId} lost its deadline-abort claim.`
          );
        }
      }
      if (replacement.status !== 'pending') {
        // The claim-scoped, never-attempted deadline abort completed without
        // requiring mutable runtime service or group authorization.
      } else {
      if (!input.context.services) {
        throw new Error('Plugin service registry is unavailable for replacement poll publication.');
      }
      if (!input.context.releasePollSendReceipt) {
        throw new Error('Plugin runtime cannot durably hold and release replacement poll history.');
      }
      const event = getEvent(input.db, replacement.eventId);
      if (!event || event.scopeId !== replacement.scopeId) {
        throw new Error(`Event ${replacement.eventId} is unavailable for poll replacement.`);
      }
      const announcementGroupWid = event.announcementGroupWid?.trim() || event.groupWid?.trim();
      if (!announcementGroupWid) {
        throw new Error(`Event ${event.id} has no announcement group for its replacement poll.`);
      }

      const reconciled = await input.context.services.call<DoasPollReconcileOutput>({
        serviceId: DOAS_POLL_SERVICE_ID,
        method: DOAS_POLL_RECONCILE_METHOD,
        scopeId: replacement.scopeId,
        actorIdentityId: replacement.editorIdentityId,
        ...(event.groupId ? { groupId: event.groupId } : {}),
        groupWid: announcementGroupWid,
        input: {
          groupWid: announcementGroupWid,
          idempotencyKey: replacement.publishIdempotencyKey
        }
      });
      const reconciledAt = clock();
      const deadlinePassed = replacementDeadlinePassed(replacement, reconciledAt);
      if (reconciled.status === 'unknown') {
        if (!replacement.publicationStartedAt) {
          throw new Error(
            'Authoritative replacement poll receipt reconciliation is unresolved without a durable provider-attempt anchor.'
          );
        }
        // whatsmeow owns the idempotency claim. Once an earlier provider
        // attempt is durably anchored, retrying publish with the exact same key
        // is the authoritative way to join or finish an unresolved claim; the
        // local lease only prevents competing plugin runners.
        claim = renewPublicationClaim(input.db, claim, reconciledAt);
        replacement = getEventPollReplacement(input.db, replacement.operationId) ?? replacement;
        if (replacement.status === 'pending') {
          providerInvocationStarted = true;
          const sent = await input.context.services.call<DoasPollPublishOutput>({
            serviceId: DOAS_POLL_SERVICE_ID,
            method: DOAS_POLL_PUBLISH_METHOD,
            scopeId: replacement.scopeId,
            actorIdentityId: replacement.editorIdentityId,
            ...(event.groupId ? { groupId: event.groupId } : {}),
            groupWid: announcementGroupWid,
            input: {
              groupWid: announcementGroupWid,
              question: replacement.target.pollQuestion,
              options: replacement.target.pollOptions.map((option) => option.label),
              allowMultipleAnswers: replacement.target.allowMultipleAnswers,
              idempotencyKey: replacement.publishIdempotencyKey,
              notAfter: replacement.target.closeAt,
              reason: `replace event ${replacement.eventId}`,
              sourcePluginId: EVENTS_PLUGIN_ID,
              historyHoldOwner: EVENTS_PLUGIN_ID
            }
          });
          providerInvocationCompleted = true;
          if (!sent?.messageId) {
            throw new Error('doas poll service did not return a replacement poll message id.');
          }
          replacement = markEventPollReplacementPublished(input.db, {
            operationId: replacement.operationId,
            messageId: sent.messageId,
            publishedAt: clock().toISOString()
          });
        }
      }
      if (reconciled.status === 'found') {
        if (!reconciled.messageId) {
          throw new Error('Authoritative replacement poll receipt omitted its message id.');
        }
        replacement = markEventPollReplacementPublished(input.db, {
          operationId: replacement.operationId,
          messageId: reconciled.messageId,
          publishedAt: reconciled.acceptedAt ?? reconciledAt.toISOString()
        });
        if (deadlinePassed && replacement.status === 'published') {
          replacement = abortPublishedEventPollReplacement(input.db, {
            operationId: replacement.operationId,
            reason: 'The recovered replacement poll was no longer eligible to become authoritative.',
            abortedAt: reconciledAt.toISOString()
          });
        }
      } else if (reconciled.status === 'absent') {
        claim = renewPublicationClaim(input.db, claim, reconciledAt);
        replacement = getEventPollReplacement(input.db, replacement.operationId) ?? replacement;
        if (replacement.status !== 'pending') {
          // A late authoritative result or another terminal transition won.
        } else {
          if (replacement.publicationStartedAt) {
            const cleared = clearEventPollReplacementPublicationStarted(input.db, {
              operationId: replacement.operationId,
              claimToken: claim.claimToken,
              expectedStartedAt: replacement.publicationStartedAt,
              clearedAt: reconciledAt.toISOString()
            });
            replacement = cleared.replacement;
            if (!cleared.cleared) {
              throw new EventPollReplacementPublicationClaimLostError(
                `Event poll replacement ${replacement.operationId} lost its proven-absent anchor reset claim.`
              );
            }
          }

          if (deadlinePassed) {
            const reason = 'The replacement poll publication deadline passed and reconciliation proved no poll was sent.';
            const aborted = abortUnstartedEventPollReplacement(input.db, {
              operationId: replacement.operationId,
              claimToken: claim.claimToken,
              reason,
              abortedAt: reconciledAt.toISOString()
            });
            replacement = aborted.replacement;
            if (!aborted.aborted && replacement.status === 'pending') {
              throw new EventPollReplacementPublicationClaimLostError(
                `Event poll replacement ${replacement.operationId} lost its reconciled deadline-abort claim.`
              );
            }
          } else {
            const publicationStartedAt = clock().toISOString();
            const anchored = markEventPollReplacementPublicationStarted(input.db, {
              operationId: replacement.operationId,
              claimToken: claim.claimToken,
              startedAt: publicationStartedAt
            });
            if (!anchored) {
              throw new EventPollReplacementPublicationClaimLostError(
                `Event poll replacement ${replacement.operationId} lost its pre-publication anchor claim.`
              );
            }
            replacement = anchored;
            ownedPublicationStartedAt = publicationStartedAt;

            const providerBoundaryAt = clock();
            claim = renewPublicationClaim(input.db, claim, providerBoundaryAt);
            providerInvocationStarted = true;
            const sent = await input.context.services.call<DoasPollPublishOutput>({
              serviceId: DOAS_POLL_SERVICE_ID,
              method: DOAS_POLL_PUBLISH_METHOD,
              scopeId: replacement.scopeId,
              actorIdentityId: replacement.editorIdentityId,
              ...(event.groupId ? { groupId: event.groupId } : {}),
              groupWid: announcementGroupWid,
              input: {
                groupWid: announcementGroupWid,
                question: replacement.target.pollQuestion,
                options: replacement.target.pollOptions.map((option) => option.label),
                allowMultipleAnswers: replacement.target.allowMultipleAnswers,
                idempotencyKey: replacement.publishIdempotencyKey,
                notAfter: replacement.target.closeAt,
                reason: `replace event ${replacement.eventId}`,
                sourcePluginId: EVENTS_PLUGIN_ID,
                historyHoldOwner: EVENTS_PLUGIN_ID
              }
            });
            providerInvocationCompleted = true;
            if (!sent?.messageId) {
              throw new Error('doas poll service did not return a replacement poll message id.');
            }
            replacement = markEventPollReplacementPublished(input.db, {
              operationId: replacement.operationId,
              messageId: sent.messageId,
              publishedAt: clock().toISOString()
            });
          }
        }
      }
      }
    }

    if (replacement.status === 'published') {
      replacement = settlePublished(replacement, clock());
    }

  } catch (error) {
    const failedAt = clock();
    const reason = error instanceof Error ? error.message : String(error);
    const definitelyNotDelivered = Boolean(
      claim &&
      ownedPublicationStartedAt &&
      providerInvocationStarted &&
      !providerInvocationCompleted &&
      (
        isPluginServiceNotInvokedError(error) ||
        isDefinitelyNotSentTransportError(error) ||
        isTransportProviderUnavailableError(error)
      )
    );

    if (definitelyNotDelivered && claim && ownedPublicationStartedAt) {
      const retryAt = replacementFailureRetryAt(replacement, failedAt);
      const reset = resetEventPollReplacementAfterDefiniteNonDelivery(input.db, {
        operationId: replacement.operationId,
        claimToken: claim.claimToken,
        expectedStartedAt: ownedPublicationStartedAt,
        reason,
        nextAttemptAt: retryAt.toISOString(),
        failedAt: failedAt.toISOString()
      });
      replacement = reset.replacement;
      if (reset.reset) {
        return { status: 'pending', replacement, retryAt, error: reason };
      }
    }

    replacement = getEventPollReplacement(input.db, replacement.operationId) ?? replacement;
    if (replacement.status === 'published') {
      try {
        replacement = settlePublished(replacement, failedAt);
      } catch (activationError) {
        const activationReason = activationError instanceof Error
          ? activationError.message
          : String(activationError);
        const retryAt = replacementFailureRetryAt(replacement, failedAt);
        const failed = failEventPollReplacement(input.db, {
          operationId: replacement.operationId,
          reason: activationReason,
          nextAttemptAt: retryAt.toISOString(),
          failedAt: failedAt.toISOString()
        });
        replacement = failed.replacement;
        if (failed.failed) {
          return { status: 'pending', replacement, retryAt, error: activationReason };
        }
      }
    } else if (replacement.status === 'pending') {
      if (error instanceof EventPollReplacementPublicationClaimLostError || !claim) {
        return pendingWithoutFailure(replacement, failedAt, reason);
      }
      const retryAt = replacementFailureRetryAt(replacement, failedAt);
      const failed = failEventPollReplacement(input.db, {
        operationId: replacement.operationId,
        claimToken: claim.claimToken,
        reason,
        nextAttemptAt: retryAt.toISOString(),
        failedAt: failedAt.toISOString()
      });
      replacement = failed.replacement;
      if (failed.failed) {
        return { status: 'pending', replacement, retryAt, error: reason };
      }
      if (replacement.status === 'pending') {
        return pendingWithoutFailure(
          replacement,
          failedAt,
          `Event poll replacement ${replacement.operationId} changed while its failure was persisted.`
        );
      }
      if (replacement.status === 'published') {
        replacement = settlePublished(replacement, failedAt);
      }
    }

    replacement = getEventPollReplacement(input.db, replacement.operationId) ?? replacement;
    if (replacement.status === 'pending') {
      return pendingWithoutFailure(
        replacement,
        failedAt,
        `Event poll replacement ${replacement.operationId} remains owned by another runner.`
      );
    }
  }

  const completedAt = clock();
  const completedEvent = getEvent(input.db, replacement.eventId);
  if (!completedEvent || (replacement.status !== 'completed' && replacement.status !== 'aborted')) {
    throw new Error(`Event poll replacement ${replacement.operationId} did not reach completion.`);
  }

  let retirementError: string | undefined;
  const retirementDue = !replacement.nextAttemptAt ||
    Date.parse(replacement.nextAttemptAt) <= completedAt.getTime();
  if (!replacement.retiredAt && retirementDue) {
    const retirementFailures: string[] = [];
    try {
      const deletion = await deleteEventArtifacts({
        db: input.db,
        event: { id: replacement.eventId, scopeId: replacement.scopeId },
        ...(input.deleteMessage ? { deleteMessage: input.deleteMessage } : {}),
        artifactIds: replacement.artifactIds
      });
      if (deletion.skippedReason) {
        throw new Error(`Replacement artifact retirement was skipped: ${deletion.skippedReason}.`);
      }
      if (deletion.failed.length > 0) {
        throw new Error(
          `Replacement artifact retirement failed for ${deletion.failed.length} message(s): ` +
          deletion.failed.map((failure) => `${failure.messageId}: ${failure.reason}`).join('; ')
        );
      }
    } catch (error) {
      retirementFailures.push(error instanceof Error ? error.message : String(error));
    }
    if (retirementFailures.length === 0) {
      replacement = markEventPollReplacementRetired(input.db, {
        operationId: replacement.operationId,
        retiredAt: completedAt.toISOString()
      });
    } else {
      retirementError = retirementFailures.join('; ');
      const delay = EVENT_POLL_REPLACEMENT_RETRY_DELAYS_MS[Math.min(
        replacement.retirementFailureCount,
        EVENT_POLL_REPLACEMENT_RETRY_DELAYS_MS.length - 1
      )]!;
      replacement = markEventPollReplacementRetirementFailed(input.db, {
        operationId: replacement.operationId,
        reason: retirementError,
        nextAttemptAt: new Date(completedAt.getTime() + delay).toISOString(),
        failedAt: completedAt.toISOString()
      });
    }
  } else if (!replacement.retiredAt) {
    retirementError = replacement.retirementError;
  }

  const receiptReleaseRetries = await releaseEligibleEventPollReplacementReceipts({
    context: input.context,
    db: input.db,
    eventId: replacement.eventId,
    now: completedAt
  });
  replacement = getEventPollReplacement(input.db, replacement.operationId)!;

  if (replacement.status === 'aborted') {
    return {
      status: 'aborted',
      replacement,
      error: replacement.lastError ?? 'The event poll replacement was aborted.',
      retirementPending: !replacement.retiredAt,
      ...(retirementError ? { retirementError } : {}),
      receiptReleaseRetries
    };
  }
  return {
    status: 'completed',
    replacement,
    event: completedEvent,
    retirementPending: !replacement.retiredAt,
    ...(retirementError ? { retirementError } : {}),
    receiptReleaseRetries
  };
}

function renewPublicationClaim(
  db: PluginDatabase,
  claim: EventPollReplacementPublicationClaim,
  now: Date
): EventPollReplacementPublicationClaim {
  const leaseExpiresAt = new Date(
    now.getTime() + EVENT_POLL_REPLACEMENT_PUBLICATION_LEASE_MS
  ).toISOString();
  if (!renewEventPollReplacementPublicationClaim(db, {
    claim,
    now: now.toISOString(),
    leaseExpiresAt
  })) {
    throw new EventPollReplacementPublicationClaimLostError(
      `Event poll replacement ${claim.operationId} lost its publication lease before provider invocation.`
    );
  }
  return { ...claim, leaseExpiresAt };
}

function replacementFailureRetryAt(
  replacement: StoredEventPollReplacement,
  now: Date
): Date {
  const delay = EVENT_POLL_REPLACEMENT_RETRY_DELAYS_MS[Math.min(
    replacement.failureCount,
    EVENT_POLL_REPLACEMENT_RETRY_DELAYS_MS.length - 1
  )]!;
  return capReplacementRetryAtToClose(replacement, now, new Date(now.getTime() + delay));
}

function pendingWithoutFailure(
  replacement: StoredEventPollReplacement,
  now: Date,
  error: string
): Extract<EventPollReplacementRunResult, { status: 'pending' }> {
  const leaseAt = replacement.publicationLeaseExpiresAt
    ? new Date(replacement.publicationLeaseExpiresAt)
    : undefined;
  const cursorAt = replacement.nextAttemptAt ? new Date(replacement.nextAttemptAt) : undefined;
  const retryAt = leaseAt && Number.isFinite(leaseAt.getTime()) && leaseAt.getTime() > now.getTime()
    ? leaseAt
    : cursorAt && Number.isFinite(cursorAt.getTime()) && cursorAt.getTime() > now.getTime()
      ? cursorAt
      : new Date(now.getTime() + EVENT_POLL_REPLACEMENT_RETRY_DELAYS_MS[0]);
  return {
    status: 'pending',
    replacement,
    retryAt: capReplacementRetryAtToClose(replacement, now, retryAt),
    error
  };
}

function capReplacementRetryAtToClose(
  replacement: StoredEventPollReplacement,
  now: Date,
  retryAt: Date
): Date {
  const closeAt = new Date(replacement.target.closeAt);
  return Number.isFinite(closeAt.getTime()) &&
    closeAt.getTime() > now.getTime() &&
    retryAt.getTime() > closeAt.getTime()
    ? closeAt
    : retryAt;
}

function replacementDeadlinePassed(
  replacement: StoredEventPollReplacement,
  now: Date
): boolean {
  const closeAt = new Date(replacement.target.closeAt);
  return Number.isFinite(closeAt.getTime()) && closeAt.getTime() <= now.getTime();
}

/**
 * Releases held DOAS/whatsmeow poll history only after the corresponding poll
 * is no longer the authoritative open generation. Release failures are
 * durable and never roll back an already-completed lifecycle transition.
 */
export async function releaseEligibleEventPollReplacementReceipts(input: {
  context: Pick<EventPollReplacementContext, 'releasePollSendReceipt'>;
  db: PluginDatabase;
  eventId: string;
  now?: Date | undefined;
}): Promise<EventPollReceiptReleaseRetry[]> {
  const now = input.now ?? new Date();
  const retries: EventPollReceiptReleaseRetry[] = [];
  for (let replacement of listEligibleEventPollReplacementReceiptReleases(
    input.db,
    now,
    input.eventId
  )) {
    if (!eventPollReplacementReceiptReleaseEligible(input.db, replacement)) {
      continue;
    }
    try {
      if (!input.context.releasePollSendReceipt) {
        throw new Error('Plugin runtime does not expose replacement poll receipt release.');
      }
      const event = getEvent(input.db, replacement.eventId);
      const chatId = event?.announcementGroupWid?.trim() || event?.groupWid?.trim();
      if (!chatId) {
        throw new Error(`Event ${replacement.eventId} has no poll receipt chat.`);
      }
      await input.context.releasePollSendReceipt(chatId, replacement.publishIdempotencyKey);
      markEventPollReplacementReceiptReleased(input.db, {
        operationId: replacement.operationId,
        releasedAt: now.toISOString()
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const delay = EVENT_POLL_REPLACEMENT_RETRY_DELAYS_MS[Math.min(
        replacement.receiptReleaseFailureCount,
        EVENT_POLL_REPLACEMENT_RETRY_DELAYS_MS.length - 1
      )]!;
      const retryAt = new Date(now.getTime() + delay);
      replacement = markEventPollReplacementReceiptReleaseFailed(input.db, {
        operationId: replacement.operationId,
        reason,
        nextAttemptAt: retryAt.toISOString(),
        failedAt: now.toISOString()
      });
      retries.push({
        operationId: replacement.operationId,
        eventId: replacement.eventId,
        scopeId: replacement.scopeId,
        retryAt,
        failureCount: replacement.receiptReleaseFailureCount,
        error: reason
      });
    }
  }
  return retries;
}
