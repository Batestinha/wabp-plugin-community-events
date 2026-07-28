import type { EventProfile } from './config';
import { renderEventTemplate } from './flow';
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
      return profile.unplanned.sendForUnplannedEvents;
    case 'planned':
      return profile.unplanned.sendForPlannedEvents;
    case 'adopted':
      return profile.unplanned.sendForAdoptedEvents;
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

export function renderEventGroupAnnouncement(input: {
  template: string;
  profile: EventProfile;
  event: StoredEventRecord;
  groupDisplayName: string;
  groupJoinUrl: string;
  subgroupChatId: string;
  locale?: string | undefined;
  creatorDisplayName?: string | undefined;
}): string {
  return renderEventTemplate({
    template: input.template,
    profile: input.profile,
    answers: input.event.answers,
    startsAt: new Date(input.event.startsAt),
    timezone: input.event.timezone,
    locale: input.locale,
    creatorDisplayName: input.creatorDisplayName || input.event.actorLabel || input.event.actorWid,
    extraTokens: {
      eventId: input.event.id,
      groupDisplayName: input.groupDisplayName,
      groupJoinUrl: input.groupJoinUrl,
      subgroupChatId: input.subgroupChatId
    }
  }).trim();
}

export function templateUsesToken(template: string, token: string): boolean {
  return new RegExp(`\\{${token}\\}`).test(template);
}
