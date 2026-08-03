import { createHash } from 'node:crypto';
import type { PluginServiceRegistration } from '../../../platform/pluginRuntime/pluginServices';
import type { PluginServiceRegistrationContext } from '../../../platform/pluginRuntime/types';
import { parseEventsConfig } from './config';
import {
  EVENT_ALBUM_SOURCE_LIST_METHOD,
  EVENT_ALBUM_SOURCE_RESOLVE_METHOD,
  EVENT_ALBUM_SOURCE_SERVICE_ID,
  type EventAlbumSource,
  type EventAlbumSourceListInput,
  type EventAlbumSourceResolveInput,
  eventAlbumSourceListInputSchema,
  eventAlbumSourceListOutputSchema,
  eventAlbumSourceResolveInputSchema,
  eventAlbumSourceResolveOutputSchema
} from './serviceApi';
import {
  eventsDatabase,
  getEvent,
  listScopeEvents,
  type StoredEventRecord
} from './store';

const DAY_MS = 24 * 60 * 60 * 1000;

export function registerEventAlbumSourceServices(
  context: PluginServiceRegistrationContext
): PluginServiceRegistration[] {
  return [{
    serviceId: EVENT_ALBUM_SOURCE_SERVICE_ID,
    methods: [
      {
        name: EVENT_ALBUM_SOURCE_LIST_METHOD,
        access: 'read',
        inputSchema: eventAlbumSourceListInputSchema,
        outputSchema: eventAlbumSourceListOutputSchema,
        async handler(rawInput, call) {
          const input = rawInput as EventAlbumSourceListInput;
          await assertEventsEnabled(context, call.scopeId, call.actorWid);
          const referenceTime = input.referenceTime ? new Date(input.referenceTime) : new Date();
          const earliest = referenceTime.getTime() - input.lookbackDays * DAY_MS;
          const latest = referenceTime.getTime() + input.lookaheadDays * DAY_MS;
          const candidates = listScopeEvents(eventsDatabase(context.databases), call.scopeId)
            .flatMap((event) => {
              const source = eventAlbumSource(event);
              if (!source) {
                return [];
              }
              const startsAt = new Date(source.startsAt).getTime();
              return startsAt >= earliest && startsAt <= latest ? [source] : [];
            })
            .sort((left, right) => compareAlbumSources(left, right, referenceTime.getTime()))
            .slice(0, input.limit);
          return {
            generatedAt: referenceTime.toISOString(),
            candidates
          };
        }
      },
      {
        name: EVENT_ALBUM_SOURCE_RESOLVE_METHOD,
        access: 'read',
        inputSchema: eventAlbumSourceResolveInputSchema,
        outputSchema: eventAlbumSourceResolveOutputSchema,
        async handler(rawInput, call) {
          const input = rawInput as EventAlbumSourceResolveInput;
          await assertEventsEnabled(context, call.scopeId, call.actorWid);
          const event = getEvent(eventsDatabase(context.databases), input.eventId);
          if (!event) {
            return { kind: 'unavailable' as const, reason: 'not_found' as const };
          }
          if (event.scopeId !== call.scopeId) {
            return { kind: 'unavailable' as const, reason: 'wrong_scope' as const };
          }
          const source = eventAlbumSource(event);
          return source
            ? { kind: 'found' as const, event: source }
            : { kind: 'unavailable' as const, reason: 'ineligible' as const };
        }
      }
    ]
  }];
}

export function eventAlbumSource(event: StoredEventRecord): EventAlbumSource | undefined {
  if (event.eventStatus !== 'active' && event.eventStatus !== 'completed') {
    return undefined;
  }
  const startsAt = normalizedStartsAt(event);
  const localDate = normalizedLocalDate(event, startsAt);
  const localTime = normalizedLocalTime(event, startsAt);
  const title = firstNonEmpty(event.groupTitle, event.pollQuestion, event.profileLabel);
  const place = firstNonEmpty(
    event.place,
    event.eventLocation?.displayLabel,
    event.calendarLocation
  );
  if (!startsAt || !localDate || !title || !place || !validTimezone(event.timezone)) {
    return undefined;
  }
  const sourceWithoutRevision = {
    eventId: event.id,
    title,
    startsAt,
    localDate,
    ...(localTime ? { localTime } : {}),
    timezone: event.timezone,
    place,
    eventStatus: event.eventStatus
  } satisfies Omit<EventAlbumSource, 'revision'>;
  return {
    ...sourceWithoutRevision,
    revision: createHash('sha256').update(JSON.stringify(sourceWithoutRevision)).digest('hex')
  };
}

async function assertEventsEnabled(
  context: PluginServiceRegistrationContext,
  scopeId: string,
  actorWid?: string | undefined
): Promise<void> {
  const config = parseEventsConfig(await context.configFor(scopeId, actorWid));
  if (!config.enabled) {
    throw new Error('official.community-events is disabled for this scope.');
  }
}

function compareAlbumSources(left: EventAlbumSource, right: EventAlbumSource, referenceTime: number): number {
  const leftTime = new Date(left.startsAt).getTime();
  const rightTime = new Date(right.startsAt).getTime();
  const leftDistance = Math.abs(leftTime - referenceTime);
  const rightDistance = Math.abs(rightTime - referenceTime);
  return leftDistance - rightDistance || leftTime - rightTime || left.eventId.localeCompare(right.eventId);
}

function normalizedStartsAt(event: StoredEventRecord): string | undefined {
  const date = new Date(event.startsAtUtc ?? event.startsAt);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function normalizedLocalDate(event: StoredEventRecord, startsAt: string | undefined): string | undefined {
  if (event.localDate && /^\d{4}-\d{2}-\d{2}$/.test(event.localDate)) {
    return event.localDate;
  }
  return startsAt ? localDateTimeParts(startsAt, event.timezone)?.date : undefined;
}

function normalizedLocalTime(event: StoredEventRecord, startsAt: string | undefined): string | undefined {
  if (event.localTime && /^\d{2}:\d{2}$/.test(event.localTime)) {
    return event.localTime;
  }
  return startsAt ? localDateTimeParts(startsAt, event.timezone)?.time : undefined;
}

function localDateTimeParts(startsAt: string, timezone: string): { date: string; time: string } | undefined {
  if (!validTimezone(timezone)) {
    return undefined;
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(startsAt));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const hour = value('hour');
  const minute = value('minute');
  return year && month && day && hour && minute
    ? { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` }
    : undefined;
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    return Boolean(timezone.trim());
  } catch {
    return false;
  }
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  return values.map((value) => value?.trim() ?? '').find(Boolean) ?? '';
}
