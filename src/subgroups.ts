import type { PluginServiceCaller } from '../../../platform/pluginRuntime/pluginServices';
import {
  COMMUNITY_SUBGROUPS_CREATE_METHOD,
  COMMUNITY_SUBGROUPS_SERVICE_ID,
  type CommunitySubgroupCreateOutput
} from '../community-subgroups/serviceApi';

export interface EventSubgroupContext {
  services?: PluginServiceCaller | undefined;
  communityGroupWidForScope?(scopeId: string): Promise<string | undefined>;
  ensureChatArchivePolicyForScope?(scopeId: string): Promise<unknown>;
}

export async function createEventCommunitySubgroup(input: {
  context: EventSubgroupContext;
  scopeId: string;
  actorWid: string;
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
    actorWid: input.actorWid,
    groupWid: parentCommunityWid,
    input: {
      title: input.title,
      participantWids: input.participantWids,
      parentCommunityWid
    }
  });
}
