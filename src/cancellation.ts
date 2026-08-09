import type { PluginCommandContext, PluginGroupDismantleResult } from '../../../platform/pluginRuntime/types';
import { parseEventsConfig } from './config';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import { appendScopeEventJsonLog } from './log';
import {
  appendEventLog,
  listEventAnnouncementMessages,
  markEventAnnouncementMessageDeleted,
  markEventAnnouncementMessageDeleteFailed,
  markEventCancelled,
  resolvedEventCalendarId,
  type EventAnnouncementMessageKind,
  type EventCalendarStatus,
  type StoredEventRecord
} from './store';
import type { OfficialPluginCommandRuntime } from '../shared';

export interface EventCancellationActor {
  wid: string;
  label: string;
}

export type EventCancellationCalendarDisposition = Extract<EventCalendarStatus, 'cancelled' | 'hidden'>;

export interface EventAnnouncementMessageDeletionResult {
  requested: boolean;
  attempted: number;
  deleted: Array<{
    id: string;
    kind: EventAnnouncementMessageKind;
    chatId: string;
    messageId: string;
  }>;
  failed: Array<{
    id: string;
    kind: EventAnnouncementMessageKind;
    chatId: string;
    messageId: string;
    reason: string;
  }>;
  skippedReason?: string | undefined;
}

export type EventCancellationResult =
  | {
      status: 'cancelled';
      cancelledAt: string;
      calendarDisposition: EventCancellationCalendarDisposition;
      dismantleResult?: PluginGroupDismantleResult | undefined;
      announcementMessageDeletion?: EventAnnouncementMessageDeletionResult | undefined;
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
  deleteMessage?: ((messageId: string) => Promise<void>) | undefined;
  reason?: string | undefined;
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

  const announcementMessageDeletion = input.deleteAnnouncementMessages
    ? await deleteEventAnnouncementMessages({
      db,
      event,
      deleteMessage: input.deleteMessage
    })
    : undefined;
  const cancelledAt = new Date().toISOString();
  const cancelled = markEventCancelled(db, {
    eventId: event.id,
    expectedUpdatedAt: event.updatedAt,
    cancelledAt,
    cancelledByWid: actor.wid,
    cancelledByLabel: actor.label,
    calendarStatus: calendarDisposition,
    ...(input.reason ? { reason: input.reason } : {})
  });
  if (!cancelled) {
    return { status: 'not_cancellable', reason: 'event lifecycle changed during cancellation' };
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
      announcementMessageDeletion
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
      announcementMessageDeletion
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
    ...(dismantleResult ? { dismantleResult } : {})
  };
}

async function deleteEventAnnouncementMessages(input: {
  db: Parameters<typeof markEventCancelled>[0];
  event: StoredEventRecord;
  deleteMessage?: ((messageId: string) => Promise<void>) | undefined;
}): Promise<EventAnnouncementMessageDeletionResult> {
  if (!input.deleteMessage) {
    return {
      requested: true,
      attempted: 0,
      deleted: [],
      failed: [],
      skippedReason: 'message_delete_unavailable'
    };
  }
  const messages = listEventAnnouncementMessages(input.db, input.event.id)
    .filter((message) => message.scopeId === input.event.scopeId);
  const result: EventAnnouncementMessageDeletionResult = {
    requested: true,
    attempted: messages.length,
    deleted: [],
    failed: []
  };
  for (const message of messages) {
    try {
      await input.deleteMessage(message.messageId);
      const deletedAt = new Date().toISOString();
      markEventAnnouncementMessageDeleted(input.db, message.id, deletedAt);
      result.deleted.push({
        id: message.id,
        kind: message.kind,
        chatId: message.chatId,
        messageId: message.messageId
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      markEventAnnouncementMessageDeleteFailed(input.db, message.id, reason);
      result.failed.push({
        id: message.id,
        kind: message.kind,
        chatId: message.chatId,
        messageId: message.messageId,
        reason
      });
    }
  }
  return result;
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
