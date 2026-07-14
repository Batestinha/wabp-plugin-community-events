import type { AppConfig } from '../../../platform/config/runtimeConfig';
import type { PluginDatabase } from '../../../platform/pluginRuntime/runtime/pluginDatabase';
import type { EventsConfig } from './config';
import { publishScopeCalendar, type CalendarPublicationOutcome } from './calendarPublication';
import { scopeCalendarEvents, writeScopeCalendar } from './ics';
import { recordCalendarPublicationStatus, type StoredEventRecord } from './store';

export async function writePublishAndRecordScopeCalendar(input: {
  appConfig: AppConfig;
  db: PluginDatabase;
  config: EventsConfig;
  scopeId: string;
  calendarId: string;
  events: StoredEventRecord[];
}): Promise<CalendarPublicationOutcome | undefined> {
  await writeScopeCalendar({
    appConfig: input.appConfig,
    config: input.config,
    scopeId: input.scopeId,
    calendarId: input.calendarId,
    events: input.events
  });
  const publication = await publishScopeCalendar({
    config: input.config,
    scopeId: input.scopeId,
    calendarId: input.calendarId,
    events: input.events
  });
  recordCalendarPublicationStatus(input.db, {
    scopeId: input.scopeId,
    calendarId: input.calendarId,
    generatedAt: new Date().toISOString(),
    generatedEventCount: scopeCalendarEvents(input.config, input.calendarId, input.events).length,
    ...(publication ? { publication } : {})
  });
  return publication;
}
