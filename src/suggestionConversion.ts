import type { CommunityGroupSuggestion } from '../../../platform/transport/transportTypes';
import type { PluginJobEvent } from '../../../platform/pluginRuntime/types';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import { parseEventsConfig } from './config';
import {
  EventCreationFlowStarter,
  type EventCreationStartResult
} from './eventCreationFlowStarter';
import { registerEventFlowCompletionHandlers } from './commands';
import { eventsDatabase } from './store';
import {
  bindEventSuggestionCreatorIdentity,
  claimEventSuggestionConversion,
  completeEventSuggestionConversion,
  getEventSuggestionConversion,
  listEventSuggestionConversions,
  markEventSuggestionDisappeared,
  markEventSuggestionFlowStarted,
  markEventSuggestionRejectOutcomeUnknown,
  observeEventSuggestionConversion,
  releaseEventSuggestionConversionClaim,
  releaseExpiredEventSuggestionConversionClaims,
  type EventSuggestionConversionKey,
  type StoredEventSuggestionConversion
} from './suggestionConversionStore';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';

export const EVENT_SUGGESTION_RECONCILE_INTERVAL_MS = 60_000;
export const EVENT_SUGGESTION_RECONCILE_LIMIT = 10;

export interface EventSuggestionReconcileResult {
  listed: number;
  observed: number;
  flowsStarted: number;
  rejected: number;
  deferred: number;
  disappeared: number;
  failed: number;
}

export async function recoverEventSuggestionConversionJobs(
  context: PluginRuntimeContext,
  now: Date = new Date()
): Promise<number> {
  const scopeIds = await context.dataStore.accountScopeIds?.();
  if (!scopeIds) {
    context.logger.warn('Cannot recover community event suggestion conversions without account-scoped scope discovery.');
    return 0;
  }
  const db = eventsDatabase(context.databases);
  releaseExpiredEventSuggestionConversionClaims(db, now.toISOString());
  if (!context.resolveCommunitySuggestionTarget) {
    context.logger.warn('Cannot recover community event suggestion conversions without exact suggestion target resolution.');
    return 0;
  }
  let enqueued = 0;
  for (const scopeId of scopeIds) {
    if (!(await context.enabledFor(scopeId))) {
      continue;
    }
    const debtCommunities = uniqueDebtCommunityJids(
      listEventSuggestionConversions(db, scopeId)
    );
    let resolvable = await context.resolveCommunitySuggestionTarget({ scopeId })
      .then(() => true)
      .catch(() => false);
    for (const communityJid of debtCommunities) {
      if (resolvable) break;
      resolvable = await context.resolveCommunitySuggestionTarget({ scopeId, communityJid })
        .then(() => true)
        .catch(() => false);
    }
    if (!resolvable) {
      continue;
    }
    await enqueueSuggestionReconcileJob(context, scopeId, now, 'recovery');
    enqueued += 1;
  }
  return enqueued;
}

export async function handleEventSuggestionReconcileJob(
  context: PluginRuntimeContext,
  event: PluginJobEvent
): Promise<EventSuggestionReconcileResult> {
  const now = new Date();
  let primaryError: unknown;
  try {
    return await reconcileEventSuggestionsForScope(context, {
      scopeId: event.scopeId,
      now
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (await context.enabledFor(event.scopeId)) {
        const scheduleBase = new Date(Math.max(Date.now(), now.getTime()));
        await enqueueSuggestionReconcileJob(
          context,
          event.scopeId,
          new Date(scheduleBase.getTime() + EVENT_SUGGESTION_RECONCILE_INTERVAL_MS),
          'recurring'
        );
      }
    } catch (scheduleError) {
      if (!primaryError) {
        throw scheduleError;
      }
      context.logger.error(
        { error: scheduleError, scopeId: event.scopeId },
        'Unable to schedule the next community subgroup suggestion reconciliation after a failed run.'
      );
    }
  }
}

export async function reconcileEventSuggestionsForScope(
  context: PluginRuntimeContext,
  input: {
    scopeId: string;
    now?: Date | undefined;
    starter?: Pick<EventCreationFlowStarter, 'startAutomatic'> | undefined;
  }
): Promise<EventSuggestionReconcileResult> {
  const result = emptyResult();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const db = eventsDatabase(context.databases);
  releaseExpiredEventSuggestionConversionClaims(db, nowIso);

  const config = parseEventsConfig(await context.configFor(input.scopeId));
  const existing = listEventSuggestionConversions(db, input.scopeId);
  const owesRejection = existing.some(flowAlreadyStarted);
  if (config.subgroupSuggestionConversion.policy !== 'auto_convert' && !owesRejection) {
    return result;
  }
  const capabilities = requireSuggestionRuntime(context);
  const targets = new Map<string, SuggestionReconcileTarget>();
  for (const communityJid of uniqueDebtCommunityJids(existing)) {
    try {
      const target = await capabilities.resolveTarget({
        scopeId: input.scopeId,
        communityJid
      });
      targets.set(target.communityJid, { ...target, allowNewFlows: false });
    } catch (error) {
      result.failed += 1;
      context.logger.warn(
        { error, scopeId: input.scopeId, communityJid },
        'Unable to resolve the exact community target for pending suggestion rejection debt.'
      );
    }
  }
  if (config.subgroupSuggestionConversion.policy === 'auto_convert') {
    try {
      const target = await capabilities.resolveTarget({ scopeId: input.scopeId });
      targets.set(target.communityJid, { ...target, allowNewFlows: true });
    } catch (error) {
      result.failed += 1;
      context.logger.warn(
        { error, scopeId: input.scopeId },
        'Unable to resolve one exact managed community for subgroup suggestion conversion.'
      );
    }
  }
  if (targets.size === 0) {
    return result;
  }

  const starter = input.starter ?? new EventCreationFlowStarter(
    {
      flowEngine: capabilities.flowEngine,
      dataStore: context.dataStore,
      i18n: context.i18n,
      configFor: context.configFor.bind(context),
      enabledFor: context.enabledFor.bind(context),
      ...(context.resolveStableIdentityById
        ? { resolveStableIdentityById: context.resolveStableIdentityById }
        : {}),
      ...(context.communityAnnouncementGroupWidForScope
        ? { communityAnnouncementGroupWidForScope: context.communityAnnouncementGroupWidForScope }
        : {}),
      ...(context.explainPermission ? { explainPermission: context.explainPermission } : {})
    },
    (flowType, profiles, t) => registerEventFlowCompletionHandlers(context, flowType, profiles, t)
  );

  let remainingActions = EVENT_SUGGESTION_RECONCILE_LIMIT;
  for (const target of targets.values()) {
    let suggestions: CommunityGroupSuggestion[];
    try {
      suggestions = await capabilities.list(
        target.communityJid,
        target.joinedSubgroupHintJid
      );
      assertCompleteSuggestionSet(suggestions, target.communityJid);
      result.listed += suggestions.length;
    } catch (error) {
      result.failed += 1;
      context.logger.warn(
        { error, scopeId: input.scopeId, communityJid: target.communityJid },
        'Unable to list exact community subgroup suggestions.'
      );
      continue;
    }
    const currentlyPresent = new Set(suggestions.map((suggestion) => suggestionKey(suggestion)));
    const actionableSuggestions = suggestions.filter((suggestion) => {
      const record = getEventSuggestionConversion(db, conversionKey(input.scopeId, suggestion));
      if (!record) return target.allowNewFlows;
      if (record.status === 'completed' || record.status === 'disappeared') return false;
      return target.allowNewFlows || flowAlreadyStarted(record);
    });

    for (const suggestion of actionableSuggestions.slice(0, remainingActions)) {
      remainingActions -= 1;
      const key = conversionKey(input.scopeId, suggestion);
      let record = getEventSuggestionConversion(db, key);
      if (!record) {
        record = observeEventSuggestionConversion(db, { ...key, observedAt: nowIso });
        result.observed += 1;
        await auditConversion(context, 'events.subgroup_suggestion.observed', record);
      }
      const claim = claimEventSuggestionConversion(db, { ...key, now: nowIso });
      if (!claim?.leaseId) {
        result.deferred += 1;
        continue;
      }
      try {
        let creatorIdentityId = record.creatorIdentityId;
        if (!record.flowSessionId) {
          if (!creatorIdentityId) {
            const creator = await capabilities.resolveCreator(suggestion.creatorJid);
            creatorIdentityId = creator.identityId;
            record = bindEventSuggestionCreatorIdentity(db, {
              ...key,
              leaseId: claim.leaseId,
              creatorIdentityId,
              updatedAt: nowIso
            });
          }
          const flow = await starter.startAutomatic({
            scopeId: input.scopeId,
            actorIdentityId: creatorIdentityId,
            externalIdempotencyKey: eventSuggestionFlowIdempotencyKey(key),
            origin: { chatId: target.communityJid, context: 'group' },
            includeSuggestionRefusalNotice: true
          });
          const flowSessionId = startedFlowSessionId(flow);
          if (!flowSessionId) {
            const reason = flow.kind === 'unavailable' ? flow.reason : 'missing_flow_session';
            releaseEventSuggestionConversionClaim(db, {
              ...key,
              leaseId: claim.leaseId,
              error: `event flow unavailable: ${reason}`,
              updatedAt: nowIso
            });
            result.deferred += 1;
            await auditConversion(context, 'events.subgroup_suggestion.deferred', record, { reason });
            continue;
          }
          record = markEventSuggestionFlowStarted(db, {
            ...key,
            leaseId: claim.leaseId,
            flowSessionId,
            startedAt: nowIso
          });
          result.flowsStarted += 1;
          await auditConversion(context, 'events.subgroup_suggestion.flow_started', record);
        }

        try {
          const rejection = await capabilities.reject(
            suggestion,
            target.joinedSubgroupHintJid
          );
          record = completeEventSuggestionConversion(db, {
            ...key,
            leaseId: claim.leaseId,
            rejectedAt: nowIso
          });
          result.rejected += 1;
          await auditConversion(context, 'events.subgroup_suggestion.rejected', record, {
            transportStatus: rejection.status
          });
        } catch (error) {
          record = markEventSuggestionRejectOutcomeUnknown(db, {
            ...key,
            leaseId: claim.leaseId,
            reason: describeError(error),
            updatedAt: nowIso
          });
          result.failed += 1;
          await auditConversion(context, 'events.subgroup_suggestion.reject_unconfirmed', record, {
            reason: describeError(error)
          });
        }
      } catch (error) {
        const current = getEventSuggestionConversion(db, key);
        if (current?.leaseId === claim.leaseId) {
          releaseEventSuggestionConversionClaim(db, {
            ...key,
            leaseId: claim.leaseId,
            error: describeError(error),
            updatedAt: nowIso
          });
        }
        result.failed += 1;
        await auditConversion(context, 'events.subgroup_suggestion.failed', current ?? claim, {
          reason: describeError(error)
        });
      }
    }

    for (const record of listEventSuggestionConversions(db, input.scopeId)) {
      if (
        record.communityJid !== target.communityJid
        || currentlyPresent.has(recordSuggestionKey(record))
      ) {
        continue;
      }
      const key = recordKey(record);
      if (record.status === 'observed') {
        if (markEventSuggestionDisappeared(db, { ...key, updatedAt: nowIso })) {
          result.disappeared += 1;
          await auditConversion(context, 'events.subgroup_suggestion.disappeared', record);
        }
        continue;
      }
      if (!flowAlreadyStarted(record)) {
        continue;
      }
      const claim = claimEventSuggestionConversion(db, { ...key, now: nowIso });
      if (!claim?.leaseId) {
        continue;
      }
      const completed = completeEventSuggestionConversion(db, {
        ...key,
        leaseId: claim.leaseId,
        rejectedAt: nowIso
      });
      result.rejected += 1;
      await auditConversion(context, 'events.subgroup_suggestion.rejection_absence_confirmed', completed);
    }
  }
  return result;
}

interface SuggestionReconcileTarget {
  communityJid: string;
  joinedSubgroupHintJid: string;
  allowNewFlows: boolean;
}

function requireSuggestionRuntime(context: PluginRuntimeContext) {
  if (
    !context.flowEngine ||
    !context.listCommunityGroupSuggestions ||
    !context.rejectCommunityGroupSuggestion ||
    !context.resolveIdentityAddress ||
    !context.resolveStableIdentityById ||
    !context.resolveCommunitySuggestionTarget
  ) {
    throw new Error('Community subgroup suggestion conversion runtime services are unavailable.');
  }
  return {
    flowEngine: context.flowEngine,
    resolveTarget: context.resolveCommunitySuggestionTarget,
    list: context.listCommunityGroupSuggestions,
    reject: context.rejectCommunityGroupSuggestion,
    resolveCreator: context.resolveIdentityAddress
  };
}

async function enqueueSuggestionReconcileJob(
  context: PluginRuntimeContext,
  scopeId: string,
  runAt: Date,
  reason: string
): Promise<void> {
  const bucket = Math.floor(runAt.getTime() / EVENT_SUGGESTION_RECONCILE_INTERVAL_MS);
  await enqueuePluginJob(context.queue, {
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.suggestionReconcile,
    scopeId,
    runAt,
    payload: { reason },
    dedupeKey: `${EVENTS_JOBS.suggestionReconcile}:${scopeId}:${bucket}`
  });
}

function assertCompleteSuggestionSet(
  suggestions: readonly CommunityGroupSuggestion[],
  communityJid: string
): void {
  const keys = new Set<string>();
  for (const suggestion of suggestions) {
    if (suggestion.communityJid !== communityJid) {
      throw new Error('Suggestion listing returned an item from a different community.');
    }
    const key = suggestionKey(suggestion);
    if (keys.has(key)) {
      throw new Error('Suggestion listing returned a duplicate child-and-creator tuple.');
    }
    keys.add(key);
  }
}

function conversionKey(scopeId: string, suggestion: CommunityGroupSuggestion): EventSuggestionConversionKey {
  return {
    scopeId,
    communityJid: suggestion.communityJid,
    suggestedGroupJid: suggestion.childGroupJid,
    suggestionCreatorJid: suggestion.creatorJid
  };
}

function recordKey(record: StoredEventSuggestionConversion): EventSuggestionConversionKey {
  return {
    scopeId: record.scopeId,
    communityJid: record.communityJid,
    suggestedGroupJid: record.suggestedGroupJid,
    suggestionCreatorJid: record.suggestionCreatorJid
  };
}

function suggestionKey(suggestion: CommunityGroupSuggestion): string {
  return `${suggestion.childGroupJid}\u0000${suggestion.creatorJid}`;
}

function recordSuggestionKey(record: StoredEventSuggestionConversion): string {
  return `${record.suggestedGroupJid}\u0000${record.suggestionCreatorJid}`;
}

function eventSuggestionFlowIdempotencyKey(key: EventSuggestionConversionKey): string {
  return [
    'official.community-events',
    'suggestion',
    key.scopeId,
    key.communityJid,
    key.suggestedGroupJid,
    key.suggestionCreatorJid
  ].join(':');
}

function flowAlreadyStarted(record: StoredEventSuggestionConversion): boolean {
  return record.status === 'flow_started_pending_reject' || record.status === 'reject_outcome_unknown';
}

function uniqueDebtCommunityJids(
  records: readonly StoredEventSuggestionConversion[]
): string[] {
  return [...new Set(
    records.filter(flowAlreadyStarted).map((record) => record.communityJid)
  )].sort();
}

function startedFlowSessionId(result: EventCreationStartResult): string | undefined {
  return result.kind === 'started' ? result.flowSessionId : undefined;
}

async function auditConversion(
  context: PluginRuntimeContext,
  action: string,
  record: StoredEventSuggestionConversion,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await context.audit.record({
    action,
    scopeId: record.scopeId,
    targetJson: {
      communityJid: record.communityJid,
      suggestedGroupJid: record.suggestedGroupJid,
      suggestionCreatorJid: record.suggestionCreatorJid
    },
    metadataJson: {
      ...(record.creatorIdentityId ? { triggeringIdentityId: record.creatorIdentityId } : {}),
      ...(record.flowSessionId ? { flowSessionId: record.flowSessionId } : {}),
      status: record.status,
      attemptCount: record.attemptCount,
      ...metadata
    }
  });
}

function emptyResult(): EventSuggestionReconcileResult {
  return {
    listed: 0,
    observed: 0,
    flowsStarted: 0,
    rejected: 0,
    deferred: 0,
    disappeared: 0,
    failed: 0
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
