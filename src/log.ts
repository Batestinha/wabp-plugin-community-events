import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../../../platform/config/runtimeConfig';

export interface EventJsonLogEntry {
  action: string;
  scopeId: string;
  eventId?: string | undefined;
  actorWid?: string | undefined;
  profileId?: string | undefined;
  pollWaMsgId?: string | undefined;
  subgroupChatId?: string | undefined;
  metadata?: unknown;
}

export async function appendScopeEventJsonLog(input: {
  appConfig: AppConfig;
  entry: EventJsonLogEntry;
}): Promise<string> {
  const filePath = eventJsonLogPath(input.appConfig, input.entry.scopeId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...input.entry
  });
  await appendFile(filePath, `${line}\n`, 'utf8');
  return filePath;
}

export function eventJsonLogPath(appConfig: AppConfig, scopeId: string): string {
  return path.resolve(
    appConfig.PLUGIN_DATABASE_DIR,
    sanitizePathSegment(appConfig.WHATSAPP_ACCOUNT_ID),
    'official.community-events',
    'logs',
    `${sanitizePathSegment(scopeId)}.jsonl`
  );
}

function sanitizePathSegment(input: string): string {
  const sanitized = input.trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '');
  return sanitized || 'scope';
}
