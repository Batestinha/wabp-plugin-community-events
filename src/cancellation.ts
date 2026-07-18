import type { PluginCommandContext, PluginGroupDismantleResult } from '../../../platform/pluginRuntime/types';
import { parseEventsConfig } from './config';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import { appendScopeEventJsonLog } from './log';
import {
  appendEventLog,
  listCalendarEvents,
  markEventCancelled,
  type StoredEventRecord
} from './store';
import type { OfficialPluginCommandRuntime } from '../shared';

export interface EventCancellationActor {
  wid: string;
  label: string;
}

export type EventCancellationResult =
  | { status: 'cancelled'; cancelledAt: string; dismantleResult?: PluginGroupDismantleResult | undefined }
  | { status: 'not_cancellable'; reason: string }
  | { status: 'cleanup_failed'; reason: string; dismantleResult?: PluginGroupDismantleResult | undefined };

export async function cancelEventLifecycle(input: {
  context: PluginCommandContext;
  runtime: OfficialPluginCommandRuntime;
  db: Parameters<typeof markEventCancelled>[0];
  event: StoredEventRecord;
  actor: EventCancellationActor;
  reason?: string | undefined;
}): Promise<EventCancellationResult> {
  const { context, runtime, db, event, actor } = input;
  if (event.eventStatus !== 'scheduled' ||
      (event.groupLifecycleStatus !== 'poll_open' && event.groupLifecycleStatus !== 'poll_closed' && event.groupLifecycleStatus !== 'cleanup_failed')) {
    return { status: 'not_cancellable', reason: `event lifecycle is ${event.eventStatus}/${event.groupLifecycleStatus}` };
  }

  let dismantleResult: PluginGroupDismantleResult | undefined;
  if ((event.groupLifecycleStatus === 'poll_closed' || event.groupLifecycleStatus === 'cleanup_failed') && event.subgroupChatId) {
    if (!context.dismantleManagedGroup) {
      const reason = 'Plugin runtime does not expose dismantleManagedGroup.';
      await recordCancellationFailure(context, runtime, db, event, actor, reason);
      return { status: 'cleanup_failed', reason };
    }
    try {
      dismantleResult = await context.dismantleManagedGroup({
        scopeId: event.scopeId,
        chatId: event.subgroupChatId,
        reason: 'event cancellation'
      });
      if (dismantleResult.failedRemovals.length > 0) {
        const reason = partialCancellationCleanupReason(dismantleResult);
        await recordCancellationFailure(context, runtime, db, event, actor, reason, dismantleResult);
        return { status: 'cleanup_failed', reason, dismantleResult };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await recordCancellationFailure(context, runtime, db, event, actor, reason);
      return { status: 'cleanup_failed', reason };
    }
  }

  const cancelledAt = new Date().toISOString();
  markEventCancelled(db, {
    eventId: event.id,
    cancelledAt,
    cancelledByWid: actor.wid,
    cancelledByLabel: actor.label,
    ...(input.reason ? { reason: input.reason } : {})
  });
  await setCleanupFailureStatus(runtime, event.scopeId, null);
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.cancelled',
    metadata: {
      previousEventStatus: event.eventStatus,
      previousGroupLifecycleStatus: event.groupLifecycleStatus,
      actorWid: actor.wid,
      actorLabel: actor.label,
      reason: input.reason,
      dismantleResult
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
      actorLabel: actor.label,
      reason: input.reason,
      dismantleResult
    }
  });
  await refreshCalendar(runtime, db, event);
  return {
    status: 'cancelled',
    cancelledAt,
    ...(dismantleResult ? { dismantleResult } : {})
  };
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
  const profile = config.eventProfiles.find((candidate) => candidate.id === event.profileId);
  const calendarId = profile?.calendar.calendarId ?? '';
  const events = listCalendarEvents(db, event.scopeId);
  await writePublishAndRecordScopeCalendar({
    appConfig: runtime.config,
    db,
    config,
    scopeId: event.scopeId,
    calendarId,
    events
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
