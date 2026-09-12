import type { AppConfig } from './deploymentConfig';
import type { PluginDatabase } from '../../../../packages/plugin-sdk/src/database';
import type { PluginRuntimeContext } from './runtime';
import type { OfficialPluginCommandRuntime } from './runtime';
import {
  eventAnnouncementTransportIdempotencyKey,
  persistedEventAnnouncementDisposition,
  sendClaimedEventAnnouncement
} from './announcementDelivery';
import { eventGroupJoinUrl, templateUsesToken } from './announcements';
import { eventsCalendarSubscriptionUrl } from './calendarSubscription';
import type { EventCalendarResource, EventProfile } from './config';
import { renderEventTemplate } from './flow';
import { appendScopeEventJsonLog } from './log';
import {
  assertScopeEventCalendarOwnershipResolved,
  deferEventCalendarHintDelivery,
  eventsDatabase,
  getEventAnnouncementDeliveryClaim,
  getCalendarPublicationStatus,
  prepareEventCalendarHintDelivery,
  resolvedEventCalendarId,
  supersedeEventAnnouncementDelivery,
  type EventCalendarHintTrigger,
  type StoredCalendarPublicationStatus,
  type StoredEventRecord
} from './store';

export type CalendarHintTrigger = EventCalendarHintTrigger;

export interface CalendarHintTextTransport {
  sendText(
    chatId: string,
    text: string,
    options?: { idempotencyKey?: string | undefined }
  ): Promise<{ messageId?: string | undefined }>;
}

export type EventCalendarHintResult =
  | 'disabled'
  | 'already_sent'
  | 'already_claimed'
  | 'superseded'
  | 'sent'
  | 'skipped'
  | 'failed';

export interface EventCalendarHintContext {
  config: AppConfig;
  getGroupInviteCode?(groupWid: string): Promise<string | null>;
}

export type EventCalendarHintTargetAuthorization =
  | {
      ok: true;
      groupWid: string;
      managementMode: 'ASSIST' | 'MANAGE';
    }
  | {
      ok: false;
      permanent: boolean;
      reason: string;
    };

export async function sendEventCalendarHint(input: {
  context: EventCalendarHintContext;
  runtime: Pick<OfficialPluginCommandRuntime, 'config' | 'databases'>;
  db?: PluginDatabase | undefined;
  activeTransport: CalendarHintTextTransport;
  trigger: CalendarHintTrigger;
  scopeId: string;
  announcementGroupWid: string;
  event: StoredEventRecord;
  profile: EventProfile;
  calendars: EventCalendarResource[];
  timezone: string;
  locale: string;
  creatorDisplayName: string;
  groupJoinUrl?: string | undefined;
  subgroupChatId?: string | undefined;
  expectedEventUpdatedAt?: string | undefined;
  deliveryKey?: string | undefined;
}): Promise<EventCalendarHintResult> {
  const hint = input.profile.calendar.hint;
  const enabled = input.trigger === 'poll_published'
    ? hint.sendOnPollPublished
    : hint.sendOnUnplannedCreated;
  const runtime = input.runtime;
  const db = input.db ?? eventsDatabase(runtime.databases);
  const deliveryKey = input.deliveryKey?.trim() || 'initial';
  if (!enabled) {
    const existing = getEventAnnouncementDeliveryClaim(
      db,
      input.event.id,
      'calendar_hint',
      deliveryKey
    );
    if (existing && existing.status !== 'sent') {
      supersedeEventAnnouncementDelivery(db, {
        eventId: input.event.id,
        kind: 'calendar_hint',
        deliveryKey
      });
    }
    return 'disabled';
  }
  const persistedDelivery = persistedEventAnnouncementDisposition(db, input.event.id, 'calendar_hint', deliveryKey);
  if (persistedDelivery === 'already_sent') {
    return persistedDelivery;
  }
  if (persistedDelivery === 'already_claimed') {
    const claim = getEventAnnouncementDeliveryClaim(db, input.event.id, 'calendar_hint', deliveryKey);
    if (claim?.status === 'superseded') {
      return 'superseded';
    }
    const leaseExpiresAt = claim?.leaseExpiresAt
      ? new Date(claim.leaseExpiresAt).getTime()
      : Number.NaN;
    const canReacquireExpiredLease = claim?.status === 'sending' &&
      (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.now());
    const canAcquirePersistedIntent = claim?.status === 'pending' || claim?.status === 'uncertain';
    if (!canReacquireExpiredLease && !canAcquirePersistedIntent) {
      return 'already_claimed';
    }
  }
  const template = hint.template.trim() ? hint.template : '';
  let calendarId = '';
  let intentPrepared = false;
  try {
    calendarId = resolvedEventCalendarId(input.event) ?? '';
    assertScopeEventCalendarOwnershipResolved(db, input.scopeId);
    const calendar = calendarId ? input.calendars.find((candidate) => candidate.id === calendarId) : undefined;
    if (!template) {
      supersedeEventAnnouncementDelivery(db, {
        eventId: input.event.id,
        kind: 'calendar_hint',
        deliveryKey
      });
      await recordCalendarHintSkipped(input, 'empty_template', calendarId);
      return 'skipped';
    }
    if (!calendarId || !calendar) {
      supersedeEventAnnouncementDelivery(db, {
        eventId: input.event.id,
        kind: 'calendar_hint',
        deliveryKey
      });
      await recordCalendarHintSkipped(input, 'calendar_not_configured', calendarId);
      return 'skipped';
    }
    if (!calendar.enabled) {
      supersedeEventAnnouncementDelivery(db, {
        eventId: input.event.id,
        kind: 'calendar_hint',
        deliveryKey
      });
      await recordCalendarHintSkipped(input, 'calendar_disabled', calendarId);
      return 'skipped';
    }
    const expectedEventUpdatedAt = input.expectedEventUpdatedAt ?? input.event.updatedAt;
    const preparation = prepareEventCalendarHintDelivery(db, {
      eventId: input.event.id,
      scopeId: input.scopeId,
      deliveryKey,
      chatId: input.announcementGroupWid,
      idempotencyKey: eventAnnouncementTransportIdempotencyKey({
        eventId: input.event.id,
        kind: 'calendar_hint',
        deliveryKey
      }),
      intent: {
        trigger: input.trigger,
        calendarId,
        locale: input.locale,
        timezone: input.timezone,
        creatorDisplayName: input.creatorDisplayName,
        expectedEventUpdatedAt,
        ...(input.groupJoinUrl ? { groupJoinUrl: input.groupJoinUrl } : {}),
        ...(input.subgroupChatId ? { subgroupChatId: input.subgroupChatId } : {})
      }
    });
    if (preparation === 'already_sent') {
      return 'already_sent';
    }
    if (preparation === 'already_claimed') {
      return 'already_claimed';
    }
    if (preparation === 'superseded') {
      return 'superseded';
    }
    intentPrepared = true;
    const publicationStatus = getCalendarPublicationStatus(db, input.scopeId, calendarId);
    const origin = operatorConsolePublicOriginForRuntime(runtime.config);
    const subscriptionUrl = resolveEventCalendarHintSubscriptionUrl({
      config: runtime.config,
      scopeId: input.scopeId,
      calendar,
      publicationStatus
    });
    if (!subscriptionUrl) {
      deferEventCalendarHintDelivery(db, {
        eventId: input.event.id,
        deliveryKey,
        reason: 'subscription_url_unavailable'
      });
      await recordCalendarHintSkipped(input, 'subscription_url_unavailable', calendarId, {
        retryable: true,
        tokenConfigured: Boolean(calendar.subscriptionToken.trim()),
        runtimeBindingIdConfigured: Boolean(runtime.config.RUNTIME_BINDING_ID.trim()),
        operatorConsolePublicOriginConfigured: Boolean(origin),
        hostedPublicationConfigured: Boolean(publicationStatus?.subscriptionUrl)
      });
      return 'skipped';
    }
    const groupJoinUrl = input.groupJoinUrl ||
      (input.subgroupChatId && templateUsesToken(template, 'groupJoinUrl')
        ? await eventGroupJoinUrl(input.context, template, input.subgroupChatId)
        : '');
    const text = renderEventTemplate({
      template,
      profile: input.profile,
      answers: input.event.answers,
      startsAt: new Date(input.event.startsAtUtc || input.event.startsAt),
      endsAt: new Date(input.event.endsAt),
      spanKind: input.event.spanKind,
      timezone: input.timezone,
      locale: input.locale,
      creatorDisplayName: input.creatorDisplayName,
      extraTokens: {
        eventId: input.event.id,
        groupDisplayName: input.event.subgroupTitle || input.event.groupTitle,
        groupJoinUrl,
        subgroupChatId: input.subgroupChatId ?? input.event.subgroupChatId,
        calendarId: calendar.id,
        calendarDisplayName: calendar.label || calendar.id,
        calendarSubscriptionUrl: subscriptionUrl
      }
    }).trim();
    if (!text) {
      supersedeEventAnnouncementDelivery(db, {
        eventId: input.event.id,
        kind: 'calendar_hint',
        deliveryKey
      });
      await recordCalendarHintSkipped(input, 'empty_rendered_text', calendarId);
      return 'skipped';
    }
    const delivery = await sendClaimedEventAnnouncement({
      db,
      eventId: input.event.id,
      scopeId: input.scopeId,
      kind: 'calendar_hint',
      deliveryKey,
      chatId: input.announcementGroupWid,
      text,
      expectedEventUpdatedAt,
      sender: input.activeTransport
    });
    if (delivery.status !== 'sent') {
      return delivery.status;
    }
    await appendEventJsonLog(input.context, {
      action: 'event.calendar_hint_sent',
      scopeId: input.scopeId,
      eventId: input.event.id,
      actorWid: input.event.actorWid,
      profileId: input.profile.id,
      ...(input.event.pollWaMsgId ? { pollWaMsgId: input.event.pollWaMsgId } : {}),
      ...(input.event.subgroupChatId ? { subgroupChatId: input.event.subgroupChatId } : {}),
      metadata: {
        trigger: input.trigger,
        announcementGroupWid: input.announcementGroupWid,
        calendarId,
        messageId: delivery.messageId
      }
    });
    return 'sent';
  } catch (error) {
    if (intentPrepared) {
      deferEventCalendarHintDelivery(db, {
        eventId: input.event.id,
        deliveryKey,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
    await appendEventJsonLog(input.context, {
      action: 'event.calendar_hint_failed',
      scopeId: input.scopeId,
      eventId: input.event.id,
      actorWid: input.event.actorWid,
      profileId: input.profile.id,
      ...(input.event.pollWaMsgId ? { pollWaMsgId: input.event.pollWaMsgId } : {}),
      ...(input.event.subgroupChatId ? { subgroupChatId: input.event.subgroupChatId } : {}),
      metadata: {
        trigger: input.trigger,
        announcementGroupWid: input.announcementGroupWid,
        calendarId,
        reason: error instanceof Error ? error.message : String(error)
      }
    });
    return 'failed';
  }
}

async function recordCalendarHintSkipped(
  input: {
    context: EventCalendarHintContext;
    trigger: CalendarHintTrigger;
    scopeId: string;
    announcementGroupWid: string;
    event: StoredEventRecord;
    profile: EventProfile;
  },
  reason: string,
  calendarId: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await appendEventJsonLog(input.context, {
    action: 'event.calendar_hint_skipped',
    scopeId: input.scopeId,
    eventId: input.event.id,
    actorWid: input.event.actorWid,
    profileId: input.profile.id,
    ...(input.event.pollWaMsgId ? { pollWaMsgId: input.event.pollWaMsgId } : {}),
    ...(input.event.subgroupChatId ? { subgroupChatId: input.event.subgroupChatId } : {}),
    metadata: {
      trigger: input.trigger,
      announcementGroupWid: input.announcementGroupWid,
      calendarId,
      reason,
      ...metadata
    }
  });
}

function operatorConsolePublicOriginForRuntime(config: OfficialPluginCommandRuntime['config']): string {
  const configured = (config as unknown as Record<string, unknown>).OPERATOR_CONSOLE_PUBLIC_ORIGIN;
  return (typeof configured === 'string' ? configured : process.env.OPERATOR_CONSOLE_PUBLIC_ORIGIN ?? '').trim();
}

export function botHostedEventCalendarSubscriptionUrl(input: {
  config: OfficialPluginCommandRuntime['config'];
  scopeId: string;
  calendarId: string;
  token?: string | undefined;
}): string {
  return botVisibleCalendarSubscriptionUrl({
    operatorConsolePublicOrigin: operatorConsolePublicOriginForRuntime(input.config),
    runtimeBindingId: input.config.RUNTIME_BINDING_ID,
    scopeId: input.scopeId,
    calendarId: input.calendarId,
    token: input.token
  });
}

export function resolveEventCalendarHintSubscriptionUrl(input: {
  config: OfficialPluginCommandRuntime['config'];
  scopeId: string;
  calendar: Pick<EventCalendarResource, 'id' | 'subscriptionToken'>;
  publicationStatus?: Pick<StoredCalendarPublicationStatus, 'ok' | 'subscriptionUrl'> | undefined;
}): string {
  const hostedSubscriptionUrl = input.publicationStatus?.ok === true
    ? input.publicationStatus.subscriptionUrl?.trim() ?? ''
    : '';
  if (hostedSubscriptionUrl) {
    return hostedSubscriptionUrl;
  }
  return botHostedEventCalendarSubscriptionUrl({
    config: input.config,
    scopeId: input.scopeId,
    calendarId: input.calendar.id,
    token: input.calendar.subscriptionToken
  });
}

export async function authorizeEventCalendarHintTarget(
  context: Pick<PluginRuntimeContext, 'coveredGroupsForScope' | 'botCapabilitiesFor'>,
  input: { scopeId: string; chatId: string }
): Promise<EventCalendarHintTargetAuthorization> {
  if (!context.coveredGroupsForScope) {
    return {
      ok: false,
      permanent: false,
      reason: 'calendar-hint delivery cannot verify the currently covered groups for this scope'
    };
  }
  let coveredGroups: Awaited<ReturnType<NonNullable<
    PluginRuntimeContext['coveredGroupsForScope']
  >>>;
  try {
    coveredGroups = await context.coveredGroupsForScope(input.scopeId);
  } catch (error) {
    return {
      ok: false,
      permanent: false,
      reason: `calendar-hint delivery could not verify group coverage: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
  const normalizedChatId = input.chatId.trim().toLowerCase();
  const matchingGroups = coveredGroups.filter(
    (group) => group.groupWid.trim().toLowerCase() === normalizedChatId
  );
  if (matchingGroups.length !== 1) {
    return {
      ok: false,
      permanent: true,
      reason: 'calendar-hint target is not exactly one currently covered group for this scope'
    };
  }
  const matchedGroup = matchingGroups[0]!;
  if (matchedGroup.managementMode === 'OBSERVE') {
    return {
      ok: false,
      permanent: true,
      reason: 'calendar-hint target is currently managed in OBSERVE mode'
    };
  }
  if (!context.botCapabilitiesFor) {
    return {
      ok: false,
      permanent: false,
      reason: 'calendar-hint delivery cannot verify authoritative group send capability'
    };
  }
  let capabilities: Awaited<ReturnType<NonNullable<
    PluginRuntimeContext['botCapabilitiesFor']
  >>>;
  try {
    capabilities = await context.botCapabilitiesFor(normalizedChatId);
  } catch (error) {
    return {
      ok: false,
      permanent: false,
      reason: `calendar-hint delivery could not verify group send capability: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
  if (!capabilities) {
    return {
      ok: false,
      permanent: false,
      reason: 'calendar-hint delivery has no authoritative group send capability snapshot'
    };
  }
  if (!capabilities.botIsMember) {
    return {
      ok: false,
      permanent: true,
      reason: 'calendar-hint target no longer includes the bot as a member'
    };
  }
  if (!capabilities.canSend) {
    return {
      ok: false,
      permanent: false,
      reason: 'calendar-hint target does not currently allow the bot to send messages'
    };
  }
  return {
    ok: true,
    groupWid: matchedGroup.groupWid.trim().toLowerCase(),
    managementMode: matchedGroup.managementMode
  };
}

function botVisibleCalendarSubscriptionUrl(input: Parameters<typeof eventsCalendarSubscriptionUrl>[0]): string {
  const url = eventsCalendarSubscriptionUrl(input);
  if (!url) {
    return '';
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return '';
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname === '0.0.0.0' ||
      hostname.startsWith('127.') ||
      hostname.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname.startsWith('192.168.')
    ) {
      return '';
    }
    return url;
  } catch {
    return '';
  }
}

async function appendEventJsonLog(
  context: EventCalendarHintContext,
  entry: Parameters<typeof appendScopeEventJsonLog>[0]['entry']
): Promise<void> {
  try {
    await appendScopeEventJsonLog({ appConfig: context.config, entry });
  } catch {
    // Do not fail event publication just because the append-only operator log is unavailable.
  }
}
