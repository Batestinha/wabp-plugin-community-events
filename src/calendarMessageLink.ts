import type { PluginServiceCaller } from '@wabs/plugin-sdk/services';
import { parseValueTemplate, valueTemplateReferences } from '@wabs/plugin-sdk/templates';
import { parseEventsConfig, type EventCalendarResource } from './config';
import { resolvedEventCalendarId, type StoredEventRecord } from './store';

export function requiresCalendarSubscription(template: string): boolean {
  return parseValueTemplate(template).some(node => node.kind === 'variable' && node.token === 'calendarSubscriptionUrl');
}

export async function calendarPageForMessage(
  context: { services?: PluginServiceCaller | undefined; configFor?(scopeId: string): Promise<unknown> },
  template: string, event: StoredEventRecord, calendars?: readonly EventCalendarResource[]
): Promise<string | undefined> {
  if (!context.services || !valueTemplateReferences(template).tokens.includes('calendarPageUrl')) return undefined;
  try {
    const resourceKey = resolvedEventCalendarId(event);
    if (!resourceKey) return undefined;
    const resources = calendars ?? (context.configFor && parseEventsConfig(await context.configFor(event.scopeId)).calendars);
    if (!resources?.some(calendar => calendar.id === resourceKey && calendar.enabled)) return undefined;
    const result = await context.services.call<{ url: string | null }>({
      serviceId: 'official.integration-manager.message-links.v1', method: 'resolve', scopeId: event.scopeId,
      input: { target: 'calendarPage', resourceKey }
    });
    if (!result?.url) return undefined;
    const page = new URL(result.url);
    return page.protocol === 'https:' && !page.username && !page.password && !page.hash ? page.href : undefined;
  } catch {
    return undefined;
  }
}
