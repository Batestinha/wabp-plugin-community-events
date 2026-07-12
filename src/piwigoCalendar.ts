import type { AppConfig } from '../../../platform/config/runtimeConfig';
import { configConnection, parsePiwigoGalleryConfig } from '../piwigo-gallery/config';
import { PiwigoGalleryClient } from '../piwigo-gallery/piwigoClient';
import type { EventsConfig } from './config';
import { renderScopeCalendar } from './ics';
import type { StoredEventRecord } from './store';

export interface PiwigoCalendarPublishOutcome {
  enabled: boolean;
  attempted: boolean;
  ok: boolean;
  calendarId: string;
  label: string;
  downloadUrl?: string | undefined;
  calendarUrl?: string | undefined;
  updatedAt?: string | undefined;
  error?: string | undefined;
}

export async function publishScopeCalendarToPiwigo(input: {
  appConfig: Pick<AppConfig, 'PIWIGO_GALLERY_DEFAULT_BASE_URL' | 'PIWIGO_GALLERY_DEFAULT_BOT_SECRET'>;
  config: EventsConfig;
  scopeId: string;
  calendarId: string;
  events: StoredEventRecord[];
}): Promise<PiwigoCalendarPublishOutcome | undefined> {
  const calendar = input.config.calendars.find((candidate) => candidate.id === input.calendarId);
  if (!calendar || !calendar.enabled || !calendar.piwigo.enabled) {
    return undefined;
  }
  const calendarId = calendar.piwigo.calendarId.trim() || calendar.id;
  const label = calendar.piwigo.label.trim() || calendar.label;
  const connection = configConnection(
    parsePiwigoGalleryConfig({ enabled: true }),
    input.appConfig.PIWIGO_GALLERY_DEFAULT_BASE_URL,
    input.appConfig.PIWIGO_GALLERY_DEFAULT_BOT_SECRET
  );
  if (!connection) {
    return {
      enabled: true,
      attempted: false,
      ok: false,
      calendarId,
      label,
      error: 'Piwigo base URL and bot secret are not configured.'
    };
  }

  try {
    const result = await new PiwigoGalleryClient(connection).publishCalendar({
      scopeId: input.scopeId,
      calendarId,
      label,
      icsBody: renderScopeCalendar(input.config, input.calendarId, input.events)
    });
    return {
      enabled: true,
      attempted: true,
      ok: true,
      calendarId,
      label,
      downloadUrl: result.download_url,
      calendarUrl: result.calendar_url,
      updatedAt: result.updated_on
    };
  } catch (error) {
    return {
      enabled: true,
      attempted: true,
      ok: false,
      calendarId,
      label,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
