import type { AppConfig } from '../../../platform/config/runtimeConfig';
import type { OfficialPluginCommandRuntime } from '../shared';
import {
  persistedEventAnnouncementDisposition,
  sendClaimedEventAnnouncement
} from './announcementDelivery';
import { eventGroupJoinUrl, templateUsesToken } from './announcements';
import { eventsCalendarSubscriptionUrl } from './calendarSubscription';
import type { EventCalendarResource, EventProfile } from './config';
import { renderEventTemplate } from './flow';
import { appendScopeEventJsonLog } from './log';
import {
  eventsDatabase,
  getCalendarPublicationStatus,
  type StoredEventRecord
} from './store';

export type CalendarHintTrigger = 'poll_published' | 'unplanned_created' | 'unplanned_recovery';

export interface CalendarHintTextTransport {
  sendText(chatId: string, text: string): Promise<{ messageId?: string | undefined }>;
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

export async function sendEventCalendarHint(input: {
  context: EventCalendarHintContext;
  runtime: OfficialPluginCommandRuntime;
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
}): Promise<EventCalendarHintResult> {
  const hint = input.profile.calendar.hint;
  const enabled = input.trigger === 'poll_published'
    ? hint.sendOnPollPublished
    : hint.sendOnUnplannedCreated;
  if (!enabled) {
    return 'disabled';
  }
  const runtime = input.runtime;
  const db = eventsDatabase(runtime.databases);
  const persistedDelivery = persistedEventAnnouncementDisposition(db, input.event.id, 'calendar_hint', 'initial');
  if (persistedDelivery) {
    return persistedDelivery;
  }
  const template = hint.template.trim() ? hint.template : '';
  const calendarId = input.profile.calendar.calendarId.trim();
  try {
    const calendar = calendarId ? input.calendars.find((candidate) => candidate.id === calendarId) : undefined;
    if (!template) {
      await recordCalendarHintSkipped(input, 'empty_template', calendarId);
      return 'skipped';
    }
    if (!calendarId || !calendar) {
      await recordCalendarHintSkipped(input, 'calendar_not_configured', calendarId);
      return 'skipped';
    }
    if (!calendar.enabled) {
      await recordCalendarHintSkipped(input, 'calendar_disabled', calendarId);
      return 'skipped';
    }
    const publicationStatus = getCalendarPublicationStatus(db, input.scopeId, calendarId);
    const hostedSubscriptionUrl = publicationStatus?.ok
      ? publicationStatus.subscriptionUrl || ''
      : '';
    const origin = operatorConsolePublicOriginForRuntime(runtime.config);
    const fallbackSubscriptionUrl = botVisibleCalendarSubscriptionUrl({
      operatorConsolePublicOrigin: origin,
      runtimeBindingId: runtime.config.RUNTIME_BINDING_ID,
      scopeId: input.scopeId,
      calendarId,
      token: calendar.subscriptionToken
    });
    const subscriptionUrl = hostedSubscriptionUrl || fallbackSubscriptionUrl;
    if (!subscriptionUrl) {
      await recordCalendarHintSkipped(input, 'subscription_url_unavailable', calendarId, {
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
      await recordCalendarHintSkipped(input, 'empty_rendered_text', calendarId);
      return 'skipped';
    }
    const delivery = await sendClaimedEventAnnouncement({
      db,
      eventId: input.event.id,
      scopeId: input.scopeId,
      kind: 'calendar_hint',
      deliveryKey: 'initial',
      chatId: input.announcementGroupWid,
      text,
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
