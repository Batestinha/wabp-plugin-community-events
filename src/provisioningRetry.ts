import { z } from 'zod';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import {
  isManagedCommunitySubgroupProvisioningError
} from '../../../platform/pluginRuntime/runtime/pluginCommunityOperations';
import type { PluginDatabase } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { PluginJobEvent } from '../../../platform/pluginRuntime/types';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import {
  mergedParticipantOutcomes,
  resumeEventProvisioning,
  type ResumeEventProvisioningInput,
  type ResumeEventProvisioningResult
} from './provisioningRecovery';
import {
  appendEventLog,
  checkpointEventProvisioningCandidate,
  eventsDatabase,
  getEvent,
  listCreatedGroupParticipants,
  type StoredEventRecord
} from './store';

export const EVENT_PROVISIONING_RETRY_BASE_DELAY_MS = 60 * 60 * 1_000;
export const EVENT_PROVISIONING_RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1_000;
export const EVENT_PROVISIONING_RETRY_CLAIM_LEASE_MS = 15 * 60 * 1_000;

const retryPayloadSchema = z.object({
  eventId: z.string().trim().min(1),
  subgroupChatId: z.string().trim().min(1),
  generation: z.number().int().min(1)
}).strict();

export type EventProvisioningRetryStatus = 'scheduled' | 'claimed' | 'exhausted';

export interface StoredEventProvisioningRetry {
  eventId: string;
  subgroupChatId: string;
  generation: number;
  status: EventProvisioningRetryStatus;
  nextRetryAt?: string | undefined;
  claimedAt?: string | undefined;
  lastError?: string | undefined;
  updatedAt: string;
}

export type RequestEventProvisioningRetryResult =
  | ResumeEventProvisioningResult
  | {
      status: 'retry_scheduled';
      event: StoredEventRecord;
      retry: StoredEventProvisioningRetry;
    };

export function getEventProvisioningRetry(
  db: PluginDatabase,
  eventId: string
): StoredEventProvisioningRetry | undefined {
  const row = db.get<{
    event_id: string;
    subgroup_chat_id: string;
    generation: number;
    status: string;
    next_retry_at: string | null;
    claimed_at: string | null;
    last_error: string | null;
    updated_at: string;
  }>(
    `SELECT event_id, subgroup_chat_id, generation, status, next_retry_at,
            claimed_at, last_error, updated_at
       FROM event_provisioning_retries
      WHERE event_id = ?`,
    eventId
  );
  if (!row) {
    return undefined;
  }
  return {
    eventId: row.event_id,
    subgroupChatId: row.subgroup_chat_id,
    generation: row.generation,
    status: retryStatus(row.status),
    ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    updatedAt: row.updated_at
  };
}

export function ensureEventProvisioningRetry(
  db: PluginDatabase,
  event: StoredEventRecord,
  now: Date
): StoredEventProvisioningRetry {
  const subgroupChatId = requiredCheckpointedSubgroup(event);
  return db.transaction(() => {
    const existing = getEventProvisioningRetry(db, event.id);
    if (existing) {
      if (existing.subgroupChatId !== subgroupChatId) {
        throw new Error(
          `Event ${event.id} retry targets ${existing.subgroupChatId}; refusing replacement with ${subgroupChatId}.`
        );
      }
      if (expiredRetryClaim(existing, now)) {
        const retryAt = new Date(now.getTime() + EVENT_PROVISIONING_RETRY_BASE_DELAY_MS);
        const cleanupAt = new Date(event.cleanupAt);
        const schedulable = Number.isFinite(cleanupAt.getTime()) &&
          retryAt.getTime() < cleanupAt.getTime();
        db.run(
          `UPDATE event_provisioning_retries
              SET generation = generation + 1,
                  status = ?,
                  next_retry_at = ?,
                  claimed_at = NULL,
                  last_error = COALESCE(last_error, 'Recovered expired provisioning retry claim.'),
                  updated_at = ?
            WHERE event_id = ?
              AND subgroup_chat_id = ?
              AND generation = ?
              AND status = 'claimed'`,
          schedulable ? 'scheduled' : 'exhausted',
          schedulable ? retryAt.toISOString() : null,
          now.toISOString(),
          event.id,
          subgroupChatId,
          existing.generation
        );
        return requiredRetry(db, event.id);
      }
      return existing;
    }

    const retryAt = initialEventProvisioningRetryAt(event, now);
    const cleanupAt = new Date(event.cleanupAt);
    const schedulable = Number.isFinite(cleanupAt.getTime()) &&
      retryAt.getTime() < cleanupAt.getTime();
    const nextRetryAt = schedulable ? retryAt.toISOString() : null;
    const status: EventProvisioningRetryStatus = schedulable ? 'scheduled' : 'exhausted';
    const lastError = schedulable
      ? event.error
      : `${event.error ?? 'Provisioning failed.'} Retry window ended before event cleanup.`;
    db.run(
      `INSERT INTO event_provisioning_retries (
         event_id, subgroup_chat_id, generation, status, next_retry_at,
         claimed_at, last_error, updated_at
       ) VALUES (?, ?, 1, ?, ?, NULL, ?, ?)`,
      event.id,
      subgroupChatId,
      status,
      nextRetryAt,
      lastError ?? null,
      now.toISOString()
    );
    return requiredRetry(db, event.id);
  });
}

export function claimEventProvisioningRetry(
  db: PluginDatabase,
  input: {
    eventId: string;
    subgroupChatId: string;
    generation: number;
    now: Date;
  }
): boolean {
  const result = db.run(
    `UPDATE event_provisioning_retries
        SET status = 'claimed',
            claimed_at = ?,
            updated_at = ?
      WHERE event_id = ?
        AND subgroup_chat_id = ?
        AND generation = ?
        AND status = 'scheduled'
        AND next_retry_at IS NOT NULL
        AND next_retry_at <= ?`,
    input.now.toISOString(),
    input.now.toISOString(),
    input.eventId,
    input.subgroupChatId,
    input.generation,
    input.now.toISOString()
  );
  return result.changes === 1;
}

export function rescheduleEventProvisioningRetry(
  db: PluginDatabase,
  input: {
    eventId: string;
    subgroupChatId: string;
    generation: number;
    now: Date;
    cleanupAt: string;
    error: string;
  }
): StoredEventProvisioningRetry {
  return db.transaction(() => {
    const delayMs = eventProvisioningRetryDelayMs(input.generation + 1);
    const nextRetryAt = new Date(input.now.getTime() + delayMs);
    const cleanupAt = new Date(input.cleanupAt);
    if (!Number.isFinite(cleanupAt.getTime()) || nextRetryAt.getTime() >= cleanupAt.getTime()) {
      exhaustEventProvisioningRetry(db, {
        eventId: input.eventId,
        subgroupChatId: input.subgroupChatId,
        generation: input.generation,
        now: input.now,
        error: `${input.error} Retry window ended before event cleanup.`
      });
      return requiredRetry(db, input.eventId);
    }
    const result = db.run(
      `UPDATE event_provisioning_retries
          SET generation = generation + 1,
              status = 'scheduled',
              next_retry_at = ?,
              claimed_at = NULL,
              last_error = ?,
              updated_at = ?
        WHERE event_id = ?
          AND subgroup_chat_id = ?
          AND generation = ?
          AND status = 'claimed'`,
      nextRetryAt.toISOString(),
      input.error,
      input.now.toISOString(),
      input.eventId,
      input.subgroupChatId,
      input.generation
    );
    if (result.changes !== 1) {
      throw new Error(`Event ${input.eventId} provisioning retry changed while rescheduling.`);
    }
    return requiredRetry(db, input.eventId);
  });
}

export function exhaustEventProvisioningRetry(
  db: PluginDatabase,
  input: {
    eventId: string;
    subgroupChatId: string;
    generation: number;
    now: Date;
    error: string;
  }
): boolean {
  const result = db.run(
    `UPDATE event_provisioning_retries
        SET status = 'exhausted',
            next_retry_at = NULL,
            claimed_at = NULL,
            last_error = ?,
            updated_at = ?
      WHERE event_id = ?
        AND subgroup_chat_id = ?
        AND generation = ?`,
    input.error,
    input.now.toISOString(),
    input.eventId,
    input.subgroupChatId,
    input.generation
  );
  return result.changes === 1;
}

export function clearEventProvisioningRetry(db: PluginDatabase, eventId: string): void {
  db.run('DELETE FROM event_provisioning_retries WHERE event_id = ?', eventId);
}

export function eventProvisioningRetryDelayMs(generation: number): number {
  const exponent = Math.max(0, generation - 1);
  return Math.min(
    EVENT_PROVISIONING_RETRY_MAX_DELAY_MS,
    EVENT_PROVISIONING_RETRY_BASE_DELAY_MS * (2 ** exponent)
  );
}

export function eventProvisioningRetryDedupeKey(
  retry: Pick<StoredEventProvisioningRetry, 'eventId' | 'subgroupChatId' | 'generation' | 'nextRetryAt'>
): string {
  return [
    EVENTS_JOBS.provisioningRetry,
    retry.eventId,
    retry.subgroupChatId,
    `generation-${retry.generation}`,
    retry.nextRetryAt ?? 'no-due-time'
  ].join(':');
}

export function eventProvisioningRetryClaimLeaseDedupeKey(
  retry: Pick<StoredEventProvisioningRetry, 'eventId' | 'subgroupChatId' | 'generation' | 'claimedAt'>
): string {
  return [
    EVENTS_JOBS.provisioningRetry,
    retry.eventId,
    retry.subgroupChatId,
    `generation-${retry.generation}`,
    'claim-lease',
    retry.claimedAt ?? 'unknown'
  ].join(':');
}

export function isRateLimitedCommunityLinkError(error: unknown): boolean {
  return isManagedCommunitySubgroupProvisioningError(error) &&
    error.stage === 'link_parent' &&
    /\b(?:429|rate-overlimit)\b/i.test(error.message);
}

export async function enqueueEventProvisioningRetry(
  context: PluginRuntimeContext,
  event: StoredEventRecord,
  retry: StoredEventProvisioningRetry
): Promise<boolean> {
  let runAt: Date;
  let dedupeKey: string;
  if (retry.status === 'scheduled' && retry.nextRetryAt) {
    runAt = new Date(retry.nextRetryAt);
    dedupeKey = eventProvisioningRetryDedupeKey(retry);
  } else if (retry.status === 'claimed' && retry.claimedAt) {
    runAt = new Date(
      new Date(retry.claimedAt).getTime() + EVENT_PROVISIONING_RETRY_CLAIM_LEASE_MS
    );
    dedupeKey = eventProvisioningRetryClaimLeaseDedupeKey(retry);
  } else {
    return false;
  }
  if (!Number.isFinite(runAt.getTime())) {
    throw new Error(`Event ${event.id} has an invalid provisioning retry wake-up time.`);
  }
  await enqueuePluginJob(context.queue, {
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.provisioningRetry,
    scopeId: event.scopeId,
    ...(event.groupId ? { groupId: event.groupId } : {}),
    ...(event.groupWid ? { groupWid: event.groupWid } : {}),
    payload: {
      eventId: event.id,
      subgroupChatId: retry.subgroupChatId,
      generation: retry.generation
    },
    runAt,
    dedupeKey,
    attempts: 1
  });
  return true;
}

export async function recoverEventProvisioningRetry(
  context: PluginRuntimeContext,
  event: StoredEventRecord,
  now: Date
): Promise<boolean> {
  const db = eventsDatabase(context.databases);
  const existing = getEventProvisioningRetry(db, event.id);
  if (!existing && !isPersistedRateLimitedCommunityLinkFailure(event)) {
    return false;
  }
  const retry = ensureEventProvisioningRetry(db, event, now);
  return enqueueEventProvisioningRetry(context, event, retry);
}

export async function requestEventProvisioningRetry(
  input: ResumeEventProvisioningInput
): Promise<RequestEventProvisioningRetryResult> {
  const scopeId = input.scopeId.trim();
  const eventId = input.eventId.trim();
  const subgroupChatId = input.subgroupChatId.trim().toLowerCase();
  const db = eventsDatabase(input.context.databases);
  let event = getEvent(db, eventId);
  if (!event || event.scopeId !== scopeId) {
    return {
      status: 'not_found',
      reason: `Unknown event ${eventId} in scope ${scopeId}.`
    };
  }
  if (event.subgroupChatId === subgroupChatId && (
    (
      event.eventStatus === 'active' &&
      (event.groupLifecycleStatus === 'poll_closed' ||
        event.groupLifecycleStatus === 'cleanup_failed')
    ) ||
    (event.eventStatus === 'completed' && event.groupLifecycleStatus === 'cleaned')
  )) {
    return { status: 'already_completed', event };
  }
  if (
    event.eventStatus !== 'failed' ||
    event.groupLifecycleStatus !== 'none' ||
    (event.subgroupChatId && event.subgroupChatId !== subgroupChatId)
  ) {
    return {
      status: 'rejected',
      reason: `Event ${event.id} cannot schedule recovery from ${event.eventStatus}/${event.groupLifecycleStatus} with subgroup ${subgroupChatId}.`,
      event
    };
  }

  if (
    (input.subgroupTitle !== undefined || input.participants !== undefined)
  ) {
    const checkpointed = checkpointEventProvisioningCandidate(db, {
      eventId: event.id,
      scopeId,
      subgroupChatId,
      subgroupTitle: input.subgroupTitle?.trim() || event.subgroupTitle || event.groupTitle,
      participants: mergedParticipantOutcomes(
        listCreatedGroupParticipants(db, event.id),
        input.participants
      ),
      checkpointedAt: event.updatedAt
    });
    if (!checkpointed) {
      const changedEvent = getEvent(db, event.id) ?? event;
      return {
        status: 'rejected',
        reason: `Event ${event.id} changed state while its provisioning retry was being prepared.`,
        event: changedEvent
      };
    }
    event = getEvent(db, event.id) ?? event;
  }

  const now = input.now ?? new Date();
  const retry = ensureEventProvisioningRetry(db, event, now);
  if (retry.status === 'exhausted') {
    return {
      status: 'rejected',
      reason: `Event ${event.id} provisioning retry window ended before cleanup.`,
      event
    };
  }
  await enqueueEventProvisioningRetry(input.context, event, retry);
  await recordRetryEvent(input.context, event, 'events.provisioning_retry.requested', {
    generation: retry.generation,
    retryStatus: retry.status,
    nextRetryAt: retry.nextRetryAt,
    actorWid: input.actorWid,
    actorLabel: input.actorLabel
  });
  await input.context.audit.record({
    scopeId: event.scopeId,
    ...(event.groupId ? { groupId: event.groupId } : {}),
    action: 'official.community-events.provisioning.retry_requested',
    targetJson: {
      eventId: event.id,
      subgroupChatId
    },
    metadataJson: {
      generation: retry.generation,
      retryStatus: retry.status,
      nextRetryAt: retry.nextRetryAt,
      actorWid: input.actorWid,
      actorLabel: input.actorLabel
    }
  });
  return {
    status: 'retry_scheduled',
    event,
    retry
  };
}

export async function handleEventProvisioningRetryJob(
  context: PluginRuntimeContext,
  job: PluginJobEvent
): Promise<PluginAction[]> {
  const parsed = retryPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    return [audit('events.provisioning_retry.skipped', { reason: 'invalid payload' })];
  }
  const payload = parsed.data;
  const subgroupChatId = payload.subgroupChatId.toLowerCase();
  const db = eventsDatabase(context.databases);
  const event = getEvent(db, payload.eventId);
  const retry = getEventProvisioningRetry(db, payload.eventId);

  if (!event || !retry) {
    return [audit('events.provisioning_retry.skipped', {
      eventId: payload.eventId,
      reason: event ? 'retry state missing' : 'event missing'
    })];
  }
  if (
    event.eventStatus !== 'failed' ||
    event.groupLifecycleStatus !== 'none' ||
    event.subgroupChatId !== subgroupChatId
  ) {
    clearEventProvisioningRetry(db, event.id);
    return [audit('events.provisioning_retry.skipped', {
      eventId: event.id,
      reason: 'event no longer requires provisioning recovery'
    })];
  }
  if (
    retry.subgroupChatId !== subgroupChatId ||
    retry.generation !== payload.generation
  ) {
    await enqueueEventProvisioningRetry(context, event, retry);
    return [audit('events.provisioning_retry.skipped', {
      eventId: event.id,
      reason: 'stale or duplicate retry generation',
      requestedGeneration: payload.generation,
      currentGeneration: retry.generation,
      currentStatus: retry.status
    })];
  }
  if (retry.status === 'exhausted') {
    return [audit('events.provisioning_retry.skipped', {
      eventId: event.id,
      reason: 'retry window is exhausted',
      generation: retry.generation
    })];
  }
  if (retry.status === 'claimed') {
    const recovered = ensureEventProvisioningRetry(db, event, new Date());
    await enqueueEventProvisioningRetry(context, event, recovered);
    return [audit('events.provisioning_retry.skipped', {
      eventId: event.id,
      reason: recovered.status === 'claimed'
        ? 'retry claim lease is still active'
        : 'expired retry claim was recovered',
      requestedGeneration: payload.generation,
      currentGeneration: recovered.generation,
      currentStatus: recovered.status
    })];
  }

  const now = new Date();
  const cleanupAt = new Date(event.cleanupAt);
  if (!Number.isFinite(cleanupAt.getTime()) || cleanupAt.getTime() <= now.getTime()) {
    const reason = 'Provisioning retry window ended at event cleanup.';
    exhaustEventProvisioningRetry(db, {
      eventId: event.id,
      subgroupChatId,
      generation: retry.generation,
      now,
      error: reason
    });
    await recordRetryEvent(context, event, 'events.provisioning_retry.exhausted', {
      reason,
      generation: retry.generation
    });
    return [audit('events.provisioning_retry.exhausted', {
      eventId: event.id,
      reason,
      generation: retry.generation
    })];
  }
  if (!claimEventProvisioningRetry(db, {
    eventId: event.id,
    subgroupChatId,
    generation: retry.generation,
    now
  })) {
    const current = getEventProvisioningRetry(db, event.id);
    if (current) {
      await enqueueEventProvisioningRetry(context, event, current);
    }
    return [audit('events.provisioning_retry.skipped', {
      eventId: event.id,
      reason: 'retry was early or concurrently claimed',
      generation: retry.generation
    })];
  }

  try {
    const result = await resumeEventProvisioning({
      context,
      scopeId: event.scopeId,
      eventId: event.id,
      subgroupChatId,
      ...(event.subgroupTitle ? { subgroupTitle: event.subgroupTitle } : {}),
      actorWid: 'plugin-retry@system',
      actorLabel: 'Provisioning retry'
    });
    if (result.status === 'queued' || result.status === 'already_completed') {
      clearEventProvisioningRetry(db, event.id);
      await recordRetryEvent(context, event, 'events.provisioning_retry.completed', {
        generation: retry.generation,
        resultStatus: result.status
      });
      return [audit('events.provisioning_retry.completed', {
        eventId: event.id,
        generation: retry.generation,
        resultStatus: result.status
      })];
    }
    const reason = result.status === 'rejected'
      ? result.reason
      : `Unexpected provisioning retry result ${result.status}.`;
    exhaustEventProvisioningRetry(db, {
      eventId: event.id,
      subgroupChatId,
      generation: retry.generation,
      now: new Date(),
      error: reason
    });
    await recordRetryEvent(context, event, 'events.provisioning_retry.exhausted', {
      reason,
      generation: retry.generation
    });
    return [audit('events.provisioning_retry.exhausted', {
      eventId: event.id,
      reason,
      generation: retry.generation
    })];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!isRateLimitedCommunityLinkError(error)) {
      exhaustEventProvisioningRetry(db, {
        eventId: event.id,
        subgroupChatId,
        generation: retry.generation,
        now: new Date(),
        error: reason
      });
      await recordRetryEvent(context, event, 'events.provisioning_retry.exhausted', {
        reason,
        generation: retry.generation
      });
      return [audit('events.provisioning_retry.exhausted', {
        eventId: event.id,
        reason,
        generation: retry.generation
      })];
    }

    const rescheduled = rescheduleEventProvisioningRetry(db, {
      eventId: event.id,
      subgroupChatId,
      generation: retry.generation,
      now: new Date(),
      cleanupAt: event.cleanupAt,
      error: reason
    });
    if (rescheduled.status === 'scheduled') {
      await enqueueEventProvisioningRetry(context, event, rescheduled);
    }
    await recordRetryEvent(context, event, 'events.provisioning_retry.rescheduled', {
      reason,
      previousGeneration: retry.generation,
      generation: rescheduled.generation,
      nextRetryAt: rescheduled.nextRetryAt,
      status: rescheduled.status
    });
    return [audit('events.provisioning_retry.rescheduled', {
      eventId: event.id,
      previousGeneration: retry.generation,
      generation: rescheduled.generation,
      nextRetryAt: rescheduled.nextRetryAt,
      status: rescheduled.status
    })];
  }
}

function initialEventProvisioningRetryAt(event: StoredEventRecord, now: Date): Date {
  if (!isPersistedRateLimitedCommunityLinkFailure(event)) {
    return now;
  }
  const lastFailureAt = new Date(event.updatedAt);
  const base = Number.isFinite(lastFailureAt.getTime()) ? lastFailureAt : now;
  return new Date(Math.max(now.getTime(), base.getTime() + EVENT_PROVISIONING_RETRY_BASE_DELAY_MS));
}

function isPersistedRateLimitedCommunityLinkFailure(event: StoredEventRecord): boolean {
  const error = event.error ?? '';
  return /failed while linking standalone group to parent community:/i.test(error) &&
    /\b(?:429|rate-overlimit)\b/i.test(error);
}

function expiredRetryClaim(retry: StoredEventProvisioningRetry, now: Date): boolean {
  if (retry.status !== 'claimed') {
    return false;
  }
  if (!retry.claimedAt) {
    return true;
  }
  const claimedAt = new Date(retry.claimedAt);
  return !Number.isFinite(claimedAt.getTime()) ||
    claimedAt.getTime() + EVENT_PROVISIONING_RETRY_CLAIM_LEASE_MS <= now.getTime();
}

function requiredCheckpointedSubgroup(event: StoredEventRecord): string {
  const subgroupChatId = event.subgroupChatId?.trim().toLowerCase();
  if (
    event.eventStatus !== 'failed' ||
    event.groupLifecycleStatus !== 'none' ||
    !subgroupChatId
  ) {
    throw new Error(`Event ${event.id} does not have a failed provisioning checkpoint.`);
  }
  return subgroupChatId;
}

function requiredRetry(db: PluginDatabase, eventId: string): StoredEventProvisioningRetry {
  const retry = getEventProvisioningRetry(db, eventId);
  if (!retry) {
    throw new Error(`Event ${eventId} provisioning retry was not persisted.`);
  }
  return retry;
}

function retryStatus(value: string): EventProvisioningRetryStatus {
  if (value === 'scheduled' || value === 'claimed' || value === 'exhausted') {
    return value;
  }
  throw new Error(`Unknown event provisioning retry status ${value}.`);
}

async function recordRetryEvent(
  context: PluginRuntimeContext,
  event: StoredEventRecord,
  action: string,
  metadata: Record<string, unknown>
): Promise<void> {
  appendEventLog(eventsDatabase(context.databases), {
    eventId: event.id,
    action,
    metadata
  });
  try {
    await appendScopeEventJsonLog({
      appConfig: context.config,
      entry: {
        action: action.replace(/^events\./, 'event.'),
        scopeId: event.scopeId,
        eventId: event.id,
        profileId: event.profileId,
        ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
        ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
        metadata
      }
    });
  } catch (error) {
    context.logger.warn(
      { error, action, eventId: event.id },
      'Unable to append official.community-events provisioning retry JSONL log'
    );
  }
}

function audit(action: string, metadataJson: unknown): PluginAction {
  return {
    type: 'audit.record',
    action,
    metadataJson
  };
}
