import type { FlowState, FlowStep } from '@wabs/plugin-sdk/flow-types';
import type { PluginEphemeralStore } from '@wabs/plugin-sdk/ephemeral-store';
import type { PluginServiceCaller } from '@wabs/plugin-sdk/services';
import { scopeTimezoneSchema } from '@wabs/plugin-sdk/clock';
import type { TranslateFn } from './runtime';
import { GEOCODER_SERVICE_ID, GEOCODER_TIMEZONE_METHOD, geocoderTimezoneOutputSchema,
  type ResolveOutput } from './contracts/geocoder/serviceApi';
import { geocodedEventLocation } from './eventLocation';
import { chooseEventPlace, rememberEventPlace, resolveEventPlace } from './places';

export interface EventLocationResolution {
  services?: PluginServiceCaller | undefined;
  ephemeralStore?: PluginEphemeralStore | undefined;
  scopeId: string;
  actorIdentityId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
}

interface Search { displayPlace: string; output: ResolveOutput }

/**
 * The geocoder decides which places to list, in what order, and what a reply means; this step shows the
 * event's own wording around its lines. Numbered results stay stable across restarts: the list lives in
 * the ephemeral store and a number is never read against a list the person has not seen.
 */
export function createEventLocationStep(input: {
  id: string; flowType: string; resolution: EventLocationResolution; locale: string; t: TranslateFn;
  placeForState(state: FlowState): string | undefined;
  nextStepIdForState(state: FlowState): string | undefined;
}): FlowStep {
  const { services, ephemeralStore, ...actor } = input.resolution;
  const key = `event-flow-location:${input.flowType}:${input.id}`;
  const prompt = (search: Search) => [input.t(search.output.candidates.length
    ? 'official.community-events.location.select' : 'official.community-events.location.noResults',
  { displayPlace: search.displayPlace, searchQuery: search.output.searchQuery }),
  ...search.output.presentation.optionLines].join('\n');
  const search = async (displayPlace: string, query = displayPlace): Promise<Search> => {
    if (!services || !ephemeralStore) throw new Error('Location service unavailable');
    const output = await resolveEventPlace(services, actor, { query, language: input.locale });
    const value = { displayPlace, output };
    // Longer than the 30-minute questionnaire; expires even after cancellation.
    await ephemeralStore.set(key, value, 3600);
    return value;
  };
  const cached = async (displayPlace: string) => {
    const value = await ephemeralStore?.get<Search>(key);
    return value?.displayPlace === displayPlace && value.output?.presentation ? value : undefined;
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
        const listed = previous.output;
        const choice = await chooseEventPlace(services!, actor, {
          searchQuery: listed.searchQuery,
          status: listed.status,
          candidates: listed.candidates.map(candidate => candidate.place),
          reply,
          language: input.locale
        });
        if (choice.status === 'invalid') return { status: 'error', reply: input.t('official.community-events.location.invalid') };
        if (choice.status === 'ask_number') return { status: 'error', reply: choice.text };
        if (choice.status === 'search') return { status: 'error', reply: prompt(await search(displayPlace, choice.query)) };
        const place = choice.place;
        let timezone: string;
        try {
          timezone = scopeTimezoneSchema.parse(place.timezone ?? geocoderTimezoneOutputSchema.parse(await services!.call({
            ...actor, serviceId: GEOCODER_SERVICE_ID, method: GEOCODER_TIMEZONE_METHOD, input: place.point
          })).timezone);
        } catch { return { status: 'error', reply: input.t('official.community-events.location.timezoneUnavailable') }; }
        await rememberEventPlace(services, actor, { queries: [displayPlace, listed.searchQuery], place });
        return { status: 'use-value', value: geocodedEventLocation({ query: listed.searchQuery, displayLabel: displayPlace,
          timezone, provider: listed.provider, place }) };
      } catch { return { status: 'error', reply: input.t('official.community-events.location.failed') }; }
    },
    nextStepIdForState: input.nextStepIdForState
  };
}
