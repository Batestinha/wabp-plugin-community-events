import type { PluginServiceCaller } from '@wabs/plugin-sdk/services';
import type {
  CreatedGroupParticipantResult,
  PersistedRequiredCreatorReference,
  RequiredCreatorBinding
} from '@wabs/plugin-sdk/transport';
import {
  COMMUNITY_SUBGROUPS_CANDIDATE_METHOD,
  COMMUNITY_SUBGROUPS_COMPLETE_METHOD,
  COMMUNITY_SUBGROUPS_CONFIGURE_METHOD,
  COMMUNITY_SUBGROUPS_RECONCILE_CREATOR_METHOD,
  COMMUNITY_SUBGROUPS_SERVICE_ID,
  type CommunitySubgroupCandidateOutput,
  type CommunitySubgroupCompleteOutput,
  type CommunitySubgroupConfigureOutput,
  type CommunitySubgroupReconcileCreatorOutput,
} from './contracts/community-subgroups/serviceApi';

export interface EventSubgroupContext {
  services?: PluginServiceCaller | undefined;
  communityGroupWidForScope?: ((scopeId: string) => Promise<string | undefined>) | undefined;
  ensureChatArchivePolicyForScope?: ((scopeId: string) => Promise<unknown>) | undefined;
}

export async function createEventCommunitySubgroupCandidate(input: {
  context: EventSubgroupContext;
  scopeId: string;
  actorIdentityId: string;
  title: string;
}): Promise<CommunitySubgroupCandidateOutput> {
  if (!input.context.services) {
    throw new Error('Plugin runtime does not expose plugin services.');
  }
  await input.context.ensureChatArchivePolicyForScope?.(input.scopeId);
  const parentCommunityWid = await input.context.communityGroupWidForScope?.(input.scopeId);
  if (!parentCommunityWid) {
    throw new Error('No parent community is mapped for this scope.');
  }
  return input.context.services.call<CommunitySubgroupCandidateOutput>({
    serviceId: COMMUNITY_SUBGROUPS_SERVICE_ID,
    method: COMMUNITY_SUBGROUPS_CANDIDATE_METHOD,
    scopeId: input.scopeId,
    actorIdentityId: input.actorIdentityId,
    groupWid: parentCommunityWid,
    input: {
      title: input.title,
      parentCommunityWid
    }
  });
}

export async function reconcileEventCommunitySubgroupCreator(input: {
  context: EventSubgroupContext;
  scopeId: string;
  actorIdentityId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  requiredCreator: PersistedRequiredCreatorReference;
  participants: Record<string, CreatedGroupParticipantResult>;
  parentCommunityWid: string;
}): Promise<CommunitySubgroupReconcileCreatorOutput> {
  if (!input.context.services) {
    throw new Error('Plugin runtime does not expose plugin services.');
  }
  await input.context.ensureChatArchivePolicyForScope?.(input.scopeId);
  return input.context.services.call<CommunitySubgroupReconcileCreatorOutput>({
    serviceId: COMMUNITY_SUBGROUPS_SERVICE_ID,
    method: COMMUNITY_SUBGROUPS_RECONCILE_CREATOR_METHOD,
    scopeId: input.scopeId,
    actorIdentityId: input.actorIdentityId,
    groupWid: input.parentCommunityWid,
    input: {
      chatId: input.subgroupChatId,
      title: input.subgroupTitle,
      requiredCreator: input.requiredCreator,
      participants: input.participants,
      parentCommunityWid: input.parentCommunityWid
    }
  });
}

export async function completeEventCommunitySubgroup(input: {
  context: EventSubgroupContext;
  scopeId: string;
  actorIdentityId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  requiredCreator: RequiredCreatorBinding;
  participantWids: string[];
  participants: Record<string, CreatedGroupParticipantResult>;
  parentCommunityWid: string;
}): Promise<CommunitySubgroupCompleteOutput> {
  if (!input.context.services) {
    throw new Error('Plugin runtime does not expose plugin services.');
  }
  await input.context.ensureChatArchivePolicyForScope?.(input.scopeId);
  return input.context.services.call<CommunitySubgroupCompleteOutput>({
    serviceId: COMMUNITY_SUBGROUPS_SERVICE_ID,
    method: COMMUNITY_SUBGROUPS_COMPLETE_METHOD,
    scopeId: input.scopeId,
    actorIdentityId: input.actorIdentityId,
    groupWid: input.parentCommunityWid,
    input: {
      chatId: input.subgroupChatId,
      title: input.subgroupTitle,
      requiredCreator: input.requiredCreator,
      participantWids: input.participantWids,
      participants: input.participants,
      parentCommunityWid: input.parentCommunityWid
    }
  });
}

export async function configureEventCommunitySubgroup(input: {
  context: EventSubgroupContext;
  scopeId: string;
  actorIdentityId: string;
  subgroupChatId: string;
  subgroupTitle: string;
  requiredCreator: RequiredCreatorBinding;
  participants: Record<string, CreatedGroupParticipantResult>;
  parentCommunityWid: string;
}): Promise<CommunitySubgroupConfigureOutput> {
  if (!input.context.services) {
    throw new Error('Plugin runtime does not expose plugin services.');
  }
  await input.context.ensureChatArchivePolicyForScope?.(input.scopeId);
  return input.context.services.call<CommunitySubgroupConfigureOutput>({
    serviceId: COMMUNITY_SUBGROUPS_SERVICE_ID,
    method: COMMUNITY_SUBGROUPS_CONFIGURE_METHOD,
    scopeId: input.scopeId,
    actorIdentityId: input.actorIdentityId,
    groupWid: input.parentCommunityWid,
    input: {
      chatId: input.subgroupChatId,
      title: input.subgroupTitle,
      requiredCreator: input.requiredCreator,
      participants: input.participants,
      parentCommunityWid: input.parentCommunityWid
    }
  });
}
