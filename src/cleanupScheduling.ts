import { EVENTS_JOBS } from './manifest';
import type { StoredEventRecord } from './store';

export interface EventCleanupJobRequest {
  jobName: string;
  scopeId: string;
  runAt: Date;
  payload: { eventId: string; attempt: number };
  dedupeKey: string;
}

/**
 * One stable deadline job per event revision of cleanupAt. It is deliberately
 * usable before the community link succeeds: cleanup owns the exact persisted
 * child, not the eventual link outcome.
 */
export function eventCleanupJobRequest(
  event: Pick<StoredEventRecord, 'id' | 'scopeId' | 'cleanupAt'>,
  attempt = 0
): EventCleanupJobRequest {
  const runAt = new Date(event.cleanupAt);
  if (!Number.isFinite(runAt.getTime())) {
    throw new Error(`Event ${event.id} has an invalid cleanup deadline ${event.cleanupAt}.`);
  }
  return {
    jobName: EVENTS_JOBS.cleanup,
    scopeId: event.scopeId,
    runAt,
    payload: { eventId: event.id, attempt },
    dedupeKey: `${EVENTS_JOBS.cleanup}:${event.id}:deadline:${event.cleanupAt}`
  };
}
