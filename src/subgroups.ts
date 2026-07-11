import type { CreatedGroup } from '../../../platform/transport/transportTypes';
import type { ManagedCommunitySubgroupCreationPolicy } from '../../../platform/pluginRuntime/runtime/pluginCommunityOperations';
import { parseCommunitySubgroupsConfig } from '../community-subgroups/config';
import { COMMUNITY_SUBGROUPS_PLUGIN_ID } from '../community-subgroups/manifest';

export interface EventSubgroupContext {
  catalog?: {
    configFor(pluginId: string, scopeId: string, actorWid?: string | undefined): Promise<Record<string, unknown>>;
  } | undefined;
  communityGroupWidForScope?(scopeId: string): Promise<string | undefined>;
  ensureChatArchivePolicyForScope?(scopeId: string): Promise<unknown>;
  createManagedCommunitySubgroup?(input: {
    scopeId: string;
    actorWid: string;
    title: string;
    description?: string | undefined;
    participantWids: string[];
    parentCommunityWid: string;
    creationPolicy: ManagedCommunitySubgroupCreationPolicy;
  }): Promise<{
    created: CreatedGroup;
    participantCount?: number | undefined;
  }>;
}

export async function createEventCommunitySubgroup(input: {
  context: EventSubgroupContext;
  scopeId: string;
  actorWid: string;
  title: string;
  participantWids: string[];
}): Promise<Awaited<ReturnType<NonNullable<EventSubgroupContext['createManagedCommunitySubgroup']>>>> {
  if (!input.context.createManagedCommunitySubgroup) {
    throw new Error('Plugin runtime does not expose createManagedCommunitySubgroup.');
  }
  await input.context.ensureChatArchivePolicyForScope?.(input.scopeId);
  const parentCommunityWid = await input.context.communityGroupWidForScope?.(input.scopeId);
  if (!parentCommunityWid) {
    throw new Error('No parent community is mapped for this scope.');
  }
  const creationPolicy = await communitySubgroupCreationPolicyForScope(input.context, input.scopeId, input.actorWid);
  return input.context.createManagedCommunitySubgroup({
    scopeId: input.scopeId,
    actorWid: input.actorWid,
    title: input.title,
    participantWids: input.participantWids,
    parentCommunityWid,
    creationPolicy
  });
}

export async function communitySubgroupCreationPolicyForScope(
  context: EventSubgroupContext,
  scopeId: string,
  actorWid?: string | undefined
): Promise<ManagedCommunitySubgroupCreationPolicy> {
  const rawConfig = context.catalog
    ? await context.catalog.configFor(COMMUNITY_SUBGROUPS_PLUGIN_ID, scopeId, actorWid)
    : {};
  return parseCommunitySubgroupsConfig(rawConfig).creationPolicy;
}
