import { canonicalTimezone } from '../../../../packages/plugin-sdk/src/clock';
import type { GeocoderPlace } from './contracts/geocoder/serviceApi';
import type { EventProfile } from './config';
import type { StoredEventLocation } from './store';

export function fixedEventLocation(
  profile: EventProfile,
  eventTimezone: string
): StoredEventLocation | undefined {
  if (profile.location.source !== 'fixed') {
    return undefined;
  }
  return {
    source: 'fixed',
    displayLabel: profile.location.label,
    resolvedLabel: profile.location.label,
    latitude: profile.location.latitude,
    longitude: profile.location.longitude,
    timezone: profile.location.timezone || eventTimezone
  };
}

export function eventLocationQuery(
  profile: EventProfile,
  answers: Record<string, string>
): string | undefined {
  if (profile.location.source !== 'question') {
    return undefined;
  }
  return answers[profile.location.questionKey]?.trim() || undefined;
}

export function geocodedEventLocation(input: {
  query: string;
  displayLabel?: string | undefined;
  timezone: string;
  provider: string;
  place: GeocoderPlace;
}): StoredEventLocation {
  return {
    source: 'question',
    displayLabel: input.displayLabel?.trim() || input.query,
    resolvedLabel: input.place.label,
    latitude: input.place.point.latitude,
    longitude: input.place.point.longitude,
    timezone: canonicalTimezone(input.place.timezone ?? input.timezone),
    query: input.query,
    provider: input.provider,
    ...(input.place.providerRef ? { providerRef: input.place.providerRef } : {})
  };
}
