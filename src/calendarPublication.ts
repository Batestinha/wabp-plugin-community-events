import type { EventsConfig } from './config';
import { renderScopeCalendar } from './ics';
import type { StoredEventRecord } from './store';

const DEFAULT_PUBLICATION_TIMEOUT_MS = 15_000;

export interface CalendarPublicationOutcome {
  enabled: boolean;
  attempted: boolean;
  ok: boolean;
  endpointUrl: string;
  feedId: string;
  label: string;
  subscriptionUrl?: string | undefined;
  calendarUrl?: string | undefined;
  updatedAt?: string | undefined;
  error?: string | undefined;
}

export async function publishScopeCalendar(input: {
  config: EventsConfig;
  scopeId: string;
  calendarId: string;
  events: StoredEventRecord[];
}): Promise<CalendarPublicationOutcome | undefined> {
  const calendar = input.config.calendars.find((candidate) => candidate.id === input.calendarId);
  if (!calendar || !calendar.enabled) {
    return undefined;
  }
  return publishCalendarBody({
    scopeId: input.scopeId,
    calendar,
    icsBody: renderScopeCalendar(input.config, input.calendarId, input.events)
  });
}

export async function publishCalendarBody(input: {
  scopeId: string;
  calendar: EventsConfig['calendars'][number];
  icsBody: string;
}): Promise<CalendarPublicationOutcome | undefined> {
  if (!input.calendar.publication.enabled) {
    return undefined;
  }
  const target = calendarPublicationTarget(input.scopeId, input.calendar);
  if (!target.endpointUrl) {
    return {
      enabled: true,
      attempted: false,
      ok: false,
      endpointUrl: '',
      feedId: target.feedId,
      label: target.label,
      error: 'Calendar publication POST URL is not configured.'
    };
  }

  try {
    const result = await postCalendarPublication(target, input.icsBody);
    return {
      enabled: true,
      attempted: true,
      ok: true,
      endpointUrl: target.endpointUrl,
      feedId: target.feedId,
      label: target.label,
      subscriptionUrl: result.subscriptionUrl || undefined,
      calendarUrl: result.calendarUrl || target.calendarUrl || undefined,
      updatedAt: result.updatedAt || undefined
    };
  } catch (error) {
    return {
      enabled: true,
      attempted: true,
      ok: false,
      endpointUrl: target.endpointUrl,
      feedId: target.feedId,
      label: target.label,
      calendarUrl: target.calendarUrl || undefined,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function calendarPublicationTarget(
  scopeId: string,
  calendar: EventsConfig['calendars'][number]
): {
  enabled: boolean;
  scopeId: string;
  endpointUrl: string;
  secret: string;
  secretFieldName: string;
  feedId: string;
  label: string;
  calendarUrl: string;
} {
  return {
    enabled: calendar.publication.enabled === true,
    scopeId,
    endpointUrl: calendar.publication.endpointUrl.trim(),
    secret: calendar.publication.secret.trim(),
    secretFieldName: calendar.publication.secretFieldName.trim() || 'bot_secret',
    feedId: calendar.publication.feedId.trim() || calendar.id,
    label: calendar.publication.label.trim() || calendar.label,
    calendarUrl: calendar.publication.calendarUrl.trim()
  };
}

async function postCalendarPublication(
  target: ReturnType<typeof calendarPublicationTarget>,
  icsBody: string
): Promise<{ subscriptionUrl: string; calendarUrl: string; updatedAt: string }> {
  const body = new URLSearchParams();
  if (target.secret) {
    body.set(target.secretFieldName, target.secret);
  }
  body.set('scope_id', target.scopeId);
  body.set('calendar_id', target.feedId);
  body.set('label', target.label);
  body.set('ics_body', icsBody);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_PUBLICATION_TIMEOUT_MS);
  const response = await fetch(target.endpointUrl, {
    method: 'POST',
    body,
    signal: controller.signal
  }).finally(() => {
    clearTimeout(timeout);
  });
  const text = await response.text();
  const payload = parsePublicationPayload(text);
  const result = publicationResultPayload(payload);
  if (!response.ok) {
    throw new Error(publicationErrorMessage(payload) || `Calendar publisher returned HTTP ${response.status}`);
  }
  if (isRecord(payload) && payload.stat && payload.stat !== 'ok') {
    throw new Error(publicationErrorMessage(payload) || 'Calendar publisher rejected the update.');
  }
  if (isRecord(payload) && payload.ok === false) {
    throw new Error(publicationErrorMessage(payload) || 'Calendar publisher rejected the update.');
  }
  return {
    subscriptionUrl: stringField(result, 'subscriptionUrl') || stringField(result, 'subscription_url'),
    calendarUrl: stringField(result, 'calendarUrl') || stringField(result, 'calendar_url'),
    updatedAt: stringField(result, 'updatedAt') || stringField(result, 'updated_on')
  };
}

function parsePublicationPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { message: trimmed };
  }
}

function publicationResultPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return {};
  }
  const result = payload.result;
  return isRecord(result) ? result : payload;
}

function publicationErrorMessage(payload: unknown): string {
  if (!isRecord(payload)) {
    return '';
  }
  return stringField(payload, 'message') || stringField(payload, 'error') || stringField(payload, 'err');
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
