import { z } from 'zod';
import type { PluginOperationContext, PluginServiceRegistrationContext } from '../../../platform/pluginRuntime/types';
import type { PluginServiceCallContext, PluginServiceRegistration } from '../../../platform/pluginRuntime/pluginServices';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import { bindWorkflowInput, canonicalJson, preparedActionSchema, workflowActionResultSchema, workflowBindingSchema, workflowDigest,
  type PreparedAction, type WorkflowActionResult, type WorkflowBinding } from '../../../platform/workflows/contracts';
import { requireOfficialCommandRuntime } from '../shared';
import { applyEventUpdate, eventIsEditable, eventUpdateAllowed, eventUpdatePrefill, type EventUpdateDraft } from './commands';
import { cancelEventLifecycle } from './cancellation';
import { localizeDefaultEventProfiles, parseEventsConfig } from './config';
import { eventFlowAnswersFromRaw } from './flow';
import { eventLocationQuery, fixedEventLocation } from './eventLocation';
import { materializeEventLifecycle } from './materialize';
import { eventsDatabase, getEvent, getEventEditRepair, getEventPollReplacement, listScopeEvents, listEventAnnouncementMessages, type StoredEventRecord } from './store';
import { EVENT_WORKFLOW_SERVICE_ID, eventActionCancelInputSchema, eventActionEditInputSchema, eventWorkflowActions, type EventActionEditInput } from './workflowActionApi';

const describeSchema = z.object({ input: z.object({ eventId: z.string().optional(), query: z.string().max(500).optional() }).passthrough() }).strict();
const prepareSchema = z.object({ input: z.record(z.unknown()), bindings: z.array(workflowBindingSchema).default([]) }).strict();
const executeSchema = z.object({ input: z.record(z.unknown()), guard: z.record(z.unknown()), operationId: z.string().min(1).max(300), predecessors: z.record(z.unknown()).default({}) }).strict();
const inspectSchema = z.object({ operationId: z.string().min(1).max(300) }).strict();
type Operation = 'edit' | 'cancel';
interface ReceiptRow extends Record<string, unknown> {
  operation_id: string; scope_id: string; actor_identity_id: string; event_id: string;
  action: Operation; input_digest: string; input_json: string; guard_json: string; status: string; result_json: string | null;
}

export function registerEventWorkflowServices(context: PluginServiceRegistrationContext): PluginServiceRegistration[] {
  return [{ serviceId: EVENT_WORKFLOW_SERVICE_ID, methods: (['edit', 'cancel'] as const).flatMap((operation) => [
    { name: `${operation}Describe`, access: 'read' as const, inputSchema: describeSchema, outputSchema: z.record(z.unknown()),
      handler: async (raw, call) => describe(context, operation, describeSchema.parse(raw).input, call) },
    { name: `${operation}Prepare`, access: 'read' as const, inputSchema: prepareSchema, outputSchema: preparedActionSchema,
      handler: async (raw, call) => prepare(context, operation, prepareSchema.parse(raw), call) },
    { name: `${operation}Execute`, access: 'mutation' as const, inputSchema: executeSchema, outputSchema: workflowActionResultSchema,
      handler: async (raw, call) => execute(context, operation, executeSchema.parse(raw), call) },
    { name: `${operation}Inspect`, access: 'read' as const, inputSchema: inspectSchema, outputSchema: workflowActionResultSchema,
      handler: async (raw, call) => inspect(context, inspectSchema.parse(raw).operationId, call) }
  ]) }];
}

function operationContext(context: PluginServiceRegistrationContext): PluginOperationContext {
  if (!context.flowEngine) throw new Error('Event workflow runtime is unavailable');
  return { ...context, flowEngine: context.flowEngine,
    releasePollSendReceipt: (chatId, key) => {
      if (!context.platform.transport.releasePollSendReceipt) throw new Error('Poll receipt release is unavailable');
      return context.platform.transport.releasePollSendReceipt(chatId, key, context.pluginId, { requiredProviderId: 'whatsmeow' });
    },
    enqueuePluginJob: (input) => enqueuePluginJob(context.queue, { pluginId: context.pluginId, ...input }) };
}

async function actorContext(context: PluginServiceRegistrationContext, call: PluginServiceCallContext) {
  if (!call.actorIdentityId || !context.resolveStableIdentityById) throw new Error('Workflow actions require the original requester identity');
  if (!await context.enabledFor(call.scopeId)) throw new Error('Community Events is disabled');
  const actor = await context.resolveStableIdentityById(call.actorIdentityId);
  if (actor.identityId !== call.actorIdentityId) throw new Error('Requester identity resolution mismatch');
  const locale = await context.i18n.resolveScopeLocale(call.scopeId);
  const t = await context.i18n.translatorForIdentity(call.actorIdentityId, call.scopeId);
  const config = parseEventsConfig(await context.configFor(call.scopeId, call.actorIdentityId));
  return { actor, locale: locale.locale, t, config, domain: operationContext(context) };
}

async function requireEvent(context: PluginServiceRegistrationContext, eventId: string, call: PluginServiceCallContext) {
  const current = await actorContext(context, call);
  const event = getEvent(eventsDatabase(context.databases), eventId);
  if (!event || event.scopeId !== call.scopeId) throw new Error(current.t('official.community-events.workflow.unavailable'));
  if (!await eventUpdateAllowed(current.domain, { event, actor: current.actor, creatorIdentityId: event.actorIdentityId })) {
    throw new Error(current.t('official.community-events.update.permissionDenied'));
  }
  const profile = localizeDefaultEventProfiles(current.config.eventProfiles, current.t).find((profile) => profile.id === event.profileId);
  if (!profile) throw new Error(current.t('official.community-events.workflow.unavailable'));
  return { ...current, event, profile };
}

async function describe(context: PluginServiceRegistrationContext, operation: Operation, input: { eventId?: string | undefined; query?: string | undefined }, call: PluginServiceCallContext) {
  const current = await actorContext(context, call);
  if (!input.eventId) {
    const candidates = [];
    for (const event of listScopeEvents(eventsDatabase(context.databases), call.scopeId)) {
      if ((operation === 'edit' ? !eventIsEditable(event) : event.eventStatus !== 'active')
        || (input.query && !`${event.id} ${event.groupTitle}`.toLocaleLowerCase().includes(input.query.toLocaleLowerCase()))) continue;
      if (!await eventUpdateAllowed(current.domain, { event, actor: current.actor, creatorIdentityId: event.actorIdentityId })) continue;
      candidates.push({ id: event.id, label: event.groupTitle, startsAt: event.startsAt, timezone: event.timezone });
      if (candidates.length >= 100) break;
    }
    return { candidates };
  }
  const target = await requireEvent(context, input.eventId, call);
  return { eventId: target.event.id, label: target.event.groupTitle, timezone: target.event.timezone,
    revision: target.event.updatedAt, inputSchema: eventWorkflowActions.find((action) => action.actionId.endsWith(`.${operation}`))!.inputSchema,
    fields: operation === 'edit' ? target.profile.questions.map((question) => ({
      key: question.key, label: question.prompt, type: question.type, current: target.event.answers[question.key] ?? '',
      question
    })) : [],
    current: operation === 'edit' ? eventUpdatePrefill(target.event, target.profile) : { eventStatus: target.event.eventStatus }
  };
}

async function prepare(context: PluginServiceRegistrationContext, operation: Operation, request: z.infer<typeof prepareSchema>, call: PluginServiceCallContext): Promise<PreparedAction> {
  const eventId = z.string().min(1).parse(request.input.eventId);
  const target = await requireEvent(context, eventId, call);
  if (operation === 'edit' && !eventIsEditable(target.event)) throw new Error(target.t('official.community-events.workflow.unavailable'));
  if (operation === 'cancel' && target.event.eventStatus !== 'active') throw new Error(target.t('official.community-events.workflow.unavailable'));
  const variants = bindingVariants(request.input, request.bindings);
  const effects = new Set<string>();
  const summaries = [];
  for (const variant of variants) {
    if (operation === 'edit') {
      const input = eventActionEditInputSchema.parse(variant);
      const prepared = prepareEdit(target, input);
      for (const key of editFields(input)) effects.add(key);
      summaries.push(target.t('official.community-events.workflow.edit.summary', {
        event: target.event.groupTitle, changes: prepared.changes, timezone: target.event.timezone
      }));
    } else {
      const input = eventActionCancelInputSchema.parse(variant);
      effects.add('*');
      summaries.push(target.t('official.community-events.workflow.cancel.summary', {
        event: target.event.groupTitle, calendar: input.calendarDisposition,
        messages: input.deleteAnnouncementMessages ? target.t('official.community-events.workflow.deleteMessages') : target.t('official.community-events.workflow.keepMessages')
      }));
    }
  }
  const fields = [...effects];
  if (!fields.length) throw new Error(target.t('official.community-events.workflow.noChanges'));
  return { summary: [...new Set(summaries)].join('\n'), input: request.input,
    guard: { eventId, revision: target.event.updatedAt, profileDigest: workflowDigest(json(target.profile)), timezone: target.event.timezone,
      fields: Object.fromEntries(fields.map((field) => [field, currentField(target.event, field)])) },
    effects: [{ resource: `event:${eventId}`, fields, description: summaries.join('\n') }] };
}

function prepareEdit(target: Awaited<ReturnType<typeof requireEvent>>, input: EventActionEditInput) {
  const baseline = eventUpdatePrefill(target.event, target.profile);
  for (const key of Object.keys(input.patch.answers)) {
    const question = target.profile.questions.find((question) => question.key === key);
    if (!question) throw new Error(`Unknown event field ${key}`);
    if (question.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(input.patch.answers[key]!)) throw new Error('Event dates must be explicit local dates');
  }
  const answers = eventFlowAnswersFromRaw({ profile: target.profile,
    answers: { ...baseline.answers, ...input.patch.answers }, timezone: target.event.timezone, locale: target.locale,
    spanKind: input.patch.spanKind ?? baseline.spanKind, endLocalDate: input.patch.endLocalDate ?? baseline.endLocalDate,
    endLocalTime: input.patch.endLocalTime ?? baseline.endLocalTime, allowPast: target.event.groupLifecycleStatus !== 'poll_open'
  });
  if (!answers) throw new Error(target.t('official.community-events.workflow.invalidInput'));
  const query = eventLocationQuery(target.profile, answers.answers);
  const fixed = fixedEventLocation(target.profile, target.event.timezone);
  const location = fixed ?? input.patch.location ?? (query === eventLocationQuery(target.profile, target.event.answers) ? target.event.eventLocation : undefined);
  if (!location || (!fixed && location.displayLabel !== query)) throw new Error(target.t('official.community-events.workflow.locationRequired'));
  if (fixed && input.patch.location && canonicalJson(fixed) !== canonicalJson(input.patch.location)) throw new Error(target.t('official.community-events.workflow.fixedLocation'));
  new Intl.DateTimeFormat('en', { timeZone: location.timezone }).format();
  const materialized = materializeEventLifecycle({ profile: target.profile, answers, timezone: target.event.timezone,
    locale: target.locale, creatorDisplayName: target.event.actorLabel, eventLocation: location });
  if (target.event.eventStatus === 'active' && materialized.lifecycleCompleteAt <= new Date() && !input.confirmPastCompletion) {
    throw new Error(target.t('official.community-events.update.pastCompletionConfirmationRequired'));
  }
  const changes = Object.entries(input.patch.answers).map(([key, value]) => `${target.profile.questions.find((question) => question.key === key)!.prompt}: ${value}`);
  if (input.patch.spanKind) changes.push(`${target.t('official.community-events.workflow.span')}: ${input.patch.spanKind}`);
  if (input.patch.endLocalDate || input.patch.endLocalTime) changes.push(`${target.t('official.community-events.workflow.end')}: ${answers.endLocalDate} ${answers.endLocalTime ?? ''}`);
  if (input.patch.location) changes.push(`${target.t('official.community-events.workflow.location')}: ${location.displayLabel} (${location.latitude}, ${location.longitude})`);
  if (input.confirmPastCompletion) changes.push(target.t('official.community-events.workflow.allowCompletion'));
  return { answers, location, changes: changes.join('; ') };
}

async function execute(context: PluginServiceRegistrationContext, operation: Operation, request: z.infer<typeof executeSchema>, call: PluginServiceCallContext): Promise<WorkflowActionResult> {
  const eventId = z.string().min(1).parse(request.input.eventId);
  const target = await requireEvent(context, eventId, call);
  const db = eventsDatabase(context.databases);
  const digest = workflowDigest([operation, request.input, request.guard]);
  const existing = db.get<ReceiptRow>('SELECT * FROM event_workflow_operations WHERE operation_id = ?', request.operationId);
  if (existing) {
    if (existing.scope_id !== call.scopeId || existing.actor_identity_id !== call.actorIdentityId || existing.input_digest !== digest) throw new Error('Event workflow operation identity conflict');
    return inspect(context, request.operationId, call);
  }
  const guard = z.object({ eventId: z.string(), revision: z.string(), profileDigest: z.string(), timezone: z.string(), fields: z.record(z.unknown()) }).strict().parse(request.guard);
  const predecessorRevision = Object.values(request.predecessors).some((output) => output && typeof output === 'object'
    && (output as Record<string, unknown>).eventId === eventId && (output as Record<string, unknown>).updatedAt === target.event.updatedAt);
  const conflict = guard.eventId !== eventId || guard.timezone !== target.event.timezone || guard.profileDigest !== workflowDigest(json(target.profile))
    || (!predecessorRevision && Object.entries(guard.fields).some(([field, value]) => canonicalJson(value) !== canonicalJson(currentField(target.event, field))));
  if (conflict) return { status: 'blocked', reason: target.t('official.community-events.workflow.conflict'), retryable: false };
  const prepared = operation === 'edit' ? prepareEdit(target, eventActionEditInputSchema.parse(request.input)) : undefined;
  if (operation === 'edit' && !context.platform.workflowTransport) throw new Error('Event action transport is unavailable');
  const now = new Date().toISOString();
  db.run(`INSERT INTO event_workflow_operations (operation_id, scope_id, actor_identity_id, event_id, action, input_digest, input_json, guard_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`, request.operationId, call.scopeId, call.actorIdentityId!, eventId, operation, digest, canonicalJson(request.input), canonicalJson(request.guard), now, now);
  const runtime = requireOfficialCommandRuntime(target.domain);
  let result: WorkflowActionResult;
  if (operation === 'edit') {
    if (!context.platform.workflowTransport) throw new Error('Event action transport is unavailable');
    const draft: EventUpdateDraft = {
      flowSessionId: request.operationId, flowType: 'workflow', scopeId: call.scopeId, chatId: target.actor.deliveryChatId,
      eventId, eventUpdatedAt: target.event.updatedAt, requestedTitle: target.event.groupTitle, sourcePluginId: call.callerPluginId,
      actorWid: target.actor.canonicalWid, actorIdentityId: target.actor.identityId, actorLabel: target.actor.displayName ?? target.actor.canonicalWid,
      creatorIdentityId: target.event.actorIdentityId, timezone: target.event.timezone, locale: target.locale,
      profile: target.profile, profiles: target.config.eventProfiles, calendars: target.config.calendars, prefill: eventUpdatePrefill(target.event, target.profile), createdAt: now,
      ...(target.event.groupId ? { groupId: target.event.groupId } : {}), ...(target.event.groupWid ? { groupWid: target.event.groupWid } : {})
    };
    result = await applyEventUpdate({ context: target.domain, runtime, activeTransport: context.platform.workflowTransport,
      responseChatId: target.actor.deliveryChatId, draft, eventId, answers: prepared!.answers, eventLocation: prepared!.location,
      pastCompletionConfirmed: eventActionEditInputSchema.parse(request.input).confirmPastCompletion, t: target.t, notify: false });
  } else {
    const input = eventActionCancelInputSchema.parse(request.input);
    const cancelled = await cancelEventLifecycle({ context: target.domain, runtime, db, event: target.event,
      actor: { wid: target.actor.canonicalWid, label: target.actor.displayName ?? target.actor.canonicalWid },
      calendarDisposition: input.calendarDisposition, deleteAnnouncementMessages: input.deleteAnnouncementMessages,
      deleteMessage: context.platform.workflowTransport ? (messageId) => context.platform.workflowTransport!.deleteMessage(messageId) : undefined,
      reason: input.reason });
    result = cancelled.status === 'cancelled' && cancellationSettled(db, eventId, input.deleteAnnouncementMessages)
      ? { status: 'completed', output: { eventId, updatedAt: getEvent(db, eventId)!.updatedAt }, summary: target.t('official.community-events.workflow.cancelled', { event: target.event.groupTitle }) }
      : cancelled.status === 'cancelled'
        ? { status: 'pending', operationId: request.operationId, summary: target.t('official.community-events.workflow.pending') }
        : { status: 'blocked', reason: cancelled.reason, retryable: false };
  }
  saveResult(db, request.operationId, result);
  return result;
}

async function inspect(context: PluginServiceRegistrationContext, operationId: string, call: PluginServiceCallContext): Promise<WorkflowActionResult> {
  const db = eventsDatabase(context.databases);
  const row = db.get<ReceiptRow>('SELECT * FROM event_workflow_operations WHERE operation_id = ? AND scope_id = ? AND actor_identity_id = ?', operationId, call.scopeId, call.actorIdentityId ?? '');
  if (!row) return { status: 'blocked', reason: 'No authorized event operation receipt exists', retryable: false };
  const target = await requireEvent(context, row.event_id, call);
  if (row.result_json) {
    const result = workflowActionResultSchema.parse(JSON.parse(row.result_json));
    if (result.status !== 'pending') return result;
  }
  const repair = getEventEditRepair(db, operationId);
  const replacement = getEventPollReplacement(db, operationId);
  const completed = row.action === 'cancel' ? target.event.eventStatus === 'cancelled'
    && cancellationSettled(db, row.event_id, eventActionCancelInputSchema.parse(JSON.parse(row.input_json)).deleteAnnouncementMessages)
    : (repair?.status === 'completed' || replacement?.status === 'completed');
  if (completed) {
    const result: WorkflowActionResult = { status: 'completed', output: { eventId: target.event.id, updatedAt: target.event.updatedAt }, summary: target.t('official.community-events.workflow.applied', { event: target.event.groupTitle }) };
    saveResult(db, operationId, result);
    return result;
  }
  return { status: 'pending', operationId, summary: target.t('official.community-events.workflow.pending') };
}

function cancellationSettled(db: ReturnType<typeof eventsDatabase>, eventId: string, deleteMessages: boolean): boolean {
  if (deleteMessages && listEventAnnouncementMessages(db, eventId).some((artifact) => artifact.kind !== 'cancellation_notice'
    && artifact.deletionStatus !== 'confirmed')) return false;
  return !db.get(`SELECT operation_id FROM event_poll_replacements WHERE event_id = ?
    AND status IN ('completed', 'aborted') AND new_poll_wa_msg_id IS NOT NULL AND receipt_released_at IS NULL LIMIT 1`, eventId);
}

function saveResult(db: ReturnType<typeof eventsDatabase>, operationId: string, result: WorkflowActionResult) {
  db.run('UPDATE event_workflow_operations SET status = ?, result_json = ?, updated_at = ? WHERE operation_id = ?', result.status, canonicalJson(result), new Date().toISOString(), operationId);
}
function json(value: unknown): Record<string, unknown> { return JSON.parse(JSON.stringify(value)) as Record<string, unknown>; }
function editFields(input: EventActionEditInput): string[] {
  return [...Object.keys(input.patch.answers).map((key) => `answers.${key}`),
    ...(['spanKind', 'endLocalDate', 'endLocalTime', 'location'] as const).filter((key) => input.patch[key] !== undefined)];
}
function currentField(event: StoredEventRecord, field: string): unknown {
  if (field === '*') return event.updatedAt;
  if (field.startsWith('answers.')) return event.answers[field.slice(8)] ?? null;
  if (field === 'location') return event.eventLocation ? json(event.eventLocation) : null;
  if (field === 'endLocalDate' || field === 'endLocalTime') return event.endsAt;
  if (field === 'spanKind') return event.spanKind;
  throw new Error('Unknown guarded event field');
}
function bindingVariants(input: Record<string, unknown>, bindings: WorkflowBinding[]): Record<string, unknown>[] {
  let variants = [input];
  for (const binding of bindings) {
    if (!binding.mapping?.length) throw new Error('Event result bindings need explicit validated value mappings');
    variants = variants.flatMap((variant) => binding.mapping!.map((entry) => bindWorkflowInput({ id: 'preview', actionId: 'preview', version: 1, input: variant,
      dependsOn: [], conditions: [], bindings: [{ ...binding, source: { kind: 'result', path: [] }, mapping: undefined }] }, entry.to, {})));
    if (variants.length > 128) throw new Error('Too many combinations of event result values');
  }
  return variants;
}
