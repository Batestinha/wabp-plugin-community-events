import { z } from 'zod';

export const COMMUNITY_SUBGROUPS_SERVICE_ID = 'official.community-subgroups.v1';
export const COMMUNITY_SUBGROUPS_CANDIDATE_METHOD = 'createManagedSubgroupCandidate';
export const COMMUNITY_SUBGROUPS_CANDIDATE_TIMEOUT_MS = 120_000;
export const COMMUNITY_SUBGROUPS_RECONCILE_CREATOR_METHOD = 'reconcileManagedSubgroupCreator';
export const COMMUNITY_SUBGROUPS_RECONCILE_CREATOR_TIMEOUT_MS = 120_000;
export const COMMUNITY_SUBGROUPS_CONFIGURE_METHOD = 'configureManagedSubgroup';
export const COMMUNITY_SUBGROUPS_CONFIGURE_TIMEOUT_MS = 120_000;
export const COMMUNITY_SUBGROUPS_COMPLETE_METHOD = 'completeManagedSubgroup';
export const COMMUNITY_SUBGROUPS_COMPLETE_TIMEOUT_MS = 120_000;

const createdGroupParticipantResultSchema = z.object({
  statusCode: z.number().int().optional(),
  message: z.string().optional(),
  isGroupCreator: z.boolean(),
  isInviteV4Sent: z.boolean(),
  requiredCreatorMembershipStatus: z.enum([
    'initial_create_missing',
    'technical_retry_pending',
    'direct_add_pending',
    'invite_pending',
    'privacy_invite_delivery_uncertain',
    'privacy_action_required',
    'provider_rejection',
    'outcome_ambiguous',
    'direct_add_not_observed',
    'membership_confirmed'
  ]).optional()
}).strict();

const createdGroupSchema = z.object({
  chatId: z.string().min(1),
  title: z.string(),
  participants: z.record(createdGroupParticipantResultSchema)
}).strict();

export const requiredCreatorBindingSchema = z.object({
  identityId: z.string().trim().min(1),
  participantWid: z.string().trim().min(1),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const persistedRequiredCreatorReferenceSchema = requiredCreatorBindingSchema.extend({
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict();

const managedCommunitySubgroupSchema = createdGroupSchema.extend({
  requiredCreator: requiredCreatorBindingSchema
}).strict();

const createdGroupCandidateSchema = managedCommunitySubgroupSchema.extend({
  intendedParentCommunityJid: z.string().min(1)
}).strict();

export const communitySubgroupCandidateInputSchema = z.object({
  title: z.string().min(1),
  parentCommunityWid: z.string().min(1)
}).strict();

export const communitySubgroupCandidateOutputSchema = z.object({
  created: createdGroupCandidateSchema
}).strict();

export const communitySubgroupReconcileCreatorInputSchema = z.object({
  chatId: z.string().min(1),
  title: z.string().min(1),
  requiredCreator: persistedRequiredCreatorReferenceSchema,
  participants: z.record(createdGroupParticipantResultSchema).optional(),
  parentCommunityWid: z.string().min(1)
}).strict();

export const communitySubgroupReconcileCreatorOutputSchema = z.object({
  created: managedCommunitySubgroupSchema
}).strict();

export const communitySubgroupConfigureInputSchema = z.object({
  chatId: z.string().min(1),
  title: z.string().min(1),
  requiredCreator: requiredCreatorBindingSchema,
  description: z.string().optional(),
  participants: z.record(createdGroupParticipantResultSchema).optional(),
  parentCommunityWid: z.string().min(1)
}).strict();

export const communitySubgroupConfigureOutputSchema = z.object({
  created: managedCommunitySubgroupSchema
}).strict();

export const communitySubgroupCompleteOutputSchema = z.object({
  created: managedCommunitySubgroupSchema,
  participantCount: z.number().int().nonnegative().optional()
}).strict();

export const communitySubgroupCompleteInputSchema = z.object({
  chatId: z.string().min(1),
  title: z.string().min(1),
  requiredCreator: requiredCreatorBindingSchema,
  description: z.string().optional(),
  participantWids: z.array(z.string().min(1)),
  participants: z.record(createdGroupParticipantResultSchema).optional(),
  parentCommunityWid: z.string().min(1)
}).strict();

export type CommunitySubgroupCandidateInput = z.infer<typeof communitySubgroupCandidateInputSchema>;
export type CommunitySubgroupCandidateOutput = z.infer<typeof communitySubgroupCandidateOutputSchema>;
export type CommunitySubgroupReconcileCreatorInput = z.infer<typeof communitySubgroupReconcileCreatorInputSchema>;
export type CommunitySubgroupReconcileCreatorOutput = z.infer<typeof communitySubgroupReconcileCreatorOutputSchema>;
export type CommunitySubgroupConfigureInput = z.infer<typeof communitySubgroupConfigureInputSchema>;
export type CommunitySubgroupConfigureOutput = z.infer<typeof communitySubgroupConfigureOutputSchema>;
export type CommunitySubgroupCompleteInput = z.infer<typeof communitySubgroupCompleteInputSchema>;
export type CommunitySubgroupCompleteOutput = z.infer<typeof communitySubgroupCompleteOutputSchema>;
