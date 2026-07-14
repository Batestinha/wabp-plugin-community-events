import type { ParsedResult } from 'chrono-node';
import { chronoParserForLocale } from '../../../platform/naturalDate/chronoLocale';

const MAX_FUTURE_YEARS = 2;
const STRICT_LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
const STRICT_LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:[zZ]|[+-]\d{2}:?\d{2})$/;

export interface EventDateParts {
  year: number;
  month: number;
  day: number;
}

export interface EventTimeParts {
  hour: number;
  minute: number;
}

export interface EventDateTimeParseOptions {
  timezone: string;
  locale: string;
  now?: Date | undefined;
}

export type EventDateTimeParseResult =
  | {
      status: 'ok';
      date: Date;
      raw: string;
      hadExplicitTime: boolean;
      normalized: string;
    }
  | {
      status: 'missing_time';
      raw: string;
      date: EventDateParts;
      promptDate: string;
    }
  | {
      status: 'invalid';
      reason: 'empty' | 'unrecognized' | 'past' | 'too_far' | 'unsupported_locale';
    };

export type EventDateParseResult =
  | {
      status: 'ok';
      raw: string;
      date: EventDateParts;
      normalized: string;
    }
  | {
      status: 'invalid';
      reason: 'empty' | 'unrecognized' | 'past' | 'too_far' | 'unsupported_locale' | 'has_time';
    };

export type EventTimeParseResult =
  | {
      status: 'ok';
      raw: string;
      time: EventTimeParts;
      normalized: string;
    }
  | {
      status: 'invalid';
      reason: 'empty' | 'unrecognized';
    };

export interface EventDateTimeAnswer {
  kind: 'event-datetime';
  raw: string;
  iso: string;
  normalized: string;
}

export interface EventDateAnswer {
  kind: 'event-date';
  raw: string;
  year: number;
  month: number;
  day: number;
  normalized: string;
}

export interface EventTimeAnswer {
  kind: 'event-time';
  raw: string;
  hour: number;
  minute: number;
  normalized: string;
}

export interface EventDateDraft {
  kind: 'event-date-draft';
  raw: string;
  year: number;
  month: number;
  day: number;
  promptDate: string;
}

export function parseEventDateTime(input: string, options: EventDateTimeParseOptions): Date | undefined {
  const result = parseEventDateTimeInput(input, options);
  return result.status === 'ok' ? result.date : undefined;
}

export function parseEventDateInput(input: string, options: EventDateTimeParseOptions): EventDateParseResult {
  const result = parseEventDateTimeInput(input, options);
  if (result.status === 'missing_time') {
    return {
      status: 'ok',
      raw: result.raw,
      date: result.date,
      normalized: formatEventDateParts(result.date)
    };
  }
  if (result.status === 'ok') {
    return { status: 'invalid', reason: 'has_time' };
  }
  return result;
}

export function parseEventTimeInput(input: string): EventTimeParseResult {
  const raw = input.trim();
  if (!raw) {
    return { status: 'invalid', reason: 'empty' };
  }
  const time = parseDirectTimeOnly(raw);
  if (!time) {
    return { status: 'invalid', reason: 'unrecognized' };
  }
  return {
    status: 'ok',
    raw,
    time,
    normalized: formatEventTimeParts(time)
  };
}

export function combineEventDateAndTime(
  date: EventDateParts & { raw?: string | undefined },
  time: EventTimeParts & { raw?: string | undefined },
  options: EventDateTimeParseOptions
): EventDateTimeParseResult {
  const now = options.now ?? new Date();
  const combined = eventDateAndTimeToUtc(date, time, options.timezone);
  return validateDateTimeResult({
    status: 'ok',
    raw: [date.raw, time.raw].filter(Boolean).join(' '),
    hadExplicitTime: true,
    normalized: '',
    date: combined ?? new Date(Number.NaN)
  }, options, now);
}

export function eventDateAndTimeToUtc(date: EventDateParts, time: EventTimeParts, timezone: string): Date | undefined {
  return zonedDateTimeToUtc({
    year: date.year,
    month: date.month,
    day: date.day,
    hour: time.hour,
    minute: time.minute,
    timezone
  });
}

export function parseEventDateTimeInput(input: string, options: EventDateTimeParseOptions): EventDateTimeParseResult {
  const raw = input.trim();
  const now = options.now ?? new Date();
  if (!raw) {
    return { status: 'invalid', reason: 'empty' };
  }

  const strictDate = parseStrictDateTime(raw, options);
  if (strictDate.status !== 'invalid' || strictDate.reason !== 'unrecognized') {
    return validateDateTimeResult(strictDate, options, now);
  }

  const portugueseRelative = parsePortugueseRelativeDateTime(raw, options, now);
  if (portugueseRelative.status !== 'invalid' || portugueseRelative.reason !== 'unrecognized') {
    return validateDateTimeResult(portugueseRelative, options, now);
  }

  const parser = chronoParserForLocale(options.locale);
  if (!parser) {
    return { status: 'invalid', reason: 'unsupported_locale' };
  }
  const referenceTimezone = timezoneOffsetMinutes(now, options.timezone);
  if (referenceTimezone === undefined) {
    return { status: 'invalid', reason: 'unrecognized' };
  }
  const naturalInput = normalizeNaturalInputForLocale(raw, options.locale);
  const result = parser.parse(naturalInput, {
    instant: now,
    timezone: referenceTimezone
  }, {
    forwardDate: true
  })[0];
  if (!result) {
    return { status: 'invalid', reason: 'unrecognized' };
  }
  return validateDateTimeResult(chronoResultToEventResult(result, raw, options), options, now);
}

export function combineEventDateDraftWithTime(
  draft: EventDateDraft,
  input: string,
  options: EventDateTimeParseOptions
): EventDateTimeParseResult {
  const now = options.now ?? new Date();
  const time = parseTimeOnly(input, options, draft);
  if (!time) {
    return { status: 'invalid', reason: 'unrecognized' };
  }
  return validateDateTimeResult({
    status: 'ok',
    raw: `${draft.raw} ${input.trim()}`,
    hadExplicitTime: true,
    normalized: '',
    date: zonedDateTimeToUtc({
      year: draft.year,
      month: draft.month,
      day: draft.day,
      hour: time.hour,
      minute: time.minute,
      timezone: options.timezone
    }) ?? new Date(Number.NaN)
  }, options, now);
}

export function eventDateTimeAnswer(result: Extract<EventDateTimeParseResult, { status: 'ok' }>): EventDateTimeAnswer {
  return {
    kind: 'event-datetime',
    raw: result.raw,
    iso: result.date.toISOString(),
    normalized: result.normalized
  };
}

export function eventDateAnswer(result: Extract<EventDateParseResult, { status: 'ok' }>): EventDateAnswer {
  return {
    kind: 'event-date',
    raw: result.raw,
    year: result.date.year,
    month: result.date.month,
    day: result.date.day,
    normalized: result.normalized
  };
}

export function eventTimeAnswer(result: Extract<EventTimeParseResult, { status: 'ok' }>): EventTimeAnswer {
  return {
    kind: 'event-time',
    raw: result.raw,
    hour: result.time.hour,
    minute: result.time.minute,
    normalized: result.normalized
  };
}

export function eventDateDraft(result: Extract<EventDateTimeParseResult, { status: 'missing_time' }>): EventDateDraft {
  return {
    kind: 'event-date-draft',
    raw: result.raw,
    year: result.date.year,
    month: result.date.month,
    day: result.date.day,
    promptDate: result.promptDate
  };
}

export function isEventDateTimeAnswer(value: unknown): value is EventDateTimeAnswer {
  return Boolean(value && typeof value === 'object' && (value as Partial<EventDateTimeAnswer>).kind === 'event-datetime');
}

export function isEventDateAnswer(value: unknown): value is EventDateAnswer {
  return Boolean(value && typeof value === 'object' && (value as Partial<EventDateAnswer>).kind === 'event-date');
}

export function isEventTimeAnswer(value: unknown): value is EventTimeAnswer {
  return Boolean(value && typeof value === 'object' && (value as Partial<EventTimeAnswer>).kind === 'event-time');
}

export function isEventDateDraft(value: unknown): value is EventDateDraft {
  return Boolean(value && typeof value === 'object' && (value as Partial<EventDateDraft>).kind === 'event-date-draft');
}

export function eventDateTemplateTokens(date: Date, timezone: string, locale = 'en'): Record<string, string> {
  const parts = new Intl.DateTimeFormat(locale || 'en', {
    timeZone: timezone,
    weekday: 'long',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const yyyy = new Intl.DateTimeFormat(locale || 'en', { timeZone: timezone, year: 'numeric' }).format(date);
  return {
    weekday: value('weekday'),
    dd: value('day'),
    mm: value('month'),
    yy: value('year'),
    yyyy,
    hour: value('hour'),
    minute: value('minute')
  };
}

export function formatEventDateTime(date: Date, timezone: string, locale = 'en'): string {
  const tokens = eventDateTemplateTokens(date, timezone, locale);
  return `${tokens.weekday}, ${tokens.dd}-${tokens.mm}-${tokens.yy} ${tokens.hour}:${tokens.minute} ${timezone}`;
}

function parseStrictDateTime(raw: string, options: EventDateTimeParseOptions): EventDateTimeParseResult {
  if (ISO_WITH_ZONE.test(raw)) {
    const date = new Date(raw);
    return validDate(date)
      ? okResult(raw, date, true, options.timezone, options.locale)
      : { status: 'invalid', reason: 'unrecognized' };
  }

  const localDateTime = raw.match(STRICT_LOCAL_DATE_TIME);
  if (localDateTime) {
    const [, year, month, day, hour, minute] = localDateTime;
    const date = zonedDateTimeToUtc({
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      timezone: options.timezone
    });
    return date
      ? okResult(raw, date, true, options.timezone, options.locale)
      : { status: 'invalid', reason: 'unrecognized' };
  }

  const localDate = raw.match(STRICT_LOCAL_DATE);
  if (localDate) {
    const [, year, month, day] = localDate;
    return missingTimeResult(raw, {
      year: Number(year),
      month: Number(month),
      day: Number(day)
    }, options.timezone, options.locale);
  }

  return { status: 'invalid', reason: 'unrecognized' };
}

function parsePortugueseRelativeDateTime(
  raw: string,
  options: EventDateTimeParseOptions,
  now: Date
): EventDateTimeParseResult {
  if (!localeLanguage(options.locale).startsWith('pt')) {
    return { status: 'invalid', reason: 'unrecognized' };
  }
  const match = raw.match(/\b(?:daqui\s+a|dentro\s+de|em)\s+(\d{1,3})\s+(minutos?|horas?|dias?|semanas?)(?:\s*(?:as|a|ao|às)?\s*(\d{1,2})(?::|h)?(\d{2})?)?\b/i);
  if (!match) {
    return { status: 'invalid', reason: 'unrecognized' };
  }
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? '';
  const hourText = match[3];
  const minuteText = match[4];
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { status: 'invalid', reason: 'unrecognized' };
  }

  if (unit.startsWith('minuto')) {
    return okResult(raw, new Date(now.getTime() + amount * 60_000), true, options.timezone, options.locale);
  }
  if (unit.startsWith('hora')) {
    return okResult(raw, new Date(now.getTime() + amount * 3_600_000), true, options.timezone, options.locale);
  }

  const nowLocal = localDateTimeParts(now, options.timezone);
  if (!nowLocal) {
    return { status: 'invalid', reason: 'unrecognized' };
  }
  const days = unit.startsWith('semana') ? amount * 7 : amount;
  const targetDate = datePartsPlusDays(nowLocal, days);
  const hasTime = hourText !== undefined;
  if (!hasTime) {
    return missingTimeResult(raw, targetDate, options.timezone, options.locale);
  }
  const time = parseNumericTime(hourText, minuteText ?? '00');
  if (!time) {
    return { status: 'invalid', reason: 'unrecognized' };
  }
  const date = zonedDateTimeToUtc({
    ...targetDate,
    hour: time.hour,
    minute: time.minute,
    timezone: options.timezone
  });
  return date
    ? okResult(raw, date, true, options.timezone, options.locale)
    : { status: 'invalid', reason: 'unrecognized' };
}

function chronoResultToEventResult(
  result: ParsedResult,
  raw: string,
  options: EventDateTimeParseOptions
): EventDateTimeParseResult {
  const start = result.start;
  const dateParts = {
    year: start.get('year') ?? 0,
    month: start.get('month') ?? 0,
    day: start.get('day') ?? 0
  };
  const hasExplicitTime = start.isCertain('hour') && start.isCertain('minute');
  if (!hasExplicitTime) {
    return missingTimeResult(raw, dateParts, options.timezone, options.locale);
  }
  const hour = start.get('hour');
  const minute = start.get('minute');
  if (hour === null || minute === null) {
    return { status: 'invalid', reason: 'unrecognized' };
  }
  const date = zonedDateTimeToUtc({
    ...dateParts,
    hour,
    minute,
    timezone: options.timezone
  });
  return date
    ? okResult(raw, date, true, options.timezone, options.locale)
    : { status: 'invalid', reason: 'unrecognized' };
}

function parseTimeOnly(input: string, options: EventDateTimeParseOptions, draft: EventDateDraft): EventTimeParts | undefined {
  const raw = input.trim();
  const direct = parseDirectTimeOnly(raw);
  if (direct) {
    return direct;
  }
  const parser = chronoParserForLocale(options.locale);
  if (!parser) {
    return undefined;
  }
  const reference = zonedDateTimeToUtc({
    year: draft.year,
    month: draft.month,
    day: draft.day,
    hour: 12,
    minute: 0,
    timezone: options.timezone
  });
  const timezone = reference ? timezoneOffsetMinutes(reference, options.timezone) : undefined;
  if (!reference || timezone === undefined) {
    return undefined;
  }
  const result = parser.parse(raw, { instant: reference, timezone }, { forwardDate: false })[0];
  const hour = result?.start.get('hour');
  const minute = result?.start.get('minute') ?? 0;
  return result?.start.isCertain('hour') && hour !== null && hour !== undefined
    ? { hour, minute }
    : undefined;
}

function parseDirectTimeOnly(raw: string): EventTimeParts | undefined {
  const direct = raw.match(/^(?:at|as|a|às)?\s*(\d{1,2})(?::|h)?(\d{2})?\s*(am|pm)?$/i);
  if (direct) {
    return parseNumericTime(direct[1] ?? '', direct[2] ?? '00', direct[3]);
  }
  if (/^noon$/i.test(raw) || /^meio-dia$/i.test(raw)) {
    return { hour: 12, minute: 0 };
  }
  if (/^midnight$/i.test(raw) || /^meia-noite$/i.test(raw)) {
    return { hour: 0, minute: 0 };
  }
  return undefined;
}

function parseNumericTime(hourText: string, minuteText: string, meridiem?: string | undefined): EventTimeParts | undefined {
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isSafeInteger(hour) || !Number.isSafeInteger(minute) || minute < 0 || minute > 59) {
    return undefined;
  }
  const normalizedMeridiem = meridiem?.toLowerCase();
  if (normalizedMeridiem === 'am' && hour === 12) {
    hour = 0;
  } else if (normalizedMeridiem === 'pm' && hour < 12) {
    hour += 12;
  }
  if (hour < 0 || hour > 23) {
    return undefined;
  }
  return { hour, minute };
}

function validateDateTimeResult(
  result: EventDateTimeParseResult,
  options: EventDateTimeParseOptions,
  now: Date
): EventDateTimeParseResult {
  if (result.status === 'invalid') {
    return result;
  }
  if (result.status === 'missing_time') {
    const dayEnd = zonedDateTimeToUtc({
      ...result.date,
      hour: 23,
      minute: 59,
      timezone: options.timezone
    });
    const dayStart = zonedDateTimeToUtc({
      ...result.date,
      hour: 0,
      minute: 0,
      timezone: options.timezone
    });
    if (!dayEnd || !dayStart) {
      return { status: 'invalid', reason: 'unrecognized' };
    }
    if (dayEnd < now) {
      return { status: 'invalid', reason: 'past' };
    }
    if (dayStart > maxFutureDate(now)) {
      return { status: 'invalid', reason: 'too_far' };
    }
    return result;
  }
  if (!validDate(result.date)) {
    return { status: 'invalid', reason: 'unrecognized' };
  }
  if (result.date < now) {
    return { status: 'invalid', reason: 'past' };
  }
  if (result.date > maxFutureDate(now)) {
    return { status: 'invalid', reason: 'too_far' };
  }
  return {
    ...result,
    normalized: formatEventDateTime(result.date, options.timezone, options.locale)
  };
}

function okResult(raw: string, date: Date, hadExplicitTime: boolean, timezone: string, locale = 'en'): Extract<EventDateTimeParseResult, { status: 'ok' }> {
  return {
    status: 'ok',
    raw,
    date,
    hadExplicitTime,
    normalized: formatEventDateTime(date, timezone, locale)
  };
}

function missingTimeResult(raw: string, date: EventDateParts, timezone: string, locale = 'en'): Extract<EventDateTimeParseResult, { status: 'missing_time' }> {
  const preview = zonedDateTimeToUtc({ ...date, hour: 12, minute: 0, timezone });
  return {
    status: 'missing_time',
    raw,
    date,
    promptDate: preview ? dateOnlyLabel(preview, timezone, locale) : `${date.year}-${date.month}-${date.day}`
  };
}

function dateOnlyLabel(date: Date, timezone: string, locale = 'en'): string {
  const tokens = eventDateTemplateTokens(date, timezone, locale);
  return `${tokens.weekday}, ${tokens.dd}-${tokens.mm}-${tokens.yy}`;
}

export function formatEventDateParts(date: EventDateParts): string {
  return [
    String(date.year).padStart(4, '0'),
    String(date.month).padStart(2, '0'),
    String(date.day).padStart(2, '0')
  ].join('-');
}

export function formatEventTimeParts(time: EventTimeParts): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

function normalizeNaturalInputForLocale(input: string, locale: string): string {
  if (localeLanguage(locale) !== 'pt') {
    return input;
  }
  return input
    .replace(/\bamanha\b/gi, 'amanhã')
    .replace(/\bproxima\b/gi, 'próxima')
    .replace(/\bproximo\b/gi, 'próximo')
    .replace(/\bterca\b/gi, 'terça')
    .replace(/\bsabado\b/gi, 'sábado')
    .replace(/\bas\b(?=\s*\d{1,2}(?::|h)?\d{0,2})/gi, 'às');
}

function localeLanguage(locale: string): string {
  return locale.trim().split('-')[0]?.toLowerCase() || 'en';
}

function maxFutureDate(now: Date): Date {
  const max = new Date(now);
  max.setFullYear(max.getFullYear() + MAX_FUTURE_YEARS);
  return max;
}

function datePartsPlusDays(parts: EventDateParts, days: number): EventDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function localDateTimeParts(date: Date, timezone: string): (EventDateParts & EventTimeParts) | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    return {
      year: Number(value('year')),
      month: Number(value('month')),
      day: Number(value('day')),
      hour: Number(value('hour')),
      minute: Number(value('minute'))
    };
  } catch {
    return undefined;
  }
}

function zonedDateTimeToUtc(input: EventDateParts & EventTimeParts & { timezone: string }): Date | undefined {
  if (
    !Number.isSafeInteger(input.year) ||
    input.month < 1 || input.month > 12 ||
    input.day < 1 || input.day > 31 ||
    input.hour < 0 || input.hour > 23 ||
    input.minute < 0 || input.minute > 59
  ) {
    return undefined;
  }
  let utcMs = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const offset = timeZoneOffsetMs(new Date(utcMs), input.timezone);
    if (offset === undefined) {
      return undefined;
    }
    utcMs = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0) - offset;
  }
  return validDate(new Date(utcMs));
}

function timezoneOffsetMinutes(date: Date, timezone: string): number | undefined {
  const offset = timeZoneOffsetMs(date, timezone);
  return offset === undefined ? undefined : offset / 60_000;
}

function timeZoneOffsetMs(date: Date, timezone: string): number | undefined {
  const parts = localDateTimePartsWithSecond(date, timezone);
  if (!parts) {
    return undefined;
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function localDateTimePartsWithSecond(date: Date, timezone: string): (EventDateParts & EventTimeParts & { second: number }) | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    return {
      year: Number(value('year')),
      month: Number(value('month')),
      day: Number(value('day')),
      hour: Number(value('hour')),
      minute: Number(value('minute')),
      second: Number(value('second'))
    };
  } catch {
    return undefined;
  }
}

function validDate(date: Date): Date | undefined {
  return Number.isFinite(date.getTime()) ? date : undefined;
}
