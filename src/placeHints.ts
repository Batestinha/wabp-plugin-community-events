import type { PluginDatabaseRegistry } from '@wabs/plugin-sdk/database';
import type { GeocoderBoundingBox } from './contracts/geocoder/serviceApi';
import { eventsDatabase, listScopeEvents } from './store';

export interface EventPlaceHints {
  /** Place answers this community already used, newest first. */
  knownPlaces: string[];
  /** Area around the community's usual locations, used to rank geocoder results. */
  biasBounds?: GeocoderBoundingBox | undefined;
}

const NEIGHBOURHOOD_DEGREES = 1.5;
const MARGIN_DEGREES = 0.3;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Bounds of the locations near the median one, so a single trip abroad does not widen them. */
export function eventBiasBounds(points: { latitude: number; longitude: number }[]): GeocoderBoundingBox | undefined {
  if (points.length < 2) return undefined;
  const latitude = median(points.map(point => point.latitude));
  const longitude = median(points.map(point => point.longitude));
  const near = points.filter(point => Math.abs(point.latitude - latitude) <= NEIGHBOURHOOD_DEGREES
    && Math.abs(point.longitude - longitude) <= NEIGHBOURHOOD_DEGREES);
  if (near.length < 2) return undefined;
  const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
  return {
    south: clamp(Math.min(...near.map(point => point.latitude)) - MARGIN_DEGREES, 90),
    west: clamp(Math.min(...near.map(point => point.longitude)) - MARGIN_DEGREES, 180),
    north: clamp(Math.max(...near.map(point => point.latitude)) + MARGIN_DEGREES, 90),
    east: clamp(Math.max(...near.map(point => point.longitude)) + MARGIN_DEGREES, 180)
  };
}

export function eventPlaceHints(databases: PluginDatabaseRegistry | undefined, scopeId: string): EventPlaceHints {
  if (!databases) return { knownPlaces: [] };
  try {
    const events = listScopeEvents(eventsDatabase(databases), scopeId)
      .filter(event => event.eventStatus !== 'cancelled')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const knownPlaces = [...new Set(events.map(event => event.eventLocation?.displayLabel?.trim()).filter((place): place is string => Boolean(place)))];
    const points = events.flatMap(event => event.eventLocation && Number.isFinite(event.eventLocation.latitude)
      && Number.isFinite(event.eventLocation.longitude)
      ? [{ latitude: event.eventLocation.latitude, longitude: event.eventLocation.longitude }] : []);
    const biasBounds = eventBiasBounds(points);
    return { knownPlaces, ...(biasBounds ? { biasBounds } : {}) };
  } catch {
    return { knownPlaces: [] };
  }
}
