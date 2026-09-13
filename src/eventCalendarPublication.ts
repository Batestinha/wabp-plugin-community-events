import { z } from 'zod';
import type { PluginRuntimeContext } from './runtime';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import { parseEventsConfig } from './config';
import { eventsDatabase } from './store';

const requestSchema = z.object({
  scopeId: z.string().trim().min(1),
  calendarId: z.string().trim().min(1)
}).strict();

export async function publishEventCalendarFromOperator(input: {
  context: PluginRuntimeContext;
  request: unknown;
}) {
  const request = requestSchema.parse(input.request);
  const { context } = input;
  if (!(await context.enabledFor(request.scopeId))) {
    throw new Error('Community events is not enabled for this scope.');
  }
  const config = parseEventsConfig(await context.configFor(request.scopeId));
  if (!config.enabled) {
    throw new Error('Community events is not enabled for this scope.');
  }
  return writePublishAndRecordScopeCalendar({
    appConfig: context.config,
    db: eventsDatabase(context.databases),
    config,
    ...request,
    services: context.services
  });
}
