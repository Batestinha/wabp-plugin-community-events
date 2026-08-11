import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import {
  isManagedCommunitySubgroupProvisioningError
} from '../../../platform/pluginRuntime/runtime/pluginCommunityOperations';
import type { CreatedGroupParticipantResult } from '../../../platform/transport/transportTypes';
import type { StoredEventRecord } from './store';

export type EventCreatorMembershipPauseKind =
  | 'invite_pending'
  | 'manual_join_pending';

type EventCreatorMembershipNoticeContext = Pick<
  PluginRuntimeContext,
  'getGroupInviteCode' | 'i18n' | 'resolveStableIdentityById' | 'sendText'
>;

type EventCreatorMembershipNoticeTranslator = (
  key: string,
  variables?: Record<string, string | number | boolean | undefined>
) => string;

export interface RenderedEventCreatorMembershipNotice {
  kind: EventCreatorMembershipPauseKind;
  text: string;
  idempotencyKey: string;
  groupJoinUrl?: string | undefined;
}

export function eventCreatorMembershipPauseKind(
  participants: Record<string, CreatedGroupParticipantResult>
): EventCreatorMembershipPauseKind | undefined {
  const statuses = Object.values(participants).flatMap((participant) =>
    participant.requiredCreatorMembershipStatus
      ? [participant.requiredCreatorMembershipStatus]
      : []
  );
  if (statuses.includes('invite_pending')) {
    return 'invite_pending';
  }
  if (statuses.includes('manual_join_pending')) {
    return 'manual_join_pending';
  }
  return undefined;
}

export function eventCreatorMembershipPauseKindForFailure(
  error: unknown
): EventCreatorMembershipPauseKind | undefined {
  if (
    !isManagedCommunitySubgroupProvisioningError(error) ||
    error.stage !== 'reconcile_creator'
  ) {
    return undefined;
  }
  const persistedKind = eventCreatorMembershipPauseKind(error.created.participants);
  if (error.preconditionReason === 'invite_pending' && persistedKind === 'invite_pending') {
    return persistedKind;
  }
  if (
    error.preconditionReason === 'creator_action_required' &&
    persistedKind === 'manual_join_pending'
  ) {
    return persistedKind;
  }
  return undefined;
}

export async function renderEventCreatorMembershipNotice(input: {
  context: Pick<EventCreatorMembershipNoticeContext, 'getGroupInviteCode'>;
  t: EventCreatorMembershipNoticeTranslator;
  eventId: string;
  title: string;
  subgroupChatId: string;
  kind: EventCreatorMembershipPauseKind;
}): Promise<RenderedEventCreatorMembershipNotice> {
  const groupJoinUrl = await eventCreatorGroupJoinUrl(input.context, input.subgroupChatId);
  if (input.kind === 'manual_join_pending' && !groupJoinUrl) {
    throw new Error(
      `No reusable group link is available for creator manual join in event ${input.eventId}.`
    );
  }
  const variables = {
    title: input.title,
    eventId: input.eventId,
    ...(groupJoinUrl ? { groupJoinUrl } : {})
  };
  const messageKey = groupJoinUrl
    ? input.kind === 'invite_pending'
      ? 'official.community-events.creatorMembershipPaused.joinLink.invitePending'
      : 'official.community-events.creatorMembershipPaused.joinLink.manualJoin'
    : input.kind === 'invite_pending'
      ? 'official.community-events.creatorMembershipPaused.privateInvite'
      : 'official.community-events.creatorMembershipPaused.joinLink.manualJoin';
  return {
    kind: input.kind,
    text: input.t(messageKey, variables),
    idempotencyKey: eventCreatorMembershipNoticeIdempotencyKey(
      input.eventId,
      input.subgroupChatId,
      input.kind
    ),
    ...(groupJoinUrl ? { groupJoinUrl } : {})
  };
}

export async function notifyEventCreatorMembershipPaused(input: {
  context: EventCreatorMembershipNoticeContext;
  event: StoredEventRecord;
  kind: EventCreatorMembershipPauseKind;
}): Promise<RenderedEventCreatorMembershipNotice> {
  const actorIdentityId = input.event.actorIdentityId?.trim();
  if (!actorIdentityId) {
    throw new Error(`Event ${input.event.id} has no authoritative creator identity for membership notice.`);
  }
  const subgroupChatId = input.event.subgroupChatId?.trim();
  if (!subgroupChatId) {
    throw new Error(`Event ${input.event.id} has no exact subgroup for membership notice.`);
  }
  if (!input.context.resolveStableIdentityById || !input.context.sendText) {
    throw new Error('Plugin runtime does not expose authoritative creator notice delivery.');
  }
  const [creatorAddress, t] = await Promise.all([
    input.context.resolveStableIdentityById(actorIdentityId),
    input.context.i18n.translatorForIdentity(actorIdentityId, input.event.scopeId)
  ]);
  const notice = await renderEventCreatorMembershipNotice({
    context: input.context,
    t,
    eventId: input.event.id,
    title: input.event.subgroupTitle || input.event.groupTitle,
    subgroupChatId,
    kind: input.kind
  });
  await input.context.sendText(creatorAddress.deliveryChatId, notice.text, {
    idempotencyKey: notice.idempotencyKey
  });
  return notice;
}

async function eventCreatorGroupJoinUrl(
  context: Pick<EventCreatorMembershipNoticeContext, 'getGroupInviteCode'>,
  subgroupChatId: string
): Promise<string | undefined> {
  if (!context.getGroupInviteCode) {
    return undefined;
  }
  try {
    const inviteCode = (await context.getGroupInviteCode(subgroupChatId))?.trim();
    if (!inviteCode) {
      return undefined;
    }
    return inviteCode.startsWith('http')
      ? inviteCode
      : `https://chat.whatsapp.com/${inviteCode}`;
  } catch {
    // A successful invite-v4 delivery remains usable even when the reusable
    // group link cannot be read. Notice rendering must not hide that invite.
    return undefined;
  }
}

function eventCreatorMembershipNoticeIdempotencyKey(
  eventId: string,
  subgroupChatId: string,
  kind: EventCreatorMembershipPauseKind
): string {
  return `community-events:creator-membership-paused:${eventId}:${subgroupChatId}:${kind}`;
}
