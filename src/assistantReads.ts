import { z } from 'zod';
import { startOfScopeDate } from '@wabs/plugin-sdk/clock';
import type { PluginServiceDeclaration, PluginServiceRegistration } from '@wabs/plugin-sdk/services';
import type { PluginServiceRegistrationContext } from './runtime';
import { parseEventsConfig } from './config';
import { eventsDatabase, listEventReadPage } from './store';

export const eventReadDeclaration: PluginServiceDeclaration = {
  serviceId: 'official.community-events.assistant.v1',
  methods: [{ name: 'events', access: 'read', assistantRead: {
    name: 'official.community-events.events', descriptionKey: 'official.community-events.assistant.read.events', allowScopeMembers: true
  } }]
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cursor = z.object({ timestamp: z.string().datetime({ offset: true }), id: z.string().min(1).max(128) }).strict();
const range = z.object({
  mode: z.enum(['upcoming', 'history']),
  from: date.optional(), until: date.optional(),
  after: cursor.optional(),
  limit: z.number().int().min(1).max(25).default(10)
}).strict().refine(input => input.mode !== 'history' || Boolean(input.from && input.until && input.from < input.until),
  'History requires an increasing local date range.');
const inputSchema = {
  type: 'object', additionalProperties: false, required: ['mode'],
  properties: {
    mode: { type: 'string', enum: ['upcoming', 'history'] },
    from: { type: 'string', description: 'Inclusive local date in YYYY-MM-DD format.' },
    until: { type: 'string', description: 'Exclusive local date in YYYY-MM-DD format.' },
    after: { type: 'object', additionalProperties: false, required: ['timestamp', 'id'],
      properties: { timestamp: { type: 'string' }, id: { type: 'string' } } },
    limit: { type: 'integer', minimum: 1, maximum: 25 }
  }
};

const article = z.object({
  id: z.string(), title: z.string(), startsAt: z.string(), endsAt: z.string(),
  timezone: z.string(), place: z.string().nullable()
}).strict();

export function registerEventReads(context: PluginServiceRegistrationContext): PluginServiceRegistration {
  return { serviceId: eventReadDeclaration.serviceId, methods: [{
    name: 'events', access: 'read', inputSchema: range,
    outputSchema: z.object({ events: z.array(article), next: cursor.nullable(), timezone: z.string() }).strict(),
    assistantSchema: { input: inputSchema, output: { type: 'object' } },
    async handler(raw, call) {
      const input = range.parse(raw);
      if (!parseEventsConfig(await context.configFor(call.scopeId, call.actorIdentityId)).enabled) throw new Error('Events are disabled.');
      const clock = await context.clockFor?.(call.scopeId, { scopeId: call.scopeId });
      if (!clock) throw new Error('The community clock is unavailable.');
      const after = input.after;
      const from = input.from ? startOfScopeDate(clock, input.from) : undefined;
      const until = input.until ? startOfScopeDate(clock, input.until) : undefined;
      const rows = listEventReadPage(eventsDatabase(context.databases), {
        scopeId: call.scopeId, start: input.mode === 'upcoming' ? new Date().toISOString() : from!,
        until, after, limit: input.limit + 1
      });
      const events = rows.slice(0, input.limit).map(event => ({
        id: event.id, title: event.groupTitle || event.pollQuestion || event.profileLabel,
        startsAt: event.startsAt, endsAt: event.endsAt, timezone: event.timezone, place: event.place || null
      }));
      const last = rows[input.limit - 1];
      return { events, timezone: clock.timezone,
        next: last && rows.length > input.limit ? { timestamp: last.startsAt, id: last.id } : null };
    }
  }] };
}
