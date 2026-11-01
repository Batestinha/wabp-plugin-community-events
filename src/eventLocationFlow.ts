import type { FlowState, FlowStep } from '@wabs/plugin-sdk/flow-types';
import type { PluginEphemeralStore } from '@wabs/plugin-sdk/ephemeral-store';
import type { PluginServiceCaller } from '@wabs/plugin-sdk/services';
import { scopeTimezoneSchema } from '@wabs/plugin-sdk/clock';
import type { TranslateFn } from './runtime';
import { GEOCODER_SERVICE_ID, GEOCODER_GEOCODE_METHOD, GEOCODER_TIMEZONE_METHOD,
  geocodeOutputSchema, geocoderTimezoneOutputSchema, type GeocodeOutput } from './contracts/geocoder/serviceApi';
import { geocodedEventLocation } from './eventLocation';
import { eventReplyControl, normalizedPlaceText } from './answerResilience';
import type { GeocoderBoundingBox } from './contracts/geocoder/serviceApi';

export interface EventLocationResolution {
  services?: PluginServiceCaller | undefined;
  ephemeralStore?: PluginEphemeralStore | undefined;
  scopeId: string;
  actorIdentityId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
  /** Area this community usually meets in; ranks nearby results first without excluding others. */
  biasBounds?: GeocoderBoundingBox | undefined;
}

const HEDGES = /\b(?:maybe|perhaps|tbd|talvez|por decidir|a decidir|a confirmar|por confirmar|ou outro|ou outra|or other|or so)\b/giu;

/** The search text for a place answer: notes such as "(maybe?)" and alternatives stay out of the query. */
export function eventPlaceSearchQuery(place: string): string {
  const first = place.replace(/\([^)]*\)/g, ' ').split(/\s*\/\s*|\s+(?:ou|or)\s+/iu)[0] ?? place;
  const cleaned = first.replace(HEDGES, ' ').replace(/[?¿!]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length >= 2 ? cleaned : place.trim();
}

/** A typed reply that names exactly one listed result selects it. */
export function typedLocationChoice(results: { label: string; name?: string | undefined }[], reply: string): number | undefined {
  const wanted = normalizedPlaceText(reply);
  if (!wanted) return undefined;
  const matches = results.flatMap((place, index) => [place.name, place.label.split(',')[0], place.label]
    .filter((name): name is string => Boolean(name)).map(normalizedPlaceText).includes(wanted) ? [index] : []);
  return matches.length === 1 ? matches[0] : undefined;
}
interface Search { displayPlace: string; query: string; output: GeocodeOutput }

/** Keep numbered results stable across process restarts; the answer lives in FlowState. */
export function createEventLocationStep(input: {
  id: string; flowType: string; resolution: EventLocationResolution; locale: string; t: TranslateFn;
  placeForState(state: FlowState): string | undefined;
  nextStepIdForState(state: FlowState): string | undefined;
}): FlowStep {
  const { services, ephemeralStore, ...actor } = input.resolution;
  const key = `event-flow-location:${input.flowType}:${input.id}`;
  const prompt = (search: Search) => [input.t(search.output.results.length
    ? 'official.community-events.location.select' : 'official.community-events.location.noResults',
  { displayPlace: search.displayPlace, searchQuery: search.query }),
  ...search.output.results.map((place, index) => `${index + 1}. ${place.label}`)].join('\n');
  const search = async (displayPlace: string, query = displayPlace): Promise<Search> => {
    if (!services || !ephemeralStore) throw new Error('Location service unavailable');
    const output = geocodeOutputSchema.parse(await services.call({ ...actor, serviceId: GEOCODER_SERVICE_ID,
      method: GEOCODER_GEOCODE_METHOD, input: { query, language: input.locale, limit: 5,
        ...(input.resolution.biasBounds ? { bounds: input.resolution.biasBounds } : {}) } }));
    const value = { displayPlace, query, output };
    // Longer than the 30-minute questionnaire; expires even after cancellation.
    await ephemeralStore.set(key, value, 3600);
    return value;
  };
  const cached = async (displayPlace: string) => {
    const value = await ephemeralStore?.get<Search>(key);
    return value?.displayPlace === displayPlace ? value : undefined;
  };
  return {
    id: input.id, kind: 'text', prompt: input.t('official.community-events.location.failed'),
    promptMessageForState: async state => {
      const place = input.placeForState(state);
      if (!place) return { text: input.t('official.community-events.location.missing') };
      try { return { text: prompt(await cached(place) ?? await search(place, eventPlaceSearchQuery(place))) }; }
      catch { return { text: input.t('official.community-events.location.failed') }; }
    },
    resolveInputAsync: async ({ state, input: reply }) => {
      const displayPlace = input.placeForState(state);
      if (!displayPlace) return { status: 'error', reply: input.t('official.community-events.location.missing') };
      try {
        const previous = await cached(displayPlace);
        // Never reinterpret a number against refreshed results the user has not seen.
        if (!previous) return { status: 'error', reply: prompt(await search(displayPlace, eventPlaceSearchQuery(displayPlace))) };
        const results = previous.output.results;
        // "ok" with a single result, or typing the name of one listed result, selects it.
        const typed = /^\d+$/.test(reply) ? undefined
          : eventReplyControl(reply) === 'accept' && results.length === 1 ? 0 : typedLocationChoice(results, reply);
        if (!/^\d+$/.test(reply) && typed === undefined) {
          if (reply.startsWith('/')) return { status: 'error', reply: input.t('official.community-events.location.invalid') };
          // Retyping the same search would show the same list again: ask for the number instead.
          if (results.length > 0 && normalizedPlaceText(reply) === normalizedPlaceText(previous.query)) {
            return { status: 'error', reply: [input.t('official.community-events.location.chooseNumber', { count: results.length }),
              ...results.map((place, index) => `${index + 1}. ${place.label}`)].join('\n') };
          }
          return { status: 'error', reply: prompt(await search(displayPlace, reply)) };
        }
        const place = results[typed ?? Number(reply) - 1];
        if (!place) return { status: 'error', reply: input.t('official.community-events.location.invalid') };
        let timezone: string;
        try {
          timezone = scopeTimezoneSchema.parse(place.timezone ?? geocoderTimezoneOutputSchema.parse(await services!.call({
            ...actor, serviceId: GEOCODER_SERVICE_ID, method: GEOCODER_TIMEZONE_METHOD, input: place.point
          })).timezone);
        } catch { return { status: 'error', reply: input.t('official.community-events.location.timezoneUnavailable') }; }
        return { status: 'use-value', value: geocodedEventLocation({ query: previous.query, displayLabel: displayPlace,
          timezone, provider: previous.output.provider, place }) };
      } catch { return { status: 'error', reply: input.t('official.community-events.location.failed') }; }
    },
    nextStepIdForState: input.nextStepIdForState
  };
}
