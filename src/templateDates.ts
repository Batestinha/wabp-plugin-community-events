import type { EventSpanKind } from './span';

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
  return {
    // Intl's "short" weekdays can still be whole words (notably in pt-PT).
    weekday: Array.from(value('weekday').normalize('NFC')).slice(0, 3).join(''),
    dd: value('day'),
    mm: value('month'),
    yy: value('year'),
    yyyy: new Intl.DateTimeFormat(locale || 'en', { timeZone: timezone, year: 'numeric' }).format(date),
    hour: value('hour'),
    minute: value('minute')
  };
}

export function formatEventTemplateDate(date: Date, timezone: string, locale = 'en'): string {
  const tokens = eventDateTemplateTokens(date, timezone, locale);
  return `${tokens.dd}-${tokens.mm}-${tokens.yy}`;
}

export function formatEventDateTime(date: Date, timezone: string, locale = 'en'): string {
  const tokens = eventDateTemplateTokens(date, timezone, locale);
  return `${tokens.weekday}, ${tokens.dd}-${tokens.mm}-${tokens.yy} ${tokens.hour}:${tokens.minute} ${timezone}`;
}

export function eventSpanTemplateValues(input: {
  startsAt: Date;
  endsAt?: Date | undefined;
  spanKind?: EventSpanKind | undefined;
  timezone: string;
  locale?: string | undefined;
}): Record<string, string> {
  const end = input.endsAt ? eventDateTemplateTokens(input.endsAt, input.timezone, input.locale) : undefined;
  return {
    ...eventDateTemplateTokens(input.startsAt, input.timezone, input.locale),
    isMultiDay: input.spanKind === 'multi_day' ? 'true' : '',
    ...(input.spanKind ? { spanKind: input.spanKind } : {}),
    ...(end && input.endsAt ? {
      ...Object.fromEntries(Object.entries(end).map(([token, value]) => [`end${token[0]!.toUpperCase()}${token.slice(1)}`, value])),
      endsAt: formatEventDateTime(input.endsAt, input.timezone, input.locale),
      endDate: formatEventTemplateDate(input.endsAt, input.timezone, input.locale),
      endTime: `${end.hour}:${end.minute}`
    } : {})
  };
}
