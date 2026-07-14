import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../../../platform/config/runtimeConfig';
import type { EventCalendarResource, EventsConfig } from './config';
import type { StoredEventRecord } from './store';

const CALENDAR_EXPORT_ROOT = 'calendar-exports';

export async function writeScopeCalendar(input: {
  appConfig: AppConfig;
  config: EventsConfig;
  scopeId: string;
  calendarId: string;
  events: StoredEventRecord[];
}): Promise<string | undefined> {
  const calendar = input.config.calendars.find((candidate) => candidate.id === input.calendarId);
  if (!calendar || !calendar.enabled) {
    return undefined;
  }
  const filePath = scopeCalendarPath(input.appConfig, calendar, input.scopeId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, renderScopeCalendar(input.config, input.calendarId, input.events), 'utf8');
  await rename(tempPath, filePath);
  return filePath;
}

export function renderScopeCalendar(config: EventsConfig, calendarId: string, events: StoredEventRecord[]): string {
  return renderIcs(scopeCalendarEvents(config, calendarId, events));
}

export function scopeCalendarEvents(config: EventsConfig, calendarId: string, events: StoredEventRecord[]): StoredEventRecord[] {
  const calendar = config.calendars.find((candidate) => candidate.id === calendarId);
  if (!calendar) {
    return [];
  }
  const profileIds = new Set(config.eventProfiles
    .filter((profile) => profile.calendar.calendarId === calendar.id)
    .map((profile) => profile.id));
  return events.filter((event) => profileIds.has(event.profileId));
}

export function scopeCalendarPath(appConfig: AppConfig, calendar: EventCalendarResource, scopeId: string): string {
  const root = path.resolve(
    appConfig.PLUGIN_DATABASE_DIR,
    sanitizePathSegment(appConfig.BOT_PROFILE_ID),
    'official.community-events',
    CALENDAR_EXPORT_ROOT
  );
  const directory = safeRelativeDirectory(calendar.directory);
  const resolved = path.resolve(root, directory, sanitizePathSegment(scopeId), `${sanitizePathSegment(calendar.id)}.ics`);
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
    throw new Error('Calendar export path escapes the events plugin data directory.');
  }
  return resolved;
}

export function renderIcs(events: StoredEventRecord[], now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//whatsapp-bot-platform//official.community-events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events.flatMap((event) => renderEvent(event, now)),
    'END:VCALENDAR'
  ];
  return `${lines.join('\r\n')}\r\n`;
}

function renderEvent(event: StoredEventRecord, now: Date): string[] {
  const startsAt = new Date(event.startsAt);
  const endsAt = new Date(startsAt.getTime() + event.calendarDurationMinutes * 60_000);
  return [
    'BEGIN:VEVENT',
    `UID:${escapeText(`${event.id}@official.community-events.whatsapp-bot-platform`)}`,
    `DTSTAMP:${formatUtc(now)}`,
    `DTSTART:${formatUtc(startsAt)}`,
    `DTEND:${formatUtc(endsAt)}`,
    `LAST-MODIFIED:${formatUtc(new Date(event.updatedAt))}`,
    `SEQUENCE:${event.calendarStatus === 'cancelled' ? 1 : 0}`,
    ...(event.calendarStatus === 'cancelled' ? ['STATUS:CANCELLED'] : ['STATUS:CONFIRMED']),
    `SUMMARY:${escapeText(event.groupTitle)}`,
    ...(event.calendarLocation ? [`LOCATION:${escapeText(event.calendarLocation)}`] : []),
    ...(event.calendarDescription ? [`DESCRIPTION:${escapeText(event.calendarDescription)}`] : []),
    'END:VEVENT'
  ];
}

function formatUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function safeRelativeDirectory(input: string): string {
  const normalized = input.trim() || 'calendar';
  if (path.isAbsolute(normalized)) {
    throw new Error('Calendar directory must be relative.');
  }
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new Error('Calendar directory cannot contain relative path segments.');
  }
  return parts.map(sanitizePathSegment).join(path.sep) || 'calendar';
}

function sanitizePathSegment(input: string): string {
  const sanitized = input.trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '');
  return sanitized || 'scope';
}
