import type { PluginOperationContext as PluginCommandContext } from './runtime';
import type { CalendarHintTextTransport } from './calendarHint';
import {
  authorizeEventCalendarHintTarget,
  sendEventCalendarHint,
  type CalendarHintTrigger,
  type EventCalendarHintResult
} from './calendarHint';
import { parseEventsConfig } from './config';
import {
  eventCalendarHintReplayInputSchema,
  type EventCalendarHintReplayResult
} from './operatorActions';
import {
  eventsDatabase,
  getEvent,
  getEventAnnouncementDeliveryClaim,
  type EventCalendarHintDeliveryIntent,
  type StoredEventRecord
} from './store';
import { requireOfficialCommandRuntime } from './runtime';

const GROUP_WID_PATTERN = /^[^\s@]+@g\.us$/i;
const INITIAL_CALENDAR_HINT_DELIVERY_KEY = 'initial';

export interface EventCalendarHintReplayDeps {
  sendCalendarHint?: typeof sendEventCalendarHint | undefined;
}

export async function replayInitialEventCalendarHint(input: {
  context: PluginCommandContext;
  activeTransport: CalendarHintTextTransport;
  request: unknown;
}, deps: EventCalendarHintReplayDeps = {}): Promise<EventCalendarHintReplayResult> {
  const request = eventCalendarHintReplayInputSchema.parse(input.request);
  const runtime = requireOfficialCommandRuntime(input.context);
  const db = eventsDatabase(runtime.databases);
  const event = getEvent(db, request.eventId);
  if (!event || event.scopeId !== request.scopeId) {
    return {
      ...request,
      status: 'not_found',
      reason: `Unknown event ${request.eventId} in scope ${request.scopeId}.`
    };
  }
  if (event.eventStatus !== 'active') {
    return rejected(request, `Event ${event.id} is ${event.eventStatus}; only active events can replay their initial calendar hint.`);
  }
  if (input.context.enabledFor && !(await input.context.enabledFor(request.scopeId))) {
    return rejected(request, 'official.community-events is not enabled for this scope.');
  }

  const config = parseEventsConfig(await runtime.configFor(request.scopeId, event.actorIdentityId));
  if (!config.enabled) {
    return rejected(request, 'official.community-events is disabled for this scope.');
  }
  const profile = config.eventProfiles.find((candidate) => candidate.id === event.profileId);
  if (!profile) {
    return rejected(request, `Event profile ${event.profileId} is not available in the active scope configuration.`);
  }

  const persistedDelivery = getEventAnnouncementDeliveryClaim(
    db,
    event.id,
    'calendar_hint',
    INITIAL_CALENDAR_HINT_DELIVERY_KEY
  );
  if (persistedDelivery && persistedDelivery.scopeId !== request.scopeId) {
    return rejected(request, 'The persisted initial calendar-hint delivery belongs to a different scope.');
  }
  const persistedIntent = persistedDelivery?.calendarHintIntent;
  const announcementGroupWid = (
    persistedDelivery?.chatId ?? event.announcementGroupWid ?? ''
  ).trim().toLowerCase();
  if (!GROUP_WID_PATTERN.test(announcementGroupWid)) {
    return rejected(request, `Event ${event.id} has no valid announcement group.`);
  }
  const authorization = await authorizeEventCalendarHintTarget({
    ...(input.context.coveredGroupsForScope
      ? { coveredGroupsForScope: input.context.coveredGroupsForScope }
      : {}),
    ...(input.context.botCapabilitiesFor
      ? { botCapabilitiesFor: input.context.botCapabilitiesFor }
      : {})
  }, {
    scopeId: request.scopeId,
    chatId: announcementGroupWid
  });
  if (!authorization.ok) {
    return rejected(
      request,
      `Announcement group ${announcementGroupWid} is not eligible for calendar-hint replay: ${authorization.reason}.`
    );
  }

  const trigger = persistedIntent?.trigger ?? calendarHintReplayTrigger(event);
  const locale = persistedIntent?.locale ?? await eventCalendarHintReplayLocale(
    input.context,
    event,
    request.scopeId
  );
  const replayEvent = eventForPersistedCalendarHintIntent(event, persistedIntent);
  const status = await (deps.sendCalendarHint ?? sendEventCalendarHint)({
    context: {
      config: input.context.config,
      ...(input.context.getGroupInviteCode ? { getGroupInviteCode: input.context.getGroupInviteCode } : {})
    },
    runtime,
    db,
    activeTransport: input.activeTransport,
    trigger,
    scopeId: request.scopeId,
    announcementGroupWid,
    event: replayEvent,
    profile,
    calendars: config.calendars,
    timezone: persistedIntent?.timezone ?? (event.timezone || config.timezone),
    locale,
    creatorDisplayName: persistedIntent?.creatorDisplayName ?? (event.actorLabel || event.actorWid),
    ...(persistedIntent
      ? {
          groupJoinUrl: persistedIntent.groupJoinUrl ?? '',
          subgroupChatId: persistedIntent.subgroupChatId ?? ''
        }
      : event.subgroupChatId
        ? { subgroupChatId: event.subgroupChatId }
        : {}),
    expectedEventUpdatedAt: persistedIntent?.expectedEventUpdatedAt ?? event.updatedAt,
    deliveryKey: INITIAL_CALENDAR_HINT_DELIVERY_KEY
  });

  return {
    ...request,
    status,
    trigger,
    deliveryKey: INITIAL_CALENDAR_HINT_DELIVERY_KEY,
    profileId: profile.id,
    announcementGroupWid,
    ...(calendarHintReplayReason(status) ? { reason: calendarHintReplayReason(status) } : {})
  };
}

function calendarHintReplayTrigger(event: StoredEventRecord): CalendarHintTrigger {
  return event.origin === 'created' ? 'poll_published' : 'unplanned_recovery';
}

function eventForPersistedCalendarHintIntent(
  event: StoredEventRecord,
  intent: EventCalendarHintDeliveryIntent | undefined
): StoredEventRecord {
  if (!intent) {
    return event;
  }
  return {
    ...event,
    calendarId: intent.calendarId,
    calendarOwnershipStatus: 'assigned'
  };
}

function calendarHintReplayReason(status: EventCalendarHintResult): string | undefined {
  switch (status) {
    case 'disabled':
      return 'Calendar hints are disabled for this event profile and origin.';
    case 'already_claimed':
      return 'The initial calendar hint is already being delivered.';
    case 'superseded':
      return 'The initial calendar-hint delivery intent was superseded.';
    case 'skipped':
      return 'The initial calendar hint was skipped because its calendar, template, or subscription URL is unavailable.';
    case 'failed':
      return 'The initial calendar hint delivery failed.';
    case 'already_sent':
    case 'sent':
      return undefined;
  }
}

async function eventCalendarHintReplayLocale(
  context: PluginCommandContext,
  event: StoredEventRecord,
  scopeId: string
): Promise<string> {
  let actorIdentityId = event.actorIdentityId?.trim();
  if (!actorIdentityId && context.resolveIdentityAddress) {
    try {
      actorIdentityId = (await context.resolveIdentityAddress(event.actorWid)).identityId.trim();
    } catch {
      // Legacy events can lack an authoritative identity. Scope locale
      // resolution remains available without weakening the replay fence.
    }
  }
  return actorIdentityId
    ? (await context.i18n.resolveIdentityLocale(actorIdentityId, scopeId)).locale
    : (await context.i18n.resolveScopeLocale(scopeId)).locale;
}

function rejected(
  request: { scopeId: string; eventId: string },
  reason: string
): EventCalendarHintReplayResult {
  return { ...request, status: 'rejected', reason };
}
