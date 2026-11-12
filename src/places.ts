import type { PluginServiceCaller } from '@wabs/plugin-sdk/services';
import {
  GEOCODER_CHOOSE_METHOD,
  GEOCODER_REMEMBER_METHOD,
  GEOCODER_RESOLVE_METHOD,
  GEOCODER_SERVICE_ID,
  chooseOutputSchema,
  resolveOutputSchema,
  type ChooseOutput,
  type GeocoderPlace,
  type GeocoderResolveStatus,
  type ResolveOutput
} from './contracts/geocoder/serviceApi';
import type { PluginDatabaseRegistry } from '@wabs/plugin-sdk/database';
import { eventsDatabase, listEventScopeIds, listScopeEvents, type StoredEventRecord } from './store';

/**
 * Which place an event means is the geocoder's decision (official.geocoder resolve / choose / remember):
 * its cleaned search, this community's remembered places and area, ranking, and reply reading.
 * This plugin only asks, shows the event wording around the geocoder's lines, and reports choices.
 */

export interface PlacePrincipal {
  scopeId: string;
  actorIdentityId?: string | undefined;
  groupId?: string | undefined;
  groupWid?: string | undefined;
  signal?: AbortSignal | undefined;
}

function principalFields(principal: PlacePrincipal) {
  return {
    scopeId: principal.scopeId,
    ...(principal.actorIdentityId ? { actorIdentityId: principal.actorIdentityId } : {}),
    ...(principal.groupId ? { groupId: principal.groupId } : {}),
    ...(principal.groupWid ? { groupWid: principal.groupWid } : {}),
    ...(principal.signal ? { signal: principal.signal } : {})
  };
}

export async function resolveEventPlace(services: PluginServiceCaller, principal: PlacePrincipal, input: {
  query: string;
  language: string;
  limit?: number | undefined;
  memoryOnly?: boolean | undefined;
}): Promise<ResolveOutput> {
  return resolveOutputSchema.parse(await services.call({
    ...principalFields(principal),
    serviceId: GEOCODER_SERVICE_ID,
    method: GEOCODER_RESOLVE_METHOD,
    input: {
      query: input.query,
      language: input.language,
      limit: input.limit ?? 5,
      ...(input.memoryOnly ? { memoryOnly: true } : {})
    }
  }));
}

export async function chooseEventPlace(services: PluginServiceCaller, principal: PlacePrincipal, input: {
  searchQuery: string;
  status: GeocoderResolveStatus;
  candidates: GeocoderPlace[];
  reply: string;
  language: string;
}): Promise<ChooseOutput> {
  return chooseOutputSchema.parse(await services.call({
    ...principalFields(principal),
    serviceId: GEOCODER_SERVICE_ID,
    method: GEOCODER_CHOOSE_METHOD,
    input
  }));
}

/** Teach the geocoder a confirmed choice. Best effort: a failure never blocks the event. */
export async function rememberEventPlace(services: PluginServiceCaller | undefined, principal: PlacePrincipal, input: {
  /** What was typed for the place, and the search that found it if different. */
  queries: string[];
  place: GeocoderPlace;
}): Promise<void> {
  const queries = [...new Set(input.queries.map(query => query.trim()).filter(Boolean))];
  if (!services || queries.length === 0) return;
  try {
    await services.call({
      ...principalFields(principal),
      serviceId: GEOCODER_SERVICE_ID,
      method: GEOCODER_REMEMBER_METHOD,
      input: { places: queries.map(query => ({ query, place: input.place })), source: 'confirmed' }
    });
  } catch {
    // The geocoder may be older or disabled for this scope; the event keeps its coordinates either way.
  }
}

/** The geocoder place an event's stored location stands for, for importing past choices. */
export function storedEventPlace(event: StoredEventRecord): { query: string; place: GeocoderPlace; usedAt: string } | undefined {
  const location = event.eventLocation;
  if (!location || location.source !== 'question' || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
    return undefined;
  }
  const query = (location.query || location.displayLabel || '').trim();
  const label = (location.resolvedLabel || location.displayLabel || '').trim();
  if (!query || !label) return undefined;
  return {
    query,
    usedAt: new Date(event.createdAt).toISOString(),
    place: {
      label,
      point: { latitude: location.latitude, longitude: location.longitude },
      ...(location.timezone ? { timezone: location.timezone } : {}),
      address: {},
      ...(location.providerRef ? { providerRef: location.providerRef } : {}),
      attribution: { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' }
    }
  };
}

/**
 * Give the geocoder the places past events used, once per runtime start. It only adds what it does not
 * know yet and writes nothing otherwise, so this is cheap to repeat. Failures never block startup.
 */
export async function importEventPlacesToGeocoder(context: {
  services?: PluginServiceCaller | undefined;
  databases?: PluginDatabaseRegistry | undefined;
  logger?: { warn(details: unknown, message: string): void } | undefined;
}): Promise<number> {
  if (!context.services || !context.databases) return 0;
  let imported = 0;
  const db = eventsDatabase(context.databases);
  for (const scopeId of listEventScopeIds(db)) {
    const places = listScopeEvents(db, scopeId)
      .filter(event => event.eventStatus !== 'cancelled')
      .flatMap(event => storedEventPlace(event) ?? [])
      .slice(-200);
    if (places.length === 0) continue;
    try {
      await context.services.call({
        scopeId,
        serviceId: GEOCODER_SERVICE_ID,
        method: GEOCODER_REMEMBER_METHOD,
        input: { places, source: 'import' }
      });
      imported += places.length;
    } catch (error) {
      context.logger?.warn({ error, scopeId }, 'official.community-events could not share past event places with the geocoder');
    }
  }
  return imported;
}
