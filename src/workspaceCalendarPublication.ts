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
import type { EventCalendarResource, EventsConfig } from './config';
import { calendarEventLocalDate, calendarEventSummary } from './ics';
import type { StoredEventRecord } from './store';
import {
  WORKSPACE_CALENDAR_PROJECTION_CAPABILITY,
  WorkspaceCalendarProjectionEventSchema,
  WorkspaceCalendarProjectionSchema,
  type WorkspaceCalendarProjectionEvent
} from './workspaceCalendarContract';

export async function publishWorkspaceCalendarProjection(input: {
  appConfig: AppConfig;
  services?: PluginServiceCaller | undefined;
  scopeId: string;
  timezone: string;
  calendar: EventCalendarResource;
  icsBody: string;
  events: WorkspaceCalendarProjectionEvent[];
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
    events: input.events
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
    if (isPluginServiceNotInvokedError(error)) {
      return {
        generation: input.generation,
        enabled: true,
        attempted: false,
        ok: false,
        endpointUrl: 'workspace-connector',
        feedId: input.calendar.id,
        label: input.calendar.label,
        error: `Workspace connector service was not invoked: ${error.message}`
      };
    }
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

export function workspaceCalendarProjectionEvent(
  event: StoredEventRecord,
  config: Pick<EventsConfig, 'eventProfiles'>
): WorkspaceCalendarProjectionEvent {
  const lifecycleStatus = workspaceCalendarLifecycleStatus(event);
  const projected = {
    eventId: event.id,
    title: calendarEventSummary(event, config),
    startsAt: event.startsAt,
    localDate: event.localDate ?? calendarEventLocalDate(new Date(event.startsAt), event.timezone),
    ...(event.localTime ? { localTime: event.localTime } : {}),
    timezone: event.timezone,
    ...(event.calendarLocation ? { place: event.calendarLocation } : {}),
    lifecycleStatus
  };
  return WorkspaceCalendarProjectionEventSchema.parse({
    ...projected,
    revisionSha256: createHash('sha256')
      .update(workspaceConnectorCanonicalJson(projected))
      .digest('hex')
  });
}

function workspaceCalendarLifecycleStatus(
  event: StoredEventRecord
): WorkspaceCalendarProjectionEvent['lifecycleStatus'] {
  if (event.calendarStatus === 'cancelled' || event.eventStatus === 'cancelled') {
    return 'cancelled';
  }
  if (event.eventStatus === 'active' || event.eventStatus === 'completed') {
    return event.eventStatus;
  }
  if (event.eventStatus === 'failed' && event.calendarStatus === 'included') {
    // A recoverable subgroup/link failure is intentionally made visible in
    // the calendar before the community link is retried. The failure is an
    // internal provisioning state; externally the event is still planned.
    return 'planned';
  }
  throw new Error(
    `Calendar event ${event.id} has incompatible lifecycle ${event.eventStatus}/${event.calendarStatus}.`
  );
}
