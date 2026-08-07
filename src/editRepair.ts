import type { AppConfig } from '../../../platform/config/runtimeConfig';
import type { PluginDatabase } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { OutboundSendResult, SendTextOptions } from '../../../platform/transport/transportTypes';
import { sendClaimedEventAnnouncement } from './announcementDelivery';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import { parseEventsConfig } from './config';
import {
  completeEventEditRepair,
  getEvent,
  getEventAnnouncementDeliveryClaim,
  getEventEditRepair,
  markEventEditRepairPending,
  resolvedEventCalendarId,
  supersedeEventAnnouncementDelivery
} from './store';

export interface EventEditRepairResult {
  status: 'missing' | 'completed' | 'pending';
  failures: string[];
  retryAt?: Date | undefined;
}

export async function repairEventEdit(input: {
  appConfig: AppConfig;
  db: PluginDatabase;
  operationId: string;
  configFor(scopeId: string): Promise<Record<string, unknown>>;
  sender: {
    sendText(chatId: string, text: string, options?: SendTextOptions | undefined): Promise<OutboundSendResult>;
    setGroupSubject(chatId: string, subject: string): Promise<void>;
  };
  now?: Date | undefined;
  publishCalendar?: typeof writePublishAndRecordScopeCalendar | undefined;
}): Promise<EventEditRepairResult> {
  const repair = getEventEditRepair(input.db, input.operationId);
  if (!repair || repair.status === 'completed') {
    return { status: repair ? 'completed' : 'missing', failures: [] };
  }

  const now = input.now ?? new Date();
  const event = getEvent(input.db, repair.eventId);
  if (!event) {
    return { status: 'missing', failures: [] };
  }
  const isCurrentEdit = event.updatedAt === repair.expectedEventUpdatedAt;

  const failures: string[] = [];
  let retryAt: Date | undefined;
  let config: ReturnType<typeof parseEventsConfig> | undefined;
  try {
    config = parseEventsConfig(await input.configFor(repair.scopeId));
  } catch (error) {
    failures.push(`config: ${errorReason(error)}`);
  }

  if (
    repair.subgroupChatId &&
    isCurrentEdit &&
    event.subgroupChatId === repair.subgroupChatId &&
    event.groupTitle === repair.targetGroupTitle
  ) {
    try {
      await input.sender.setGroupSubject(repair.subgroupChatId, repair.targetGroupTitle);
    } catch (error) {
      failures.push(`group_subject: ${errorReason(error)}`);
    }
  }

  if (config) {
    try {
      const calendarId = resolvedEventCalendarId(event) ?? '';
      if (repair.calendarId !== calendarId) {
        failures.push('calendar: persisted edit intent does not match authoritative event calendar ownership');
      } else if (calendarId) {
        const publication = await (input.publishCalendar ?? writePublishAndRecordScopeCalendar)({
          appConfig: input.appConfig,
          db: input.db,
          config,
          scopeId: repair.scopeId,
          calendarId
        });
        if (publication && !publication.ok) {
          failures.push(`calendar: ${publication.error || 'publication failed'}`);
        }
      }
    } catch (error) {
      failures.push(`calendar: ${errorReason(error)}`);
    }
  }

  if (repair.announcementDeliveryKey) {
    const claim = getEventAnnouncementDeliveryClaim(
      input.db,
      repair.eventId,
      'event_edit',
      repair.announcementDeliveryKey
    );
    if (!isCurrentEdit) {
      if (!supersedeEventAnnouncementDelivery(input.db, {
        eventId: repair.eventId,
        kind: 'event_edit',
        deliveryKey: repair.announcementDeliveryKey,
        updatedAt: now.toISOString()
      })) {
        failures.push('edit_announcement: stale delivery intent could not be superseded');
      }
    } else if (!claim?.text || !claim.idempotencyKey) {
      failures.push('edit_announcement: persisted delivery intent is missing');
    } else {
      try {
        const delivery = await sendClaimedEventAnnouncement({
          db: input.db,
          eventId: repair.eventId,
          scopeId: claim.scopeId,
          kind: 'event_edit',
          deliveryKey: claim.deliveryKey,
          chatId: claim.chatId,
          text: claim.text,
          idempotencyKey: claim.idempotencyKey,
          expectedEventUpdatedAt: repair.expectedEventUpdatedAt,
          sender: input.sender
        });
        if (delivery.status === 'superseded') {
          // A newer edit won the database race before this send claim was acquired.
        } else if (delivery.status === 'already_claimed') {
          failures.push('edit_announcement: delivery is already in progress');
          const leaseExpiresAt = claim.leaseExpiresAt ? new Date(claim.leaseExpiresAt) : undefined;
          if (leaseExpiresAt && Number.isFinite(leaseExpiresAt.getTime()) && leaseExpiresAt > now) {
            retryAt = leaseExpiresAt;
          }
        }
      } catch (error) {
        failures.push(`edit_announcement: ${errorReason(error)}`);
      }
    }
  }

  if (failures.length === 0) {
    completeEventEditRepair(input.db, {
      operationId: repair.operationId,
      completedAt: now.toISOString()
    });
    return { status: 'completed', failures: [] };
  }

  markEventEditRepairPending(input.db, {
    operationId: repair.operationId,
    reason: failures.join('; '),
    updatedAt: now.toISOString()
  });
  return {
    status: 'pending',
    failures,
    ...(retryAt ? { retryAt } : {})
  };
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
