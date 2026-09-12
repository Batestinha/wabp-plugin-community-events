import type { Logger } from './runtime';
import type { AppConfig } from './deploymentConfig';
import type { PluginDatabaseRegistry } from '@wabs/plugin-sdk/database';
import type { PluginServiceCaller } from '@wabs/plugin-sdk/services';
import type { EventsConfig } from './config';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import {
  appendEventLog,
  eventsDatabase,
  resolvedEventCalendarId,
  type StoredEventRecord
} from './store';

/**
 * Consumes the calendar publication generation created by the durable
 * hidden -> included event transition before the transport is allowed to
 * attempt the physical community link.
 *
 * Calendar I/O remains non-fatal: the durable generation is retained for the
 * calendar recovery worker when a writer or remote publisher fails. The
 * event-state precondition is not optional, however; callers must never link
 * a child before the exact event is durably poll_closed and calendar-visible.
 */
export async function publishEventCalendarBeforeCommunityLink(input: {
  context: {
    config: AppConfig;
    databases?: PluginDatabaseRegistry | undefined;
    logger?: Pick<Logger, 'warn'> | undefined;
    services?: PluginServiceCaller | undefined;
  };
  config: EventsConfig;
  event: StoredEventRecord;
}): Promise<void> {
  const event = input.event;
  if (
    event.eventStatus !== 'failed' ||
    event.groupLifecycleStatus !== 'poll_closed' ||
    event.calendarStatus !== 'included' ||
    !event.subgroupChatId
  ) {
    throw new Error(
      `Event ${event.id} cannot attempt its community link before the exact poll-closed calendar fence is persisted.`
    );
  }

  let calendarId: string | undefined;
  try {
    calendarId = resolvedEventCalendarId(event);
    if (!calendarId) {
      return;
    }
    const calendar = input.config.calendars.find((candidate) => candidate.id === calendarId);
    if (!calendar?.enabled) {
      return;
    }
    const publication = await writePublishAndRecordScopeCalendar({
      appConfig: input.context.config,
      db: eventsDatabase(input.context.databases),
      config: input.config,
      scopeId: event.scopeId,
      calendarId,
      ...(input.context.services ? { services: input.context.services } : {}),
      requestGeneration: false
    });
    if (publication && !publication.ok) {
      throw new Error(publication.error || 'Calendar publisher rejected the event update.');
    }
    appendEventLog(eventsDatabase(input.context.databases), {
      eventId: event.id,
      action: 'events.calendar.published_before_community_link',
      metadata: { calendarId }
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.context.logger?.warn(
      { reason, eventId: event.id, scopeId: event.scopeId, calendarId },
      'Event calendar publication remains pending before community link'
    );
    appendEventLog(eventsDatabase(input.context.databases), {
      eventId: event.id,
      action: 'events.calendar.publication_pending_before_community_link',
      metadata: { reason, ...(calendarId ? { calendarId } : {}) }
    });
  }
}
