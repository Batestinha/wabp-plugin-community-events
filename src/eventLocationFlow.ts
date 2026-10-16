import type { FlowState, FlowStep } from '@wabs/plugin-sdk/flow-types';
import type { PluginEphemeralStore } from '@wabs/plugin-sdk/ephemeral-store';
import type { PluginServiceCaller } from '@wabs/plugin-sdk/services';
import { scopeTimezoneSchema } from '@wabs/plugin-sdk/clock';
import type { TranslateFn } from './runtime';
import { GEOCODER_SERVICE_ID, GEOCODER_GEOCODE_METHOD, GEOCODER_TIMEZONE_METHOD,
  geocodeOutputSchema, geocoderTimezoneOutputSchema, type GeocodeOutput } from './contracts/geocoder/serviceApi';
import { geocodedEventLocation } from './eventLocation';

export interface EventLocationResolution {
  services?: PluginServiceCaller | undefined;
  ephemeralStore?: PluginEphemeralStore | undefined;
  scopeId: string;
  actorIdentityId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
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
      method: GEOCODER_GEOCODE_METHOD, input: { query, language: input.locale, limit: 5 } }));
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
      try { return { text: prompt(await cached(place) ?? await search(place)) }; }
      catch { return { text: input.t('official.community-events.location.failed') }; }
    },
    resolveInputAsync: async ({ state, input: reply }) => {
      const displayPlace = input.placeForState(state);
      if (!displayPlace) return { status: 'error', reply: input.t('official.community-events.location.missing') };
      try {
        const previous = await cached(displayPlace);
        // Never reinterpret a number against refreshed results the user has not seen.
        if (!previous) return { status: 'error', reply: prompt(await search(displayPlace)) };
        if (!/^\d+$/.test(reply)) {
          if (reply.startsWith('/')) return { status: 'error', reply: input.t('official.community-events.location.invalid') };
          return { status: 'error', reply: prompt(await search(displayPlace, reply)) };
        }
        const place = previous.output.results[Number(reply) - 1];
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
