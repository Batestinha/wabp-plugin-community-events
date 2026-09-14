import { resolvePluginTemplateMentions, combineResolvedTemplate, previewTemplateFragment, type PluginTemplateMentionContext, type TemplateFragment } from '@wabs/plugin-sdk/templates';
import type { EventProfile } from './config';
import { renderEventTemplateFragment } from './flow';
import type { StoredEventRecord } from './store';

export type EventGroupHintTrigger = 'unplanned' | 'planned' | 'adopted';

export interface EventGroupInviteContext {
  getGroupInviteCode?(groupWid: string): Promise<string | null>;
}

export function eventGroupHintEnabled(profile: EventProfile | undefined, trigger: EventGroupHintTrigger): boolean {
  if (!profile) {
    return false;
  }
  switch (trigger) {
    case 'unplanned':
      return profile.eventGroupHint.sendForUnplannedEvents;
    case 'planned':
      return profile.eventGroupHint.sendForPlannedEvents;
    case 'adopted':
      return profile.eventGroupHint.sendForAdoptedEvents;
  }
}

export async function eventGroupJoinUrl(
  context: EventGroupInviteContext,
  template: string,
  subgroupChatId: string
): Promise<string> {
  if (!templateUsesToken(template, 'groupJoinUrl')) {
    return '';
  }
  if (!context.getGroupInviteCode) {
    throw new Error('Plugin runtime does not expose getGroupInviteCode.');
  }
  const inviteCode = await context.getGroupInviteCode(subgroupChatId);
  if (!inviteCode) {
    throw new Error('No invite link is available for the event group.');
  }
  return inviteCode.startsWith('http')
    ? inviteCode
    : `https://chat.whatsapp.com/${inviteCode}`;
}

export function renderEventGroupAnnouncementFragment(input: {
  template: string;
  profile: EventProfile;
  event: StoredEventRecord;
  groupDisplayName: string;
  groupJoinUrl: string;
  subgroupChatId: string;
  locale?: string | undefined;
  creatorDisplayName?: string | undefined;
}): TemplateFragment {
  return renderEventTemplateFragment({
    template: input.template,
    profile: input.profile,
    answers: input.event.answers,
    rawAnswers: input.event.rawAnswers,
    startsAt: new Date(input.event.startsAt),
    endsAt: new Date(input.event.endsAt),
    spanKind: input.event.spanKind,
    timezone: input.event.timezone,
    locale: input.locale,
    creatorDisplayName: input.creatorDisplayName || input.event.actorLabel || input.event.actorWid,
    extraTokens: {
      eventId: input.event.id,
      groupDisplayName: input.groupDisplayName,
      groupJoinUrl: input.groupJoinUrl,
      subgroupChatId: input.subgroupChatId
    }
  });
}

export function renderEventEditAnnouncementFragment(input: {
  template: string;
  profile: EventProfile;
  event: StoredEventRecord;
  previousGroupDisplayName: string;
  editorDisplayName: string;
  locale?: string | undefined;
}): TemplateFragment {
  return renderEventTemplateFragment({
    template: input.template,
    profile: input.profile,
    answers: input.event.answers,
    rawAnswers: input.event.rawAnswers,
    startsAt: new Date(input.event.startsAtUtc || input.event.startsAt),
    endsAt: new Date(input.event.endsAt),
    spanKind: input.event.spanKind,
    timezone: input.event.timezone,
    locale: input.locale,
    creatorDisplayName: input.event.actorLabel || input.event.actorWid,
    extraTokens: {
      eventId: input.event.id,
      groupDisplayName: input.event.subgroupTitle || input.event.groupTitle,
      previousGroupDisplayName: input.previousGroupDisplayName,
      subgroupChatId: input.event.subgroupChatId,
      editorDisplayName: input.editorDisplayName
    }
  });
}

export function templateUsesToken(template: string, token: string): boolean {
  return new RegExp(`\\{${token}\\}`).test(template);
}

export async function resolveEventBody(fragment: TemplateFragment, context: PluginTemplateMentionContext, event: StoredEventRecord, chatId: string) {
  return combineResolvedTemplate(await resolvePluginTemplateMentions(fragment, { context, scopeId: event.scopeId, chatId,
    currentGroupId: chatId.endsWith('@g.us') ? chatId : event.groupWid,
    targets: { creator: [{ identityId: event.actorIdentityId, wid: event.actorWid }] } }));
}
function textOnly(fragment: TemplateFragment): string {
  if (fragment.segments.some(segment => segment.kind === 'mention')) throw new Error('Resolve event message mentions before delivery.');
  return previewTemplateFragment(fragment);
}
export function renderEventGroupAnnouncement(input: Parameters<typeof renderEventGroupAnnouncementFragment>[0]) { return textOnly(renderEventGroupAnnouncementFragment(input)); }
export function renderEventEditAnnouncement(input: Parameters<typeof renderEventEditAnnouncementFragment>[0]) { return textOnly(renderEventEditAnnouncementFragment(input)); }
