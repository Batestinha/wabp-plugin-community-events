import { z } from 'zod';

export const eventCalendarHintReplayInputSchema = z.object({
  scopeId: z.string().trim().min(1),
  eventId: z.string().trim().min(1)
}).strict();

export const eventCalendarHintReplayDispositionSchema = z.enum([
  'disabled',
  'already_sent',
  'already_claimed',
  'superseded',
  'sent',
  'skipped',
  'failed'
]);

const eventCalendarHintReplayTargetSchema = z.object({
  scopeId: z.string().trim().min(1),
  eventId: z.string().trim().min(1)
});

export const eventCalendarHintReplayResultSchema = z.discriminatedUnion('status', [
  eventCalendarHintReplayTargetSchema.extend({
    status: z.literal('not_found'),
    reason: z.string().trim().min(1)
  }).strict(),
  eventCalendarHintReplayTargetSchema.extend({
    status: z.literal('rejected'),
    reason: z.string().trim().min(1)
  }).strict(),
  eventCalendarHintReplayTargetSchema.extend({
    status: eventCalendarHintReplayDispositionSchema,
    trigger: z.enum(['poll_published', 'unplanned_created', 'unplanned_recovery']),
    deliveryKey: z.literal('initial'),
    profileId: z.string().trim().min(1),
    announcementGroupWid: z.string().trim().min(1),
    reason: z.string().trim().min(1).optional()
  }).strict()
]);

export type EventCalendarHintReplayInput = z.infer<typeof eventCalendarHintReplayInputSchema>;
export type EventCalendarHintReplayResult = z.infer<typeof eventCalendarHintReplayResultSchema>;

const runtimeGroupChatIdSchema = z.string().trim().regex(/^[^\s@]+@g\.us$/i).transform((value) => value.toLowerCase());
export const eventOperatorActionSchemas = {
  officialEventsAdopt: z.object({
    eventId: z.string().trim().min(1).optional(),
    scopeId: z.string().trim().min(1),
    mode: z.enum(['poll', 'group']),
    profileId: z.string().trim().min(1),
    answers: z.record(z.string()).default({}),
    locale: z.string().trim().min(1).optional(),
    pollWaMsgId: z.string().trim().min(1).optional(),
    subgroupChatId: runtimeGroupChatIdSchema.optional(),
    eventLocation: z.object({
      source: z.enum(['question', 'fixed']),
      displayLabel: z.string().trim().min(1),
      resolvedLabel: z.string().trim().min(1),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      timezone: z.string().trim().min(1),
      query: z.string().trim().min(1).optional(),
      provider: z.string().trim().min(1).optional(),
      providerRef: z.string().trim().min(1).optional()
    }).strict().optional(),
    actorIdentityId: z.string().trim().min(1)
  }).strict(),
  officialEventsTerminate: z.object({
    scopeId: z.string().trim().min(1),
    eventId: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(500).optional(),
    calendarDisposition: z.enum(['cancelled', 'hidden']).default('hidden'),
    deleteAnnouncementMessages: z.boolean().default(true),
    actorWid: z.string().trim().min(1).optional(),
    actorLabel: z.string().trim().min(1).optional()
  }).strict(),
  officialEventsRetryCancellationCleanup: z.object({
    scopeId: z.string().trim().min(1),
    eventId: z.string().trim().min(1)
  }).strict(),
  officialEventsResumeProvisioning: z.object({
    scopeId: z.string().trim().min(1),
    eventId: z.string().trim().min(1),
    subgroupChatId: runtimeGroupChatIdSchema,
    subgroupTitle: z.string().trim().min(1).optional(),
    participants: z.record(z.object({
      statusCode: z.number().int().optional(),
      message: z.string().optional(),
      isGroupCreator: z.boolean(),
      isInviteV4Sent: z.boolean()
    }).strict()).optional(),
    actorWid: z.string().trim().min(1).optional(),
    actorLabel: z.string().trim().min(1).optional()
  }).strict(),
  officialEventsRetryPreCreateProvisioning: z.object({
    scopeId: z.string().trim().min(1),
    eventId: z.string().trim().min(1),
    expectedUpdatedAt: z.string().datetime()
  }).strict(),
  officialEventsReplaceRejectedChild: z.object({
    scopeId: z.string().trim().min(1),
    eventId: z.string().trim().min(1),
    rejectedSubgroupChatId: runtimeGroupChatIdSchema,
    expectedUpdatedAt: z.string().datetime(),
    expectedProvisioningGeneration: z.string().trim().min(1),
    expectedProvisioningAttempt: z.number().int().positive(),
    expectedProvisioningHaltedAt: z.string().datetime(),
    operationId: z.string().uuid(),
    failureKind: z.literal('community_link_rejected'),
    confirm: z.literal(true),
    reason: z.string().trim().min(1).max(1_000),
    actorWid: z.string().trim().min(1).optional(),
    actorLabel: z.string().trim().min(1).optional()
  }).strict(),
  officialEventsCalendarHintReplay: eventCalendarHintReplayInputSchema,
  officialEventsPublishCalendar: z.object({ scopeId: z.string().trim().min(1), calendarId: z.string().trim().min(1) }).strict(),
  officialEventsRecoverJobs: z.object({}).strict()
};

// Account recovery actions remain available for owned persisted events when a scope is disabled.
// The authenticated runtime admin endpoint and the host-owned account database retain ownership.
export const eventOperatorActionDeclarations = [
  { actionId: 'official.community-events.adopt', access: 'mutation' as const, scope: 'scope' as const, timeoutMs: 120_000 },
  { actionId: 'official.community-events.terminate', access: 'mutation' as const, scope: 'account' as const, timeoutMs: 120_000 },
  { actionId: 'official.community-events.retryCancellationCleanup', access: 'mutation' as const, scope: 'account' as const, timeoutMs: 120_000 },
  { actionId: 'official.community-events.calendarHintReplay', access: 'mutation' as const, scope: 'scope' as const, timeoutMs: 120_000 },
  { actionId: 'official.community-events.publishCalendar', access: 'mutation' as const, scope: 'scope' as const, timeoutMs: 120_000 },
  { actionId: 'official.community-events.resumeProvisioning', access: 'mutation' as const, scope: 'account' as const, timeoutMs: 120_000 },
  { actionId: 'official.community-events.retryPreCreateProvisioning', access: 'mutation' as const, scope: 'account' as const, timeoutMs: 120_000 },
  { actionId: 'official.community-events.replaceRejectedChild', access: 'mutation' as const, scope: 'account' as const, timeoutMs: 120_000 },
  { actionId: 'official.community-events.recoverJobs', access: 'mutation' as const, scope: 'account' as const, timeoutMs: 120_000 },
];
