import { z } from 'zod';

const key = z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9._:-]*$/);
const opaque = z.string().trim().min(1).max(512);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const WORKSPACE_CALENDAR_PROJECTION_CAPABILITY = 'calendar.feed.replace.v1' as const;

export const WorkspaceCalendarProjectionEventSchema = z.object({
  eventId: opaque,
  revisionSha256: sha256,
  title: z.string().trim().min(1).max(500),
  startsAt: z.string().datetime(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone: z.string().trim().min(1).max(100),
  place: z.string().trim().min(1).max(500).optional(),
  lifecycleStatus: z.enum(['planned', 'active', 'completed', 'cancelled', 'removed'])
}).strict();

export const WorkspaceCalendarProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('workspace-calendar-projection'),
  calendarKey: key,
  scopeId: opaque,
  label: z.string().trim().min(1).max(240),
  timezone: z.string().trim().min(1).max(100),
  generation: z.number().int().positive(),
  icsSha256: sha256,
  ics: z.string().min(1).max(16 * 1024 * 1024),
  events: z.array(WorkspaceCalendarProjectionEventSchema).max(20_000)
}).strict().superRefine((value, context) => {
  if (!value.ics.includes('BEGIN:VCALENDAR') || !value.ics.includes('END:VCALENDAR')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['ics'], message: 'complete VCALENDAR required' });
  }
});

export type WorkspaceCalendarProjectionEvent = z.infer<
  typeof WorkspaceCalendarProjectionEventSchema
>;
