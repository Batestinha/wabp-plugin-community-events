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
