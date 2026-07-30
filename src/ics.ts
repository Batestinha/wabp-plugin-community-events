import { chown, lstat, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../../../platform/config/runtimeConfig';
import type { EventCalendarResource, EventsConfig } from './config';
import { renderEventTemplate } from './flow';
import type { StoredEventRecord } from './store';

const CALENDAR_EXPORT_ROOT = 'calendar-exports';
const DEFAULT_CONTAINER_APP_UID = 1000;
const DEFAULT_CONTAINER_APP_GID = 1000;

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
  await chownCalendarExportTree(calendarExportRoot(input.appConfig));
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, renderScopeCalendar(input.config, input.calendarId, input.events), 'utf8');
  await chownCalendarExportPath(tempPath);
  await rename(tempPath, filePath);
  await chownCalendarExportPath(filePath);
  return filePath;
}

export function renderScopeCalendar(config: EventsConfig, calendarId: string, events: StoredEventRecord[]): string {
  const calendar = config.calendars.find((candidate) => candidate.id === calendarId);
  return renderIcsWithConfig(scopeCalendarEvents(config, calendarId, events), config, new Date(), calendar?.label || calendarId);
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
  const root = calendarExportRoot(appConfig);
  const directory = safeRelativeDirectory(calendar.directory);
  const resolved = path.resolve(root, directory, sanitizePathSegment(scopeId), `${sanitizePathSegment(calendar.id)}.ics`);
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
    throw new Error('Calendar export path escapes the events plugin data directory.');
  }
  return resolved;
}

export function renderIcs(events: StoredEventRecord[], now = new Date(), calendarName = 'Events'): string {
  return renderIcsWithConfig(events, {}, now, calendarName);
}

function renderIcsWithConfig(
  events: StoredEventRecord[],
  config: Pick<EventsConfig, 'eventProfiles'> | Record<string, never>,
  now = new Date(),
  calendarName = 'Events'
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//whatsapp-bot-platform//official.community-events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `NAME:${escapeText(calendarName)}`,
    ...events.flatMap((event) => renderEvent(event, config, now)),
    'END:VCALENDAR'
  ];
  return `${lines.flatMap(foldIcsLine).join('\r\n')}\r\n`;
}

function renderEvent(
  event: StoredEventRecord,
  config: Pick<EventsConfig, 'eventProfiles'> | Record<string, never>,
  now: Date
): string[] {
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
    `SUMMARY:${escapeText(calendarEventSummary(event, config))}`,
    ...(event.calendarLocation ? [`LOCATION:${escapeText(event.calendarLocation)}`] : []),
    ...(event.calendarDescription ? [`DESCRIPTION:${escapeText(event.calendarDescription)}`] : []),
    'END:VEVENT'
  ];
}

function calendarEventSummary(
  event: StoredEventRecord,
  config: Pick<EventsConfig, 'eventProfiles'> | Record<string, never>
): string {
  const profile = 'eventProfiles' in config
    ? config.eventProfiles.find((candidate) => candidate.id === event.profileId)
    : undefined;
  const template = profile?.calendar.titleTemplate?.trim();
  if (!profile || !template) {
    return event.groupTitle;
  }
  const rendered = renderEventTemplate({
    template,
    profile,
    answers: event.answers,
    startsAt: new Date(event.startsAt),
    timezone: event.timezone,
    creatorDisplayName: event.actorLabel
  }).trim();
  return rendered || event.groupTitle;
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

function foldIcsLine(line: string): string[] {
  if (Buffer.byteLength(line, 'utf8') <= 75) {
    return [line];
  }

  const folded: string[] = [];
  let remaining = line;
  let first = true;
  while (remaining.length > 0) {
    const maxBytes = first ? 75 : 74;
    let index = 0;
    let bytes = 0;
    for (const char of remaining) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (bytes + charBytes > maxBytes) {
        break;
      }
      bytes += charBytes;
      index += char.length;
    }
    const chunk = remaining.slice(0, Math.max(index, 1));
    folded.push(first ? chunk : ` ${chunk}`);
    remaining = remaining.slice(chunk.length);
    first = false;
  }
  return folded;
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

function calendarExportRoot(appConfig: AppConfig): string {
  return path.resolve(
    appConfig.PLUGIN_DATABASE_DIR,
    sanitizePathSegment(appConfig.WHATSAPP_ACCOUNT_ID),
    'official.community-events',
    CALENDAR_EXPORT_ROOT
  );
}

async function chownCalendarExportTree(root: string): Promise<void> {
  const owner = calendarExportOwner();
  if (!owner) {
    return;
  }
  await chownPathAndChildren(root, owner);
}

async function chownCalendarExportPath(targetPath: string): Promise<void> {
  const owner = calendarExportOwner();
  if (!owner) {
    return;
  }
  await chownPath(targetPath, owner);
}

async function chownPathAndChildren(targetPath: string, owner: CalendarExportOwner): Promise<void> {
  const stat = await statOrMissing(targetPath);
  if (!stat) {
    return;
  }
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of await readdir(targetPath)) {
      await chownPathAndChildren(path.join(targetPath, entry), owner);
    }
  }
  await chown(targetPath, owner.uid, owner.gid);
}

async function chownPath(targetPath: string, owner: CalendarExportOwner): Promise<void> {
  const stat = await statOrMissing(targetPath);
  if (!stat || stat.isSymbolicLink()) {
    return;
  }
  await chown(targetPath, owner.uid, owner.gid);
}

async function statOrMissing(targetPath: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

interface CalendarExportOwner {
  uid: number;
  gid: number;
}

function calendarExportOwner(): CalendarExportOwner | undefined {
  // The Docker console runs as root, while the bot writes the same export tree as node.
  if (process.env.WA_BOT_CONTAINER_RUNTIME !== 'docker') {
    return undefined;
  }
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return undefined;
  }
  return {
    uid: integerEnv(process.env.WABP_APP_UID) ?? DEFAULT_CONTAINER_APP_UID,
    gid: integerEnv(process.env.WABP_APP_GID) ?? DEFAULT_CONTAINER_APP_GID
  };
}

function integerEnv(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
