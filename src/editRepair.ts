import type { AppConfig } from '../../../platform/config/runtimeConfig';
import type { PluginDatabase } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { PluginServiceCaller } from '../../../platform/pluginRuntime/pluginServices';
import type { OutboundSendResult, SendTextOptions } from '../../../platform/transport/transportTypes';
import { sendClaimedEventAnnouncement } from './announcementDelivery';
import { sendEventCalendarHint } from './calendarHint';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import { parseEventsConfig } from './config';
import {
  claimEventEditRepairExecution,
  completeEventEditRepair,
  EVENT_EDIT_REPAIR_EXECUTION_LEASE_MS,
  getEvent,
  getEventAnnouncementDeliveryClaim,
  getEventCleanupClaim,
  getEventEditRepair,
  markEventEditRepairPending,
  releaseEventEditRepairExecution,
  renewEventEditRepairExecution,
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
  getGroupInviteCode?(groupWid: string): Promise<string | null>;
  now?: Date | undefined;
  services?: PluginServiceCaller | undefined;
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
  const leaseClockOffsetMs = now.getTime() - Date.now();
  const leaseNow = (): Date => new Date(Date.now() + leaseClockOffsetMs);
  const execution = claimEventEditRepairExecution(input.db, {
    operationId: repair.operationId,
    claimedAt: leaseNow().toISOString()
  });
  if (!execution) {
    const cleanupClaim = getEventCleanupClaim(input.db, repair.eventId);
    const currentRepair = getEventEditRepair(input.db, repair.operationId);
    if (!currentRepair || currentRepair.status === 'completed') {
      return { status: currentRepair ? 'completed' : 'missing', failures: [] };
    }
    const reason = cleanupClaim
      ? 'cancellation_or_cleanup: event cleanup mutation is in progress'
      : 'edit_repair: another repair worker owns the execution lease';
    const leaseExpiresAt = new Date(
      cleanupClaim?.leaseExpiresAt ?? currentRepair?.executionLeaseExpiresAt ?? ''
    );
    return {
      status: 'pending',
      failures: [reason],
      ...(Number.isFinite(leaseExpiresAt.getTime()) && leaseExpiresAt > now
        ? { retryAt: leaseExpiresAt }
        : {})
    };
  }

  let renewalError: Error | undefined;
  const renew = (): void => {
    if (renewalError) return;
    try {
      const renewed = renewEventEditRepairExecution(input.db, {
        operationId: repair.operationId,
        claimId: execution.claimId,
        leaseExpiresAt: new Date(
          leaseNow().getTime() + EVENT_EDIT_REPAIR_EXECUTION_LEASE_MS
        ).toISOString()
      });
      if (!renewed) {
        renewalError = new Error('edit repair execution lease was lost');
      }
    } catch (error) {
      renewalError = error instanceof Error ? error : new Error(String(error));
    }
  };
  const assertExecution = (): void => {
    renew();
    if (renewalError) {
      throw renewalError;
    }
  };
  const completeRepair = (): boolean => {
    assertExecution();
    return completeEventEditRepair(input.db, {
      operationId: repair.operationId,
      executionClaimId: execution.claimId,
      completedAt: now.toISOString()
    });
  };
  const heartbeat = setInterval(renew, Math.max(
    1_000,
    Math.floor(EVENT_EDIT_REPAIR_EXECUTION_LEASE_MS / 3)
  ));
  heartbeat.unref();

  try {
    const isCurrentEdit = event.updatedAt === repair.expectedEventUpdatedAt;

    const failures: string[] = [];
    let retryAt: Date | undefined;
    if (!isCurrentEdit) {
    assertExecution();
    if (repair.calendarHintDeliveryKey) {
      const hintClaim = getEventAnnouncementDeliveryClaim(
        input.db,
        repair.eventId,
        'calendar_hint',
        repair.calendarHintDeliveryKey
      );
      if (hintClaim && !supersedeEventAnnouncementDelivery(input.db, {
        eventId: repair.eventId,
        kind: 'calendar_hint',
        deliveryKey: repair.calendarHintDeliveryKey,
        updatedAt: now.toISOString()
      })) {
        failures.push('calendar_hint: stale delivery intent could not be superseded');
      }
    }
    if (repair.announcementDeliveryKey && !supersedeEventAnnouncementDelivery(input.db, {
      eventId: repair.eventId,
      kind: 'event_edit',
      deliveryKey: repair.announcementDeliveryKey,
      updatedAt: now.toISOString()
    })) {
      failures.push('edit_announcement: stale delivery intent could not be superseded');
    }
    if (failures.length === 0) {
      return completeRepair()
        ? { status: 'completed', failures: [] }
        : { status: 'pending', failures: ['edit_repair: execution lease was lost before completion'] };
    }
    markEventEditRepairPending(input.db, {
      operationId: repair.operationId,
      executionClaimId: execution.claimId,
      reason: failures.join('; '),
      updatedAt: now.toISOString()
    });
    return { status: 'pending', failures };
  }

    let config: ReturnType<typeof parseEventsConfig> | undefined;
    if (repair.calendarId || repair.calendarHintDeliveryKey) {
    try {
      assertExecution();
      config = parseEventsConfig(await input.configFor(repair.scopeId));
      assertExecution();
    } catch (error) {
      failures.push(`config: ${errorReason(error)}`);
    }
  }

    if (
    repair.subgroupChatId &&
    event.subgroupChatId === repair.subgroupChatId &&
    event.groupTitle === repair.targetGroupTitle
  ) {
    try {
      assertExecution();
      await input.sender.setGroupSubject(repair.subgroupChatId, repair.targetGroupTitle);
      assertExecution();
    } catch (error) {
      failures.push(`group_subject: ${errorReason(error)}`);
    }
  }

    if (config) {
    try {
      assertExecution();
      const calendarId = resolvedEventCalendarId(event) ?? '';
      if (repair.calendarId !== calendarId) {
        failures.push('calendar: persisted edit intent does not match authoritative event calendar ownership');
      } else if (calendarId) {
        const publication = await (input.publishCalendar ?? writePublishAndRecordScopeCalendar)({
          appConfig: input.appConfig,
          db: input.db,
          config,
          scopeId: repair.scopeId,
          calendarId,
          ...(input.services ? { services: input.services } : {})
        });
        assertExecution();
        if (publication && !publication.ok) {
          failures.push(`calendar: ${publication.error || 'publication failed'}`);
        }
      }
    } catch (error) {
      failures.push(`calendar: ${errorReason(error)}`);
    }
  }

    if (repair.calendarHintDeliveryKey) {
    if (config) {
      const profile = config.eventProfiles.find((candidate) => candidate.id === event.profileId);
      if (!profile) {
        failures.push('calendar_hint: event profile is unavailable');
      } else if (!event.announcementGroupWid) {
        failures.push('calendar_hint: announcement group is unavailable');
      } else {
        try {
          assertExecution();
          const result = await sendEventCalendarHint({
            context: {
              config: input.appConfig,
              ...(input.getGroupInviteCode ? { getGroupInviteCode: input.getGroupInviteCode } : {})
            },
            runtime: { config: input.appConfig },
            db: input.db,
            activeTransport: input.sender,
            trigger: 'poll_published',
            scopeId: repair.scopeId,
            announcementGroupWid: event.announcementGroupWid,
            event,
            profile,
            calendars: config.calendars,
            timezone: event.timezone,
            locale: repair.calendarHintLocale ?? 'en',
            creatorDisplayName: event.actorLabel || event.actorWid,
            ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
            expectedEventUpdatedAt: repair.expectedEventUpdatedAt,
            deliveryKey: repair.calendarHintDeliveryKey
          });
          assertExecution();
          if (result === 'failed') {
            failures.push('calendar_hint: delivery failed');
          } else if (result === 'already_claimed') {
            failures.push('calendar_hint: delivery is already in progress');
            const currentClaim = getEventAnnouncementDeliveryClaim(
              input.db,
              repair.eventId,
              'calendar_hint',
              repair.calendarHintDeliveryKey
            );
            const leaseExpiresAt = currentClaim?.leaseExpiresAt
              ? new Date(currentClaim.leaseExpiresAt)
              : undefined;
            if (leaseExpiresAt && Number.isFinite(leaseExpiresAt.getTime()) && leaseExpiresAt > now) {
              retryAt = laterDate(retryAt, leaseExpiresAt);
            }
          }
        } catch (error) {
          failures.push(`calendar_hint: ${errorReason(error)}`);
        }
      }
    }
  }

    if (repair.announcementDeliveryKey) {
    const claim = getEventAnnouncementDeliveryClaim(
      input.db,
      repair.eventId,
      'event_edit',
      repair.announcementDeliveryKey
    );
    if (!claim?.text || !claim.idempotencyKey) {
      failures.push('edit_announcement: persisted delivery intent is missing');
    } else {
      try {
        assertExecution();
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
        assertExecution();
        if (delivery.status === 'superseded') {
          // A newer edit won the database race before this send claim was acquired.
        } else if (delivery.status === 'already_claimed') {
          failures.push('edit_announcement: delivery is already in progress');
          const leaseExpiresAt = claim.leaseExpiresAt ? new Date(claim.leaseExpiresAt) : undefined;
          if (leaseExpiresAt && Number.isFinite(leaseExpiresAt.getTime()) && leaseExpiresAt > now) {
            retryAt = laterDate(retryAt, leaseExpiresAt);
          }
        }
      } catch (error) {
        failures.push(`edit_announcement: ${errorReason(error)}`);
      }
    }
  }

    if (failures.length === 0) {
    return completeRepair()
      ? { status: 'completed', failures: [] }
      : { status: 'pending', failures: ['edit_repair: execution lease was lost before completion'] };
  }

    markEventEditRepairPending(input.db, {
    operationId: repair.operationId,
    executionClaimId: execution.claimId,
    reason: failures.join('; '),
    updatedAt: now.toISOString()
  });
    return {
    status: 'pending',
    failures,
    ...(retryAt ? { retryAt } : {})
    };
  } finally {
    clearInterval(heartbeat);
    releaseEventEditRepairExecution(input.db, {
      operationId: repair.operationId,
      claimId: execution.claimId
    });
  }
}

function laterDate(current: Date | undefined, candidate: Date): Date {
  return !current || candidate > current ? candidate : current;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
