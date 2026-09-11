import { z } from 'zod';
import type { WorkflowActionDeclaration } from '../../../platform/workflows/contracts';

export const EVENT_WORKFLOW_SERVICE_ID = 'official.community-events.workflow.v1';
export const eventActionLocationSchema = z.object({
  source: z.enum(['question', 'fixed']), displayLabel: z.string().min(1).max(2048), resolvedLabel: z.string().min(1).max(2048),
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), timezone: z.string().min(1).max(100),
  query: z.string().max(2048).optional(), provider: z.string().max(200).optional(), providerRef: z.string().max(500).optional()
}).strict();
export const eventActionEditInputSchema = z.object({
  eventId: z.string().min(1).max(128),
  patch: z.object({
    answers: z.record(z.string().max(12000)).default({}),
    spanKind: z.enum(['day_trip', 'multi_day']).optional(),
    endLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endLocalTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    location: eventActionLocationSchema.optional()
  }).strict(),
  confirmPastCompletion: z.boolean().default(false)
}).strict();
export const eventActionCancelInputSchema = z.object({
  eventId: z.string().min(1).max(128),
  calendarDisposition: z.enum(['cancelled', 'hidden']).default('cancelled'),
  deleteAnnouncementMessages: z.boolean().default(true), reason: z.string().max(2000).default('')
}).strict();
export type EventActionEditInput = z.infer<typeof eventActionEditInputSchema>;
export type EventActionCancelInput = z.infer<typeof eventActionCancelInputSchema>;

const eventId = { type: 'string', title: 'Event', format: 'event-reference', 'x-workflow-target': true };
const outputSchema = { type: 'object', properties: { eventId: { type: 'string' }, updatedAt: { type: 'string', format: 'date-time' },
  previousUpdatedAt: { type: 'string', format: 'date-time' }, appliedFields: { type: 'object', additionalProperties: {} } }, required: ['eventId', 'updatedAt'] };
const editInputSchema = { type: 'object', additionalProperties: false, required: ['eventId', 'patch'], properties: {
  eventId, patch: { type: 'object', additionalProperties: false, properties: {
    answers: { type: 'object', title: 'Event fields', additionalProperties: { type: 'string' } },
    spanKind: { type: 'string', enum: ['day_trip', 'multi_day'] }, endLocalDate: { type: 'string', format: 'date' }, endLocalTime: { type: 'string', format: 'time' },
    location: { type: 'object', properties: { source: { type: 'string', enum: ['question', 'fixed'] },
      displayLabel: { type: 'string' }, resolvedLabel: { type: 'string' }, latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 },
      timezone: { type: 'string' }, query: { type: 'string' }, provider: { type: 'string' }, providerRef: { type: 'string' }
    }, required: ['source', 'displayLabel', 'resolvedLabel', 'latitude', 'longitude', 'timezone'] }
  } }, confirmPastCompletion: { type: 'boolean', default: false }
} };
const cancelInputSchema = { type: 'object', additionalProperties: false, required: ['eventId'], properties: {
  eventId, calendarDisposition: { type: 'string', enum: ['cancelled', 'hidden'], default: 'cancelled' },
  deleteAnnouncementMessages: { type: 'boolean', default: true }, reason: { type: 'string' }
} };

export const eventWorkflowActions: WorkflowActionDeclaration[] = ['edit', 'cancel'].map((operation) => ({
  actionId: `official.community-events.${operation}`, version: 1,
  titleKey: `official.community-events.workflow.${operation}.title`, descriptionKey: `official.community-events.workflow.${operation}.description`,
  sources: ['assistant', 'poll_outcome'], serviceId: EVENT_WORKFLOW_SERVICE_ID,
  methods: { describe: `${operation}Describe`, prepare: `${operation}Prepare`, execute: `${operation}Execute`, inspect: `${operation}Inspect` },
  inputSchema: operation === 'edit' ? editInputSchema : cancelInputSchema, outputSchema,
  // Target authorization follows /event edit: the event creator OR events.manage.
  requiredPermissions: [], requiredBotCapabilities: []
}));
