import { randomUUID } from 'node:crypto';
import { PollSelectionRule } from '@prisma/client';
import type { FlowDefinition, FlowState } from '../../../adminBot/flows/flowTypes';
import type { CommandMetadata, CommandTargetSpec } from '../../../adminBot/router/commandMetadata';
import type { CommandContext } from '../../../adminBot/router/commandRouter';
import type { PluginCancellationRegistration, PluginCommandContext } from '../../../platform/pluginRuntime/types';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import { enqueuePluginJob as enqueueRuntimePluginJob } from '../../../platform/jobs/queue';
import {
  isManagedCommunitySubgroupProvisioningError,
  type ManagedCommunitySubgroupProvisioningError
} from '../../../platform/pluginRuntime/runtime/pluginCommunityOperations';
import type {
  OutboundSendResult,
  PrivateDeliveryFallback,
  SendTextOptions
} from '../../../platform/transport/transportTypes';
import { requireIdentityAddress } from '../../../platform/identity/messageActor';
import { requireOfficialCommandRuntime, requireScopeId, type OfficialPluginCommandRuntime } from '../shared';
import { cancelEventLifecycle } from './cancellation';
import {
  eventAnnouncementTransportIdempotencyKey,
  sendClaimedEventAnnouncement
} from './announcementDelivery';
import { repairEventEdit } from './editRepair';
import { calendarResourceForProfile, eventProfilePermission, localizeDefaultEventProfiles, parseEventsConfig, type EventCalendarResource, type EventProfile } from './config';
import { eventProfileQuestionSchemaRevision } from './profileRevision';
import { sendEventCalendarHint } from './calendarHint';
import { formatEventDateTime } from './datetime';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import {
  createEventFlowDefinition,
  eventConfirmPurpose,
  eventFlowAnswers,
  eventFlowConfirmed,
  eventFlowPastCompletionConfirmed,
  eventInitialFlowData,
  eventFlowSelectedProfileId,
  renderEventTemplate,
  selectedOptionLabels,
  type EventFlowAnswers,
  type EventFlowPrefill
} from './flow';
import {
  EventCreationFlowStarter,
  eventDraftKey,
  type EventDraft
} from './eventCreationFlowStarter';
import { appendScopeEventJsonLog } from './log';
import {
  eventGroupHintEnabled,
  eventGroupJoinUrl,
  renderEventEditAnnouncement,
  renderEventGroupAnnouncement
} from './announcements';
import { materializeEventLifecycle, type MaterializedEventLifecycle } from './materialize';
import { eventLocationQuery, fixedEventLocation, geocodedEventLocation } from './eventLocation';
import { EVENTS_JOBS, EVENTS_PERMISSIONS, EVENTS_PLUGIN_ID } from './manifest';
import { createEventCommunitySubgroup } from './subgroups';
import {
  attemptUnplannedEventFinalization,
  eventProvisioningRecoveryDedupeKey,
  eventProvisioningRecoveryRunAt
} from './provisioningRecovery';
import { eventWeatherForecastJobRequest } from './weather';
import {
  GEOCODER_GEOCODE_METHOD,
  GEOCODER_SERVICE_ID,
  type GeocodeOutput,
  type GeocoderPlace
} from '../geocoder/serviceApi';
import {
  DOAS_POLL_PUBLISH_METHOD,
  DOAS_POLL_SERVICE_ID,
  type DoasPollPublishOutput
} from '../doas/serviceApi';
import {
  appendEventLog,
  checkpointUnplannedEventProvisioningFailure,
  completeUnplannedEventProvisioning,
  eventsDatabase,
  getEvent,
  listEventsBySubgroupChatId,
  insertEvent,
  listCancellableEvents,
  listCalendarEvents,
  listScopeEvents,
  newEventId,
  recordEventAnnouncementMessage,
  updateEventStructuredData,
  type EventAnnouncementDeliveryIntent,
  type StoredEventLocation,
  type NewStoredEventRecord,
  type StoredEventRecord,
} from './store';

const CHAT_TARGET: CommandTargetSpec = {
  kind: 'group',
  name: 'chat',
  flag: 'chat',
  position: 0
};

const CHAT_FLAG_TARGET: CommandTargetSpec = {
  kind: 'group',
  name: 'chat',
  flag: 'chat'
};

const SCOPE_TARGET: CommandTargetSpec = {
  kind: 'scope',
  flag: ['scope', 'scope-id'],
  fallback: 'current_scope'
};

interface EventCancelDraft {
  flowSessionId: string;
  flowType: string;
  scopeId: string;
  chatId: string;
  actorWid: string;
  actorIdentityId: string;
  actorLabel: string;
  candidateEventIds: string[];
  creatorIdentityIds: Record<string, string>;
  createdAt: string;
}

interface EventUpdateDraft {
  flowSessionId: string;
  flowType: string;
  scopeId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
  chatId: string;
  eventId: string;
  eventUpdatedAt: string;
  requestedTitle: string;
  sourcePluginId: string;
  actorWid: string;
  actorIdentityId: string;
  creatorIdentityId?: string | undefined;
  actorLabel: string;
  privateDeliveryFallback?: PrivateDeliveryFallback | undefined;
  timezone: string;
  locale: string;
  profile: EventProfile;
  profiles: EventProfile[];
  calendars: EventCalendarResource[];
  prefill: EventFlowPrefill;
  createdAt: string;
}

interface EventAuthorizationPrincipal {
  identityId: string;
  canonicalWid: string;
}

interface EventAuthorizationActor extends EventAuthorizationPrincipal {
  deliveryChatId: string;
  mentionWid: string;
}

interface EventTextTransport {
  sendText(
    chatId: string,
    text: string,
    options?: SendTextOptions | undefined
  ): Promise<OutboundSendResult>;
  setGroupSubject(chatId: string, subject: string): Promise<void>;
}

export type EventFlowCompletionContext = PluginCommandContext | PluginRuntimeContext;

type PendingEventFlowAnswers = Omit<EventFlowAnswers, 'startsAt'> & {
  startsAt: string;
};

interface PendingCreateEventLocationSelection {
  kind: 'create';
  id: string;
  responseChatId: string;
  draft: EventDraft;
  profile: EventProfile;
  answers: PendingEventFlowAnswers;
  announcementGroupWid: string;
  displayPlace: string;
  searchQuery: string;
  provider: string;
  candidates: GeocoderPlace[];
}

interface PendingUpdateEventLocationSelection {
  kind: 'update';
  id: string;
  responseChatId: string;
  draft: EventUpdateDraft;
  answers: PendingEventFlowAnswers;
  eventId: string;
  pastCompletionConfirmed: boolean;
  displayPlace: string;
  searchQuery: string;
  provider: string;
  candidates: GeocoderPlace[];
}

type PendingEventLocationSelection =
  | PendingCreateEventLocationSelection
  | PendingUpdateEventLocationSelection;

const EVENT_CANCEL_SELECT_STEP_ID = 'event';
const EVENT_CANCEL_CONFIRM_STEP_ID = 'confirm';
const EVENT_LOCATION_SELECTION_PURPOSE = 'official.community-events.location.select';
const EVENT_LOCATION_SELECTION_CANCELLATION_WORKFLOW_ID = 'event-location-selection';
const EVENT_LOCATION_FREE_TEXT_OPTION_ID = 'location-query';
const EVENT_LOCATION_MAX_CANDIDATES = 5;
const EVENT_LOCATION_SELECTION_TTL_SECONDS = 30 * 60;
const EVENT_UPDATE_CONFLICT_ERROR = 'event_update_conflict';

export function registerEventsCommands(context: PluginCommandContext): void {
  const runtime = requireOfficialCommandRuntime(context);
  const router = context.router;
  registerEventLocationSelectionHandler(context);

  router.register('event', 'status', eventCommand({
    mutation: 'none',
    auditAction: 'events.status',
    permission: EVENTS_PERMISSIONS.configure,
    usage: '/event status',
    topicId: 'inspect-events',
    descriptionKey: 'official.community-events.help.status',
    exampleKey: 'official.community-events.help.status.example'
  }), async (ctx) => {
    const config = parseEventsConfig(await runtime.configFor(requireScopeId(ctx), eventAuthorizationActor(ctx)?.identityId));
    return {
      handled: true,
      text: ctx.t('official.community-events.status', {
        enabled: String(config.enabled),
        profiles: config.eventProfiles.map((profile) => profile.id).join(',') || ctx.t('official.community-events.none'),
        timezone: config.timezone
      })
    };
  });

  router.register('event', 'cancel', eventCommand({
    auditAction: 'events.cancel',
    usage: '/event cancel [eventId|event title]',
    topicId: 'cancel-events',
    descriptionKey: 'official.community-events.help.cancel',
    exampleKey: 'official.community-events.help.cancel.example',
    requiresCurrentManagedGroupMembership: false,
    privateManagedTargetArgPosition: false,
    assistant: {
      intentTags: ['event', 'cancel'],
      argumentHints: ['<eventId>', '<event title>'],
      examples: ['/event cancel evt-1234abcd', '/event cancel Bouldering in Sintra'],
      executable: true,
      requiresConfirmation: true
    }
  }), async (ctx) => startEventCancelFlow(context, ctx));

  router.register('event', 'new', eventCommand({
    auditAction: 'events.create',
    usage: '/event new [--chat groupName]',
    topicId: 'create-events',
    descriptionKey: 'official.community-events.help.command',
    exampleKey: 'official.community-events.help.create.example'
  }), async (ctx) => startEventFlow(context, ctx));

  router.register('event', 'edit', eventCommand({
    auditAction: 'events.edit',
    usage: '/event edit [eventId|event title]',
    topicId: 'edit-events',
    descriptionKey: 'official.community-events.help.edit',
    exampleKey: 'official.community-events.help.edit.example',
    requiresCurrentManagedGroupMembership: false,
    privateManagedTargetArgPosition: false,
    assistant: {
      intentTags: ['event', 'edit'],
      argumentHints: ['<eventId>', '<event title>'],
      examples: ['/event edit evt-1234abcd', '/event edit Bouldering in Sintra'],
      executable: true,
      requiresConfirmation: true
    }
  }), async (ctx) => startEventEditFlow(context, ctx));

  router.register('event', 'list', eventCommand({
    mutation: 'none',
    auditAction: 'events.list',
    usage: '/event list',
    topicId: 'list-events',
    descriptionKey: 'official.community-events.help.list',
    exampleKey: 'official.community-events.help.list.example',
    requiresCurrentManagedGroupMembership: false,
    privateManagedTargetArgPosition: false,
    assistant: {
      intentTags: ['event', 'list'],
      examples: ['/event list'],
      executable: true,
      requiresConfirmation: false
    }
  }), async (ctx) => listFutureEvents(context, ctx));

  router.register('event', '*', eventCommand({
    mutation: 'none',
    auditAction: 'events.usage',
    usage: '/event',
    topicId: 'overview-events',
    descriptionKey: 'official.community-events.help.command',
    exampleKey: 'official.community-events.help.overview.example',
    requiresManagedGroup: false,
    targeting: false,
    assistant: {
      intentTags: ['event', 'help'],
      examples: ['/event'],
      executable: true,
      requiresConfirmation: false
    }
  }), async (ctx) => ({ handled: true, text: ctx.t('official.community-events.usage') }));
}

export function registerEventsCancellations(context: PluginCommandContext): PluginCancellationRegistration[] {
  const runtime = requireOfficialCommandRuntime(context);
  return [{
    workflowId: EVENT_LOCATION_SELECTION_CANCELLATION_WORKFLOW_ID,
    cancel: async (input) => {
      const actorIdentityId = input.actorIdentityId.trim();
      if (!actorIdentityId) {
        return undefined;
      }
      const result = await cancelActiveEventLocationSelectionsForActor(context, runtime, {
        actorIdentityId
      });
      if (result.cancelled === 0) {
        return undefined;
      }
      const t = await context.i18n.translatorForIdentity(actorIdentityId, result.scopeId);
      return {
        workflowId: EVENT_LOCATION_SELECTION_CANCELLATION_WORKFLOW_ID,
        cancelled: true,
        text: t('official.community-events.cancelled')
      };
    }
  }];
}

async function startEventFlow(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const actor = eventAuthorizationActor(ctx);
  if (!actor) {
    return { handled: true, text: ctx.t('official.community-events.permissionDenied') };
  }
  await cancelActiveEventLocationSelectionsForActor(context, runtime, {
    actorIdentityId: actor.identityId
  });
  const scopeId = requireScopeId(ctx);
  const privateDeliveryFallback = privateFlowDeliveryFallback(ctx, actor);
  const starter = new EventCreationFlowStarter({
    flowEngine: context.flowEngine,
    dataStore: runtime.dataStore,
    i18n: context.i18n,
    configFor: runtime.configFor,
    ...(context.enabledFor ? { enabledFor: context.enabledFor } : {}),
    ...(context.resolveStableIdentityById
      ? { resolveStableIdentityById: context.resolveStableIdentityById }
      : {}),
    ...(context.communityAnnouncementGroupWidForScope
      ? { communityAnnouncementGroupWidForScope: context.communityAnnouncementGroupWidForScope }
      : {}),
    ...(context.explainPermission ? { explainPermission: context.explainPermission } : {})
  }, (flowType, profiles, t) => {
    registerEventFlowCompletionHandlers(context, flowType, profiles, t);
  });
  let started: Awaited<ReturnType<EventCreationFlowStarter['startCommand']>>;
  try {
    started = await starter.startCommand({
      actor: requireIdentityAddress(requireEventActor(ctx)),
      actorLabel: ctx.message.senderDisplayName ?? ctx.message.senderWid,
      externalIdempotencyKey: eventCreationCommandIdempotencyKey(scopeId, actor.identityId, ctx.message.id),
      origin: {
        chatId: ctx.message.chatId,
        context: ctx.message.context
      },
      scopeId,
      ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
      ...(ctx.groupWid ? { groupWid: ctx.groupWid } : {}),
      locale: ctx.locale,
      t: ctx.t,
      prefillArgs: ctx.remainingArgs ?? ctx.command.args,
      ...(privateDeliveryFallback ? { privateDeliveryFallback } : {})
    });
  } catch {
    return {
      handled: true,
      text: ctx.message.context === 'group'
        ? ctx.t('official.community-events.privateStartFailed')
        : ctx.t('official.community-events.startFailed')
    };
  }
  if (started.kind === 'unavailable') {
    return {
      handled: true,
      text: ctx.t(started.reason === 'disabled'
        ? 'official.community-events.disabled'
        : 'official.community-events.notConfigured')
    };
  }
  if (ctx.message.context !== 'group') {
    return { handled: true, response: { kind: 'none' as const } };
  }
  return {
    handled: true,
    text: ctx.t(started.usedPrivateDeliveryFallback
      ? 'official.community-events.startedInGroupFallback'
      : 'official.community-events.startedPrivate')
  };
}

async function startEventEditFlow(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const actor = eventAuthorizationActor(ctx);
  if (!actor) {
    return { handled: true, text: ctx.t('official.community-events.update.permissionDenied') };
  }
  await cancelActiveEventLocationSelectionsForActor(context, runtime, {
    actorIdentityId: actor.identityId
  });
  const scopeId = requireScopeId(ctx);
  const config = parseEventsConfig(await runtime.configFor(scopeId, actor.identityId));
  if (!config.enabled) {
    return { handled: true, text: ctx.t('official.community-events.disabled') };
  }

  const db = eventsDatabase(runtime.databases);
  const query = ctx.command.args.join(' ').trim();
  const subgroupChatId = ctx.groupWid ?? (ctx.message.context === 'group' ? ctx.message.chatId : undefined);
  const subgroupMatches = !query && subgroupChatId
    ? listEventsBySubgroupChatId(db, scopeId, subgroupChatId).filter(eventIsEditable)
    : [];
  const allEditable = listScopeEvents(db, scopeId)
    .filter(eventIsEditable);
  const matches = subgroupMatches.length > 0
    ? subgroupMatches
    : query
      ? findEventMatches(allEditable, query, ctx.locale)
      : [];

  if (matches.length === 0) {
    return { handled: true, text: ctx.t('official.community-events.edit.noEvents') };
  }
  if (matches.length > 1) {
    return { handled: true, text: ctx.t('official.community-events.edit.ambiguous') };
  }

  const event = matches[0]!;
  const creatorIdentityId = event.actorIdentityId;
  if (!await eventUpdateAllowed(context, { event, actor, creatorIdentityId })) {
    return { handled: true, text: ctx.t('official.community-events.update.permissionDenied') };
  }
  if (event.eventStatus === 'active' && event.groupLifecycleStatus === 'poll_open') {
    return {
      handled: true,
      text: ctx.t('official.community-events.edit.pollOpen', {
        title: eventDisplayTitle(event),
        eventId: event.id
      })
    };
  }

  return startEventUpdateFlow(context, ctx, {
    event,
    config,
    requestedTitle: eventDisplayTitle(event),
    sourcePluginId: EVENTS_PLUGIN_ID,
    actor,
    creatorIdentityId
  });
}

async function listFutureEvents(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const config = parseEventsConfig(await runtime.configFor(scopeId, eventAuthorizationActor(ctx)?.identityId));
  if (!config.enabled) {
    return { handled: true, text: ctx.t('official.community-events.disabled') };
  }
  const now = Date.now();
  const events = listScopeEvents(eventsDatabase(runtime.databases), scopeId)
    .filter((event) => event.eventStatus === 'active' && new Date(event.startsAt).getTime() >= now)
    .sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime() || left.id.localeCompare(right.id));
  if (events.length === 0) {
    return { handled: true, text: ctx.t('official.community-events.list.none') };
  }
  const items = events.map((event) => ctx.t('official.community-events.list.item', {
    title: eventDisplayTitle(event),
    startsAt: eventStartsAtLabel(event, ctx.locale),
    status: eventLifecycleLabel(event, ctx.t),
    eventId: event.id
  }));
  return {
    handled: true,
    text: ctx.t('official.community-events.list.result', {
      count: String(items.length),
      events: items.join('\n')
    })
  };
}

async function startEventCancelFlow(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const actor = eventAuthorizationActor(ctx);
  if (!actor) {
    return { handled: true, text: ctx.t('official.community-events.cancel.permissionDenied') };
  }
  await cancelActiveEventLocationSelectionsForActor(context, runtime, {
    actorIdentityId: actor.identityId
  });
  const scopeId = requireScopeId(ctx);
  const db = eventsDatabase(runtime.databases);
  const actorWid = actor.deliveryChatId;
  const privateDeliveryFallback = privateFlowDeliveryFallback(ctx, actor);
  const actorLabel = ctx.message.senderDisplayName ?? actorWid;
  const query = ctx.command.args.join(' ').trim();
  const resolution = await resolveEventCancelCandidates(context, {
    db,
    scopeId,
    chatId: ctx.message.chatId,
    query,
    locale: ctx.locale,
    actor
  });

  if (resolution.status === 'none') {
    return { handled: true, text: ctx.t('official.community-events.cancel.noEvents') };
  }
  if (resolution.status === 'permission_denied') {
    return { handled: true, text: ctx.t('official.community-events.cancel.permissionDenied') };
  }

  const preselectedEventId = resolution.candidates.length === 1 ? resolution.candidates[0]?.id : undefined;
  const definition = createEventCancelFlowDefinition({
    t: ctx.t,
    locale: ctx.locale,
    candidates: resolution.candidates,
    preselectedEventId
  });
  registerEventCancelFlowCompletionHandler(context, definition.flowType, ctx.t);

  let flowSessionId: string;
  try {
    const flowStart = await context.flowEngine.startFlow({
      definition,
      message: ctx.message,
      scopeId,
      ...(preselectedEventId ? { initialData: { [EVENT_CANCEL_SELECT_STEP_ID]: preselectedEventId } } : {}),
      ...(privateDeliveryFallback ? { privateDeliveryFallback } : {})
    });
    flowSessionId = flowStart.flowSessionId;
  } catch {
    return { handled: true, text: ctx.t('official.community-events.cancel.startFailed') };
  }

  await runtime.dataStore.set(eventCancelDraftKey(scopeId, flowSessionId), {
    flowSessionId,
    flowType: definition.flowType,
    scopeId,
    chatId: ctx.message.chatId,
    actorWid: actor.canonicalWid,
    actorIdentityId: actor.identityId,
    actorLabel,
    candidateEventIds: resolution.candidates.map((event) => event.id),
    creatorIdentityIds: resolution.creatorIdentityIds,
    createdAt: new Date().toISOString()
  } satisfies EventCancelDraft);
  return { handled: true, text: ctx.t('official.community-events.cancel.started') };
}

async function startEventUpdateFlow(
  context: PluginCommandContext,
  ctx: CommandContext,
  input: {
    event: StoredEventRecord;
    config: ReturnType<typeof parseEventsConfig>;
    requestedTitle: string;
    sourcePluginId: string;
    actor: EventAuthorizationActor;
    creatorIdentityId?: string | undefined;
  }
) {
  const runtime = requireOfficialCommandRuntime(context);
  const eventProfiles = localizeDefaultEventProfiles(input.config.eventProfiles, ctx.t);
  const profile = eventProfiles.find((candidate) => candidate.id === input.event.profileId);
  if (!profile) {
    return { handled: true, text: ctx.t('official.community-events.notConfigured') };
  }

  const timezone = input.event.timezone || input.config.timezone;
  const prefill = eventUpdatePrefill(input.event, profile);
  const startedAt = new Date();
  const initialData = eventInitialFlowData([profile], prefill, {
    timezone,
    locale: ctx.locale,
    now: startedAt,
    allowPast: true
  });
  const definition = createEventFlowDefinition({
    t: ctx.t,
    profiles: [profile],
    prefill,
    timezone,
    locale: ctx.locale,
    initialData,
    askPrefilledQuestions: true,
    flowTypePrefix: 'official.community-events.update',
    confirmMessageKey: 'official.community-events.update.confirm',
    pastCompletionConfirmMessageKey: input.event.eventStatus === 'active'
      ? 'official.community-events.update.confirmPastCompletion'
      : 'official.community-events.update.confirm',
    allowPastStartsAt: true,
    now: () => startedAt,
    completeMessageKey: false
  });
  registerEventUpdateFlowCompletionHandler(context, definition.flowType, profile, ctx.t);

  const privateActorWid = input.actor.deliveryChatId;
  const privateDeliveryFallback = privateFlowDeliveryFallback(ctx, input.actor);
  const conversationChatId = ctx.message.context === 'group'
    ? privateActorWid
    : ctx.message.chatId;
  const flowMessage = ctx.message.context === 'group' && privateActorWid !== ctx.message.senderWid
    ? {
        ...ctx.message,
        senderWid: privateActorWid,
        authorWid: privateActorWid
      }
    : ctx.message;

  let flowSessionId: string;
  let usedPrivateDeliveryFallback = false;
  try {
    const flowStart = await context.flowEngine.startFlow({
      definition,
      message: flowMessage,
      scopeId: input.event.scopeId,
      conversationChatId,
      conversationContext: 'private',
      initialData,
      ...(privateDeliveryFallback ? { privateDeliveryFallback } : {})
    });
    flowSessionId = flowStart.flowSessionId;
    usedPrivateDeliveryFallback = Boolean(flowStart.privateDeliveryFallback);
  } catch {
    return {
      handled: true,
      text: ctx.message.context === 'group'
        ? ctx.t('official.community-events.update.privateStartFailed')
        : ctx.t('official.community-events.update.startFailed')
    };
  }

  await runtime.dataStore.set(eventUpdateDraftKey(input.event.scopeId, flowSessionId), {
    flowSessionId,
    flowType: definition.flowType,
    scopeId: input.event.scopeId,
    ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
    ...(input.event.groupWid ? { groupWid: input.event.groupWid } : {}),
    chatId: conversationChatId,
    eventId: input.event.id,
    eventUpdatedAt: input.event.updatedAt,
    requestedTitle: input.requestedTitle,
    sourcePluginId: input.sourcePluginId,
    actorWid: input.actor.canonicalWid,
    actorIdentityId: input.actor.identityId,
    ...(input.creatorIdentityId ? { creatorIdentityId: input.creatorIdentityId } : {}),
    actorLabel: ctx.message.senderDisplayName ?? ctx.message.senderWid,
    ...(privateDeliveryFallback ? { privateDeliveryFallback } : {}),
    timezone,
    locale: ctx.locale,
    profile,
    profiles: eventProfiles,
    calendars: input.config.calendars,
    prefill,
    createdAt: new Date().toISOString()
  } satisfies EventUpdateDraft);

  if (ctx.message.context !== 'group') {
    return { handled: true, response: { kind: 'none' as const } };
  }
  return {
    handled: true,
    text: ctx.t(usedPrivateDeliveryFallback
      ? 'official.community-events.update.startedInGroupFallback'
      : 'official.community-events.update.startedPrivate')
  };
}

function registerEventUpdateFlowCompletionHandler(
  context: PluginCommandContext,
  flowType: string,
  profile: EventProfile,
  t: CommandContext['t']
): void {
  const runtime = requireOfficialCommandRuntime(context);
  context.flowEngine.registerPromptHandler(eventConfirmPurpose(flowType, profile), async (lock, activeTransport) => {
    if (!lock.flowSessionId) {
      return false;
    }
    const snapshot = await context.flowEngine.getSessionSnapshot(lock.flowSessionId);
    if (!snapshot || snapshot.flowType !== flowType || !snapshot.scopeId) {
      return false;
    }
    const draft = await runtime.dataStore.get<EventUpdateDraft>(eventUpdateDraftKey(snapshot.scopeId, lock.flowSessionId));
    if (!draft) {
      return false;
    }
    const responseChatId = snapshot.chatId || draft.chatId;
    await runtime.dataStore.delete(eventUpdateDraftKey(snapshot.scopeId, lock.flowSessionId));

    if (!eventFlowConfirmed(snapshot, draft.profile)) {
      await activeTransport.sendText(responseChatId, t('official.community-events.update.cancelled'));
      return true;
    }

    const db = eventsDatabase(runtime.databases);
    const event = getEvent(db, draft.eventId);
    if (!event || !eventIsEditable(event) || event.updatedAt !== draft.eventUpdatedAt) {
      await activeTransport.sendText(responseChatId, t('official.community-events.update.invalid'));
      return true;
    }
    if (!await eventUpdateAllowed(context, {
      event,
      actor: { identityId: draft.actorIdentityId, canonicalWid: draft.actorWid },
      creatorIdentityId: draft.creatorIdentityId
    })) {
      await activeTransport.sendText(responseChatId, t('official.community-events.update.permissionDenied'));
      return true;
    }

    const answers = eventFlowAnswers(snapshot, draft.profile, draft.timezone, draft.locale);
    if (!answers) {
      await activeTransport.sendText(responseChatId, t('official.community-events.update.invalid'));
      return true;
    }
    const startsInPast = answers.startsAt.getTime() <= Date.now();
    const pastCompletionConfirmed = eventFlowPastCompletionConfirmed(snapshot, draft.profile);
    if (event.eventStatus === 'active' && startsInPast && !pastCompletionConfirmed) {
      await activeTransport.sendText(
        responseChatId,
        t('official.community-events.update.pastCompletionConfirmationRequired')
      );
      return true;
    }

    await beginEventUpdateLocationSelection({
      context,
      runtime,
      activeTransport,
      responseChatId,
      draft,
      event,
      answers,
      pastCompletionConfirmed,
      t
    });
    return true;
  });
}

async function beginEventUpdateLocationSelection(input: {
  context: PluginCommandContext;
  runtime: OfficialPluginCommandRuntime;
  activeTransport: EventTextTransport;
  responseChatId: string;
  draft: EventUpdateDraft;
  event: StoredEventRecord;
  answers: EventFlowAnswers;
  pastCompletionConfirmed: boolean;
  t: CommandContext['t'];
}): Promise<void> {
  const fixedLocation = fixedEventLocation(input.draft.profile, input.draft.timezone);
  if (fixedLocation) {
    await completeEventUpdate({ ...input, eventId: input.event.id, eventLocation: fixedLocation });
    return;
  }
  const place = eventLocationQuery(input.draft.profile, input.answers.answers);
  if (!place) {
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.location.missing')
    );
    return;
  }
  if (
    input.event.eventLocation?.source === 'question' &&
    input.event.eventLocation.displayLabel === place
  ) {
    await completeEventUpdate({
      ...input,
      eventId: input.event.id,
      eventLocation: input.event.eventLocation
    });
    return;
  }
  if (!input.context.services) {
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.location.failed')
    );
    return;
  }
  let output: GeocodeOutput;
  try {
    output = await input.context.services.call<GeocodeOutput>({
      serviceId: GEOCODER_SERVICE_ID,
      method: GEOCODER_GEOCODE_METHOD,
      scopeId: input.draft.scopeId,
      actorIdentityId: input.draft.actorIdentityId,
      ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
      ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
      input: {
        query: place,
        language: input.draft.locale,
        limit: 5
      }
    });
  } catch (error) {
    await recordEventLocationFailure(input.context, {
      phase: 'geocode',
      scopeId: input.draft.scopeId,
      eventId: input.event.id,
      actorWid: input.draft.actorWid,
      profileId: input.draft.profile.id,
      query: place,
      error
    });
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.location.failed')
    );
    return;
  }
  const pending: PendingEventLocationSelection = {
    kind: 'update',
    id: randomUUID(),
    responseChatId: input.responseChatId,
    draft: input.draft,
    answers: pendingEventFlowAnswers(input.answers),
    eventId: input.event.id,
    pastCompletionConfirmed: input.pastCompletionConfirmed,
    displayPlace: place,
    searchQuery: place,
    provider: output.provider,
    candidates: output.results
  };
  try {
    await promptEventLocationConfirmation({ ...input, pending });
  } catch (error) {
    await recordEventLocationFailure(input.context, {
      phase: 'prompt_dispatch',
      scopeId: input.draft.scopeId,
      eventId: input.event.id,
      actorWid: input.draft.actorWid,
      profileId: input.draft.profile.id,
      query: place,
      error
    });
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.location.promptFailed')
    );
  }
}

async function completeEventUpdate(input: {
  context: PluginCommandContext;
  runtime: OfficialPluginCommandRuntime;
  activeTransport: EventTextTransport;
  responseChatId: string;
  draft: EventUpdateDraft;
  eventId: string;
  answers: EventFlowAnswers;
  eventLocation: StoredEventLocation;
  pastCompletionConfirmed: boolean;
  t: CommandContext['t'];
}): Promise<void> {
  const db = eventsDatabase(input.runtime.databases);
  const event = getEvent(db, input.eventId);
  if (!event || !eventIsEditable(event) || event.updatedAt !== input.draft.eventUpdatedAt) {
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.update.invalid')
    );
    return;
  }
  if (!await eventUpdateAllowed(input.context, {
    event,
    actor: {
      identityId: input.draft.actorIdentityId,
      canonicalWid: input.draft.actorWid
    },
    creatorIdentityId: input.draft.creatorIdentityId
  })) {
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.update.permissionDenied')
    );
    return;
  }
  if (!await eventProfileSnapshotIsCurrent({
    runtime: input.runtime,
    scopeId: input.draft.scopeId,
    actorIdentityId: input.draft.actorIdentityId,
    snapshot: input.draft.profile,
    t: input.t
  })) {
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.update.invalid')
    );
    return;
  }
  try {
    const materialized = materializeEventLifecycle({
      profile: input.draft.profile,
      answers: input.answers,
      timezone: input.draft.timezone,
      locale: input.draft.locale,
      creatorDisplayName: event.actorLabel || event.actorWid,
      eventLocation: input.eventLocation
    });
    const now = new Date();
    const startsInPast = materialized.startsAt.getTime() <= now.getTime();
    if (event.eventStatus === 'active' && startsInPast && !input.pastCompletionConfirmed) {
      await input.activeTransport.sendText(
        input.responseChatId,
        input.t('official.community-events.update.pastCompletionConfirmationRequired')
      );
      return;
    }
    const config = draftEventsConfig({
      timezone: input.draft.timezone,
      calendars: input.draft.calendars,
      profiles: input.draft.profiles
    });
    const outcome = await updateEventLifecycle({
      context: input.context,
      runtime: input.runtime,
      activeTransport: input.activeTransport,
      db,
      event,
      profile: input.draft.profile,
      config,
      materialized,
      actorWid: input.draft.actorWid,
      actorLabel: input.draft.actorLabel,
      locale: input.draft.locale,
      requestedTitle: input.draft.requestedTitle,
      pastCompletionConfirmed: input.pastCompletionConfirmed,
      now,
      operationId: input.draft.flowSessionId,
      sourcePluginId: input.draft.sourcePluginId
    });
    if (!outcome.changed) {
      await input.activeTransport.sendText(
        input.responseChatId,
        input.t('official.community-events.update.noChanges', {
          title: materialized.groupTitle,
          eventId: event.id
        })
      );
      return;
    }
    const doneMessageKey = outcome.repairPending
      ? outcome.completedNow
        ? 'official.community-events.update.donePastCompletionRepairPending'
        : 'official.community-events.update.doneRepairPending'
      : outcome.completedNow
        ? 'official.community-events.update.donePastCompletion'
        : 'official.community-events.update.done';
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t(doneMessageKey, {
        title: materialized.groupTitle,
        eventId: event.id,
        cleanupAt: formatEventDateTime(outcome.cleanupAt, event.timezone, input.draft.locale)
      })
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await appendEventJsonLog(input.context, {
      action: 'event.update_failed',
      scopeId: input.draft.scopeId,
      eventId: input.draft.eventId,
      actorWid: input.draft.actorWid,
      profileId: input.draft.profile.id,
      metadata: { reason, sourcePluginId: input.draft.sourcePluginId }
    });
    await input.activeTransport.sendText(input.responseChatId, reason === EVENT_UPDATE_CONFLICT_ERROR
      ? input.t('official.community-events.update.invalid')
      : input.t('official.community-events.update.failed'));
  }
}

async function updateEventLifecycle(input: {
  context: PluginCommandContext;
  runtime: OfficialPluginCommandRuntime;
  activeTransport: EventTextTransport;
  db: ReturnType<typeof eventsDatabase>;
  event: StoredEventRecord;
  profile: EventProfile;
  config: ReturnType<typeof parseEventsConfig>;
  materialized: MaterializedEventLifecycle;
  actorWid: string;
  actorLabel: string;
  locale: string;
  requestedTitle: string;
  pastCompletionConfirmed: boolean;
  now: Date;
  operationId: string;
  sourcePluginId?: string | undefined;
}): Promise<{ changed: boolean; completedNow: boolean; repairPending: boolean; cleanupAt: Date }> {
  const previousUpdatedAtMs = new Date(input.event.updatedAt).getTime();
  const updatedAt = new Date(Math.max(
    input.now.getTime(),
    Number.isFinite(previousUpdatedAtMs) ? previousUpdatedAtMs + 1 : input.now.getTime()
  )).toISOString();
  const completionRequested = input.event.eventStatus === 'active' &&
    input.pastCompletionConfirmed &&
    input.materialized.startsAt.getTime() <= input.now.getTime();
  const cleanupAt = input.materialized.cleanupAt;
  const timezone = input.event.timezone || input.config.timezone;
  const changed = completionRequested || eventStructuredDataChanged(input.event, {
    materialized: input.materialized,
    cleanupAt,
    timezone
  });
  if (!changed) {
    return { changed: false, completedNow: false, repairPending: false, cleanupAt };
  }
  const liveSubgroupChatId =
    input.event.subgroupChatId &&
    (input.event.eventStatus === 'active' || input.event.eventStatus === 'completed') &&
    (input.event.groupLifecycleStatus === 'poll_closed' || input.event.groupLifecycleStatus === 'cleanup_failed')
      ? input.event.subgroupChatId
      : undefined;
  if (liveSubgroupChatId) {
    const capabilities = await input.context.botCapabilitiesFor?.(liveSubgroupChatId);
    if (capabilities && (!capabilities.botIsAdmin || !capabilities.canChangeInfo || !capabilities.canSetSubject)) {
      throw new Error('Bot cannot change the event subgroup subject.');
    }
  }
  const calendar = calendarResourceForProfile(input.config, input.profile);
  const announcementGroupWid = input.profile.eventEditAnnouncement.enabled
    ? input.event.announcementGroupWid?.trim()
    : undefined;
  let announcementIntent: EventAnnouncementDeliveryIntent | undefined;
  if (input.profile.eventEditAnnouncement.enabled) {
    if (!announcementGroupWid) {
      throw new Error('Event edit announcement is enabled, but the event announcement group is unavailable.');
    }
    const prospectiveEvent: StoredEventRecord = {
      ...input.event,
      eventStatus: completionRequested ? 'completed' : input.event.eventStatus,
      pollQuestion: input.materialized.pollQuestion,
      pollOptions: input.materialized.pollOptions,
      responseClasses: input.materialized.responseClasses,
      answers: input.materialized.answers,
      eventLocation: input.materialized.eventLocation,
      startsAt: input.materialized.startsAt.toISOString(),
      startsAtUtc: input.materialized.startsAt.toISOString(),
      timezone,
      localDate: input.materialized.localDate,
      localTime: input.materialized.localTime,
      place: input.materialized.place,
      closeAt: input.materialized.closeAt.toISOString(),
      cleanupAt: cleanupAt.toISOString(),
      groupTitle: input.materialized.groupTitle,
      ...(input.event.subgroupChatId ? { subgroupTitle: input.materialized.groupTitle } : {}),
      calendarDurationMinutes: input.materialized.calendarDurationMinutes,
      calendarLocation: input.materialized.calendarLocation,
      calendarDescription: input.materialized.calendarDescription,
      updatedAt
    };
    const text = renderEventEditAnnouncement({
      template: input.profile.eventEditAnnouncement.template,
      profile: input.profile,
      event: prospectiveEvent,
      previousGroupDisplayName: input.event.subgroupTitle || input.event.groupTitle,
      editorDisplayName: input.actorLabel || input.actorWid,
      locale: input.locale
    });
    if (!text.trim()) {
      throw new Error('Event edit announcement rendered empty.');
    }
    announcementIntent = {
      scopeId: input.event.scopeId,
      kind: 'event_edit',
      deliveryKey: input.operationId,
      chatId: announcementGroupWid,
      text,
      idempotencyKey: eventAnnouncementTransportIdempotencyKey({
        eventId: input.event.id,
        kind: 'event_edit',
        deliveryKey: input.operationId
      })
    };
  }
  const updated = updateEventStructuredData(input.db, {
    eventId: input.event.id,
    profileRevision: eventProfileQuestionSchemaRevision(input.profile),
    pollQuestion: input.materialized.pollQuestion,
    pollOptions: input.materialized.pollOptions,
    responseClasses: input.materialized.responseClasses,
    answers: input.materialized.answers,
    ...(input.materialized.eventLocation ? { eventLocation: input.materialized.eventLocation } : {}),
    startsAt: input.materialized.startsAt.toISOString(),
    startsAtUtc: input.materialized.startsAt.toISOString(),
    timezone,
    localDate: input.materialized.localDate,
    ...(input.materialized.localTime ? { localTime: input.materialized.localTime } : {}),
    ...(input.materialized.place ? { place: input.materialized.place } : {}),
    closeAt: input.materialized.closeAt.toISOString(),
    cleanupAt: cleanupAt.toISOString(),
    groupTitle: input.materialized.groupTitle,
    calendarDurationMinutes: input.materialized.calendarDurationMinutes,
    ...(input.materialized.calendarLocation ? { calendarLocation: input.materialized.calendarLocation } : {}),
    ...(input.materialized.calendarDescription ? { calendarDescription: input.materialized.calendarDescription } : {}),
    expectedUpdatedAt: input.event.updatedAt,
    updatedAt,
    ...(completionRequested ? { completeEvent: true } : {}),
    ...(announcementIntent ? { announcementIntent } : {}),
    repairIntent: {
      operationId: input.operationId,
      scopeId: input.event.scopeId,
      ...(liveSubgroupChatId ? { subgroupChatId: liveSubgroupChatId } : {}),
      targetGroupTitle: input.materialized.groupTitle,
      calendarId: input.profile.calendar.calendarId,
      ...(announcementIntent ? { announcementDeliveryKey: announcementIntent.deliveryKey } : {})
    }
  });
  if (!updated) {
    throw new Error(EVENT_UPDATE_CONFLICT_ERROR);
  }

  const repair = await repairEventEdit({
    appConfig: input.runtime.config,
    db: input.db,
    operationId: input.operationId,
    configFor: async () => input.config,
    sender: input.activeTransport,
    now: input.now
  });
  const repairFailures = [...repair.failures];
  if (repair.status === 'pending') {
    try {
      await input.runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.editRepair,
        scopeId: input.event.scopeId,
        ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
        ...(input.event.groupWid ? { groupWid: input.event.groupWid } : {}),
        ...(repair.retryAt ? { runAt: repair.retryAt } : { delayMs: 5_000 }),
        payload: { operationId: input.operationId, attempt: 0 },
        dedupeKey: `${EVENTS_JOBS.editRepair}:${input.operationId}:initial`
      });
    } catch (error) {
      repairFailures.push(`repair_job: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const completedNow = completionRequested;
  if (
    liveSubgroupChatId
  ) {
    const cleanupDue = cleanupAt.getTime() <= input.now.getTime();
    try {
      await input.runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.cleanup,
        scopeId: input.event.scopeId,
        ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
        ...(input.event.groupWid ? { groupWid: input.event.groupWid } : {}),
        ...(!cleanupDue ? { runAt: cleanupAt } : {}),
        payload: { eventId: input.event.id, attempt: 0 },
        dedupeKey: cleanupDue
          ? `${EVENTS_JOBS.cleanup}:${input.event.id}:past-update:${updatedAt}`
          : `${EVENTS_JOBS.cleanup}:${input.event.id}:updated:${cleanupAt.toISOString()}`
      });
    } catch (error) {
      repairFailures.push(`cleanup_job: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (
    input.event.eventStatus === 'active' &&
    !completionRequested &&
    liveSubgroupChatId
  ) {
    const weatherRequest = eventWeatherForecastJobRequest({
      event: {
        ...input.event,
        updatedAt,
        startsAt: input.materialized.startsAt.toISOString(),
        startsAtUtc: input.materialized.startsAt.toISOString(),
        timezone,
        ...(input.materialized.eventLocation ? { eventLocation: input.materialized.eventLocation } : {}),
        localDate: input.materialized.localDate,
        ...(input.materialized.localTime ? { localTime: input.materialized.localTime } : {}),
        closeAt: input.materialized.closeAt.toISOString(),
        cleanupAt: cleanupAt.toISOString(),
        groupTitle: input.materialized.groupTitle,
        ...(input.event.subgroupTitle || input.materialized.groupTitle ? { subgroupTitle: input.materialized.groupTitle } : {})
      },
      profile: input.profile
    });
    if (weatherRequest) {
      try {
        await input.runtime.enqueuePluginJob(weatherRequest);
      } catch (error) {
        repairFailures.push(`weather_job: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  appendEventLog(input.db, {
    eventId: input.event.id,
    action: 'events.updated',
    metadata: {
      actorWid: input.actorWid,
      actorLabel: input.actorLabel,
      sourcePluginId: input.sourcePluginId,
      requestedTitle: input.requestedTitle,
      groupTitle: input.materialized.groupTitle,
      answers: input.materialized.answers,
      startsAt: input.materialized.startsAt.toISOString(),
      localDate: input.materialized.localDate,
      localTime: input.materialized.localTime,
      completionRequested,
      cleanupAt: cleanupAt.toISOString(),
      calendarId: input.profile.calendar.calendarId,
      repairFailures
    }
  });
  await appendEventJsonLog(input.context, {
    action: 'event.updated',
    scopeId: input.event.scopeId,
    eventId: input.event.id,
    actorWid: input.actorWid,
    profileId: input.profile.id,
    ...(input.event.pollWaMsgId ? { pollWaMsgId: input.event.pollWaMsgId } : {}),
    ...(input.event.subgroupChatId ? { subgroupChatId: input.event.subgroupChatId } : {}),
    metadata: {
      calendarEnabled: calendar?.enabled === true,
      calendarId: input.profile.calendar.calendarId,
      sourcePluginId: input.sourcePluginId,
      requestedTitle: input.requestedTitle,
      groupTitle: input.materialized.groupTitle,
      startsAt: input.materialized.startsAt.toISOString(),
      localDate: input.materialized.localDate,
      localTime: input.materialized.localTime,
      completionRequested,
      cleanupAt: cleanupAt.toISOString(),
      repairFailures
    }
  });
  return { changed: true, completedNow, repairPending: repairFailures.length > 0, cleanupAt };
}

function eventStructuredDataChanged(
  event: StoredEventRecord,
  input: {
    materialized: MaterializedEventLifecycle;
    cleanupAt: Date;
    timezone: string;
  }
): boolean {
  const materialized = input.materialized;
  return event.pollQuestion !== materialized.pollQuestion ||
    stableJson(event.pollOptions) !== stableJson(materialized.pollOptions) ||
    stableJson(event.responseClasses) !== stableJson(materialized.responseClasses) ||
    stableJson(event.answers) !== stableJson(materialized.answers) ||
    stableJson(event.eventLocation) !== stableJson(materialized.eventLocation) ||
    new Date(event.startsAt).toISOString() !== materialized.startsAt.toISOString() ||
    new Date(event.startsAtUtc ?? event.startsAt).toISOString() !== materialized.startsAt.toISOString() ||
    event.timezone !== input.timezone ||
    event.localDate !== materialized.localDate ||
    normalizedOptional(event.localTime) !== normalizedOptional(materialized.localTime) ||
    normalizedOptional(event.place) !== normalizedOptional(materialized.place) ||
    new Date(event.closeAt).toISOString() !== materialized.closeAt.toISOString() ||
    new Date(event.cleanupAt).toISOString() !== input.cleanupAt.toISOString() ||
    event.groupTitle !== materialized.groupTitle ||
    (event.subgroupChatId !== undefined && event.subgroupTitle !== materialized.groupTitle) ||
    event.calendarDurationMinutes !== materialized.calendarDurationMinutes ||
    normalizedOptional(event.calendarLocation) !== normalizedOptional(materialized.calendarLocation) ||
    normalizedOptional(event.calendarDescription) !== normalizedOptional(materialized.calendarDescription);
}

function eventIsEditable(event: StoredEventRecord): boolean {
  return event.eventStatus === 'active' || event.eventStatus === 'completed';
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function normalizedOptional(value: string | undefined): string {
  return value?.trim() ?? '';
}

async function eventUpdateAllowed(
  context: PluginCommandContext,
  input: {
    event: StoredEventRecord;
    actor: EventAuthorizationPrincipal;
    creatorIdentityId?: string | undefined;
  }
): Promise<boolean> {
  if (input.creatorIdentityId && input.actor.identityId === input.creatorIdentityId) {
    return true;
  }
  if (!context.explainPermission) {
    return false;
  }
  const decision = await context.explainPermission({
    actorIdentityId: input.actor.identityId,
    action: EVENTS_PERMISSIONS.manage,
    scopeId: input.event.scopeId,
    pluginId: EVENTS_PLUGIN_ID,
    ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
    ...(input.event.groupWid ? { groupWid: input.event.groupWid } : {}),
    requiresCurrentManagedGroupMembership: false
  });
  return decision.allowed;
}

function eventUpdatePrefill(event: StoredEventRecord, profile: EventProfile): EventFlowPrefill {
  const answers = { ...event.answers };
  if (event.localDate) {
    answers[profile.startsAtDateQuestionKey] = event.localDate;
  }
  if (event.localTime) {
    answers[profile.startsAtTimeQuestionKey] = event.localTime;
  }
  return {
    profileId: profile.id,
    answers
  };
}

function registerEventCancelFlowCompletionHandler(
  context: PluginCommandContext,
  flowType: string,
  t: CommandContext['t']
): void {
  const runtime = requireOfficialCommandRuntime(context);
  context.flowEngine.registerPromptHandler(eventCancelConfirmPurpose(flowType), async (lock, activeTransport) => {
    if (!lock.flowSessionId) {
      return false;
    }
    const snapshot = await context.flowEngine.getSessionSnapshot(lock.flowSessionId);
    if (!snapshot || snapshot.flowType !== flowType || !snapshot.scopeId) {
      return false;
    }
    const draft = await runtime.dataStore.get<EventCancelDraft>(eventCancelDraftKey(snapshot.scopeId, lock.flowSessionId));
    if (!draft) {
      return false;
    }
    const responseChatId = snapshot.chatId || draft.chatId;
    await runtime.dataStore.delete(eventCancelDraftKey(snapshot.scopeId, lock.flowSessionId));

    if (!eventCancelFlowConfirmed(snapshot)) {
      await activeTransport.sendText(responseChatId, t('official.community-events.cancel.cancelled'));
      return true;
    }

    const eventId = eventCancelFlowSelectedEventId(snapshot);
    if (!eventId || !draft.candidateEventIds.includes(eventId)) {
      await activeTransport.sendText(responseChatId, t('official.community-events.cancel.invalid'));
      return true;
    }

    const db = eventsDatabase(runtime.databases);
    const event = getEvent(db, eventId);
    if (!event) {
      await activeTransport.sendText(responseChatId, t('official.community-events.cancel.invalid'));
      return true;
    }
    if (!await eventCancellationAllowed(context, {
      event,
      actor: { identityId: draft.actorIdentityId, canonicalWid: draft.actorWid },
      creatorIdentityId: draft.creatorIdentityIds[event.id]
    })) {
      await activeTransport.sendText(responseChatId, t('official.community-events.cancel.permissionDenied'));
      return true;
    }

    const result = await cancelEventLifecycle({
      context,
      runtime,
      db,
      event,
      actor: {
        wid: draft.actorWid,
        label: draft.actorLabel
      }
    });
    if (result.status === 'cancelled') {
      await activeTransport.sendText(responseChatId, t('official.community-events.cancel.done', {
        title: eventDisplayTitle(event),
        eventId: event.id
      }));
      return true;
    }
    if (result.status === 'not_cancellable') {
      await activeTransport.sendText(responseChatId, t('official.community-events.cancel.notCancellable', {
        title: eventDisplayTitle(event),
        status: eventLifecycleLabel(event, t)
      }));
      return true;
    }
    await activeTransport.sendText(responseChatId, t('official.community-events.cancel.failed', {
      title: eventDisplayTitle(event),
      reason: result.reason
    }));
    return true;
  });
}

function createEventCancelFlowDefinition(input: {
  t: CommandContext['t'];
  locale: string;
  candidates: StoredEventRecord[];
  preselectedEventId?: string | undefined;
}): FlowDefinition {
  const steps: FlowDefinition['steps'] = {};
  if (!input.preselectedEventId) {
    steps[EVENT_CANCEL_SELECT_STEP_ID] = {
      id: EVENT_CANCEL_SELECT_STEP_ID,
      kind: 'choice',
      prompt: input.t('official.community-events.cancel.select'),
      options: input.candidates.map((event) => ({
        label: eventChoiceLabel(event, input.t, input.locale),
        value: event.id
      })),
      minSelections: 1,
      maxSelections: 1,
      nextStepId: EVENT_CANCEL_CONFIRM_STEP_ID
    };
  }
  steps[EVENT_CANCEL_CONFIRM_STEP_ID] = {
    id: EVENT_CANCEL_CONFIRM_STEP_ID,
    kind: 'choice',
    prompt: input.t('official.community-events.cancel.confirm', { summary: '' }),
    promptForState: (state) => input.t('official.community-events.cancel.confirm', {
      summary: eventCancelConfirmationSummary({
        state,
        candidates: input.candidates,
        preselectedEventId: input.preselectedEventId,
        locale: input.locale,
        t: input.t
      })
    }),
    options: [
      { label: input.t('official.community-events.flow.yes'), value: 'yes' },
      { label: input.t('official.community-events.flow.no'), value: 'no' }
    ],
    minSelections: 1,
    maxSelections: 1
  };
  return {
    flowType: `official.community-events.cancel.${randomUUID()}`,
    t: input.t,
    initialStepId: input.preselectedEventId ? EVENT_CANCEL_CONFIRM_STEP_ID : EVENT_CANCEL_SELECT_STEP_ID,
    context: 'either',
    timeoutMinutes: 10,
    completionReply: input.t('official.community-events.cancel.complete'),
    steps
  };
}

async function resolveEventCancelCandidates(
  context: PluginCommandContext,
  input: {
    db: ReturnType<typeof eventsDatabase>;
    scopeId: string;
    chatId: string;
    query: string;
    locale: string;
    actor: EventAuthorizationPrincipal;
  }
): Promise<
  | {
      status: 'candidates';
      candidates: StoredEventRecord[];
      creatorIdentityIds: Record<string, string>;
    }
  | { status: 'none' }
  | { status: 'permission_denied' }
> {
  const allCandidates = listCancellableEvents(input.db, input.scopeId);
  const subgroupCandidates = input.query
    ? []
    : listEventsBySubgroupChatId(input.db, input.scopeId, input.chatId)
      .filter((candidate) => candidate.eventStatus === 'active');
  const matched = subgroupCandidates.length > 0
    ? subgroupCandidates
    : input.query
      ? findEventMatches(allCandidates, input.query, input.locale)
      : allCandidates;
  if (matched.length === 0) {
    return { status: 'none' };
  }

  const authorized: StoredEventRecord[] = [];
  const creatorIdentityIds: Record<string, string> = {};
  for (const event of matched) {
    const creatorIdentityId = event.actorIdentityId;
    if (await eventCancellationAllowed(context, {
      event,
      actor: input.actor,
      creatorIdentityId
    })) {
      authorized.push(event);
      if (creatorIdentityId) {
        creatorIdentityIds[event.id] = creatorIdentityId;
      }
    }
  }
  if (authorized.length === 0) {
    return input.query || subgroupCandidates.length > 0
      ? { status: 'permission_denied' }
      : { status: 'none' };
  }
  return { status: 'candidates', candidates: uniqueEvents(authorized), creatorIdentityIds };
}

async function eventCancellationAllowed(
  context: PluginCommandContext,
  input: {
    event: StoredEventRecord;
    actor: EventAuthorizationPrincipal;
    creatorIdentityId?: string | undefined;
  }
): Promise<boolean> {
  if (input.creatorIdentityId && input.actor.identityId === input.creatorIdentityId) {
    return true;
  }
  if (!context.explainPermission) {
    return false;
  }
  const decision = await context.explainPermission({
    actorIdentityId: input.actor.identityId,
    action: EVENTS_PERMISSIONS.manage,
    scopeId: input.event.scopeId,
    pluginId: EVENTS_PLUGIN_ID,
    ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
    ...(input.event.groupWid ? { groupWid: input.event.groupWid } : {}),
    requiresCurrentManagedGroupMembership: false
  });
  return decision.allowed;
}

function findEventMatches(events: StoredEventRecord[], query: string, locale = 'en'): StoredEventRecord[] {
  const normalizedQuery = normalizeEventSearchText(query);
  if (!normalizedQuery) {
    return events;
  }
  const exactId = events.filter((event) => event.id.toLowerCase() === query.trim().toLowerCase());
  if (exactId.length > 0) {
    return exactId;
  }
  const exactTitle = events.filter((event) => eventSearchFields(event, locale).some((field) =>
    normalizeEventSearchText(field) === normalizedQuery
  ));
  if (exactTitle.length > 0) {
    return uniqueEvents(exactTitle);
  }
  return uniqueEvents(events.filter((event) => eventSearchFields(event, locale).some((field) =>
    normalizeEventSearchText(field).includes(normalizedQuery)
  )));
}

function eventCancelFlowConfirmed(snapshot: { state: FlowState }): boolean {
  const value = snapshot.state.data[EVENT_CANCEL_CONFIRM_STEP_ID];
  return Array.isArray(value) ? value.includes('yes') : value === 'yes';
}

function eventCancelFlowSelectedEventId(snapshot: { state: FlowState }): string | undefined {
  const value = snapshot.state.data[EVENT_CANCEL_SELECT_STEP_ID];
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function eventCancelConfirmPurpose(flowType: string): string {
  return `flow.${flowType}.${EVENT_CANCEL_CONFIRM_STEP_ID}`;
}

function eventCancelConfirmationSummary(input: {
  state: FlowState;
  candidates: StoredEventRecord[];
  preselectedEventId?: string | undefined;
  locale: string;
  t: CommandContext['t'];
}): string {
  const eventId = eventCancelFlowSelectedEventId({ state: input.state }) ?? input.preselectedEventId;
  const event = input.candidates.find((candidate) => candidate.id === eventId) ?? input.candidates[0];
  if (!event) {
    return '';
  }
  return input.t('official.community-events.cancel.summary', {
    title: eventDisplayTitle(event),
    startsAt: eventStartsAtLabel(event, input.locale),
    status: eventLifecycleLabel(event, input.t),
    eventId: event.id
  });
}

function eventChoiceLabel(event: StoredEventRecord, t: CommandContext['t'], locale: string): string {
  return t('official.community-events.cancel.choiceLabel', {
    title: eventDisplayTitle(event),
    startsAt: eventStartsAtLabel(event, locale),
    status: eventLifecycleLabel(event, t),
    eventId: event.id
  });
}

function eventLifecycleLabel(event: StoredEventRecord, t: CommandContext['t']): string {
  return t('official.community-events.lifecycle.label', {
    eventStatus: t(`official.community-events.lifecycle.event.${event.eventStatus}`),
    groupLifecycleStatus: t(`official.community-events.lifecycle.group.${event.groupLifecycleStatus}`)
  });
}

function eventStartsAtLabel(event: StoredEventRecord, locale = 'en'): string {
  return formatEventDateTime(new Date(event.startsAt), event.timezone, locale);
}

function eventDisplayTitle(event: StoredEventRecord): string {
  return event.groupTitle || event.pollQuestion || event.id;
}

function eventSearchFields(event: StoredEventRecord, locale = 'en'): string[] {
  return [
    event.id,
    event.groupTitle,
    event.pollQuestion,
    event.subgroupTitle,
    event.profileLabel,
    eventStartsAtLabel(event, locale)
  ].filter((value): value is string => Boolean(value));
}

function normalizeEventSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function uniqueEvents(events: StoredEventRecord[]): StoredEventRecord[] {
  const seen = new Set<string>();
  const unique: StoredEventRecord[] = [];
  for (const event of events) {
    if (!seen.has(event.id)) {
      seen.add(event.id);
      unique.push(event);
    }
  }
  return unique;
}

export function registerEventFlowCompletionHandlers(
  context: EventFlowCompletionContext,
  flowType: string,
  profiles: EventProfile[],
  t: CommandContext['t']
): void {
  const runtime = requireEventFlowRuntime(context);
  const flowEngine = requireEventFlowEngine(context);
  for (const profile of profiles) {
    flowEngine.registerPromptHandler(eventConfirmPurpose(flowType, profile), async (lock, activeTransport) => {
      if (!lock.flowSessionId) {
        return false;
      }
      const snapshot = await flowEngine.getSessionSnapshot(lock.flowSessionId);
      if (!snapshot || snapshot.flowType !== flowType || !snapshot.scopeId) {
        return false;
      }
      const draft = await runtime.dataStore.get<EventDraft>(eventDraftKey(snapshot.scopeId, lock.flowSessionId));
      if (!draft) {
        return false;
      }
      const responseChatId = snapshot.chatId || draft.chatId;
      const selectedProfileId = eventFlowSelectedProfileId(snapshot);
      if (selectedProfileId !== profile.id) {
        return false;
      }
      await runtime.dataStore.delete(eventDraftKey(snapshot.scopeId, lock.flowSessionId));
      if (!eventFlowConfirmed(snapshot, profile)) {
        await activeTransport.sendText(responseChatId, t('official.community-events.cancelled'));
        return true;
      }

      const answers = eventFlowAnswers(snapshot, profile, draft.timezone, draft.locale);
      if (!answers) {
        await activeTransport.sendText(responseChatId, t('official.community-events.invalid'));
        return true;
      }
      const actor = await resolveEventDraftAuthorizationActor(context, draft);
      if (!actor) {
        await activeTransport.sendText(responseChatId, t('official.community-events.permissionDenied'));
        return true;
      }
      const permission = eventProfilePermission(profile);
      const permissionAllowed = await eventActorPermissionAllowed(context, {
        actor,
        action: permission,
        scopeId: draft.scopeId,
        allowCurrentManagedGroupMember: profile.allowScopeMemberCreation === true,
        ...(draft.groupId ? { groupId: draft.groupId } : {}),
        ...(draft.groupWid ? { groupWid: draft.groupWid } : {})
      });
      if (!permissionAllowed) {
        await activeTransport.sendText(responseChatId, t('official.community-events.permissionDenied'));
        return true;
      }
      const announcementGroupWid = profile.announcementGroupWid || draft.defaultAnnouncementGroupWid;
      if (!announcementGroupWid) {
        await activeTransport.sendText(responseChatId, t('official.community-events.notConfigured'));
        return true;
      }
      await beginEventLocationSelection({
        context,
        runtime,
        activeTransport,
        responseChatId,
        draft: { ...draft, actorWid: actor.canonicalWid },
        profile,
        answers,
        announcementGroupWid,
        t
      });
      return true;
    });
  }
}

function registerEventLocationSelectionHandler(context: PluginCommandContext): void {
  const runtime = requireOfficialCommandRuntime(context);
  context.flowEngine.registerPromptHandler(EVENT_LOCATION_SELECTION_PURPOSE, async (lock, activeTransport) => {
    const pending = lock.subjectId
      ? await runtime.ephemeralStore.get<PendingEventLocationSelection>(eventLocationSelectionKey(lock.subjectId))
      : undefined;
    if (!pending) {
      return false;
    }
    const t = await context.i18n.translatorForIdentity(
      pending.draft.actorIdentityId,
      pending.draft.scopeId
    );
    const answers = eventFlowAnswersFromPending(pending.answers);
    if (!answers) {
      await clearActiveEventLocationSelection(runtime, pending);
      await activeTransport.sendText(
        pending.responseChatId,
        t('official.community-events.invalid')
      );
      return true;
    }
    if (!eventLocationSelectionRequestedByActor(pending, lock.voterIdentityId)) {
      await activeTransport.sendText(
        pending.responseChatId,
        t('official.community-events.location.wrongRequester')
      );
      return true;
    }
    await clearActiveEventLocationSelection(runtime, pending);
    const selected = lock.selectedOptions[0];
    if (selected?.id === EVENT_LOCATION_FREE_TEXT_OPTION_ID) {
      const query = selected.label.trim();
      if (!query) {
        await activeTransport.sendText(
          pending.responseChatId,
          t('official.community-events.location.invalid')
        );
        return true;
      }
      if (isCommandLikeLocationReply(query)) {
        await activeTransport.sendText(
          pending.responseChatId,
          t('official.community-events.cancelled')
        );
        return true;
      }
      await requeryEventLocationSelection({
        context,
        runtime,
        activeTransport,
        pending,
        query,
        t
      });
      return true;
    }
    const candidateIndex = Number(selected?.id);
    const candidate = Number.isSafeInteger(candidateIndex)
      ? pending.candidates[candidateIndex]
      : undefined;
    if (!candidate) {
      await activeTransport.sendText(
        pending.responseChatId,
        t('official.community-events.location.invalid')
      );
      return true;
    }
    const profile = pending.kind === 'create' ? pending.profile : pending.draft.profile;
    const displayPlace = eventLocationQuery(profile, answers.answers);
    if (!displayPlace || displayPlace !== pending.displayPlace) {
      await activeTransport.sendText(
        pending.responseChatId,
        t('official.community-events.location.invalid')
      );
      return true;
    }
    const eventLocation = geocodedEventLocation({
      query: pending.searchQuery,
      displayLabel: displayPlace,
      timezone: pending.draft.timezone,
      provider: pending.provider,
      place: candidate
    });
    if (pending.kind === 'create') {
      await publishConfirmedEvent({
        context,
        runtime,
        activeTransport,
        responseChatId: pending.responseChatId,
        draft: pending.draft,
        profile: pending.profile,
        answers,
        announcementGroupWid: pending.announcementGroupWid,
        eventLocation,
        t
      });
    } else {
      await completeEventUpdate({
        context,
        runtime,
        activeTransport,
        responseChatId: pending.responseChatId,
        draft: pending.draft,
        eventId: pending.eventId,
        answers,
        eventLocation,
        pastCompletionConfirmed: pending.pastCompletionConfirmed,
        t
      });
    }
    return true;
  });
}

async function promptEventLocationConfirmation(input: {
  context: EventFlowCompletionContext;
  runtime: OfficialPluginCommandRuntime;
  activeTransport: EventTextTransport;
  pending: PendingEventLocationSelection;
  t: CommandContext['t'];
}): Promise<void> {
  const options = eventLocationCandidateOptions(input.pending.candidates);
  const question = options.length > 0
    ? input.t('official.community-events.location.select', {
      displayPlace: input.pending.displayPlace,
      searchQuery: input.pending.searchQuery
    })
    : input.t('official.community-events.location.noResults', {
      displayPlace: input.pending.displayPlace,
      searchQuery: input.pending.searchQuery
    });
  await rememberActiveEventLocationSelection(input.runtime, input.pending);
  try {
    await requireEventFlowEngine(input.context).promptChoice({
      purpose: EVENT_LOCATION_SELECTION_PURPOSE,
      subjectType: 'CommunityEventLocation',
      subjectId: input.pending.id,
      question,
      options,
      freeTextOption: {
        id: EVENT_LOCATION_FREE_TEXT_OPTION_ID,
        label: input.t('official.community-events.location.freeText')
      },
      recipientWids: [input.pending.responseChatId],
      eligibleVoterIdentityIds: [requirePendingEventActorIdentityId(input.pending)],
      selectionRule: PollSelectionRule.SINGLE,
      minSelections: 1,
      maxSelections: 1,
      ...(input.pending.draft.privateDeliveryFallback
        ? { privateDeliveryFallback: input.pending.draft.privateDeliveryFallback }
        : {}),
      expiresAt: new Date(Date.now() + EVENT_LOCATION_SELECTION_TTL_SECONDS * 1000),
      t: input.t
    });
  } catch (error) {
    await clearActiveEventLocationSelection(input.runtime, input.pending);
    throw error;
  }
}

async function requeryEventLocationSelection(input: {
  context: EventFlowCompletionContext;
  runtime: OfficialPluginCommandRuntime;
  activeTransport: EventTextTransport;
  pending: PendingEventLocationSelection;
  query: string;
  t: CommandContext['t'];
}): Promise<void> {
  if (!input.context.services) {
    await input.activeTransport.sendText(
      input.pending.responseChatId,
      input.t('official.community-events.location.failed')
    );
    return;
  }
  let output: GeocodeOutput;
  try {
    output = await input.context.services.call<GeocodeOutput>({
      serviceId: GEOCODER_SERVICE_ID,
      method: GEOCODER_GEOCODE_METHOD,
      scopeId: input.pending.draft.scopeId,
      actorIdentityId: input.pending.draft.actorIdentityId,
      ...(input.pending.draft.groupId ? { groupId: input.pending.draft.groupId } : {}),
      ...(input.pending.draft.groupWid ? { groupWid: input.pending.draft.groupWid } : {}),
      input: {
        query: input.query,
        language: input.pending.draft.locale,
        limit: 5
      }
    });
  } catch (error) {
    await recordEventLocationFailure(input.context, {
      phase: 'geocode',
      scopeId: input.pending.draft.scopeId,
      ...(input.pending.kind === 'update' ? { eventId: input.pending.eventId } : {}),
      actorWid: input.pending.draft.actorWid,
      profileId: input.pending.kind === 'create'
        ? input.pending.profile.id
        : input.pending.draft.profile.id,
      query: input.query,
      error
    });
    await input.activeTransport.sendText(
      input.pending.responseChatId,
      input.t('official.community-events.location.failed')
    );
    return;
  }
  try {
    await promptEventLocationConfirmation({
      context: input.context,
      runtime: input.runtime,
      activeTransport: input.activeTransport,
      pending: {
        ...input.pending,
        id: randomUUID(),
        searchQuery: input.query,
        provider: output.provider,
        candidates: output.results
      },
      t: input.t
    });
  } catch (error) {
    await recordEventLocationFailure(input.context, {
      phase: 'prompt_dispatch',
      scopeId: input.pending.draft.scopeId,
      ...(input.pending.kind === 'update' ? { eventId: input.pending.eventId } : {}),
      actorWid: input.pending.draft.actorWid,
      profileId: input.pending.kind === 'create'
        ? input.pending.profile.id
        : input.pending.draft.profile.id,
      query: input.query,
      error
    });
    await input.activeTransport.sendText(
      input.pending.responseChatId,
      input.t('official.community-events.location.promptFailed')
    );
  }
}

async function beginEventLocationSelection(input: {
  context: EventFlowCompletionContext;
  runtime: OfficialPluginCommandRuntime;
  activeTransport: EventTextTransport;
  responseChatId: string;
  draft: EventDraft;
  profile: EventProfile;
  answers: EventFlowAnswers;
  announcementGroupWid: string;
  t: CommandContext['t'];
}): Promise<void> {
  const fixedLocation = fixedEventLocation(input.profile, input.draft.timezone);
  if (fixedLocation) {
    await publishConfirmedEvent({
      ...input,
      eventLocation: fixedLocation
    });
    return;
  }
  const place = eventLocationQuery(input.profile, input.answers.answers);
  if (!place) {
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.location.missing')
    );
    return;
  }
  if (!input.context.services) {
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.location.failed')
    );
    return;
  }
  let output: GeocodeOutput;
  try {
    output = await input.context.services.call<GeocodeOutput>({
      serviceId: GEOCODER_SERVICE_ID,
      method: GEOCODER_GEOCODE_METHOD,
      scopeId: input.draft.scopeId,
      actorIdentityId: input.draft.actorIdentityId,
      ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
      ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
      input: {
        query: place,
        language: input.draft.locale,
        limit: 5
      }
    });
  } catch (error) {
    await recordEventLocationFailure(input.context, {
      phase: 'geocode',
      scopeId: input.draft.scopeId,
      actorWid: input.draft.actorWid,
      profileId: input.profile.id,
      query: place,
      error
    });
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.location.failed')
    );
    return;
  }
  const pending: PendingEventLocationSelection = {
    kind: 'create',
    id: randomUUID(),
    responseChatId: input.responseChatId,
    draft: input.draft,
    profile: input.profile,
    answers: pendingEventFlowAnswers(input.answers),
    announcementGroupWid: input.announcementGroupWid,
    displayPlace: place,
    searchQuery: place,
    provider: output.provider,
    candidates: output.results
  };
  try {
    await promptEventLocationConfirmation({ ...input, pending });
  } catch (error) {
    await recordEventLocationFailure(input.context, {
      phase: 'prompt_dispatch',
      scopeId: input.draft.scopeId,
      actorWid: input.draft.actorWid,
      profileId: input.profile.id,
      query: place,
      error
    });
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.location.promptFailed')
    );
  }
}

async function publishConfirmedEvent(input: {
  context: EventFlowCompletionContext;
  runtime: OfficialPluginCommandRuntime;
  activeTransport: EventTextTransport;
  responseChatId: string;
  draft: EventDraft;
  profile: EventProfile;
  answers: EventFlowAnswers;
  announcementGroupWid: string;
  eventLocation: StoredEventLocation;
  t: CommandContext['t'];
}): Promise<void> {
  const eventId = newEventId();
  let creationMode: 'poll' | 'unplanned' = 'poll';
  try {
    if (!await eventProfileSnapshotIsCurrent({
      runtime: input.runtime,
      scopeId: input.draft.scopeId,
      actorIdentityId: input.draft.actorIdentityId,
      snapshot: input.profile,
      t: input.t
    })) {
      await input.activeTransport.sendText(
        input.responseChatId,
        input.t('official.community-events.invalid')
      );
      return;
    }
    const db = eventsDatabase(input.runtime.databases);
    const materialized = materializeEventLifecycle({
      profile: input.profile,
      answers: input.answers,
      timezone: input.draft.timezone,
      locale: input.draft.locale,
      creatorDisplayName: input.draft.actorLabel || input.draft.actorWid,
      eventLocation: input.eventLocation
    });
    const now = new Date();
    creationMode = materialized.closeAt.getTime() <= now.getTime() ? 'unplanned' : 'poll';
    if (creationMode === 'unplanned') {
      await createUnplannedEventLifecycle({
        context: input.context,
        runtime: input.runtime,
        activeTransport: input.activeTransport,
        db,
        eventId,
        draft: input.draft,
        profile: input.profile,
        announcementGroupWid: input.announcementGroupWid,
        materialized,
        now
      });
      await input.activeTransport.sendText(
        input.responseChatId,
        input.t('official.community-events.unplannedPublished')
      );
      return;
    }
    if (!input.context.services) {
      throw new Error('Plugin service registry is unavailable.');
    }
    const sent = await input.context.services.call<DoasPollPublishOutput>({
      serviceId: DOAS_POLL_SERVICE_ID,
      method: DOAS_POLL_PUBLISH_METHOD,
      scopeId: input.draft.scopeId,
      actorIdentityId: input.draft.actorIdentityId,
      ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
      ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
      input: {
        groupWid: input.announcementGroupWid,
        question: materialized.pollQuestion,
        options: selectedOptionLabels(input.profile),
        allowMultipleAnswers: input.profile.poll.allowMultipleAnswers,
        reason: `event ${input.profile.id}`,
        sourcePluginId: EVENTS_PLUGIN_ID
      }
    });
    if (!sent?.messageId) {
      throw new Error('doas poll service did not return a message id');
    }
    const nowIso = now.toISOString();
    const event: NewStoredEventRecord = {
      id: eventId,
      scopeId: input.draft.scopeId,
      ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
      ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
      profileId: input.profile.id,
      profileRevision: eventProfileQuestionSchemaRevision(input.profile),
      profileLabel: input.profile.label,
      origin: 'created',
      eventStatus: 'active',
      groupLifecycleStatus: 'poll_open',
      calendarStatus: 'included',
      actorIdentityId: input.draft.actorIdentityId,
      actorWid: input.draft.actorWid,
      actorLabel: input.draft.actorLabel,
      announcementGroupWid: input.announcementGroupWid,
      pollWaMsgId: sent.messageId,
      pollQuestion: materialized.pollQuestion,
      pollOptions: materialized.pollOptions,
      responseClasses: materialized.responseClasses,
      answers: materialized.answers,
      eventLocation: input.eventLocation,
      startsAt: materialized.startsAt.toISOString(),
      startsAtUtc: materialized.startsAt.toISOString(),
      timezone: input.draft.timezone,
      localDate: materialized.localDate,
      ...(materialized.localTime ? { localTime: materialized.localTime } : {}),
      ...(materialized.place ? { place: materialized.place } : {}),
      closeAt: materialized.closeAt.toISOString(),
      cleanupAt: materialized.cleanupAt.toISOString(),
      groupTitle: materialized.groupTitle,
      calendarDurationMinutes: materialized.calendarDurationMinutes,
      ...(materialized.calendarLocation ? { calendarLocation: materialized.calendarLocation } : {}),
      ...(materialized.calendarDescription ? { calendarDescription: materialized.calendarDescription } : {}),
      createdAt: nowIso,
      updatedAt: nowIso
    };
    insertEvent(db, event);
    recordEventAnnouncementMessage(db, {
      eventId: event.id,
      scopeId: event.scopeId,
      kind: 'poll',
      deliveryKey: 'initial',
      chatId: input.announcementGroupWid,
      messageId: sent.messageId,
      createdAt: nowIso
    });
    try {
      const calendarConfig = draftEventsConfig(input.draft);
      const calendar = calendarResourceForProfile(calendarConfig, input.profile);
      const calendarEvents = listCalendarEvents(db, input.draft.scopeId);
      const publication = await writePublishAndRecordScopeCalendar({
        appConfig: input.runtime.config,
        db,
        config: calendarConfig,
        scopeId: input.draft.scopeId,
        calendarId: input.profile.calendar.calendarId,
        events: calendarEvents
      });
      await appendEventJsonLog(input.context, {
        action: 'calendar.exported',
        scopeId: input.draft.scopeId,
        eventId,
        actorWid: input.draft.actorWid,
        profileId: input.profile.id,
        pollWaMsgId: sent.messageId,
        metadata: {
          calendarEnabled: calendar?.enabled === true,
          calendarId: input.profile.calendar.calendarId,
          ...(publication ? { publication } : {})
        }
      });
    } catch (error) {
      await appendEventJsonLog(input.context, {
        action: 'calendar.export_failed',
        scopeId: input.draft.scopeId,
        eventId,
        actorWid: input.draft.actorWid,
        profileId: input.profile.id,
        pollWaMsgId: sent.messageId,
        metadata: { reason: error instanceof Error ? error.message : String(error) }
      });
    }
    await appendEventJsonLog(input.context, {
      action: 'event.created',
      scopeId: input.draft.scopeId,
      eventId,
      actorWid: input.draft.actorWid,
      profileId: input.profile.id,
      pollWaMsgId: sent.messageId,
      metadata: {
        announcementGroupWid: input.announcementGroupWid,
        pollQuestion: materialized.pollQuestion,
        pollOptions: materialized.pollOptions,
        responseClasses: materialized.responseClasses,
        answers: materialized.answers,
        eventLocation: input.eventLocation,
        startsAt: materialized.startsAt.toISOString(),
        closeAt: materialized.closeAt.toISOString(),
        cleanupAt: materialized.cleanupAt.toISOString(),
        prefill: input.draft.prefill
      }
    });
    await input.runtime.enqueuePluginJob({
      jobName: EVENTS_JOBS.close,
      scopeId: input.draft.scopeId,
      ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
      ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
      runAt: materialized.closeAt,
      payload: { eventId },
      dedupeKey: `${EVENTS_JOBS.close}:${eventId}`
    });
    await sendEventCalendarHint({
      context: input.context,
      runtime: input.runtime,
      activeTransport: input.activeTransport,
      trigger: 'poll_published',
      scopeId: input.draft.scopeId,
      announcementGroupWid: input.announcementGroupWid,
      event,
      profile: input.profile,
      calendars: input.draft.calendars,
      timezone: input.draft.timezone,
      locale: input.draft.locale,
      creatorDisplayName: input.draft.actorLabel || input.draft.actorWid
    });
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.pollPublished')
    );
  } catch (error) {
    await appendEventJsonLog(input.context, {
      action: creationMode === 'unplanned' ? 'event.unplanned_failed' : 'event.publish_failed',
      scopeId: input.draft.scopeId,
      eventId,
      actorWid: input.draft.actorWid,
      profileId: input.profile.id,
      metadata: {
        reason: error instanceof Error ? error.message : String(error)
      }
    });
    await input.activeTransport.sendText(input.responseChatId, input.t(
      creationMode === 'unplanned'
        ? 'official.community-events.unplannedPublishFailed'
        : 'official.community-events.publishFailed',
      {
        reason: error instanceof Error ? error.message : String(error)
      }
    ));
  }
}

async function eventProfileSnapshotIsCurrent(input: {
  runtime: OfficialPluginCommandRuntime;
  scopeId: string;
  actorIdentityId: string;
  snapshot: EventProfile;
  t: CommandContext['t'];
}): Promise<boolean> {
  try {
    const config = parseEventsConfig(await input.runtime.configFor(input.scopeId, input.actorIdentityId));
    const current = localizeDefaultEventProfiles(config.eventProfiles, input.t)
      .find((profile) => profile.id === input.snapshot.id);
    return Boolean(current && stableJson(current) === stableJson(input.snapshot));
  } catch {
    return false;
  }
}

async function createUnplannedEventLifecycle(input: {
  context: EventFlowCompletionContext;
  runtime: OfficialPluginCommandRuntime;
  activeTransport: EventTextTransport;
  db: ReturnType<typeof eventsDatabase>;
  eventId: string;
  draft: EventDraft;
  profile: EventProfile;
  announcementGroupWid: string;
  materialized: MaterializedEventLifecycle;
  now: Date;
}): Promise<void> {
  const creatorParticipantWid = eventCreatorParticipantWid(input.draft);
  const nowIso = input.now.toISOString();
  const intent: NewStoredEventRecord = {
    id: input.eventId,
    scopeId: input.draft.scopeId,
    ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
    ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
    profileId: input.profile.id,
    profileRevision: eventProfileQuestionSchemaRevision(input.profile),
    profileLabel: input.profile.label,
    origin: 'unplanned',
    eventStatus: 'failed',
    groupLifecycleStatus: 'none',
    calendarStatus: 'hidden',
    actorIdentityId: input.draft.actorIdentityId,
    actorWid: input.draft.actorWid,
    actorLabel: input.draft.actorLabel,
    announcementGroupWid: input.announcementGroupWid,
    pollOptions: [],
    responseClasses: input.materialized.responseClasses,
    answers: input.materialized.answers,
    ...(input.materialized.eventLocation ? { eventLocation: input.materialized.eventLocation } : {}),
    startsAt: input.materialized.startsAt.toISOString(),
    startsAtUtc: input.materialized.startsAt.toISOString(),
    timezone: input.draft.timezone,
    localDate: input.materialized.localDate,
    ...(input.materialized.localTime ? { localTime: input.materialized.localTime } : {}),
    ...(input.materialized.place ? { place: input.materialized.place } : {}),
    closeAt: input.materialized.closeAt.toISOString(),
    cleanupAt: input.materialized.cleanupAt.toISOString(),
    groupTitle: input.materialized.groupTitle,
    calendarDurationMinutes: input.materialized.calendarDurationMinutes,
    ...(input.materialized.calendarLocation ? { calendarLocation: input.materialized.calendarLocation } : {}),
    ...(input.materialized.calendarDescription ? { calendarDescription: input.materialized.calendarDescription } : {}),
    createdAt: nowIso,
    updatedAt: nowIso
  };

  insertEvent(input.db, intent);
  appendEventLog(input.db, {
    eventId: intent.id,
    action: 'events.unplanned.provisioning_intent_created',
    metadata: {
      groupTitle: intent.groupTitle,
      attendeeWids: [creatorParticipantWid]
    }
  });
  const result = await provisionUnplannedEventSubgroup({
    context: input.context,
    runtime: input.runtime,
    db: input.db,
    event: intent,
    creatorParticipantWid
  });
  const created = result.created;
  const completedAt = new Date().toISOString();
  const completed = completeUnplannedEventProvisioning(input.db, {
    eventId: intent.id,
    scopeId: intent.scopeId,
    subgroupChatId: created.chatId,
    subgroupTitle: created.title,
    participants: created.participants,
    completedAt
  });
  if (!completed) {
    throw new Error(
      `Unplanned event ${intent.id} cannot complete with subgroup ${created.chatId}; ` +
      'its persisted provisioning intent is missing or belongs to another subgroup.'
    );
  }
  const event = getEvent(input.db, intent.id);
  if (!event) {
    throw new Error(`Unplanned event ${intent.id} disappeared after provisioning completion.`);
  }
  await appendEventJsonLog(input.context, {
    action: 'subgroup.created',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: event.actorWid,
    profileId: event.profileId,
    subgroupChatId: created.chatId,
    metadata: {
      title: created.title,
      attendeeWids: [creatorParticipantWid],
      participants: created.participants,
      unplanned: true
    }
  });

  await attemptUnplannedEventFinalization({
    context: input.context,
    runtime: input.runtime,
    activeTransport: input.activeTransport,
    event,
    profile: input.profile,
    config: draftEventsConfig(input.draft),
    locale: input.draft.locale,
    creatorDisplayName: input.draft.actorLabel || input.draft.actorWid,
    trigger: 'unplanned_created',
    now: input.now
  });
}

async function provisionUnplannedEventSubgroup(input: {
  context: EventFlowCompletionContext;
  runtime: OfficialPluginCommandRuntime;
  db: ReturnType<typeof eventsDatabase>;
  event: StoredEventRecord;
  creatorParticipantWid: string;
}): Promise<Awaited<ReturnType<typeof createEventCommunitySubgroup>>> {
  try {
    return await createEventCommunitySubgroup({
      context: input.context,
      scopeId: input.event.scopeId,
      actorIdentityId: requireStoredEventActorIdentityId(input.event),
      title: input.event.groupTitle,
      participantWids: [input.creatorParticipantWid]
    });
  } catch (error) {
    if (!isManagedCommunitySubgroupProvisioningError(error)) {
      throw error;
    }
    const cursor = checkpointManagedUnplannedProvisioningFailure(input.db, input.event, error);
    const failedEvent = getEvent(input.db, input.event.id);
    if (!failedEvent || failedEvent.subgroupChatId !== error.created.chatId) {
      throw new Error(
        `Unplanned event ${input.event.id} lost its exact subgroup recovery checkpoint ${error.created.chatId}.`
      );
    }
    try {
      await input.runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.provisioningRecovery,
        scopeId: failedEvent.scopeId,
        ...(failedEvent.groupId ? { groupId: failedEvent.groupId } : {}),
        ...(failedEvent.groupWid ? { groupWid: failedEvent.groupWid } : {}),
        runAt: cursor.runAt,
        payload: {
          eventId: failedEvent.id,
          subgroupChatId: error.created.chatId,
          generation: cursor.generation,
          attempt: cursor.attempt
        },
        dedupeKey: eventProvisioningRecoveryDedupeKey(failedEvent, cursor)
      });
      appendEventLog(input.db, {
        eventId: failedEvent.id,
        action: 'events.provisioning.recovery_scheduled',
        metadata: {
          subgroupChatId: error.created.chatId,
          generation: cursor.generation,
          attempt: cursor.attempt,
          runAt: cursor.runAt.toISOString(),
          stage: error.stage,
          origin: 'unplanned'
        }
      });
    } catch (enqueueError) {
      appendEventLog(input.db, {
        eventId: failedEvent.id,
        action: 'events.provisioning.recovery_enqueue_failed',
        metadata: {
          subgroupChatId: error.created.chatId,
          generation: cursor.generation,
          attempt: cursor.attempt,
          runAt: cursor.runAt.toISOString(),
          reason: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
          origin: 'unplanned'
        }
      });
      throw new Error(
        `Unplanned event ${failedEvent.id} preserved exact subgroup ${error.created.chatId}, ` +
        'but its durable provisioning recovery job could not be enqueued.',
        { cause: enqueueError }
      );
    }
    throw error;
  }
}

function checkpointManagedUnplannedProvisioningFailure(
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  error: ManagedCommunitySubgroupProvisioningError
): { generation: string; attempt: number; runAt: Date } {
  const generation = randomUUID();
  const attempt = 1;
  const failedAt = new Date();
  const runAt = eventProvisioningRecoveryRunAt(attempt, failedAt);
  const checkpointed = checkpointUnplannedEventProvisioningFailure(db, {
    eventId: event.id,
    scopeId: event.scopeId,
    subgroupChatId: error.created.chatId,
    subgroupTitle: error.created.title,
    participants: error.created.participants,
    parentCommunityWid: error.provisioning.parentCommunityWid,
    stage: error.stage,
    progress: {
      standaloneRegistered: error.provisioning.standaloneRegistered,
      attendeesVerified: error.provisioning.attendeesVerified,
      communityLinkConfirmed: error.provisioning.communityLinkConfirmed,
      linkedChildRegistered: error.provisioning.linkedChildRegistered
    },
    reason: error.message,
    failedAt: failedAt.toISOString(),
    recoveryGeneration: generation,
    recoveryAttempt: attempt,
    recoveryNextRunAt: runAt.toISOString()
  });
  if (!checkpointed) {
    throw new Error(
      `Unplanned event ${event.id} rejected provisioning output for subgroup ${error.created.chatId}; ` +
      'the event is already bound to another subgroup or left its recoverable state.'
    );
  }
  return { generation, attempt, runAt };
}

function draftEventsConfig(draft: {
  timezone: string;
  calendars: EventCalendarResource[];
  profiles: EventProfile[];
}) {
  return parseEventsConfig({
    enabled: true,
    timezone: draft.timezone,
    cleanup: { retryDelaysMinutes: [], lastFailureMessage: '', lastFailureAt: '' },
    adoption: {},
    calendars: draft.calendars,
    eventProfiles: draft.profiles
  });
}

function eventCreatorParticipantWid(draft: EventDraft): string {
  return draft.actorWid;
}

function eventCommand(input: {
  mutation?: CommandMetadata['mutation'] | undefined;
  auditAction: string;
  permission?: string | undefined;
  usage: string;
  topicId: 'overview-events' | 'create-events' | 'inspect-events' | 'cancel-events' | 'edit-events' | 'list-events';
  descriptionKey: string;
  exampleKey?: string | undefined;
  requiresCurrentManagedGroupMembership?: boolean | undefined;
  requiresManagedGroup?: boolean | undefined;
  privateManagedTargetArgPosition?: number | false | undefined;
  targeting?: boolean | undefined;
  assistant?: CommandMetadata['assistant'] | undefined;
}): CommandMetadata {
  return {
    plane: 'group_operation',
    interaction: 'either_same_chat',
    pluginId: EVENTS_PLUGIN_ID,
    currentManagedGroupMembershipMode: 'effective_scope',
    ...(input.permission ? { permission: input.permission } : {}),
    requiresManagedGroup: input.requiresManagedGroup ?? true,
    ...(input.requiresCurrentManagedGroupMembership !== undefined
      ? { requiresCurrentManagedGroupMembership: input.requiresCurrentManagedGroupMembership }
      : {}),
    ...(input.targeting === false ? {} : {
      privateManagedTarget: {
        mode: 'infer_group_or_community' as const,
        explicitTargetName: 'chat',
        ...(input.privateManagedTargetArgPosition !== false
          ? { explicitArgPosition: input.privateManagedTargetArgPosition ?? 0 }
          : {}),
        collapseCommunities: true
      },
      targets: [input.privateManagedTargetArgPosition === false ? CHAT_FLAG_TARGET : CHAT_TARGET, SCOPE_TARGET]
    }),
    mutation: input.mutation ?? 'durable',
    auditAction: input.auditAction,
    assistant: input.assistant ?? {
      intentTags: ['event'],
      argumentHints: [
        '--profile <profileId>',
        '--answer <questionKey=value>',
        '--<questionKey> <value>',
        'Example: /event new --profile climbing --place "Sintra" --startDate "tomorrow" --startTime "09:30" --style "Bouldering"'
      ],
      examples: [
        '/event new --profile climbing --place "Sintra" --startDate "tomorrow" --startTime "09:30" --style "Bouldering"'
      ],
      executable: true,
      requiresConfirmation: true
    },
    help: {
      familyKey: 'official.community-events.help.family',
      featureId: 'events',
      topicId: input.topicId,
      descriptionKey: input.descriptionKey,
      usage: input.usage,
      ...(input.exampleKey ? { exampleKeys: [input.exampleKey] } : {}),
      keywords: ['event', input.topicId]
    }
  };
}

function requireEventFlowEngine(context: EventFlowCompletionContext) {
  if (!context.flowEngine) {
    throw new Error('Community event flows require the platform flow engine.');
  }
  return context.flowEngine;
}

function requireEventFlowRuntime(context: EventFlowCompletionContext): OfficialPluginCommandRuntime {
  if ('router' in context) {
    return requireOfficialCommandRuntime(context);
  }
  if (
    !context.pluginId
    || !context.manifest
    || !context.dataStore
    || !context.ephemeralStore
    || !context.configFor
    || !context.setConfig
  ) {
    throw new Error('Community event flows require an initialized plugin runtime context.');
  }
  return {
    pluginId: context.pluginId,
    manifest: context.manifest,
    config: context.config,
    dataStore: context.dataStore,
    ephemeralStore: context.ephemeralStore,
    ...(context.databases ? { databases: context.databases } : {}),
    ...(context.mediaStore ? { mediaStore: context.mediaStore } : {}),
    configFor: context.configFor,
    setConfig: context.setConfig,
    ...(context.communityGroupWidForScope
      ? { communityGroupWidForScope: context.communityGroupWidForScope }
      : {}),
    ...(context.ensureChatArchivePolicyForScope
      ? { ensureChatArchivePolicyForScope: context.ensureChatArchivePolicyForScope }
      : {}),
    ...(context.sendAssistantStatusText
      ? { sendAssistantStatusText: context.sendAssistantStatusText }
      : {}),
    enqueuePluginJob: (input) => enqueueRuntimePluginJob(context.queue, {
      pluginId: context.pluginId,
      ...input
    })
  };
}

async function eventActorPermissionAllowed(
  context: EventFlowCompletionContext,
  input: {
    actor: EventAuthorizationPrincipal;
    action: string;
    scopeId: string;
    groupId?: string | undefined;
    groupWid?: string | undefined;
    allowCurrentManagedGroupMember?: boolean | undefined;
  }
): Promise<boolean> {
  if (!context.explainPermission) {
    return false;
  }
  const decision = await context.explainPermission({
    actorIdentityId: input.actor.identityId,
    action: input.action,
    scopeId: input.scopeId,
    pluginId: EVENTS_PLUGIN_ID,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.groupWid ? { groupWid: input.groupWid } : {}),
    requiresCurrentManagedGroupMembership: true,
    currentManagedGroupMembershipMode: 'effective_scope',
    ...(input.allowCurrentManagedGroupMember ? { allowCurrentManagedGroupMember: true } : {})
  });
  return decision.allowed;
}

function privateFlowDeliveryFallback(
  ctx: CommandContext,
  actor: Pick<EventAuthorizationActor, 'mentionWid'>
): PrivateDeliveryFallback | undefined {
  const groupWid = ctx.groupWid?.trim() || (ctx.message.context === 'group' ? ctx.message.chatId : '');
  if (!groupWid.endsWith('@g.us')) {
    return undefined;
  }
  const mentionWid = actor.mentionWid;
  return mentionWid
    ? {
        chatId: groupWid,
        mentionedWids: [mentionWid],
        ...(ctx.message.context === 'group' ? { quotedMessageId: ctx.message.id } : {})
      }
    : undefined;
}

function eventAuthorizationActor(ctx: CommandContext): EventAuthorizationActor | undefined {
  const address = requireIdentityAddress(requireEventActor(ctx));
  const identityId = address.identityId?.trim();
  return identityId
    ? {
        identityId,
        canonicalWid: address.canonicalWid,
        deliveryChatId: address.deliveryChatId,
        mentionWid: address.mentionWid
      }
    : undefined;
}

async function resolveEventDraftAuthorizationActor(
  context: EventFlowCompletionContext,
  draft: Pick<EventDraft, 'actorIdentityId' | 'actorWid'>
): Promise<EventAuthorizationActor | undefined> {
  const expectedIdentityId = draft.actorIdentityId?.trim();
  if (!expectedIdentityId || !context.resolveStableIdentityById) {
    return undefined;
  }
  try {
    const address = await context.resolveStableIdentityById(expectedIdentityId);
    return {
      identityId: expectedIdentityId,
      canonicalWid: address.canonicalWid,
      deliveryChatId: address.deliveryChatId,
      mentionWid: address.mentionWid
    };
  } catch {
    return undefined;
  }
}

function requireEventActor(ctx: CommandContext): NonNullable<CommandContext['actor']> {
  if (!ctx.actor) {
    throw new Error('Authoritative identity address is required for the community-events command.');
  }
  return ctx.actor;
}

async function appendEventJsonLog(
  context: EventFlowCompletionContext,
  entry: Parameters<typeof appendScopeEventJsonLog>[0]['entry']
): Promise<void> {
  try {
    await appendScopeEventJsonLog({ appConfig: context.config, entry });
  } catch {
    // Do not fail event creation just because the append-only operator log is unavailable.
  }
}

async function recordEventLocationFailure(
  context: EventFlowCompletionContext,
  input: {
    phase: 'geocode' | 'prompt_dispatch';
    scopeId: string;
    eventId?: string | undefined;
    actorWid: string;
    profileId: string;
    query: string;
    error: unknown;
  }
): Promise<void> {
  await appendEventJsonLog(context, {
    action: 'event.location.failed',
    scopeId: input.scopeId,
    ...(input.eventId ? { eventId: input.eventId } : {}),
    actorWid: input.actorWid,
    profileId: input.profileId,
    metadata: {
      phase: input.phase,
      query: input.query,
      error: input.error instanceof Error ? input.error.message : String(input.error)
    }
  });
}

function eventCreationCommandIdempotencyKey(
  scopeId: string,
  actorIdentityId: string,
  messageId: string
): string {
  return `event-create:command:${scopeId}:${actorIdentityId}:${messageId}`;
}

function eventCancelDraftKey(scopeId: string, flowSessionId: string): string {
  return `event-cancel-draft:${scopeId}:${flowSessionId}`;
}

function eventUpdateDraftKey(scopeId: string, flowSessionId: string): string {
  return `event-update-draft:${scopeId}:${flowSessionId}`;
}

function eventLocationSelectionKey(id: string): string {
  return `event-location-selection:${id}`;
}

function eventLocationSelectionActiveIdentityKey(identityId: string): string {
  return `event-location-selection-active-identity:${identityId}`;
}

async function rememberActiveEventLocationSelection(
  runtime: OfficialPluginCommandRuntime,
  pending: PendingEventLocationSelection
): Promise<void> {
  const actorIdentityId = requirePendingEventActorIdentityId(pending);
  await Promise.all([
    runtime.ephemeralStore.set(
      eventLocationSelectionKey(pending.id),
      pending,
      EVENT_LOCATION_SELECTION_TTL_SECONDS
    ),
    runtime.ephemeralStore.set(
      eventLocationSelectionActiveIdentityKey(actorIdentityId),
      pending.id,
      EVENT_LOCATION_SELECTION_TTL_SECONDS
    )
  ]);
}

async function clearActiveEventLocationSelection(
  runtime: OfficialPluginCommandRuntime,
  pending: PendingEventLocationSelection
): Promise<void> {
  const actorIdentityId = requirePendingEventActorIdentityId(pending);
  await Promise.all([
    runtime.ephemeralStore.delete(eventLocationSelectionKey(pending.id)),
    runtime.ephemeralStore.delete(eventLocationSelectionActiveIdentityKey(actorIdentityId))
  ]);
}

async function findActiveEventLocationSelection(
  runtime: OfficialPluginCommandRuntime,
  actorIdentityId: string
): Promise<PendingEventLocationSelection | undefined> {
  const normalizedIdentityId = actorIdentityId.trim();
  if (!normalizedIdentityId) {
    return undefined;
  }
  const activeKey = eventLocationSelectionActiveIdentityKey(normalizedIdentityId);
  const pendingId = await runtime.ephemeralStore.get<string>(activeKey);
  if (!pendingId) {
    return undefined;
  }
  const pending = await runtime.ephemeralStore.get<PendingEventLocationSelection>(
    eventLocationSelectionKey(pendingId)
  );
  if (
    pending
    && pending.draft.actorIdentityId?.trim() === normalizedIdentityId
  ) {
    return pending;
  }
  await runtime.ephemeralStore.delete(activeKey);
  return undefined;
}

async function cancelActiveEventLocationSelectionsForActor(
  context: PluginCommandContext,
  runtime: OfficialPluginCommandRuntime,
  input: {
    actorIdentityId: string;
  }
): Promise<{ cancelled: number; scopeId?: string | undefined }> {
  const pending = await findActiveEventLocationSelection(runtime, input.actorIdentityId);
  if (!pending) {
    return { cancelled: 0 };
  }
  await clearActiveEventLocationSelection(runtime, pending);
  const cancelPromptBySubject = (context.flowEngine as {
    cancelPromptBySubject?: typeof context.flowEngine.cancelPromptBySubject;
  }).cancelPromptBySubject;
  await cancelPromptBySubject?.call(context.flowEngine, {
    purpose: EVENT_LOCATION_SELECTION_PURPOSE,
    subjectId: pending.id
  });
  return {
    cancelled: 1,
    scopeId: pending.draft.scopeId
  };
}

function requirePendingEventActorIdentityId(pending: PendingEventLocationSelection): string {
  const actorIdentityId = pending.draft.actorIdentityId?.trim();
  if (!actorIdentityId) {
    throw new Error('Event location selection requires an authoritative actor identity ID.');
  }
  return actorIdentityId;
}

function requireStoredEventActorIdentityId(event: StoredEventRecord): string {
  const actorIdentityId = event.actorIdentityId?.trim();
  if (!actorIdentityId) {
    throw new Error(`Event ${event.id} has no authoritative creator identity.`);
  }
  return actorIdentityId;
}

function eventLocationSelectionRequestedByActor(
  pending: PendingEventLocationSelection,
  voterIdentityId: string
): boolean {
  const authoritativeIdentityId = voterIdentityId.trim();
  return Boolean(
    authoritativeIdentityId
    && authoritativeIdentityId === requirePendingEventActorIdentityId(pending)
  );
}

function isCommandLikeLocationReply(value: string): boolean {
  return value.trim().startsWith('/');
}

function eventLocationCandidateOptions(candidates: GeocoderPlace[]): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  const options: Array<{ id: string; label: string }> = [];
  for (const [index, candidate] of candidates.entries()) {
    const label = candidate.label.trim();
    const key = label.toLocaleLowerCase();
    if (!label || seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({
      id: String(index),
      label
    });
    if (options.length >= EVENT_LOCATION_MAX_CANDIDATES) {
      break;
    }
  }
  return options;
}

function pendingEventFlowAnswers(answers: EventFlowAnswers): PendingEventFlowAnswers {
  return {
    ...answers,
    startsAt: answers.startsAt.toISOString()
  };
}

function eventFlowAnswersFromPending(answers: PendingEventFlowAnswers): EventFlowAnswers | undefined {
  const startsAt = new Date(answers.startsAt);
  if (!Number.isFinite(startsAt.getTime())) {
    return undefined;
  }
  return {
    ...answers,
    startsAt
  };
}
