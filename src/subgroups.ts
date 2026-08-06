import type { PluginServiceCaller } from '../../../platform/pluginRuntime/pluginServices';
import type { CreatedGroupParticipantResult } from '../../../platform/transport/transportTypes';
import {
  COMMUNITY_SUBGROUPS_CREATE_METHOD,
  COMMUNITY_SUBGROUPS_RESUME_METHOD,
  COMMUNITY_SUBGROUPS_SERVICE_ID,
  type CommunitySubgroupCreateOutput,
  type CommunitySubgroupResumeOutput
} from '../community-subgroups/serviceApi';

export interface EventSubgroupContext {
  services?: PluginServiceCaller | undefined;
  communityGroupWidForScope?(scopeId: string): Promise<string | undefined>;
  ensureChatArchivePolicyForScope?(scopeId: string): Promise<unknown>;
}

export async function createEventCommunitySubgroup(input: {
  context: EventSubgroupContext;
  scopeId: string;
  actorIdentityId: string;
  title: string;
  participantWids: string[];
}): Promise<CommunitySubgroupCreateOutput> {
  if (!input.context.services) {
    throw new Error('Plugin runtime does not expose plugin services.');
  }
  await input.context.ensureChatArchivePolicyForScope?.(input.scopeId);
  const parentCommunityWid = await input.context.communityGroupWidForScope?.(input.scopeId);
  if (!parentCommunityWid) {
    throw new Error('No parent community is mapped for this scope.');
  }

  return input.context.services.call<CommunitySubgroupCreateOutput>({
    serviceId: COMMUNITY_SUBGROUPS_SERVICE_ID,
    method: COMMUNITY_SUBGROUPS_CREATE_METHOD,
    scopeId: input.scopeId,
    actorIdentityId: input.actorIdentityId,
    groupWid: parentCommunityWid,
    input: {
      title: input.title,
      participantWids: input.participantWids,
      parentCommunityWid
    }
  });
}

export async function resumeEventCommunitySubgroup(input: {
  context: EventSubgroupContext;
  scopeId: string;
  actorIdentityId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  participantWids: string[];
  participants: Record<string, CreatedGroupParticipantResult>;
  parentCommunityWid: string;
}): Promise<CommunitySubgroupResumeOutput> {
  if (!input.context.services) {
    throw new Error('Plugin runtime does not expose plugin services.');
  }
  await input.context.ensureChatArchivePolicyForScope?.(input.scopeId);
  return input.context.services.call<CommunitySubgroupResumeOutput>({
    serviceId: COMMUNITY_SUBGROUPS_SERVICE_ID,
    method: COMMUNITY_SUBGROUPS_RESUME_METHOD,
    scopeId: input.scopeId,
    actorIdentityId: input.actorIdentityId,
    groupWid: input.parentCommunityWid,
    input: {
      chatId: input.subgroupChatId,
      title: input.subgroupTitle,
      participantWids: input.participantWids,
      participants: input.participants,
      parentCommunityWid: input.parentCommunityWid
    }
  });
}
