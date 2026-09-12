import { enqueuePluginJob } from '@wabs/plugin-sdk/jobs';
import type { PluginRuntimeContext } from './runtime';
import { parseEventsConfig } from './config';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import { eventProfileQuestionSchemaRevision } from './profileRevision';
import {
  eventsDatabase,
  listPendingEventQuestionKeyRenames,
  settleEventQuestionKeyRename,
  type StoredEventQuestionKeyRename
} from './store';

const QUESTION_KEY_RENAME_RECOVERY_RETRY_MS = 60_000;
const QUESTION_KEY_RENAME_RECOVERY_MIN_DELAY_MS = 1_000;

export interface EventQuestionKeyRenameRecoveryResult {
  settled: number;
  scheduled: number;
  unresolved: number;
}

export type EventQuestionKeyRenameRecoveryDecision =
  | { status: 'leased'; retryAt: Date }
  | { status: 'settle'; authority: 'old' | 'new'; authorityRevision: string }
  | { status: 'unresolved' };

export function eventQuestionKeyRenameRecoveryDecision(
  config: ReturnType<typeof parseEventsConfig> | undefined,
  rename: StoredEventQuestionKeyRename,
  now: Date
): EventQuestionKeyRenameRecoveryDecision {
  const leaseExpiresAt = new Date(rename.leaseExpiresAt);
  if (Number.isFinite(leaseExpiresAt.getTime()) && leaseExpiresAt.getTime() > now.getTime()) {
    return { status: 'leased', retryAt: leaseExpiresAt };
  }
  if (!config) {
    return { status: 'unresolved' };
  }
  const authority = eventQuestionKeyRenameAuthority(config, rename);
  const authorityRevision = eventQuestionKeyRenameAuthorityRevision(config, rename);
  return authority && authorityRevision
    ? { status: 'settle', authority, authorityRevision }
    : { status: 'unresolved' };
}

export async function recoverEventQuestionKeyRenames(
  context: PluginRuntimeContext,
  options: {
    now?: Date | undefined;
    operationId?: string | undefined;
  } = {}
): Promise<EventQuestionKeyRenameRecoveryResult> {
  const db = eventsDatabase(context.databases);
  const now = options.now ?? new Date();
  const pending = listPendingEventQuestionKeyRenames(db, {
    ...(options.operationId ? { operationId: options.operationId } : {})
  });
  let settled = 0;
  let scheduled = 0;
  let unresolved = 0;

  for (const rename of pending) {
    const leaseDecision = eventQuestionKeyRenameRecoveryDecision(undefined, rename, now);
    if (leaseDecision.status === 'leased') {
      await scheduleQuestionKeyRenameRecovery(context, rename, leaseDecision.retryAt, now);
      scheduled += 1;
      continue;
    }

    let config: ReturnType<typeof parseEventsConfig>;
    try {
      config = parseEventsConfig(await context.configFor(rename.scopeId));
    } catch (error) {
      const retryAt = new Date(now.getTime() + QUESTION_KEY_RENAME_RECOVERY_RETRY_MS);
      context.logger.warn(
        { error, operationId: rename.operationId, scopeId: rename.scopeId, profileId: rename.profileId },
        'Unable to read authoritative event config while recovering a question-key rename'
      );
      await scheduleQuestionKeyRenameRecovery(context, rename, retryAt, now);
      scheduled += 1;
      continue;
    }

    const decision = eventQuestionKeyRenameRecoveryDecision(config, rename, now);
    if (decision.status !== 'settle') {
      context.logger.error(
        { operationId: rename.operationId, scopeId: rename.scopeId, profileId: rename.profileId },
        'Event question-key rename cannot converge because the authoritative profile contains both or neither key'
      );
      unresolved += 1;
      continue;
    }

    settleEventQuestionKeyRename(db, {
      operationId: rename.operationId,
      authority: decision.authority,
      authorityRevision: decision.authorityRevision,
      settledAt: now.toISOString()
    });
    settled += 1;
    try {
      await context.audit.record({
        scopeId: rename.scopeId,
        action: 'events.question_key_rename.recovered',
        targetJson: {
          operationId: rename.operationId,
          profileId: rename.profileId,
          oldKey: rename.oldKey,
          newKey: rename.newKey
        },
        metadataJson: { authority: decision.authority }
      });
    } catch (error) {
      context.logger.warn(
        { error, operationId: rename.operationId, scopeId: rename.scopeId },
        'Recovered event question-key rename but could not write the platform audit record'
      );
    }
    context.logger.info(
      {
        operationId: rename.operationId,
        scopeId: rename.scopeId,
        profileId: rename.profileId,
        authority: decision.authority
      },
      'Recovered event question-key rename'
    );
  }

  return { settled, scheduled, unresolved };
}

async function scheduleQuestionKeyRenameRecovery(
  context: PluginRuntimeContext,
  rename: StoredEventQuestionKeyRename,
  runAt: Date,
  now: Date
): Promise<void> {
  const minimumRunAt = new Date(now.getTime() + QUESTION_KEY_RENAME_RECOVERY_MIN_DELAY_MS);
  const normalizedRunAt = Number.isFinite(runAt.getTime()) && runAt.getTime() > minimumRunAt.getTime()
    ? runAt
    : minimumRunAt;
  await enqueuePluginJob(context, {
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.questionKeyRenameRecovery,
    scopeId: rename.scopeId,
    runAt: normalizedRunAt,
    payload: { operationId: rename.operationId },
    dedupeKey: `${EVENTS_JOBS.questionKeyRenameRecovery}:${rename.operationId}:${normalizedRunAt.toISOString()}`
  });
}

export function eventQuestionKeyRenameAuthority(
  config: ReturnType<typeof parseEventsConfig>,
  rename: Pick<StoredEventQuestionKeyRename, 'profileId' | 'oldKey' | 'newKey'>
): 'old' | 'new' | undefined {
  const profile = config.eventProfiles.find((candidate) => candidate.id === rename.profileId);
  if (!profile) {
    return undefined;
  }
  const hasOldKey = profile.questions.some((question) => question.key === rename.oldKey);
  const hasNewKey = profile.questions.some((question) => question.key === rename.newKey);
  if (hasOldKey === hasNewKey) {
    return undefined;
  }
  return hasNewKey ? 'new' : 'old';
}

export function eventQuestionKeyRenameAuthorityRevision(
  config: ReturnType<typeof parseEventsConfig>,
  rename: Pick<StoredEventQuestionKeyRename, 'profileId' | 'oldKey' | 'newKey'>
): string | undefined {
  if (!eventQuestionKeyRenameAuthority(config, rename)) {
    return undefined;
  }
  const profile = config.eventProfiles.find((candidate) => candidate.id === rename.profileId);
  return profile ? eventProfileQuestionSchemaRevision(profile) : undefined;
}
