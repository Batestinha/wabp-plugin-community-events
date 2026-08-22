export const EVENT_SPAN_KINDS = ['day_trip', 'multi_day'] as const;

export type EventSpanKind = typeof EVENT_SPAN_KINDS[number];

export const MIN_DAY_TRIP_DURATION_MINUTES = 1;
export const MAX_DAY_TRIP_DURATION_MINUTES = 24 * 60 - 1;
export const MIN_MULTI_DAY_DURATION_MINUTES = 24 * 60;
export const MAX_MULTI_DAY_DURATION_MINUTES = 30 * 24 * 60;

export function eventDurationMinutes(startsAt: Date, endsAt: Date): number {
  return (endsAt.getTime() - startsAt.getTime()) / 60_000;
}

export function validEventSpanDuration(spanKind: EventSpanKind, durationMinutes: number): boolean {
  if (!Number.isInteger(durationMinutes)) {
    return false;
  }
  return spanKind === 'day_trip'
    ? durationMinutes >= MIN_DAY_TRIP_DURATION_MINUTES && durationMinutes <= MAX_DAY_TRIP_DURATION_MINUTES
    : durationMinutes >= MIN_MULTI_DAY_DURATION_MINUTES && durationMinutes <= MAX_MULTI_DAY_DURATION_MINUTES;
}

export function inferredEventSpanKind(durationMinutes: number): EventSpanKind {
  return durationMinutes < MIN_MULTI_DAY_DURATION_MINUTES ? 'day_trip' : 'multi_day';
}

export function eventLocalDateTime(date: Date, timezone: string): { localDate: string; localTime: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    localDate: `${value('year')}-${value('month')}-${value('day')}`,
    localTime: `${value('hour')}:${value('minute')}`
  };
}
