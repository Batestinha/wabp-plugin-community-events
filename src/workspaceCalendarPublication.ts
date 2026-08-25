import { createHash } from 'node:crypto';
import type { AppConfig } from '../../../platform/config/runtimeConfig';
import { workspaceConnectorCanonicalJson } from '../../../../packages/workspace-connector-contracts/src';
import {
  isPluginServiceNotInvokedError,
  type PluginServiceCaller
} from '../../../platform/pluginRuntime/pluginServices';
import {
  WORKSPACE_CONNECTOR_PROJECTION_REPLACE_METHOD,
  WORKSPACE_CONNECTOR_PROJECTION_SERVICE_ID,
  type WorkspaceConnectorProjectionServiceInput
} from '../workspace-connector/serviceApi';
import { workspaceConnectorConnection } from '../workspace-connector/config';
import type { CalendarPublicationOutcome } from './calendarPublication';
import type { EventCalendarResource } from './config';
import type { EventAlbumSource } from './serviceApi';
import {
  WORKSPACE_CALENDAR_PROJECTION_CAPABILITY,
  WorkspaceCalendarProjectionSchema
} from './workspaceCalendarContract';

export async function publishWorkspaceCalendarProjection(input: {
  appConfig: AppConfig;
  services?: PluginServiceCaller | undefined;
  scopeId: string;
  timezone: string;
  calendar: EventCalendarResource;
  icsBody: string;
  events: EventAlbumSource[];
  generation: number;
}): Promise<CalendarPublicationOutcome | undefined> {
  if (!input.services || !workspaceConnectorConnection(input.appConfig)) return undefined;
  const payload = WorkspaceCalendarProjectionSchema.parse({
    schemaVersion: 1,
    kind: 'workspace-calendar-projection',
    calendarKey: input.calendar.id,
    scopeId: input.scopeId,
    label: input.calendar.label,
    timezone: input.timezone,
    generation: input.generation,
    icsSha256: createHash('sha256').update(input.icsBody, 'utf8').digest('hex'),
    ics: input.icsBody,
    events: input.events.map((event) => ({
      eventId: event.eventId,
      revisionSha256: event.revision,
      title: event.title,
      startsAt: event.startsAt,
      localDate: event.localDate,
      ...(event.localTime ? { localTime: event.localTime } : {}),
      timezone: event.timezone,
      ...(event.place ? { place: event.place } : {}),
      lifecycleStatus: event.eventStatus
    }))
  });
  const payloadSha256 = createHash('sha256')
    .update(workspaceConnectorCanonicalJson(payload))
    .digest('hex');
  try {
    await input.services.call({
      serviceId: WORKSPACE_CONNECTOR_PROJECTION_SERVICE_ID,
      method: WORKSPACE_CONNECTOR_PROJECTION_REPLACE_METHOD,
      scopeId: input.scopeId,
      input: {
        capabilityId: WORKSPACE_CALENDAR_PROJECTION_CAPABILITY,
        resourceKey: input.calendar.id,
        generation: input.generation,
        payloadSha256,
        idempotencyKey: `calendar:${input.scopeId}:${input.calendar.id}:${input.generation}:${payloadSha256}`,
        payload
      } satisfies WorkspaceConnectorProjectionServiceInput
    });
    return {
      generation: input.generation,
      enabled: true,
      attempted: true,
      ok: true,
      endpointUrl: 'workspace-connector',
      feedId: input.calendar.id,
      label: input.calendar.label,
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    if (isPluginServiceNotInvokedError(error)) return undefined;
    return {
      generation: input.generation,
      enabled: true,
      attempted: true,
      ok: false,
      endpointUrl: 'workspace-connector',
      feedId: input.calendar.id,
      label: input.calendar.label,
      error: error instanceof Error ? error.message : 'Workspace calendar projection failed.'
    };
  }
}
