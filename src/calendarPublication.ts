import { createHash } from 'node:crypto';
import type { AppConfig } from '../../../platform/config/runtimeConfig';
import { OidcClientCredentialsTokenProvider } from '../../../platform/identity/clientCredentialsTokenProvider';
import type { EventsConfig } from './config';

const DEFAULT_PUBLICATION_TIMEOUT_MS = 15_000;

type CalendarPublicationAppConfig = Pick<
  AppConfig,
  | 'piwigoCalendarPublicationSecret'
  | 'TOPOMARE_OIDC_ISSUER'
  | 'TOPOMARE_WABP_GALLERY_SERVICE_OIDC_CLIENT_ID'
  | 'topomareWabpGalleryServiceOidcClientSecret'
>;

export interface CalendarPublicationOutcome {
  generation: number;
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

export async function publishCalendarBody(input: {
  appConfig: CalendarPublicationAppConfig;
  scopeId: string;
  calendar: EventsConfig['calendars'][number];
  icsBody: string;
  generation: number;
}): Promise<CalendarPublicationOutcome | undefined> {
  if (!input.calendar.publication.enabled) {
    return undefined;
  }
  const target = calendarPublicationTarget(input.scopeId, input.calendar);
  if (!target.endpointUrl) {
    return {
      enabled: true,
      generation: input.generation,
      attempted: false,
      ok: false,
      endpointUrl: '',
      feedId: target.feedId,
      label: target.label,
      error: 'Calendar publication POST URL is not configured.'
    };
  }
  const secret = calendarPublicationSecret(input.appConfig);
  if (secret === undefined) {
    return {
      enabled: true,
      generation: input.generation,
      attempted: false,
      ok: false,
      endpointUrl: target.endpointUrl,
      feedId: target.feedId,
      label: target.label,
      calendarUrl: target.calendarUrl || undefined,
      error: 'PIWIGO_CALENDAR_PUBLICATION_SECRET_FILE is not configured.'
    };
  }

  try {
    const bearer = await calendarPublicationBearer(input.appConfig);
    const result = await postCalendarPublication(
      target,
      secret,
      input.icsBody,
      input.generation,
      bearer
    );
    return {
      enabled: true,
      generation: input.generation,
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
      generation: input.generation,
      attempted: true,
      ok: false,
      endpointUrl: target.endpointUrl,
      feedId: target.feedId,
      label: target.label,
      calendarUrl: target.calendarUrl || undefined,
      error: redactCalendarPublicationSecret(
        error instanceof Error ? error.message : String(error),
        secret
      )
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
  secretFieldName: string;
  feedId: string;
  label: string;
  calendarUrl: string;
} {
  return {
    enabled: calendar.publication.enabled === true,
    scopeId,
    endpointUrl: calendar.publication.endpointUrl.trim(),
    secretFieldName: calendar.publication.secretFieldName.trim() || 'bot_secret',
    feedId: calendar.publication.feedId.trim() || calendar.id,
    label: calendar.publication.label.trim() || calendar.label,
    calendarUrl: calendar.publication.calendarUrl.trim()
  };
}

function calendarPublicationSecret(
  appConfig: Pick<AppConfig, 'piwigoCalendarPublicationSecret'>
): string | undefined {
  const secret = appConfig.piwigoCalendarPublicationSecret;
  return secret || undefined;
}

async function calendarPublicationBearer(
  appConfig: CalendarPublicationAppConfig
): Promise<string | undefined> {
  const configuration = [
    appConfig.TOPOMARE_OIDC_ISSUER,
    appConfig.TOPOMARE_WABP_GALLERY_SERVICE_OIDC_CLIENT_ID,
    appConfig.topomareWabpGalleryServiceOidcClientSecret
  ];
  if (configuration.every((value) => value === '')) {
    return undefined;
  }
  if (configuration.some((value) => value === '')) {
    throw new Error('Topomare calendar publication service identity is incomplete.');
  }
  return await new OidcClientCredentialsTokenProvider({
    issuer: appConfig.TOPOMARE_OIDC_ISSUER,
    clientId: appConfig.TOPOMARE_WABP_GALLERY_SERVICE_OIDC_CLIENT_ID,
    clientSecret: appConfig.topomareWabpGalleryServiceOidcClientSecret
  }).accessToken();
}

function redactCalendarPublicationSecret(message: string, secret: string): string {
  return secret && message.includes(secret)
    ? message.split(secret).join('[redacted]')
    : message;
}

async function postCalendarPublication(
  target: ReturnType<typeof calendarPublicationTarget>,
  secret: string,
  icsBody: string,
  generation: number,
  bearer: string | undefined
): Promise<{ subscriptionUrl: string; calendarUrl: string; updatedAt: string }> {
  const bodySha256 = createHash('sha256').update(icsBody).digest('hex');
  const body = new URLSearchParams();
  if (secret) {
    body.set(target.secretFieldName, secret);
  }
  body.set('scope_id', target.scopeId);
  body.set('calendar_id', target.feedId);
  body.set('label', target.label);
  body.set('ics_body', icsBody);
  body.set('generation', String(generation));
  body.set('body_sha256', bodySha256);
  // Publishing a scoped feed must never replace the receiver's independently
  // selected default feed. Feed activation is an explicit receiver-side choice.
  body.set('activate', '0');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_PUBLICATION_TIMEOUT_MS);
  const response = await fetch(target.endpointUrl, {
    method: 'POST',
    ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
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
  const publishedScopeId = stringField(result, 'scopeId') || stringField(result, 'scope_id');
  const publishedCalendarId = stringField(result, 'calendarId') || stringField(result, 'calendar_id');
  if (publishedScopeId !== target.scopeId || publishedCalendarId !== target.feedId) {
    throw new Error(
      `Calendar publisher did not confirm scoped target ${target.scopeId}/${target.feedId}.`
    );
  }
  const publishedGeneration = numberField(result, 'generation');
  if (publishedGeneration !== generation) {
    throw new Error(
      `Calendar publisher did not confirm generation ${generation} for ${target.scopeId}/${target.feedId}.`
    );
  }
  const publishedBodySha256 = stringField(result, 'bodySha256') || stringField(result, 'body_sha256');
  if (publishedBodySha256 !== bodySha256) {
    throw new Error(
      `Calendar publisher did not confirm body SHA-256 for generation ${generation} at ${target.scopeId}/${target.feedId}.`
    );
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

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
