import { scopeTimezoneSchema } from '../../../../packages/plugin-sdk/src/clock';
import { eventAnswersInTimezone } from './locationTimezone';
import { createHash, randomUUID } from 'node:crypto';
import type { WorkflowActionResult } from '../../../../packages/plugin-sdk/src/workflows';
import type { FlowDefinition, FlowState } from '../../../../packages/plugin-sdk/src/flow-types';
import type { CommandMetadata, CommandTargetSpec } from '../../../../packages/plugin-sdk/src/command-metadata';
import type { CommandContext } from '../../../../packages/plugin-sdk/src/commands';
import type { PluginCancellationRegistration, PluginCommandContext, PluginOperationContext } from './runtime';
import type { PluginRuntimeContext } from './runtime';
import { enqueuePluginJob as enqueueRuntimePluginJob } from '../../../../packages/plugin-sdk/src/jobs';
import { WHATSAPP_POLL_MAX_OPTION_CODEPOINTS } from '../../../../packages/plugin-sdk/src/poll-contract';
import {
  isManagedCommunitySubgroupPreCreateError,
  isManagedCommunitySubgroupProvisioningError
} from '../../../../packages/plugin-sdk/src/community-errors';
import type {
  OutboundSendResult,
  MessageDeletionResult,
  PrivateDeliveryFallback,
  SendTextOptions
} from '../../../../packages/plugin-sdk/src/transport';
import { requireIdentityAddress } from '../../../../packages/plugin-sdk/src/message-actor';
import { requireOfficialCommandRuntime, requireScopeId, type OfficialPluginCommandRuntime } from './runtime';
import { cancelEventLifecycle } from './cancellation';
import {
  eventAnnouncementTransportIdempotencyKey,
  sendClaimedEventAnnouncement
} from './announcementDelivery';
import { repairEventEdit } from './editRepair';
import { eventProfilePermission, localizeDefaultEventProfiles, parseEventsConfig, type EventCalendarResource, type EventProfile } from './config';
import { eventProfileQuestionSchemaRevision } from './profileRevision';
import { sendEventCalendarHint } from './calendarHint';
import { eventLifecycleCompleteAt, formatEventDateTime } from './datetime';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import { publishEventCalendarBeforeCommunityLink } from './communityLinkCalendar';
import { eventCleanupJobRequest } from './cleanupScheduling';
import {
  createEventFlowDefinition,
  eventConfirmPurpose,
  eventFlowAnswers,
  eventFlowConfirmed,
  eventFlowPastCompletionConfirmed,
  eventInitialFlowData,
  eventFlowSelectedProfileId,
  renderEventTemplate,
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
import {
  ensureEventAttendanceLifecycle,
  eventAttendanceLifecycleRequest,
  preflightEventAttendanceLifecycle
} from './attendanceLifecycle';
import { EventConditionalTextConfigurationError } from './template';
import {
  createEventStartTimeAgreement,
  markEventStartTimeAgreementExternallyResolved
} from './startTimeAgreementStore';
import {
  eventPollReplacementPublishIdempotencyKey,
  runEventPollReplacement
} from './pollReplacement';
import { eventLocationQuery, fixedEventLocation, geocodedEventLocation } from './eventLocation';
import {
  eventCreatorMembershipPauseKindForFailure,
  renderEventCreatorMembershipNotice,
  type EventCreatorMembershipPauseKind
} from './creatorMembershipNotice';
import { EVENTS_JOBS, EVENTS_PERMISSIONS, EVENTS_PLUGIN_ID } from './manifest';
import {
  completeEventCommunitySubgroup,
  configureEventCommunitySubgroup,
  createEventCommunitySubgroupCandidate,
  reconcileEventCommunitySubgroupCreator
} from './subgroups';
import {
  attemptUnplannedEventFinalization,
  eventCommunityLinkRecoveryRunAt,
  eventProvisioningProviderHealthRunAt,
  EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS,
  eventProvisioningRecoveryCursor,
  eventProvisioningRecoveryDedupeKey,
  eventProvisioningRecoveryRunAt,
  isBaileysEventPreCreateProviderUnavailableFailure
} from './provisioningRecovery';
import { eventWeatherForecastJobRequests } from './weather';
import {
  GEOCODER_GEOCODE_METHOD,
  GEOCODER_TIMEZONE_METHOD,
  geocoderTimezoneOutputSchema,
  GEOCODER_SERVICE_ID,
  type GeocodeOutput,
  type GeocoderPlace
} from './contracts/geocoder/serviceApi';
import {
  appendEventLog,
  beginEventPollReplacement,
  bindEventPollAssistantAttendanceLifecycle,
  beginEventArtifactDeletionCleanup,
  checkpointClaimedEventProvisioningChild,
  checkpointClaimedEventParticipantOutcomes,
  advanceEventProvisioningRecovery,
  claimInitialEventPreCreateProvisioningAttempt,
  claimScheduledEventPreCreateProvisioningAttempt,
  completeUnplannedEventProvisioning,
  convertOpenPollEventToUnplanned,
  markClaimedEventReadyForCommunityLink,
  nextEventRevisionTimestamp,
  configuredEventCalendarOwnership,
  eventsDatabase,
  getEvent,
  listEventsBySubgroupChatId,
  insertEvent,
  listCancellableEvents,
  listScopeEvents,
  listEventAnnouncementMessages,
  haltClaimedEventPreCreateProvisioning,
  haltClaimedKnownChildEventProvisioning,
  markClaimedEventPreCreateProvisioningMissed,
  newEventId,
  rearmClaimedEventPreCreateProvisioningAttempt,
  renewClaimedEventCommunityLinkLease,
  renewClaimedKnownChildEventProvisioningLease,
  recordEventAnnouncementMessage,
  requestEventPollClose,
  resolvedEventCalendarId,
  updateEventStructuredData,
  type EventAnnouncementDeliveryIntent,
  type EventEditRepairIntent,
  type NewStoredEventRecord,
  type StoredEventLocation,
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

export interface EventUpdateDraft {
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

interface PendingEventEditSelection {
  operation?: 'edit' | 'poll_close' | undefined;
  id: string;
  responseChatId: string;
  scopeId: string;
  actorIdentityId: string;
  actorWid: string;
  actorDeliveryChatId: string;
  actorMentionWid: string;
  actorLabel: string;
  locale: string;
  query: string;
  candidateEventIds: string[];
  originChatId: string;
  originContext: 'private' | 'group';
  privateDeliveryFallback?: PrivateDeliveryFallback | undefined;
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

export interface EventTextTransport {
  sendText(
    chatId: string,
    text: string,
    options?: SendTextOptions | undefined
  ): Promise<OutboundSendResult>;
  deleteMessage(messageId: string): Promise<MessageDeletionResult>;
  setGroupSubject(chatId: string, subject: string): Promise<void>;
}

export type EventFlowCompletionContext = PluginOperationContext | PluginRuntimeContext;

type PendingEventFlowAnswers = Omit<EventFlowAnswers, 'startsAt' | 'endsAt'> & {
  startsAt: string;
  endsAt: string;
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
const EVENT_EDIT_SELECTION_PURPOSE = 'official.community-events.edit.select';
const EVENT_EDIT_SELECTION_CANCELLATION_WORKFLOW_ID = 'event-edit-selection';
const EVENT_EDIT_FREE_TEXT_OPTION_ID = 'event-query';
const EVENT_EDIT_SELECTION_TTL_SECONDS = 30 * 60;
const EVENT_UPDATE_CONFLICT_ERROR = 'event_update_conflict';
const EVENT_POLL_PUBLICATION_OBSERVATION_MS = 35_000;
const EVENT_POLL_PUBLICATION_OBSERVATION_INTERVAL_MS = 1_000;

export function registerEventsCommands(context: PluginCommandContext): void {
  const runtime = requireOfficialCommandRuntime(context);
  const router = context.router;
  registerEventLocationSelectionHandler(context);
  registerEventEditSelectionHandler(context);

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

  router.register('event', 'poll', eventCommand({
    auditAction: 'events.poll.close',
    usage: '/event poll close [event ID or title]',
    topicId: 'close-event-polls',
    descriptionKey: 'official.community-events.help.pollClose',
    exampleKey: 'official.community-events.help.pollClose.example',
    requiresCurrentManagedGroupMembership: false,
    privateManagedTargetArgPosition: false,
    assistant: {
      intentTags: ['event', 'poll', 'close'],
      argumentHints: ['close [event ID or title]'],
      examples: ['/event poll close', '/event poll close evt-1234abcd'],
      executable: true,
      requiresConfirmation: false
    }
  }), async (ctx) => startEventPollClose(context, ctx));

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

export function registerEventsCancellations(context: PluginOperationContext): PluginCancellationRegistration[] {
  const runtime = requireOfficialCommandRuntime(context);
  return [
    {
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
    },
    {
      workflowId: EVENT_EDIT_SELECTION_CANCELLATION_WORKFLOW_ID,
      cancel: async (input) => {
        const actorIdentityId = input.actorIdentityId.trim();
        if (!actorIdentityId) {
          return undefined;
        }
        const result = await cancelActiveEventEditSelectionForActor(context, runtime, actorIdentityId);
        if (result.cancelled === 0) {
          return undefined;
        }
        const t = await context.i18n.translatorForIdentity(actorIdentityId, result.scopeId);
        return {
          workflowId: EVENT_EDIT_SELECTION_CANCELLATION_WORKFLOW_ID,
          cancelled: true,
          text: t('official.community-events.cancelled')
        };
      }
    }
  ];
}

async function startEventFlow(context: PluginOperationContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const actor = eventAuthorizationActor(ctx);
  if (!actor) {
    return { handled: true, text: ctx.t('official.community-events.permissionDenied') };
  }
  await cancelActiveEventLocationSelectionsForActor(context, runtime, {
    actorIdentityId: actor.identityId
  });
  await cancelActiveEventEditSelectionForActor(context, runtime, actor.identityId);
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

async function startEventEditFlow(context: PluginOperationContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const actor = eventAuthorizationActor(ctx);
  if (!actor) {
    return { handled: true, text: ctx.t('official.community-events.update.permissionDenied') };
  }
  await cancelActiveEventLocationSelectionsForActor(context, runtime, {
    actorIdentityId: actor.identityId
  });
  await cancelActiveEventEditSelectionForActor(context, runtime, actor.identityId);
  const scopeId = requireScopeId(ctx);
  const config = parseEventsConfig(await runtime.configFor(scopeId, actor.identityId));
  if (!config.enabled) {
    return { handled: true, text: ctx.t('official.community-events.disabled') };
  }

  const db = eventsDatabase(runtime.databases);
  const query = ctx.command.args.join(' ').trim();
  const originSubgroupChatId = ctx.message.context === 'group' ? ctx.message.chatId : undefined;
  const scopeEvents = listScopeEvents(db, scopeId);
  const originSubgroupEvents = originSubgroupChatId
    ? scopeEvents.filter((event) => event.subgroupChatId === originSubgroupChatId)
    : [];
  const subgroupMatches = !query && originSubgroupChatId
    ? listEventsBySubgroupChatId(db, scopeId, originSubgroupChatId).filter(eventIsEditable)
    : [];
  const allEditable = scopeEvents.filter(eventIsEditable);
  const shouldDiscoverUpcoming = !query && (
    ctx.message.context === 'private' || originSubgroupEvents.length === 0
  );
  const discoveryNow = Date.now();
  const discoveryMatches = shouldDiscoverUpcoming
    ? scopeEvents.filter((event) => eventIsBareEditDiscoveryCandidate(event, discoveryNow))
    : [];
  if (subgroupMatches.length > 1) {
    return { handled: true, text: ctx.t('official.community-events.update.ambiguous') };
  }
  const rawMatches = subgroupMatches.length === 1
    ? subgroupMatches
    : query
      ? findEventMatches(allEditable, query, ctx.locale)
      : discoveryMatches;

  if (rawMatches.length === 0) {
    return { handled: true, text: ctx.t('official.community-events.edit.noEvents') };
  }
  const matches = await authorizedEventEditCandidates(context, rawMatches, actor);
  if (matches.length === 0) {
    return { handled: true, text: ctx.t('official.community-events.update.permissionDenied') };
  }
  if (matches.length > 1) {
    return startEventEditSelection(context, ctx, {
      scopeId,
      actor,
      query,
      candidates: matches
    });
  }

  const event = matches[0]!;
  const creatorIdentityId = event.actorIdentityId;
  return startEventUpdateFlow(context, ctx, {
    event,
    config,
    requestedTitle: eventDisplayTitle(event),
    sourcePluginId: EVENTS_PLUGIN_ID,
    actor,
    creatorIdentityId,
    externalIdempotencyKey: eventUpdateCommandIdempotencyKey(
      scopeId,
      actor.identityId,
      ctx.message.id,
      event.id
    )
  });
}

function eventPollIsOpen(event: StoredEventRecord): boolean {
  return event.eventStatus === 'active' && event.groupLifecycleStatus === 'poll_open' && Boolean(event.pollWaMsgId);
}

async function startEventPollClose(context: PluginOperationContext, ctx: CommandContext) {
  if (ctx.command.args[0]?.toLowerCase() !== 'close') {
    return { handled: true, text: ctx.t('official.community-events.pollClose.usage') };
  }
  const actor = eventAuthorizationActor(ctx);
  if (!actor) return { handled: true, text: ctx.t('official.community-events.pollClose.permissionDenied') };
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const query = ctx.command.args.slice(1).join(' ').trim();
  const openEvents = listScopeEvents(eventsDatabase(runtime.databases), scopeId).filter(eventPollIsOpen);
  const matches = query ? findEventMatches(openEvents, query, ctx.locale) : openEvents;
  const candidates = matches.filter((event) => event.actorIdentityId === actor.identityId);
  if (!candidates.length) {
    return { handled: true, text: ctx.t(query && matches.length
      ? 'official.community-events.pollClose.permissionDenied'
      : 'official.community-events.pollClose.noEvents') };
  }
  await cancelActiveEventEditSelectionForActor(context, runtime, actor.identityId);
  if (candidates.length > 1) {
    return startEventEditSelection(context, ctx, { scopeId, actor, query, candidates, operation: 'poll_close' });
  }
  const result = await closeSelectedEventPoll(runtime, candidates[0]!, actor);
  return { handled: true, text: ctx.t(result.messageKey, result.params) };
}

async function closeSelectedEventPoll(
  runtime: OfficialPluginCommandRuntime,
  event: StoredEventRecord,
  actor: EventAuthorizationPrincipal
): Promise<{ messageKey: string; params?: Record<string, string> }> {
  if (event.actorIdentityId !== actor.identityId) {
    return { messageKey: 'official.community-events.pollClose.permissionDenied' };
  }
  const config = parseEventsConfig(await runtime.configFor(event.scopeId, actor.identityId));
  if (!config.enabled) return { messageKey: 'official.community-events.disabled' };
  const db = eventsDatabase(runtime.databases);
  const requested = requestEventPollClose(db, {
    eventId: event.id, scopeId: event.scopeId, actorIdentityId: actor.identityId, requestedAt: new Date()
  });
  if (!requested) return { messageKey: 'official.community-events.pollClose.unavailable' };
  try {
    await runtime.enqueuePluginJob({
      jobName: EVENTS_JOBS.close,
      scopeId: requested.scopeId,
      ...(requested.groupId ? { groupId: requested.groupId } : {}),
      ...(requested.groupWid ? { groupWid: requested.groupWid } : {}),
      runAt: new Date(requested.closeAt),
      payload: { eventId: requested.id, pollGeneration: requested.pollGeneration, pollWaMsgId: requested.pollWaMsgId },
      dedupeKey: `${EVENTS_JOBS.close}:${requested.id}:manual:${requested.pollGeneration}:${requested.pollCloseCutoffAt}`
    });
  } catch {
    // The durable cutoff makes the existing queue-handoff recovery sweep retry this close.
    appendEventLog(db, { eventId: requested.id, action: 'events.poll.manual_close_enqueue_pending' });
  }
  return {
    messageKey: 'official.community-events.pollClose.queued',
    params: { title: eventDisplayTitle(requested), eventId: requested.id }
  };
}

async function startEventEditSelection(
  context: PluginOperationContext,
  ctx: CommandContext,
  input: {
    scopeId: string;
    actor: EventAuthorizationActor;
    query: string;
    candidates: StoredEventRecord[];
    operation?: 'edit' | 'poll_close' | undefined;
  }
) {
  const runtime = requireOfficialCommandRuntime(context);
  const privateDeliveryFallback = privateFlowDeliveryFallback(ctx, input.actor);
  const pending: PendingEventEditSelection = {
    ...(input.operation ? { operation: input.operation } : {}),
    id: randomUUID(),
    responseChatId: input.actor.deliveryChatId,
    scopeId: input.scopeId,
    actorIdentityId: input.actor.identityId,
    actorWid: input.actor.canonicalWid,
    actorDeliveryChatId: input.actor.deliveryChatId,
    actorMentionWid: input.actor.mentionWid,
    actorLabel: ctx.message.senderDisplayName ?? ctx.message.senderWid,
    locale: ctx.locale,
    query: input.query,
    candidateEventIds: orderedEventEditCandidates(input.candidates).map((event) => event.id),
    originChatId: ctx.message.chatId,
    originContext: ctx.message.context,
    ...(privateDeliveryFallback ? { privateDeliveryFallback } : {}),
    createdAt: new Date().toISOString()
  };

  let prompted: Awaited<ReturnType<typeof promptEventEditSelection>>;
  try {
    prompted = await promptEventEditSelection({
      context,
      runtime,
      pending,
      candidates: input.candidates,
      t: ctx.t
    });
  } catch {
    return {
      handled: true,
      text: ctx.t('official.community-events.edit.selectionStartFailed')
    };
  }
  if (ctx.message.context !== 'group') {
    return { handled: true, response: { kind: 'none' as const } };
  }
  return {
    handled: true,
    text: ctx.t(prompted.usedPrivateDeliveryFallback
      ? 'official.community-events.edit.selectionStartedInGroupFallback'
      : 'official.community-events.edit.selectionStartedPrivate')
  };
}

async function promptEventEditSelection(input: {
  context: PluginOperationContext;
  runtime: OfficialPluginCommandRuntime;
  pending: PendingEventEditSelection;
  candidates: StoredEventRecord[];
  t: CommandContext['t'];
}): Promise<{ usedPrivateDeliveryFallback: boolean }> {
  const candidatesById = new Map(input.candidates.map((event) => [event.id, event]));
  const options = input.pending.candidateEventIds.flatMap((eventId) => {
    const event = candidatesById.get(eventId);
    return event
      ? [{ id: event.id, label: eventEditChoiceLabel(event, input.t, input.pending.locale) }]
      : [];
  });
  await rememberActiveEventEditSelection(input.runtime, input.pending);
  try {
    const prompt = await input.context.flowEngine.promptChoice({
      purpose: EVENT_EDIT_SELECTION_PURPOSE,
      subjectType: 'CommunityEventEditSelection',
      subjectId: input.pending.id,
      question: input.t(options.length > 0
        ? input.pending.operation === 'poll_close' ? 'official.community-events.pollClose.select' : 'official.community-events.edit.select'
        : input.pending.operation === 'poll_close' ? 'official.community-events.pollClose.noMatches' : 'official.community-events.edit.noMatches', {
        query: input.pending.query
      }),
      options,
      freeTextOption: {
        id: EVENT_EDIT_FREE_TEXT_OPTION_ID,
        label: input.t('official.community-events.edit.refine')
      },
      recipientWids: [input.pending.responseChatId],
      eligibleVoterIdentityIds: [input.pending.actorIdentityId],
      selectionRule: 'SINGLE',
      minSelections: 1,
      maxSelections: 1,
      ...(input.pending.privateDeliveryFallback
        ? { privateDeliveryFallback: input.pending.privateDeliveryFallback }
        : {}),
      questionSendOptions: {
        idempotencyKey: `community-events:event-edit-selection:${input.pending.id}`
      },
      expiresAt: new Date(Date.now() + EVENT_EDIT_SELECTION_TTL_SECONDS * 1000),
      t: input.t
    });
    return {
      usedPrivateDeliveryFallback: Boolean(prompt.privateDeliveryFallback)
    };
  } catch (error) {
    await clearActiveEventEditSelection(input.runtime, input.pending);
    throw error;
  }
}

async function listFutureEvents(context: PluginOperationContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const config = parseEventsConfig(await runtime.configFor(scopeId, eventAuthorizationActor(ctx)?.identityId));
  if (!config.enabled) {
    return { handled: true, text: ctx.t('official.community-events.disabled') };
  }
  const now = Date.now();
  const events = listScopeEvents(eventsDatabase(runtime.databases), scopeId)
    .filter((event) => event.eventStatus === 'active' && new Date(event.lifecycleCompleteAt).getTime() > now)
    .sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime() || left.id.localeCompare(right.id));
  if (events.length === 0) {
    return { handled: true, text: ctx.t('official.community-events.list.none') };
  }
  const section = (spanKind: StoredEventRecord['spanKind'], key: string): string => {
    const items = events
      .filter((event) => event.spanKind === spanKind)
      .map((event) => ctx.t('official.community-events.list.item', {
        title: eventDisplayTitle(event),
        range: eventRangeLabel(event, ctx.locale),
        span: ctx.t(spanKind === 'day_trip'
          ? 'official.community-events.span.dayTrip'
          : 'official.community-events.span.multiDay'),
        status: eventLifecycleLabel(event, ctx.t),
        eventId: event.id
      }));
    return items.length > 0 ? ctx.t(key, { events: items.join('\n') }) : '';
  };
  const sections = [
    section('day_trip', 'official.community-events.list.dayTrips'),
    section('multi_day', 'official.community-events.list.multiDay')
  ].filter(Boolean);
  return {
    handled: true,
    text: ctx.t('official.community-events.list.result', {
      count: String(events.length),
      events: sections.join('\n\n')
    })
  };
}

async function startEventCancelFlow(context: PluginOperationContext, ctx: CommandContext) {
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
  context: PluginOperationContext,
  ctx: CommandContext,
  input: {
    event: StoredEventRecord;
    config: ReturnType<typeof parseEventsConfig>;
    requestedTitle: string;
    sourcePluginId: string;
    actor: EventAuthorizationActor;
    creatorIdentityId?: string | undefined;
    externalIdempotencyKey: string;
  }
) {
  let started: Awaited<ReturnType<typeof beginEventUpdateFlow>>;
  try {
    started = await beginEventUpdateFlow(context, {
      ...input,
      t: ctx.t,
      locale: ctx.locale,
      actorLabel: ctx.message.senderDisplayName ?? ctx.message.senderWid,
      origin: {
        chatId: ctx.message.chatId,
        context: ctx.message.context
      },
      privateDeliveryFallback: privateFlowDeliveryFallback(ctx, input.actor)
    });
  } catch {
    return {
      handled: true,
      text: ctx.message.context === 'group'
        ? ctx.t('official.community-events.update.privateStartFailed')
        : ctx.t('official.community-events.update.startFailed')
    };
  }
  if (started.status === 'not_configured') {
    return { handled: true, text: ctx.t('official.community-events.notConfigured') };
  }
  if (ctx.message.context !== 'group') {
    return { handled: true, response: { kind: 'none' as const } };
  }
  return {
    handled: true,
    text: ctx.t(started.usedPrivateDeliveryFallback
      ? 'official.community-events.update.startedInGroupFallback'
      : 'official.community-events.update.startedPrivate')
  };
}

async function beginEventUpdateFlow(
  context: PluginOperationContext,
  input: {
    event: StoredEventRecord;
    config: ReturnType<typeof parseEventsConfig>;
    requestedTitle: string;
    sourcePluginId: string;
    actor: EventAuthorizationActor;
    creatorIdentityId?: string | undefined;
    externalIdempotencyKey: string;
    t: CommandContext['t'];
    locale: string;
    actorLabel: string;
    origin: { chatId: string; context: 'private' | 'group' };
    privateDeliveryFallback?: PrivateDeliveryFallback | undefined;
  }
): Promise<
  | { status: 'started'; flowSessionId: string; usedPrivateDeliveryFallback: boolean }
  | { status: 'not_configured' }
> {
  const runtime = requireOfficialCommandRuntime(context);
  const eventProfiles = localizeDefaultEventProfiles(input.config.eventProfiles, input.t);
  const profile = eventProfiles.find((candidate) => candidate.id === input.event.profileId);
  if (!profile) {
    return { status: 'not_configured' };
  }

  const timezone = input.event.timezone || input.config.timezone;
  const replacesOpenPoll = input.event.eventStatus === 'active' &&
    input.event.groupLifecycleStatus === 'poll_open';
  const prefill = eventUpdatePrefill(input.event, profile);
  const startedAt = new Date();
  const initialData = eventInitialFlowData([profile], prefill, {
    timezone,
    locale: input.locale,
    now: startedAt,
    allowPast: !replacesOpenPoll
  });
  const definition = createEventFlowDefinition({
    t: input.t,
    profiles: [profile],
    prefill,
    timezone,
    locale: input.locale,
    initialData,
    askPrefilledQuestions: true,
    flowTypePrefix: 'official.community-events.update',
    flowInstanceId: eventUpdateFlowInstanceId(input.externalIdempotencyKey),
    confirmMessageKey: replacesOpenPoll
      ? 'official.community-events.update.confirmOpenPoll'
      : 'official.community-events.update.confirm',
    pastCompletionConfirmMessageKey: input.event.eventStatus === 'active'
      ? 'official.community-events.update.confirmPastCompletion'
      : 'official.community-events.update.confirm',
    allowPastStartsAt: !replacesOpenPoll,
    now: () => startedAt,
    completeMessageKey: false
  });
  registerEventUpdateFlowCompletionHandler(context, definition.flowType, profile, input.t);

  const flowStart = await context.flowEngine.startFlowForIdentity({
      definition,
      actorIdentityId: input.actor.identityId,
      externalIdempotencyKey: input.externalIdempotencyKey,
      origin: input.origin,
      scopeId: input.event.scopeId,
      initialData,
      ...(input.privateDeliveryFallback ? { privateDeliveryFallback: input.privateDeliveryFallback } : {}),
      onSessionCreated: async (session) => {
        await runtime.dataStore.set(eventUpdateDraftKey(input.event.scopeId, session.id), {
          flowSessionId: session.id,
          flowType: definition.flowType,
          scopeId: input.event.scopeId,
          ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
          ...(input.event.groupWid ? { groupWid: input.event.groupWid } : {}),
          chatId: input.actor.deliveryChatId,
          eventId: input.event.id,
          eventUpdatedAt: input.event.updatedAt,
          requestedTitle: input.requestedTitle,
          sourcePluginId: input.sourcePluginId,
          actorWid: input.actor.canonicalWid,
          actorIdentityId: input.actor.identityId,
          ...(input.creatorIdentityId ? { creatorIdentityId: input.creatorIdentityId } : {}),
          actorLabel: input.actorLabel,
          ...(input.privateDeliveryFallback ? { privateDeliveryFallback: input.privateDeliveryFallback } : {}),
          timezone,
          locale: input.locale,
          profile,
          profiles: eventProfiles,
          calendars: input.config.calendars,
          prefill,
          createdAt: new Date().toISOString()
        } satisfies EventUpdateDraft);
      },
      onSessionStartFailed: async (session) => {
        await runtime.dataStore.delete(eventUpdateDraftKey(input.event.scopeId, session.id));
      }
    });
  return {
    status: 'started',
    flowSessionId: flowStart.flowSessionId,
    usedPrivateDeliveryFallback: Boolean(flowStart.privateDeliveryFallback)
  };
}

function registerEventUpdateFlowCompletionHandler(
  context: PluginOperationContext,
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

    if (!eventFlowConfirmed(snapshot, draft.profile)) {
      await runtime.dataStore.delete(eventUpdateDraftKey(snapshot.scopeId, lock.flowSessionId));
      await activeTransport.sendText(responseChatId, t('official.community-events.update.cancelled'));
      return true;
    }

    const db = eventsDatabase(runtime.databases);
    const event = getEvent(db, draft.eventId);
    if (!event || !eventIsEditable(event) || event.updatedAt !== draft.eventUpdatedAt) {
      await runtime.dataStore.delete(eventUpdateDraftKey(snapshot.scopeId, lock.flowSessionId));
      await activeTransport.sendText(responseChatId, t('official.community-events.update.invalid'));
      return true;
    }
    if (!await eventUpdateAllowed(context, {
      event,
      actor: { identityId: draft.actorIdentityId, canonicalWid: draft.actorWid },
      creatorIdentityId: draft.creatorIdentityId
    })) {
      await runtime.dataStore.delete(eventUpdateDraftKey(snapshot.scopeId, lock.flowSessionId));
      await activeTransport.sendText(responseChatId, t('official.community-events.update.permissionDenied'));
      return true;
    }

    let answers: EventFlowAnswers | undefined;
    try {
      answers = eventFlowAnswers(snapshot, draft.profile, draft.timezone, draft.locale);
    } catch (error) {
      if (!(error instanceof EventConditionalTextConfigurationError)) throw error;
      await runtime.dataStore.delete(eventUpdateDraftKey(snapshot.scopeId, lock.flowSessionId));
      await appendEventJsonLog(context, {
        action: 'event.update_template_invalid',
        scopeId: draft.scopeId,
        eventId: draft.eventId,
        actorIdentityId: draft.actorIdentityId,
        actorWid: draft.actorWid,
        profileId: draft.profile.id,
        metadata: { field: error.field, code: error.code }
      });
      await activeTransport.sendText(responseChatId, t('official.community-events.templateConfigurationInvalid'));
      return true;
    }
    await runtime.dataStore.delete(eventUpdateDraftKey(snapshot.scopeId, lock.flowSessionId));
    if (!answers) {
      await activeTransport.sendText(responseChatId, t('official.community-events.update.invalid'));
      return true;
    }
    const lifecycleCompleteAt = eventLifecycleCompleteAt({
      localDate: answers.localDate,
      ...(answers.localTime ? { localTime: answers.localTime } : {}),
      endsAt: answers.endsAt,
      spanKind: answers.spanKind,
      timezone: draft.timezone
    });
    const startsInPast = Boolean(lifecycleCompleteAt && lifecycleCompleteAt.getTime() <= Date.now());
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
  context: PluginOperationContext;
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
    await applyEventUpdate({ ...input, eventId: input.event.id, eventLocation: fixedLocation });
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
    await applyEventUpdate({
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

export async function applyEventUpdate(input: {
  notify?: boolean | undefined;
  context: PluginOperationContext;
  runtime: OfficialPluginCommandRuntime;
  activeTransport: EventTextTransport;
  responseChatId: string;
  draft: EventUpdateDraft;
  eventId: string;
  answers: EventFlowAnswers;
  eventLocation: StoredEventLocation;
  pastCompletionConfirmed: boolean;
  t: CommandContext['t'];
}): Promise<WorkflowActionResult> {
  let replyText = '';
  const reply = async (text: string) => {
    replyText = text;
    if (input.notify !== false) await input.activeTransport.sendText(input.responseChatId, text);
  };
  const db = eventsDatabase(input.runtime.databases);
  const event = getEvent(db, input.eventId);
  if (!event || !eventIsEditable(event) || event.updatedAt !== input.draft.eventUpdatedAt) {
    await reply(
      input.t('official.community-events.update.invalid')
    );
    return { status: 'blocked', reason: replyText, retryable: false };
  }
  if (!await eventUpdateAllowed(input.context, {
    event,
    actor: {
      identityId: input.draft.actorIdentityId,
      canonicalWid: input.draft.actorWid
    },
    creatorIdentityId: input.draft.creatorIdentityId
  })) {
    await reply(
      input.t('official.community-events.update.permissionDenied')
    );
    return { status: 'blocked', reason: replyText, retryable: false };
  }
  if (!await eventProfileSnapshotIsCurrent({
    runtime: input.runtime,
    scopeId: input.draft.scopeId,
    actorIdentityId: input.draft.actorIdentityId,
    snapshot: input.draft.profile,
    t: input.t
  })) {
    await reply(
      input.t('official.community-events.update.invalid')
    );
    return { status: 'blocked', reason: replyText, retryable: false };
  }
  try {
    input = { ...input,
      draft: { ...input.draft, timezone: scopeTimezoneSchema.parse(input.eventLocation.timezone) },
      answers: eventAnswersInTimezone(input.answers, input.eventLocation.timezone)
    };
    const materialized = materializeEventLifecycle({
      profile: input.draft.profile,
      answers: input.answers,
      timezone: input.draft.timezone,
      locale: (await input.context.i18n.resolveScopeLocale(input.draft.scopeId)).locale,
      creatorDisplayName: event.actorLabel || event.actorWid,
      eventLocation: input.eventLocation
    });
    const now = new Date();
    const eventEnded = materialized.lifecycleCompleteAt.getTime() <= now.getTime();
    if (event.eventStatus === 'active' && eventEnded && !input.pastCompletionConfirmed) {
      await reply(
        input.t('official.community-events.update.pastCompletionConfirmationRequired')
      );
      return { status: 'blocked', reason: replyText, retryable: false };
    }
    const config = draftEventsConfig({
      timezone: input.draft.timezone,
      calendars: input.draft.calendars,
      profiles: input.draft.profiles
    });
    const openPollEdit = event.eventStatus === 'active' && event.groupLifecycleStatus === 'poll_open';
    const outcome = openPollEdit && materialized.closeAt.getTime() <= now.getTime()
      ? await convertOpenPollEditToUnplannedLifecycle({
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
          t: input.t,
          now,
          operationId: input.draft.flowSessionId,
          sourcePluginId: input.draft.sourcePluginId
        })
      : openPollEdit
        ? await replaceOpenEventPollLifecycle({
          context: input.context,
          runtime: input.runtime,
          activeTransport: input.activeTransport,
          db,
          event,
          profile: input.draft.profile,
          config,
          materialized,
          actorWid: input.draft.actorWid,
          actorIdentityId: input.draft.actorIdentityId,
          actorLabel: input.draft.actorLabel,
          locale: input.draft.locale,
          requestedTitle: input.draft.requestedTitle,
          now,
          operationId: input.draft.flowSessionId,
          sourcePluginId: input.draft.sourcePluginId
          })
        : await updateEventLifecycle({
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
    if ('replacementStatus' in outcome && outcome.replacementStatus !== 'completed') {
      await reply(
        input.t(outcome.replacementStatus === 'pending'
          ? 'official.community-events.update.replacementQueued'
          : 'official.community-events.update.replacementExpired', {
          title: materialized.groupTitle,
          eventId: event.id
        })
      );
      return outcome.replacementStatus === 'pending'
        ? { status: 'pending', operationId: input.draft.flowSessionId, summary: replyText }
        : { status: 'blocked', reason: replyText, retryable: false };
    }
    if (!outcome.changed) {
      await reply(
        input.t('official.community-events.update.noChanges', {
          title: materialized.groupTitle,
          eventId: event.id
        })
      );
      return { status: 'completed', output: { eventId: event.id, updatedAt: event.updatedAt }, summary: replyText };
    }
    const doneMessageKey = 'convertedToUnplanned' in outcome && outcome.convertedToUnplanned
      ? 'official.community-events.update.convertedToUnplanned'
      : outcome.repairPending
      ? outcome.completedNow
        ? 'official.community-events.update.donePastCompletionRepairPending'
        : 'official.community-events.update.doneRepairPending'
      : outcome.completedNow
        ? 'official.community-events.update.donePastCompletion'
        : 'official.community-events.update.done';
    await reply(
      input.t(doneMessageKey, {
        title: materialized.groupTitle,
        eventId: event.id,
        startsAt: formatEventDateTime(materialized.startsAt, materialized.timezone, input.draft.locale),
        endsAt: formatEventDateTime(materialized.endsAt, materialized.timezone, input.draft.locale),
        cleanupAt: formatEventDateTime(outcome.cleanupAt, materialized.timezone, input.draft.locale)
      })
    );
    return outcome.repairPending
      ? { status: 'pending', operationId: input.draft.flowSessionId, summary: replyText }
      : { status: 'completed', output: { eventId: event.id, updatedAt: getEvent(db, event.id)!.updatedAt }, summary: replyText };
  } catch (error) {
    const templateFailure = error instanceof EventConditionalTextConfigurationError ? error : undefined;
    const reason = error instanceof Error ? error.message : String(error);
    await appendEventJsonLog(input.context, {
      action: 'event.update_failed',
      scopeId: input.draft.scopeId,
      eventId: input.draft.eventId,
      actorWid: input.draft.actorWid,
      profileId: input.draft.profile.id,
      metadata: templateFailure
        ? { field: templateFailure.field, code: templateFailure.code, sourcePluginId: input.draft.sourcePluginId }
        : { reason, sourcePluginId: input.draft.sourcePluginId }
    });
    await reply(
      templateFailure
        ? input.t('official.community-events.templateConfigurationInvalid')
        : reason === EVENT_UPDATE_CONFLICT_ERROR
          ? input.t('official.community-events.update.invalid')
          : input.t('official.community-events.update.failed')
    );
    return { status: 'failed', reason: replyText, retryable: false };
  }
}

async function replaceOpenEventPollLifecycle(input: {
  context: PluginOperationContext;
  runtime: OfficialPluginCommandRuntime;
  activeTransport: EventTextTransport;
  db: ReturnType<typeof eventsDatabase>;
  event: StoredEventRecord;
  profile: EventProfile;
  config: ReturnType<typeof parseEventsConfig>;
  materialized: MaterializedEventLifecycle;
  actorWid: string;
  actorIdentityId: string;
  actorLabel: string;
  locale: string;
  requestedTitle: string;
  now: Date;
  operationId: string;
  sourcePluginId?: string | undefined;
}): Promise<{
  changed: boolean;
  completedNow: false;
  repairPending: boolean;
  cleanupAt: Date;
  replacementStatus: 'completed' | 'pending' | 'aborted';
}> {
  const timezone = input.materialized.timezone;
  const cleanupAt = input.materialized.cleanupAt;
  if (!eventStructuredDataChanged(input.event, {
    materialized: input.materialized,
    cleanupAt,
    timezone
  })) {
    return {
      changed: false,
      completedNow: false,
      repairPending: false,
      cleanupAt,
      replacementStatus: 'completed'
    };
  }
  if (!input.event.pollWaMsgId) {
    throw new Error(EVENT_UPDATE_CONFLICT_ERROR);
  }
  const calendarId = resolvedEventCalendarId(input.event);
  const liveSubgroupChatId = input.event.subgroupChatId;
  if (liveSubgroupChatId) {
    const capabilities = await input.context.botCapabilitiesFor?.(liveSubgroupChatId);
    if (capabilities && (!capabilities.botIsAdmin || !capabilities.canChangeInfo || !capabilities.canSetSubject)) {
      throw new Error('Bot cannot change the event subgroup subject.');
    }
  }
  const prospectiveUpdatedAt = nextEventRevisionTimestamp(input.event.updatedAt, input.now);
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
      profileLabel: input.profile.label,
      profileRevision: eventProfileQuestionSchemaRevision(input.profile),
      pollGeneration: input.event.pollGeneration + 1,
      pollQuestion: input.materialized.pollQuestion,
      pollOptions: input.materialized.pollOptions,
      responseClasses: input.materialized.responseClasses,
      answers: input.materialized.answers,
      eventLocation: input.materialized.eventLocation,
      startsAt: input.materialized.startsAt.toISOString(),
      startsAtUtc: input.materialized.startsAt.toISOString(),
      endsAt: input.materialized.endsAt.toISOString(),
      lifecycleCompleteAt: input.materialized.lifecycleCompleteAt.toISOString(),
      spanKind: input.materialized.spanKind,
      timezone,
      localDate: input.materialized.localDate,
      localTime: input.materialized.localTime,
      place: input.materialized.place,
      closeAt: input.materialized.closeAt.toISOString(),
      cleanupAt: cleanupAt.toISOString(),
      groupTitle: input.materialized.groupTitle,
      ...(liveSubgroupChatId ? { subgroupTitle: input.materialized.groupTitle } : {}),
      calendarDurationMinutes: input.materialized.calendarDurationMinutes,
      calendarLocation: input.materialized.calendarLocation,
      calendarDescription: input.materialized.calendarDescription,
      updatedAt: prospectiveUpdatedAt
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
  const repairIntent: EventEditRepairIntent = {
    operationId: input.operationId,
    scopeId: input.event.scopeId,
    ...(liveSubgroupChatId ? { subgroupChatId: liveSubgroupChatId } : {}),
    targetGroupTitle: input.materialized.groupTitle,
    calendarId: calendarId ?? '',
    ...(announcementIntent ? { announcementDeliveryKey: announcementIntent.deliveryKey } : {}),
    ...(input.profile.calendar.hint.sendOnPollPublished && input.event.announcementGroupWid
      ? {
          calendarHintDeliveryKey: input.operationId,
          calendarHintLocale: input.locale
        }
      : {})
  };
  const attendanceGroupWid = input.event.announcementGroupWid?.trim()
    || input.event.groupWid?.trim();
  if (!attendanceGroupWid) {
    throw new Error('Event attendance lifecycle has no announcement group.');
  }
  const attendanceRequest = eventAttendanceLifecycleRequest({
    eventId: input.event.id,
    generation: input.event.pollGeneration + 1,
    groupWid: attendanceGroupWid,
    question: input.materialized.pollQuestion,
    options: input.materialized.pollOptions,
    allowMultipleAnswers: input.profile.poll.allowMultipleAnswers,
    closeAt: input.materialized.closeAt.toISOString()
  });
  await preflightEventAttendanceLifecycle({
    services: input.context.services,
    scopeId: input.event.scopeId,
    actorIdentityId: input.actorIdentityId,
    ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
    groupWid: attendanceGroupWid
  }, attendanceRequest);
  beginEventPollReplacement(input.db, {
    operationId: input.operationId,
    eventId: input.event.id,
    scopeId: input.event.scopeId,
    expectedEventUpdatedAt: input.event.updatedAt,
    expectedPollWaMsgId: input.event.pollWaMsgId,
    expectedPollGeneration: input.event.pollGeneration,
    target: {
      profileLabel: input.profile.label,
      profileRevision: eventProfileQuestionSchemaRevision(input.profile),
      pollQuestion: input.materialized.pollQuestion,
      pollOptions: input.materialized.pollOptions,
      responseClasses: input.materialized.responseClasses,
      answers: input.materialized.answers,
      ...(input.materialized.eventLocation ? { eventLocation: input.materialized.eventLocation } : {}),
      startsAt: input.materialized.startsAt.toISOString(),
      startsAtUtc: input.materialized.startsAt.toISOString(),
      endsAt: input.materialized.endsAt.toISOString(),
      lifecycleCompleteAt: input.materialized.lifecycleCompleteAt.toISOString(),
      spanKind: input.materialized.spanKind,
      timezone,
      localDate: input.materialized.localDate,
      ...(input.materialized.localTime ? { localTime: input.materialized.localTime } : {}),
      ...(input.materialized.place ? { place: input.materialized.place } : {}),
      closeAt: input.materialized.closeAt.toISOString(),
      cleanupAt: cleanupAt.toISOString(),
      groupTitle: input.materialized.groupTitle,
      calendarDurationMinutes: input.materialized.calendarDurationMinutes,
      ...(input.materialized.calendarLocation
        ? { calendarLocation: input.materialized.calendarLocation }
        : {}),
      ...(input.materialized.calendarDescription
        ? { calendarDescription: input.materialized.calendarDescription }
        : {}),
      allowMultipleAnswers: input.profile.poll.allowMultipleAnswers,
      ...(announcementIntent ? { announcementIntent } : {}),
      repairIntent
    },
    editorIdentityId: input.actorIdentityId,
    editorWid: input.actorWid,
    editorLabel: input.actorLabel,
    locale: input.locale,
    sourcePluginId: input.sourcePluginId ?? EVENTS_PLUGIN_ID,
    publishIdempotencyKey: eventPollReplacementPublishIdempotencyKey({
      eventId: input.event.id,
      operationId: input.operationId,
      nextPollGeneration: input.event.pollGeneration + 1
    }),
    attendanceLifecycle: {
      owner: 'poll_assistant',
      generation: input.event.pollGeneration + 1,
      sourceIdempotencyKey: attendanceRequest.sourceIdempotencyKey,
      request: attendanceRequest
    },
    createdAt: input.now.toISOString()
  });
  const run = await runEventPollReplacement({
    context: input.context,
    db: input.db,
    operationId: input.operationId,
    deleteMessage: (messageId) => input.activeTransport.deleteMessage(messageId)
  });
  if (run.status === 'pending') {
    try {
      await input.runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.pollReplacement,
        scopeId: input.event.scopeId,
        ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
        ...(input.event.groupWid ? { groupWid: input.event.groupWid } : {}),
        runAt: run.retryAt,
        payload: { operationId: input.operationId },
        dedupeKey: `${EVENTS_JOBS.pollReplacement}:${input.operationId}:core:${run.replacement.failureCount}:${run.retryAt.toISOString()}`
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      appendEventLog(input.db, {
        eventId: input.event.id,
        action: 'events.poll_replacement.enqueue_failed',
        metadata: {
          operationId: input.operationId,
          retryAt: run.retryAt.toISOString(),
          reason
        }
      });
      await appendEventJsonLog(input.context, {
        action: 'event.poll_replacement_enqueue_failed',
        scopeId: input.event.scopeId,
        eventId: input.event.id,
        actorWid: input.actorWid,
        profileId: input.event.profileId,
        pollWaMsgId: input.event.pollWaMsgId,
        metadata: {
          operationId: input.operationId,
          retryAt: run.retryAt.toISOString(),
          reason
        }
      });
    }
    return {
      changed: true,
      completedNow: false,
      repairPending: true,
      cleanupAt,
      replacementStatus: 'pending'
    };
  }
  if (run.status === 'aborted') {
    const currentEvent = getEvent(input.db, input.event.id) ?? input.event;
    const handoffFailures: string[] = [];
    if (run.retirementPending) {
      const followUpAt = run.replacement.nextAttemptAt
        ? new Date(run.replacement.nextAttemptAt)
        : new Date(input.now.getTime() + 5_000);
      try {
        await input.runtime.enqueuePluginJob({
          jobName: EVENTS_JOBS.pollReplacement,
          scopeId: run.replacement.scopeId,
          ...(currentEvent.groupId ? { groupId: currentEvent.groupId } : {}),
          ...(currentEvent.groupWid ? { groupWid: currentEvent.groupWid } : {}),
          runAt: followUpAt,
          payload: { operationId: input.operationId },
          dedupeKey: `${EVENTS_JOBS.pollReplacement}:${input.operationId}:retire:${run.replacement.retirementFailureCount}`
        });
      } catch (error) {
        handoffFailures.push(`retirement: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const retry of run.receiptReleaseRetries) {
      try {
        await input.runtime.enqueuePluginJob({
          jobName: EVENTS_JOBS.pollReplacement,
          scopeId: retry.scopeId,
          ...(currentEvent.groupId ? { groupId: currentEvent.groupId } : {}),
          ...(currentEvent.groupWid ? { groupWid: currentEvent.groupWid } : {}),
          runAt: retry.retryAt,
          payload: { operationId: retry.operationId },
          dedupeKey: `${EVENTS_JOBS.pollReplacement}:${retry.operationId}:receipt-release:${retry.failureCount}`
        });
      } catch (error) {
        handoffFailures.push(
          `receipt release ${retry.operationId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (handoffFailures.length > 0) {
      appendEventLog(input.db, {
        eventId: currentEvent.id,
        action: 'events.poll_replacement.aborted_enqueue_failed',
        metadata: { operationId: input.operationId, handoffFailures }
      });
      await appendEventJsonLog(input.context, {
        action: 'event.poll_replacement_aborted_enqueue_failed',
        scopeId: currentEvent.scopeId,
        eventId: currentEvent.id,
        actorWid: input.actorWid,
        profileId: currentEvent.profileId,
        ...(currentEvent.pollWaMsgId ? { pollWaMsgId: currentEvent.pollWaMsgId } : {}),
        metadata: { operationId: input.operationId, handoffFailures }
      });
    }
    return {
      changed: false,
      completedNow: false,
      repairPending: false,
      cleanupAt,
      replacementStatus: 'aborted'
    };
  }

  const repairFailures: string[] = [];
  const updatedEvent = run.event;
  if (updatedEvent.localTime) {
    markEventStartTimeAgreementExternallyResolved(input.db, {
      eventId: updatedEvent.id,
      localTime: updatedEvent.localTime,
      resolvedAt: updatedEvent.updatedAt
    });
  }
  let repairNeedsJob = false;
  let repairRetryAt: Date | undefined;
  try {
    const repair = await repairEventEdit({
      appConfig: input.runtime.config,
      db: input.db,
      operationId: input.operationId,
      ...(input.runtime.services ? { services: input.runtime.services } : {}),
      configFor: async () => input.config,
      sender: input.activeTransport,
      ...(input.context.getGroupInviteCode
        ? { getGroupInviteCode: input.context.getGroupInviteCode }
        : {}),
      now: input.now
    });
    repairFailures.push(...repair.failures);
    if (repair.status === 'pending') {
      repairNeedsJob = true;
      repairRetryAt = repair.retryAt;
    }
  } catch (error) {
    repairNeedsJob = true;
    repairFailures.push(`repair: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (repairNeedsJob) {
    try {
      await input.runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.editRepair,
        scopeId: updatedEvent.scopeId,
        ...(updatedEvent.groupId ? { groupId: updatedEvent.groupId } : {}),
        ...(updatedEvent.groupWid ? { groupWid: updatedEvent.groupWid } : {}),
        ...(repairRetryAt ? { runAt: repairRetryAt } : { delayMs: 5_000 }),
        payload: { operationId: input.operationId, attempt: 0 },
        dedupeKey: `${EVENTS_JOBS.editRepair}:${input.operationId}:initial`
      });
    } catch (error) {
      repairFailures.push(`repair_job: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const closeAt = new Date(updatedEvent.closeAt);
  try {
    await input.runtime.enqueuePluginJob({
      jobName: EVENTS_JOBS.close,
      scopeId: updatedEvent.scopeId,
      ...(updatedEvent.groupId ? { groupId: updatedEvent.groupId } : {}),
      ...(updatedEvent.groupWid ? { groupWid: updatedEvent.groupWid } : {}),
      ...(closeAt.getTime() > Date.now() ? { runAt: closeAt } : {}),
      payload: {
        eventId: updatedEvent.id,
        pollGeneration: updatedEvent.pollGeneration,
        pollWaMsgId: updatedEvent.pollWaMsgId
      },
      dedupeKey: `${EVENTS_JOBS.close}:${updatedEvent.id}:poll-generation:${updatedEvent.pollGeneration}`
    });
  } catch (error) {
    repairFailures.push(`close_job: ${error instanceof Error ? error.message : String(error)}`);
    try {
      await input.runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.pollReplacement,
        scopeId: updatedEvent.scopeId,
        ...(updatedEvent.groupId ? { groupId: updatedEvent.groupId } : {}),
        ...(updatedEvent.groupWid ? { groupWid: updatedEvent.groupWid } : {}),
        delayMs: 5_000,
        payload: { operationId: input.operationId },
        dedupeKey: `${EVENTS_JOBS.pollReplacement}:${input.operationId}:close-repair:${updatedEvent.pollGeneration}`
      });
    } catch (recoveryError) {
      repairFailures.push(
        `close_recovery_job: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
      );
    }
  }
  try {
    await input.runtime.enqueuePluginJob({
      jobName: EVENTS_JOBS.complete,
      scopeId: updatedEvent.scopeId,
      ...(updatedEvent.groupId ? { groupId: updatedEvent.groupId } : {}),
      ...(updatedEvent.groupWid ? { groupWid: updatedEvent.groupWid } : {}),
      runAt: new Date(updatedEvent.lifecycleCompleteAt),
      payload: { eventId: updatedEvent.id },
      dedupeKey: `${EVENTS_JOBS.complete}:${updatedEvent.id}:${updatedEvent.lifecycleCompleteAt}`
    });
  } catch (error) {
    repairFailures.push(`completion_job: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (run.retirementPending) {
    const followUpAt = run.replacement.nextAttemptAt
      ? new Date(run.replacement.nextAttemptAt)
      : new Date(input.now.getTime() + 5_000);
    try {
      await input.runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.pollReplacement,
        scopeId: updatedEvent.scopeId,
        ...(updatedEvent.groupId ? { groupId: updatedEvent.groupId } : {}),
        ...(updatedEvent.groupWid ? { groupWid: updatedEvent.groupWid } : {}),
        runAt: followUpAt,
        payload: { operationId: input.operationId },
        dedupeKey: `${EVENTS_JOBS.pollReplacement}:${input.operationId}:retire:${run.replacement.retirementFailureCount}`
      });
    } catch (error) {
      repairFailures.push(`retirement_job: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const retry of run.receiptReleaseRetries) {
    try {
      await input.runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.pollReplacement,
        scopeId: retry.scopeId,
        ...(updatedEvent.groupId ? { groupId: updatedEvent.groupId } : {}),
        ...(updatedEvent.groupWid ? { groupWid: updatedEvent.groupWid } : {}),
        runAt: retry.retryAt,
        payload: { operationId: retry.operationId },
        dedupeKey: `${EVENTS_JOBS.pollReplacement}:${retry.operationId}:receipt-release:${retry.failureCount}`
      });
    } catch (error) {
      repairFailures.push(`receipt_release_job: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const repairPending = run.retirementPending || repairNeedsJob || repairFailures.length > 0;
  appendEventLog(input.db, {
    eventId: updatedEvent.id,
    action: 'events.updated',
    metadata: {
      operationId: input.operationId,
      replacement: true,
      actorWid: input.actorWid,
      actorLabel: input.actorLabel,
      sourcePluginId: input.sourcePluginId,
      requestedTitle: input.requestedTitle,
      groupTitle: input.materialized.groupTitle,
      pollGeneration: updatedEvent.pollGeneration,
      retirementPending: run.retirementPending,
      repairFailures
    }
  });
  await appendEventJsonLog(input.context, {
    action: 'event.updated',
    scopeId: updatedEvent.scopeId,
    eventId: updatedEvent.id,
    actorWid: input.actorWid,
    profileId: updatedEvent.profileId,
    ...(updatedEvent.pollWaMsgId ? { pollWaMsgId: updatedEvent.pollWaMsgId } : {}),
    metadata: {
      replacement: true,
      operationId: input.operationId,
      pollGeneration: updatedEvent.pollGeneration,
      retirementPending: run.retirementPending,
      repairFailures
    }
  });
  return {
    changed: true,
    completedNow: false,
    repairPending,
    cleanupAt,
    replacementStatus: 'completed'
  };
}

async function convertOpenPollEditToUnplannedLifecycle(input: {
  context: PluginOperationContext;
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
  t: CommandContext['t'];
  now: Date;
  operationId: string;
  sourcePluginId?: string | undefined;
}): Promise<{
  changed: true;
  completedNow: false;
  repairPending: boolean;
  cleanupAt: Date;
  convertedToUnplanned: true;
}> {
  if (!input.event.pollWaMsgId) {
    throw new Error(EVENT_UPDATE_CONFLICT_ERROR);
  }
  const oldPollWaMsgId = input.event.pollWaMsgId;
  const artifactIds = listEventAnnouncementMessages(input.db, input.event.id)
    .filter((artifact) => artifact.scopeId === input.event.scopeId)
    .map((artifact) => artifact.id);
  const updatedAt = nextEventRevisionTimestamp(input.event.updatedAt, input.now);
  const provisioningGeneration = randomUUID();
  const converted = convertOpenPollEventToUnplanned(input.db, {
    eventId: input.event.id,
    scopeId: input.event.scopeId,
    expectedUpdatedAt: input.event.updatedAt,
    expectedPollWaMsgId: oldPollWaMsgId,
    profileLabel: input.profile.label,
    profileRevision: eventProfileQuestionSchemaRevision(input.profile),
    responseClasses: input.materialized.responseClasses,
    answers: input.materialized.answers,
    ...(input.materialized.eventLocation ? { eventLocation: input.materialized.eventLocation } : {}),
    startsAt: input.materialized.startsAt.toISOString(),
    startsAtUtc: input.materialized.startsAt.toISOString(),
    endsAt: input.materialized.endsAt.toISOString(),
    lifecycleCompleteAt: input.materialized.lifecycleCompleteAt.toISOString(),
    spanKind: input.materialized.spanKind,
    timezone: input.materialized.timezone,
    localDate: input.materialized.localDate,
    ...(input.materialized.localTime ? { localTime: input.materialized.localTime } : {}),
    ...(input.materialized.place ? { place: input.materialized.place } : {}),
    closeAt: input.materialized.closeAt.toISOString(),
    cleanupAt: input.materialized.cleanupAt.toISOString(),
    groupTitle: input.materialized.groupTitle,
    calendarDurationMinutes: input.materialized.calendarDurationMinutes,
    ...(input.materialized.calendarLocation ? { calendarLocation: input.materialized.calendarLocation } : {}),
    ...(input.materialized.calendarDescription ? { calendarDescription: input.materialized.calendarDescription } : {}),
    provisioningGeneration,
    provisioningAttempt: 1,
    provisioningNextRunAt: updatedAt,
    updatedAt
  });
  if (!converted) {
    throw new Error(EVENT_UPDATE_CONFLICT_ERROR);
  }
  appendEventLog(input.db, {
    eventId: input.event.id,
    action: 'events.open_poll_converted_to_unplanned',
    metadata: {
      operationId: input.operationId,
      oldPollWaMsgId,
      editorWid: input.actorWid,
      sourcePluginId: input.sourcePluginId,
      closeAt: input.materialized.closeAt.toISOString()
    }
  });
  let intent = getEvent(input.db, input.event.id);
  if (!intent) {
    throw new Error(EVENT_UPDATE_CONFLICT_ERROR);
  }
  let repairPending = false;
  const cleanupInitializedAt = new Date().toISOString();
  const cleanupStarted = beginEventArtifactDeletionCleanup(
    input.db,
    intent.id,
    artifactIds,
    cleanupInitializedAt
  );
  if (cleanupStarted > 0) {
    repairPending = true;
    try {
      await input.runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.cancellationCleanup,
        scopeId: intent.scopeId,
        ...(intent.groupId ? { groupId: intent.groupId } : {}),
        ...(intent.groupWid ? { groupWid: intent.groupWid } : {}),
        payload: { eventId: intent.id },
        dedupeKey: `${EVENTS_JOBS.cancellationCleanup}:${intent.id}:unplanned-conversion:${input.operationId}`
      });
    } catch (error) {
      appendEventLog(input.db, {
        eventId: intent.id,
        action: 'events.open_poll_conversion.artifact_cleanup_enqueue_failed',
        metadata: { reason: error instanceof Error ? error.message : String(error) }
      });
    }
  }
  let provisioning: ProvisionUnplannedEventSubgroupResult | undefined;
  try {
    provisioning = await provisionUnplannedEventSubgroup({
      context: input.context,
      runtime: input.runtime,
      db: input.db,
      event: intent
    });
  } catch (error) {
    repairPending = true;
    appendEventLog(input.db, {
      eventId: intent.id,
      action: 'events.open_poll_conversion.provisioning_failed',
      metadata: { reason: error instanceof Error ? error.message : String(error) }
    });
  }
  if (provisioning?.status !== 'completed') {
    repairPending = true;
    intent = getEvent(input.db, input.event.id) ?? intent;
    try {
      const receipt = await input.activeTransport.sendText(
        intent.announcementGroupWid || intent.groupWid || '',
        input.t('official.community-events.update.convertedNoticePending', {
          title: intent.groupTitle,
          eventId: intent.id,
          startsAt: formatEventDateTime(new Date(intent.startsAt), intent.timezone, input.locale),
          endsAt: formatEventDateTime(new Date(intent.endsAt), intent.timezone, input.locale)
        }),
        {
          quotedMessageId: oldPollWaMsgId,
          idempotencyKey: `community-events:${intent.id}:unplanned-conversion-pending:${input.operationId}`
        }
      );
      if (receipt.messageId) {
        recordEventAnnouncementMessage(input.db, {
          eventId: intent.id,
          scopeId: intent.scopeId,
          kind: 'event_edit',
          deliveryKey: `unplanned-conversion-pending:${input.operationId}`,
          chatId: intent.announcementGroupWid || intent.groupWid || '',
          messageId: receipt.messageId,
          createdAt: new Date().toISOString()
        });
      }
    } catch (error) {
      appendEventLog(input.db, {
        eventId: intent.id,
        action: 'events.open_poll_conversion.notice_failed',
        metadata: { reason: error instanceof Error ? error.message : String(error) }
      });
    }
  }
  if (provisioning?.status === 'completed') {
    const event = getEvent(input.db, input.event.id);
    if (!event?.subgroupChatId) {
      throw new Error(`Converted event ${input.event.id} has no subgroup.`);
    }
    let groupJoinUrl = '';
    try {
      groupJoinUrl = await eventGroupJoinUrl(input.context, '{groupJoinUrl}', event.subgroupChatId);
    } catch {
      repairPending = true;
    }
    try {
      const notice = input.t('official.community-events.update.convertedNotice', {
        title: event.groupTitle,
        eventId: event.id,
        startsAt: formatEventDateTime(new Date(event.startsAt), event.timezone, input.locale),
        endsAt: formatEventDateTime(new Date(event.endsAt), event.timezone, input.locale),
        groupJoinUrl,
        subgroupChatId: event.subgroupChatId
      });
      const receipt = await input.activeTransport.sendText(
        event.announcementGroupWid || event.groupWid || '',
        notice,
        {
          quotedMessageId: oldPollWaMsgId,
          idempotencyKey: `community-events:${event.id}:unplanned-conversion:${input.operationId}`
        }
      );
      if (receipt.messageId) {
        recordEventAnnouncementMessage(input.db, {
          eventId: event.id,
          scopeId: event.scopeId,
          kind: 'event_edit',
          deliveryKey: `unplanned-conversion:${input.operationId}`,
          chatId: event.announcementGroupWid || event.groupWid || '',
          messageId: receipt.messageId,
          createdAt: new Date().toISOString()
        });
      }
    } catch {
      repairPending = true;
    }
    try {
      await attemptUnplannedEventFinalization({
        context: input.context,
        runtime: input.runtime,
        activeTransport: input.activeTransport,
        event,
        profile: {
          ...input.profile,
          eventGroupHint: {
            ...input.profile.eventGroupHint,
            sendForUnplannedEvents: false
          }
        },
        config: input.config,
        locale: input.locale,
        creatorDisplayName: event.actorLabel || event.actorWid,
        trigger: 'unplanned_created',
        now: input.now
      });
    } catch (error) {
      repairPending = true;
      appendEventLog(input.db, {
        eventId: event.id,
        action: 'events.open_poll_conversion.finalization_failed',
        metadata: { reason: error instanceof Error ? error.message : String(error) }
      });
    }
  }
  return {
    changed: true,
    completedNow: false,
    repairPending,
    cleanupAt: input.materialized.cleanupAt,
    convertedToUnplanned: true
  };
}

async function updateEventLifecycle(input: {
  context: PluginOperationContext;
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
    input.materialized.lifecycleCompleteAt.getTime() <= input.now.getTime();
  const cleanupAt = input.materialized.cleanupAt;
  const timezone = input.materialized.timezone;
  const changed = completionRequested || eventStructuredDataChanged(input.event, {
    materialized: input.materialized,
    cleanupAt,
    timezone
  });
  if (!changed) {
    return { changed: false, completedNow: false, repairPending: false, cleanupAt };
  }
  const calendarId = resolvedEventCalendarId(input.event);
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
  const calendar = input.config.calendars.find((candidate) => candidate.id === calendarId);
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
      endsAt: input.materialized.endsAt.toISOString(),
      lifecycleCompleteAt: input.materialized.lifecycleCompleteAt.toISOString(),
      spanKind: input.materialized.spanKind,
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
    endsAt: input.materialized.endsAt.toISOString(),
    lifecycleCompleteAt: input.materialized.lifecycleCompleteAt.toISOString(),
    spanKind: input.materialized.spanKind,
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
      calendarId: calendarId ?? '',
      ...(announcementIntent ? { announcementDeliveryKey: announcementIntent.deliveryKey } : {})
    }
  });
  if (!updated) {
    throw new Error(EVENT_UPDATE_CONFLICT_ERROR);
  }
  if (input.materialized.localTime) {
    markEventStartTimeAgreementExternallyResolved(input.db, {
      eventId: input.event.id,
      localTime: input.materialized.localTime,
      resolvedAt: updatedAt
    });
  }

  const repair = await repairEventEdit({
    appConfig: input.runtime.config,
    db: input.db,
    operationId: input.operationId,
    ...(input.runtime.services ? { services: input.runtime.services } : {}),
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
  if (!completionRequested) {
    try {
      await input.runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.complete,
        scopeId: input.event.scopeId,
        ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
        ...(input.event.groupWid ? { groupWid: input.event.groupWid } : {}),
        runAt: input.materialized.lifecycleCompleteAt,
        payload: { eventId: input.event.id },
        dedupeKey: `${EVENTS_JOBS.complete}:${input.event.id}:${input.materialized.lifecycleCompleteAt.toISOString()}`
      });
    } catch (error) {
      repairFailures.push(`completion_job: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (
    input.event.eventStatus === 'active' &&
    !completionRequested &&
    liveSubgroupChatId
  ) {
    const weatherRequests = eventWeatherForecastJobRequests({
      event: {
        ...input.event,
        updatedAt,
        startsAt: input.materialized.startsAt.toISOString(),
        startsAtUtc: input.materialized.startsAt.toISOString(),
        endsAt: input.materialized.endsAt.toISOString(),
        lifecycleCompleteAt: input.materialized.lifecycleCompleteAt.toISOString(),
        spanKind: input.materialized.spanKind,
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
    for (const weatherRequest of weatherRequests) {
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
      calendarId,
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
      calendarId,
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
    new Date(event.endsAt).toISOString() !== materialized.endsAt.toISOString() ||
    new Date(event.lifecycleCompleteAt).toISOString() !== materialized.lifecycleCompleteAt.toISOString() ||
    event.spanKind !== materialized.spanKind ||
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

export function eventIsEditable(event: StoredEventRecord): boolean {
  return (event.eventStatus === 'active' || event.eventStatus === 'completed')
    && !(event.groupLifecycleStatus === 'poll_open' && event.pollCloseCutoffAt);
}

function eventIsBareEditDiscoveryCandidate(
  event: StoredEventRecord,
  nowMs: number
): boolean {
  const lifecycleCompleteAtMs = new Date(event.lifecycleCompleteAt).getTime();
  return event.eventStatus === 'active'
    && Number.isFinite(lifecycleCompleteAtMs)
    && lifecycleCompleteAtMs > nowMs;
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

export async function eventUpdateAllowed(
  context: PluginOperationContext,
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

async function authorizedEventEditCandidates(
  context: PluginOperationContext,
  events: StoredEventRecord[],
  actor: EventAuthorizationPrincipal
): Promise<StoredEventRecord[]> {
  const unique = uniqueEvents(events);
  const allowed = await Promise.all(unique.map(async (event) => ({
    event,
    allowed: await eventUpdateAllowed(context, {
      event,
      actor,
      creatorIdentityId: event.actorIdentityId
    })
  })));
  return orderedEventEditCandidates(allowed
    .filter((candidate) => candidate.allowed)
    .map((candidate) => candidate.event));
}

function orderedEventEditCandidates(events: StoredEventRecord[]): StoredEventRecord[] {
  return [...uniqueEvents(events)].sort((left, right) => (
    new Date(right.startsAt).getTime() - new Date(left.startsAt).getTime()
    || left.id.localeCompare(right.id)
  ));
}

export function eventUpdatePrefill(event: StoredEventRecord, profile: EventProfile): EventFlowPrefill {
  const answers = { ...event.answers };
  if (event.localDate) {
    answers[profile.startsAtDateQuestionKey] = event.localDate;
  }
  if (event.localTime) {
    answers[profile.startsAtTimeQuestionKey] = event.localTime;
  }
  return {
    profileId: profile.id,
    answers,
    spanKind: event.spanKind,
    ...(event.spanKind === 'multi_day'
      ? eventEndPrefill(event)
      : {})
  };
}

function eventEndPrefill(event: StoredEventRecord): Pick<EventFlowPrefill, 'endLocalDate' | 'endLocalTime'> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: event.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(event.endsAt));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    endLocalDate: `${value('year')}-${value('month')}-${value('day')}`,
    endLocalTime: `${value('hour')}:${value('minute')}`
  };
}

function registerEventCancelFlowCompletionHandler(
  context: PluginOperationContext,
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
      },
      deleteMessage: (messageId) => activeTransport.deleteMessage(messageId)
    });
    if (result.status === 'cancelled') {
      const deletionIncomplete = Boolean(
        result.announcementMessageDeletion?.skippedReason ||
        result.announcementMessageDeletion?.failed.length ||
        result.announcementMessageDeletion?.unconfirmed.length
      );
      await activeTransport.sendText(responseChatId, t(deletionIncomplete
        ? 'official.community-events.cancel.doneDeletionPending'
        : 'official.community-events.cancel.done', {
        title: eventDisplayTitle(event),
        eventId: event.id
      }));
      return true;
    }
    if (result.status === 'not_cancellable') {
      await activeTransport.sendText(responseChatId, t(result.reason === 'event has already ended'
        ? 'official.community-events.cancel.ended'
        : 'official.community-events.cancel.notCancellable', {
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
  context: PluginOperationContext,
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
  const now = new Date();
  const allCandidates = listCancellableEvents(input.db, input.scopeId, now.toISOString());
  const subgroupCandidates = input.query
    ? []
    : listEventsBySubgroupChatId(input.db, input.scopeId, input.chatId)
      .filter((candidate) =>
        candidate.eventStatus === 'active'
        && new Date(candidate.lifecycleCompleteAt).getTime() > now.getTime()
      );
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
  context: PluginOperationContext,
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
    range: eventRangeLabel(event, input.locale),
    status: eventLifecycleLabel(event, input.t),
    eventId: event.id
  });
}

function eventChoiceLabel(event: StoredEventRecord, t: CommandContext['t'], locale: string): string {
  return t('official.community-events.cancel.choiceLabel', {
    title: eventDisplayTitle(event),
    startsAt: eventStartsAtLabel(event, locale),
    range: eventRangeLabel(event, locale),
    status: eventLifecycleLabel(event, t),
    eventId: event.id
  });
}

function eventEditChoiceLabel(event: StoredEventRecord, t: CommandContext['t'], locale: string): string {
  const params = {
    title: eventDisplayTitle(event),
    startsAt: eventStartsAtLabel(event, locale),
    range: eventRangeLabel(event, locale),
    status: eventLifecycleLabel(event, t),
    eventId: event.id
  };
  const rendered = t('official.community-events.edit.choiceLabel', params).trim();
  if (Array.from(rendered).length <= WHATSAPP_POLL_MAX_OPTION_CODEPOINTS) {
    return rendered;
  }
  const suffix = ` · ${event.id}`;
  const suffixLength = Array.from(suffix).length;
  const prefix = t('official.community-events.edit.choiceLabel', {
    ...params,
    eventId: ''
  }).replace(/[\s·|:/-]+$/u, '').trim();
  const available = Math.max(1, WHATSAPP_POLL_MAX_OPTION_CODEPOINTS - suffixLength - 1);
  return `${truncateCodePoints(prefix, available)}…${suffix}`;
}

function truncateCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('').trimEnd();
}

function eventLifecycleLabel(event: StoredEventRecord, t: CommandContext['t']): string {
  return t('official.community-events.lifecycle.label', {
    eventStatus: t(`official.community-events.lifecycle.event.${event.eventStatus}`),
    groupLifecycleStatus: t(`official.community-events.lifecycle.group.${event.groupLifecycleStatus}`)
  });
}

function eventStartsAtLabel(event: StoredEventRecord, locale = 'en'): string {
  if (!event.localTime) {
    return formatEventDateOnly(new Date(event.startsAt), event.timezone, locale);
  }
  return formatEventDateTime(new Date(event.startsAt), event.timezone, locale);
}

function eventRangeLabel(event: StoredEventRecord, locale = 'en'): string {
  if (!event.localTime) {
    const start = formatEventDateOnly(new Date(event.startsAt), event.timezone, locale);
    if (event.spanKind === 'day_trip') {
      return start;
    }
    return `${start} – ${formatEventDateOnly(new Date(event.endsAt), event.timezone, locale)}`;
  }
  return `${formatEventDateTime(new Date(event.startsAt), event.timezone, locale)} – ${
    formatEventDateTime(new Date(event.endsAt), event.timezone, locale)
  }`;
}

function formatEventDateOnly(date: Date, timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: 'medium' }).format(date);
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
    eventStartsAtLabel(event, locale),
    eventRangeLabel(event, locale),
    event.spanKind
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
      if (!eventFlowConfirmed(snapshot, profile)) {
        await runtime.dataStore.delete(eventDraftKey(snapshot.scopeId, lock.flowSessionId));
        await activeTransport.sendText(responseChatId, t('official.community-events.cancelled'));
        return true;
      }

      let answers: EventFlowAnswers | undefined;
      try {
        answers = eventFlowAnswers(snapshot, profile, draft.timezone, draft.locale);
      } catch (error) {
        if (!(error instanceof EventConditionalTextConfigurationError)) throw error;
        await runtime.dataStore.delete(eventDraftKey(snapshot.scopeId, lock.flowSessionId));
        await appendEventJsonLog(context, {
          action: 'event.flow_template_invalid',
          scopeId: draft.scopeId,
          actorIdentityId: draft.actorIdentityId,
          actorWid: draft.actorWid,
          profileId: profile.id,
          metadata: { field: error.field, code: error.code }
        });
        await activeTransport.sendText(responseChatId, t('official.community-events.templateConfigurationInvalid'));
        return true;
      }
      await runtime.dataStore.delete(eventDraftKey(snapshot.scopeId, lock.flowSessionId));
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

function registerEventEditSelectionHandler(context: PluginOperationContext): void {
  const runtime = requireOfficialCommandRuntime(context);
  context.flowEngine.registerPromptHandler(EVENT_EDIT_SELECTION_PURPOSE, async (lock, activeTransport) => {
    const pending = lock.subjectId
      ? await runtime.ephemeralStore.get<PendingEventEditSelection>(eventEditSelectionKey(lock.subjectId))
      : undefined;
    if (!pending) {
      await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
      return true;
    }
    const t = await context.i18n.translatorForIdentity(
      pending.actorIdentityId,
      pending.scopeId
    );
    if (lock.voterIdentityId.trim() !== pending.actorIdentityId) {
      await clearActiveEventEditSelection(runtime, pending);
      await activeTransport.sendText(
        pending.responseChatId,
        t(pending.operation === 'poll_close'
          ? 'official.community-events.pollClose.permissionDenied'
          : 'official.community-events.edit.wrongRequester'),
        { idempotencyKey: `community-events:event-edit-selection:${pending.id}:wrong-requester` }
      );
      await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
      return true;
    }

    const selected = lock.selectedOptions[0];
    if (selected?.id === EVENT_EDIT_FREE_TEXT_OPTION_ID) {
      const query = selected.label.trim();
      if (!query || isCommandLikeLocationReply(query)) {
        await clearActiveEventEditSelection(runtime, pending);
        await activeTransport.sendText(
          pending.responseChatId,
          t(query ? 'official.community-events.cancelled' : pending.operation === 'poll_close'
            ? 'official.community-events.pollClose.unavailable'
            : 'official.community-events.edit.invalidSelection'),
          { idempotencyKey: `community-events:event-edit-selection:${pending.id}:cancelled` }
        );
        await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
        return true;
      }

      const db = eventsDatabase(runtime.databases);
      const actor = eventEditSelectionActor(pending);
      const currentMatches = findEventMatches(
        listScopeEvents(db, pending.scopeId).filter(pending.operation === 'poll_close' ? eventPollIsOpen : eventIsEditable),
        query,
        pending.locale
      );
      const candidates = pending.operation === 'poll_close'
        ? currentMatches.filter((event) => event.actorIdentityId === actor.identityId)
        : await authorizedEventEditCandidates(context, currentMatches, actor);
      if (candidates.length === 1) {
        return completeEventEditSelection({
          context,
          runtime,
          activeTransport,
          lockFlowPromptId: lock.flowPromptId,
          pending: { ...pending, query, candidateEventIds: [candidates[0]!.id] },
          eventId: candidates[0]!.id,
          t
        });
      }

      const nextPending: PendingEventEditSelection = {
        ...pending,
        id: eventEditRefinementSelectionId(pending.id, query),
        query,
        candidateEventIds: orderedEventEditCandidates(candidates).map((event) => event.id),
        createdAt: new Date().toISOString()
      };
      await promptEventEditSelection({
        context,
        runtime,
        pending: nextPending,
        candidates,
        t
      });
      await runtime.ephemeralStore.delete(eventEditSelectionKey(pending.id));
      await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
      return true;
    }

    const eventId = selected?.id;
    if (!eventId || !pending.candidateEventIds.includes(eventId)) {
      await clearActiveEventEditSelection(runtime, pending);
      await activeTransport.sendText(
        pending.responseChatId,
        t(pending.operation === 'poll_close'
          ? 'official.community-events.pollClose.unavailable'
          : 'official.community-events.edit.invalidSelection'),
        { idempotencyKey: `community-events:event-edit-selection:${pending.id}:invalid` }
      );
      await context.flowEngine.acknowledgePromptLock(lock.flowPromptId);
      return true;
    }
    return completeEventEditSelection({
      context,
      runtime,
      activeTransport,
      lockFlowPromptId: lock.flowPromptId,
      pending,
      eventId,
      t
    });
  }, { recoverLocked: true });
}

async function completeEventEditSelection(input: {
  context: PluginOperationContext;
  runtime: OfficialPluginCommandRuntime;
  activeTransport: EventTextTransport;
  lockFlowPromptId: string;
  pending: PendingEventEditSelection;
  eventId: string;
  t: CommandContext['t'];
}): Promise<true> {
  const db = eventsDatabase(input.runtime.databases);
  const event = getEvent(db, input.eventId);
  const actor = eventEditSelectionActor(input.pending);
  const terminal = async (
    messageKey: string,
    params?: Parameters<CommandContext['t']>[1]
  ): Promise<true> => {
    await clearActiveEventEditSelection(input.runtime, input.pending);
    await input.activeTransport.sendText(
      input.pending.responseChatId,
      input.t(messageKey, params),
      { idempotencyKey: `community-events:event-edit-selection:${input.pending.id}:terminal:${messageKey}` }
    );
    await input.context.flowEngine.acknowledgePromptLock(input.lockFlowPromptId);
    return true;
  };

  if (input.pending.operation === 'poll_close') {
    if (!event || event.scopeId !== input.pending.scopeId || !input.pending.candidateEventIds.includes(event.id)) {
      return terminal('official.community-events.pollClose.noEvents');
    }
    const result = await closeSelectedEventPoll(input.runtime, event, actor);
    return terminal(result.messageKey, result.params);
  }

  if (
    !event
    || event.scopeId !== input.pending.scopeId
    || !input.pending.candidateEventIds.includes(event.id)
    || !eventIsEditable(event)
  ) {
    return terminal('official.community-events.edit.selectionStale');
  }
  if (!await eventUpdateAllowed(input.context, {
    event,
    actor,
    creatorIdentityId: event.actorIdentityId
  })) {
    return terminal('official.community-events.update.permissionDenied');
  }
  const config = parseEventsConfig(await input.runtime.configFor(
    input.pending.scopeId,
    input.pending.actorIdentityId
  ));
  if (!config.enabled) {
    return terminal('official.community-events.disabled');
  }

  const started = await beginEventUpdateFlow(input.context, {
    event,
    config,
    requestedTitle: eventDisplayTitle(event),
    sourcePluginId: EVENTS_PLUGIN_ID,
    actor,
    ...(event.actorIdentityId ? { creatorIdentityId: event.actorIdentityId } : {}),
    externalIdempotencyKey: eventUpdateSelectionIdempotencyKey(
      input.pending.scopeId,
      input.pending.actorIdentityId,
      input.pending.id,
      event.id
    ),
    t: input.t,
    locale: input.pending.locale,
    actorLabel: input.pending.actorLabel,
    origin: {
      chatId: input.pending.originChatId,
      context: input.pending.originContext
    },
    ...(input.pending.privateDeliveryFallback
      ? { privateDeliveryFallback: input.pending.privateDeliveryFallback }
      : {})
  });
  if (started.status === 'not_configured') {
    return terminal('official.community-events.notConfigured');
  }
  await clearActiveEventEditSelection(input.runtime, input.pending);
  await input.context.flowEngine.acknowledgePromptLock(input.lockFlowPromptId);
  return true;
}

function registerEventLocationSelectionHandler(context: PluginOperationContext): void {
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
    let locationTimezone: string;
    try {
      const inferred = candidate.timezone ?? geocoderTimezoneOutputSchema.parse(await context.services?.call({
        serviceId: GEOCODER_SERVICE_ID, method: GEOCODER_TIMEZONE_METHOD,
        scopeId: pending.draft.scopeId, actorIdentityId: pending.draft.actorIdentityId,
        input: candidate.point
      })).timezone;
      locationTimezone = scopeTimezoneSchema.parse(inferred);
    } catch (error) {
      await recordEventLocationFailure(context, {
        phase: 'geocode', scopeId: pending.draft.scopeId, actorWid: pending.draft.actorWid,
        profileId: profile.id, query: pending.searchQuery, error
      });
      await activeTransport.sendText(pending.responseChatId, t('official.community-events.location.timezoneUnavailable'));
      return true;
    }
    const eventLocation = geocodedEventLocation({
      query: pending.searchQuery,
      displayLabel: displayPlace,
      timezone: locationTimezone,
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
      await applyEventUpdate({
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
      selectionRule: 'SINGLE',
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
  const eventId = newEventId(`creation-flow:${input.draft.flowSessionId}`);
  let creationMode: 'poll' | 'unplanned' = 'poll';
  let db: ReturnType<typeof eventsDatabase> | undefined;
  let eventCommitSucceeded = false;
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
    input = { ...input,
      draft: { ...input.draft, timezone: scopeTimezoneSchema.parse(input.eventLocation.timezone) },
      answers: eventAnswersInTimezone(input.answers, input.eventLocation.timezone)
    };
    db = eventsDatabase(input.runtime.databases);
    const eventDb = db;
    const materialized = materializeEventLifecycle({
      profile: input.profile,
      answers: input.answers,
      timezone: input.draft.timezone,
      locale: (await input.context.i18n.resolveScopeLocale(input.draft.scopeId)).locale,
      creatorDisplayName: input.draft.actorLabel || input.draft.actorWid,
      eventLocation: input.eventLocation
    });
    const now = new Date();
    creationMode = input.answers.pollPhase === 'unplanned'
      || materialized.closeAt.getTime() <= now.getTime() ? 'unplanned' : 'poll';
    if (creationMode === 'unplanned') {
      const result = await createUnplannedEventLifecycle({
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
      if (
        result.status !== 'completed' &&
        result.creatorMembershipPauseKind &&
        result.subgroupChatId
      ) {
        try {
          if (!input.context.resolveStableIdentityById) {
            throw new Error('Plugin runtime does not expose authoritative creator notice delivery.');
          }
          const creatorAddress = await input.context.resolveStableIdentityById(
            input.draft.actorIdentityId
          );
          const notice = await renderEventCreatorMembershipNotice({
            context: input.context,
            t: input.t,
            eventId: result.eventId,
            title: result.subgroupTitle,
            subgroupChatId: result.subgroupChatId,
            kind: result.creatorMembershipPauseKind
          });
          await input.activeTransport.sendText(
            creatorAddress.deliveryChatId,
            notice.text,
            { idempotencyKey: notice.idempotencyKey }
          );
          appendEventLog(db, {
            eventId: result.eventId,
            action: 'events.provisioning.creator_membership_notice_sent',
            metadata: {
              subgroupChatId: result.subgroupChatId,
              kind: result.creatorMembershipPauseKind,
              idempotencyKey: notice.idempotencyKey,
              groupJoinUrlIncluded: Boolean(notice.groupJoinUrl),
              source: 'unplanned_immediate'
            }
          });
        } catch (noticeError) {
          const reason = noticeError instanceof Error ? noticeError.message : String(noticeError);
          appendEventLog(db, {
            eventId: result.eventId,
            action: 'events.provisioning.creator_membership_notice_failed',
            metadata: {
              subgroupChatId: result.subgroupChatId,
              kind: result.creatorMembershipPauseKind,
              reason,
              source: 'unplanned_immediate'
            }
          });
          if (input.context.logger) {
            input.context.logger.warn(
              {
                error: noticeError,
                eventId: result.eventId,
                subgroupChatId: result.subgroupChatId,
                kind: result.creatorMembershipPauseKind
              },
              'Unable to deliver immediate event creator membership pause notice'
            );
          }
        }
      } else {
        await input.activeTransport.sendText(
          input.responseChatId,
          result.status === 'recovery_scheduled'
            ? input.t('official.community-events.unplannedProvisioningPending', {
                title: result.subgroupTitle,
                eventId: result.eventId
              })
            : result.status === 'operator_required'
              ? input.t('official.community-events.unplannedProvisioningOperatorRequired', {
                  title: result.subgroupTitle,
                  eventId: result.eventId
                })
            : input.t('official.community-events.unplannedPublished')
        );
      }
      return;
    }
    const attendanceRequest = eventAttendanceLifecycleRequest({
      eventId,
      generation: 1,
      groupWid: input.announcementGroupWid,
      question: materialized.pollQuestion,
      options: materialized.pollOptions,
      allowMultipleAnswers: input.profile.poll.allowMultipleAnswers,
      closeAt: materialized.closeAt.toISOString()
    });
    const attendanceCaller = {
      services: input.context.services,
      scopeId: input.draft.scopeId,
      actorIdentityId: input.draft.actorIdentityId,
      ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
      groupWid: input.announcementGroupWid
    };
    const nowIso = now.toISOString();
    const event: NewStoredEventRecord & StoredEventRecord = {
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
      ...configuredEventCalendarOwnership(input.profile.calendar.calendarId),
      actorIdentityId: input.draft.actorIdentityId,
      actorWid: input.draft.actorWid,
      actorLabel: input.draft.actorLabel,
      announcementGroupWid: input.announcementGroupWid,
      pollGeneration: 1,
      attendanceLifecycle: {
        owner: 'poll_assistant',
        generation: 1,
        sourceIdempotencyKey: attendanceRequest.sourceIdempotencyKey,
        request: attendanceRequest
      },
      pollQuestion: materialized.pollQuestion,
      pollOptions: materialized.pollOptions,
      responseClasses: materialized.responseClasses,
      answers: materialized.answers,
      eventLocation: input.eventLocation,
      startsAt: materialized.startsAt.toISOString(),
      startsAtUtc: materialized.startsAt.toISOString(),
      endsAt: materialized.endsAt.toISOString(),
      lifecycleCompleteAt: materialized.lifecycleCompleteAt.toISOString(),
      spanKind: materialized.spanKind,
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
    const existing = getEvent(eventDb, event.id);
    if (existing) {
      const lifecycle = existing.attendanceLifecycle;
      if (
        existing.scopeId !== event.scopeId
        || existing.actorIdentityId !== event.actorIdentityId
        || lifecycle?.owner !== 'poll_assistant'
        || lifecycle.generation !== 1
        || lifecycle.sourceIdempotencyKey !== attendanceRequest.sourceIdempotencyKey
        || JSON.stringify(lifecycle.request) !== JSON.stringify(attendanceRequest)
      ) {
        throw new Error(`Event creation flow ${input.draft.flowSessionId} is already bound differently.`);
      }
      eventCommitSucceeded = true;
    } else {
      // This read call is an explicit dependency/authorization preflight. Only
      // after it succeeds may Events persist a new attendance generation.
      await preflightEventAttendanceLifecycle(attendanceCaller, attendanceRequest);
      eventDb.transaction(() => {
        insertEvent(eventDb, event);
        if (input.profile.startTimeAgreement.enabled && materialized.spanKind === 'day_trip' && !materialized.localTime) {
          createEventStartTimeAgreement(eventDb, {
            eventId: event.id,
            profile: input.profile,
            createdAt: nowIso,
            nextRunAt: new Date(Math.max(now.getTime(), materialized.closeAt.getTime())).toISOString()
          });
        }
      });
      eventCommitSucceeded = true;
    }
    const pollObservationStartedAt = Date.now();
    const postCommit = <T>(
      phase: string,
      operation: () => Promise<T>,
      legacyAction?: string
    ) => runEventPostCommitPhase({
      context: input.context,
      db: eventDb,
      event,
      phase,
      operation,
      ...(legacyAction ? { legacyAction } : {})
    });
    const pollObservation = startEventPollPublicationObservation({
      db: eventDb,
      eventId: event.id,
      startedAt: pollObservationStartedAt
    });
    const pollObservationResult = postCommit(
      'poll_binding_observation',
      () => pollObservation.promise
    );

    await postCommit(
      'attendance_job_enqueue',
      () => input.runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.attendanceLifecycle,
        scopeId: event.scopeId,
        ...(event.groupId ? { groupId: event.groupId } : {}),
        ...(event.groupWid ? { groupWid: event.groupWid } : {}),
        payload: { eventId: event.id, pollGeneration: event.pollGeneration },
        dedupeKey: `${EVENTS_JOBS.attendanceLifecycle}:${event.id}:${event.pollGeneration}:publication`
      }),
      'events.attendance_lifecycle.enqueue_failed'
    );

    let persistedEvent = getEvent(eventDb, event.id) ?? event;
    const attendanceResult = await postCommit(
      'attendance_lifecycle_ensure',
      async () => {
        const lifecycle = await ensureEventAttendanceLifecycle(attendanceCaller, attendanceRequest);
        return bindEventPollAssistantAttendanceLifecycle(eventDb, {
          eventId: event.id,
          scopeId: event.scopeId,
          generation: event.pollGeneration,
          sourceIdempotencyKey: attendanceRequest.sourceIdempotencyKey,
          pollId: lifecycle.pollId,
          roundId: lifecycle.roundId,
          ...(lifecycle.pollWaMessageId
            ? { pollWaMessageId: lifecycle.pollWaMessageId }
            : {}),
          boundAt: new Date().toISOString()
        });
      },
      'events.attendance_lifecycle.ensure_deferred'
    );
    if (attendanceResult.ok) {
      persistedEvent = attendanceResult.value;
    } else {
      persistedEvent = safelyGetStoredEvent(eventDb, event.id) ?? persistedEvent;
    }

    await postCommit('calendar_publication', async () => {
      const calendarConfig = draftEventsConfig(input.draft);
      const calendarId = resolvedEventCalendarId(persistedEvent);
      const calendar = calendarId
        ? calendarConfig.calendars.find((candidate) => candidate.id === calendarId)
        : undefined;
      const publication = calendarId
        ? await writePublishAndRecordScopeCalendar({
          appConfig: input.runtime.config,
          db: eventDb,
          config: calendarConfig,
          scopeId: input.draft.scopeId,
          calendarId,
          ...(input.runtime.services ? { services: input.runtime.services } : {})
        })
        : undefined;
      await appendEventJsonLog(input.context, {
        action: 'calendar.exported',
        scopeId: input.draft.scopeId,
        eventId,
        actorWid: input.draft.actorWid,
        profileId: input.profile.id,
        ...(persistedEvent.pollWaMsgId ? { pollWaMsgId: persistedEvent.pollWaMsgId } : {}),
        metadata: {
          calendarEnabled: calendar?.enabled === true,
          calendarId: calendarId ?? '',
          ...(publication ? { publication } : {})
        }
      });
    });

    await postCommit('event_created_log', () => appendEventJsonLog(input.context, {
      action: 'event.created',
      scopeId: input.draft.scopeId,
      eventId,
      actorWid: input.draft.actorWid,
      profileId: input.profile.id,
      ...(persistedEvent.pollWaMsgId ? { pollWaMsgId: persistedEvent.pollWaMsgId } : {}),
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
    }));

    await postCommit('close_job_enqueue', () => input.runtime.enqueuePluginJob({
      jobName: EVENTS_JOBS.close,
      scopeId: input.draft.scopeId,
      ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
      ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
      runAt: materialized.closeAt,
      payload: {
        eventId,
        pollGeneration: 1,
        ...(persistedEvent.pollWaMsgId ? { pollWaMsgId: persistedEvent.pollWaMsgId } : {})
      },
      dedupeKey: `${EVENTS_JOBS.close}:${eventId}`
    }));

    await postCommit('completion_job_enqueue', () => input.runtime.enqueuePluginJob({
      jobName: EVENTS_JOBS.complete,
      scopeId: persistedEvent.scopeId,
      ...(persistedEvent.groupId ? { groupId: persistedEvent.groupId } : {}),
      ...(persistedEvent.groupWid ? { groupWid: persistedEvent.groupWid } : {}),
      runAt: new Date(persistedEvent.lifecycleCompleteAt),
      payload: { eventId: persistedEvent.id },
      dedupeKey: `${EVENTS_JOBS.complete}:${persistedEvent.id}:${persistedEvent.lifecycleCompleteAt}`
    }));

    await postCommit('calendar_hint_notification', () => sendEventCalendarHint({
      context: input.context,
      runtime: input.runtime,
      activeTransport: input.activeTransport,
      trigger: 'poll_published',
      scopeId: input.draft.scopeId,
      announcementGroupWid: input.announcementGroupWid,
      event: persistedEvent,
      profile: input.profile,
      calendars: input.draft.calendars,
      timezone: input.draft.timezone,
      locale: input.draft.locale,
      creatorDisplayName: input.draft.actorLabel || input.draft.actorWid
    }));

    if (safelyGetStoredEvent(eventDb, event.id)?.pollWaMsgId) {
      pollObservation.cancel();
    }
    const observed = await pollObservationResult;
    if (observed.ok) {
      persistedEvent = observed.value;
    } else {
      persistedEvent = safelyGetStoredEvent(eventDb, event.id) ?? persistedEvent;
    }

    await postCommit('creator_notification', () => input.activeTransport.sendText(
      input.responseChatId,
      input.t(persistedEvent.pollWaMsgId
        ? 'official.community-events.pollPublished'
        : 'official.community-events.pollLifecycleQueued'),
      { idempotencyKey: eventCreatorPublicationNotificationIdempotencyKey(event.id) }
    ));
  } catch (error) {
    const unplannedCommittedEvent = creationMode === 'unplanned' && db
      ? safelyGetStoredEvent(db, eventId)
      : undefined;
    if (
      eventCommitSucceeded ||
      (
        unplannedCommittedEvent?.scopeId === input.draft.scopeId &&
        unplannedCommittedEvent.actorIdentityId === input.draft.actorIdentityId &&
        unplannedCommittedEvent.profileId === input.profile.id
      )
    ) {
      if (db) {
        await recordEventPostCommitDeferred({
          context: input.context,
          db,
          eventId,
          scopeId: input.draft.scopeId,
          actorWid: input.draft.actorWid,
          profileId: input.profile.id,
          phase: 'unexpected_post_commit',
          error
        });
      }
      return;
    }
    const templateFailure = error instanceof EventConditionalTextConfigurationError ? error : undefined;
    await appendEventJsonLog(input.context, {
      action: creationMode === 'unplanned' ? 'event.unplanned_failed' : 'event.publish_failed',
      scopeId: input.draft.scopeId,
      eventId,
      actorWid: input.draft.actorWid,
      profileId: input.profile.id,
      metadata: templateFailure
        ? { field: templateFailure.field, code: templateFailure.code }
        : { reason: error instanceof Error ? error.message : String(error) }
    });
    await input.activeTransport.sendText(
      input.responseChatId,
      templateFailure
        ? input.t('official.community-events.templateConfigurationInvalid')
        : input.t(
            creationMode === 'unplanned'
              ? 'official.community-events.unplannedPublishFailed'
              : 'official.community-events.publishFailed',
            { reason: error instanceof Error ? error.message : String(error) }
          )
    );
  }
}

type EventPostCommitPhaseResult<T> =
  | { ok: true; value: T }
  | { ok: false };

async function runEventPostCommitPhase<T>(input: {
  context: EventFlowCompletionContext;
  db: ReturnType<typeof eventsDatabase>;
  event: StoredEventRecord;
  phase: string;
  operation: () => Promise<T>;
  legacyAction?: string | undefined;
}): Promise<EventPostCommitPhaseResult<T>> {
  try {
    return { ok: true, value: await input.operation() };
  } catch (error) {
    await recordEventPostCommitDeferred({
      context: input.context,
      db: input.db,
      eventId: input.event.id,
      scopeId: input.event.scopeId,
      actorWid: input.event.actorWid,
      profileId: input.event.profileId,
      phase: input.phase,
      error,
      ...(input.legacyAction ? { legacyAction: input.legacyAction } : {})
    });
    return { ok: false };
  }
}

async function recordEventPostCommitDeferred(input: {
  context: EventFlowCompletionContext;
  db: ReturnType<typeof eventsDatabase>;
  eventId: string;
  scopeId: string;
  actorWid: string;
  profileId: string;
  phase: string;
  error: unknown;
  legacyAction?: string | undefined;
}): Promise<void> {
  const reason = input.error instanceof Error ? input.error.message : String(input.error);
  const metadata = { phase: input.phase, reason };
  for (const action of ['event.post_commit_deferred', input.legacyAction].filter(
    (action): action is string => Boolean(action)
  )) {
    try {
      appendEventLog(input.db, {
        eventId: input.eventId,
        action,
        metadata
      });
    } catch {
      // The durable event remains the success boundary even when diagnostics are unavailable.
    }
  }
  await appendEventJsonLog(input.context, {
    action: 'event.post_commit_deferred',
    scopeId: input.scopeId,
    eventId: input.eventId,
    actorWid: input.actorWid,
    profileId: input.profileId,
    metadata
  });
  if (input.phase === 'calendar_publication') {
    await appendEventJsonLog(input.context, {
      action: 'calendar.export_failed',
      scopeId: input.scopeId,
      eventId: input.eventId,
      actorWid: input.actorWid,
      profileId: input.profileId,
      metadata: { reason }
    });
  }
  if (input.context.logger) {
    try {
      input.context.logger.warn(
        {
          eventId: input.eventId,
          scopeId: input.scopeId,
          phase: input.phase,
          reason
        },
        'Deferred official.community-events post-commit work'
      );
    } catch {
      // Diagnostics must never turn a durable creation into a user-visible failure.
    }
  }
}

function startEventPollPublicationObservation(input: {
  db: ReturnType<typeof eventsDatabase>;
  eventId: string;
  startedAt: number;
}): { promise: Promise<StoredEventRecord>; cancel: () => void } {
  const controller = new AbortController();
  return {
    promise: observeEventPollPublication({ ...input, signal: controller.signal }),
    cancel: () => controller.abort()
  };
}

async function observeEventPollPublication(input: {
  db: ReturnType<typeof eventsDatabase>;
  eventId: string;
  startedAt: number;
  signal: AbortSignal;
}): Promise<StoredEventRecord> {
  let event = requireStoredEvent(input.db, input.eventId);
  if (event.pollWaMsgId) {
    return event;
  }
  const deadline = input.startedAt + EVENT_POLL_PUBLICATION_OBSERVATION_MS;
  while (!input.signal.aborted && Date.now() < deadline) {
    await waitForEventPollObservation(Math.min(
      EVENT_POLL_PUBLICATION_OBSERVATION_INTERVAL_MS,
      deadline - Date.now()
    ), input.signal);
    event = requireStoredEvent(input.db, input.eventId);
    if (event.pollWaMsgId) {
      return event;
    }
  }
  return event;
}

function requireStoredEvent(
  db: ReturnType<typeof eventsDatabase>,
  eventId: string
): StoredEventRecord {
  const event = getEvent(db, eventId);
  if (!event) {
    throw new Error(`Durably recorded event ${eventId} is unavailable during publication observation.`);
  }
  return event;
}

function safelyGetStoredEvent(
  db: ReturnType<typeof eventsDatabase>,
  eventId: string
): StoredEventRecord | undefined {
  try {
    return getEvent(db, eventId);
  } catch {
    return undefined;
  }
}

function waitForEventPollObservation(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, delayMs));
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) {
      done();
    }
  });
}

function eventCreatorPublicationNotificationIdempotencyKey(eventId: string): string {
  return `community-events:event-creation:${eventId}:creator-notification`;
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

type CreateUnplannedEventLifecycleResult =
  | { status: 'completed' }
  | {
      status: 'recovery_scheduled' | 'operator_required';
      eventId: string;
      subgroupChatId?: string | undefined;
      subgroupTitle: string;
      creatorMembershipPauseKind?: EventCreatorMembershipPauseKind | undefined;
    };

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
}): Promise<CreateUnplannedEventLifecycleResult> {
  const creatorParticipantWid = eventCreatorParticipantWid(input.draft);
  const nowIso = input.now.toISOString();
  const intent: NewStoredEventRecord & StoredEventRecord = {
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
    ...configuredEventCalendarOwnership(input.profile.calendar.calendarId),
    actorIdentityId: input.draft.actorIdentityId,
    actorWid: input.draft.actorWid,
    actorLabel: input.draft.actorLabel,
    announcementGroupWid: input.announcementGroupWid,
    pollGeneration: 1,
    pollOptions: [],
    responseClasses: input.materialized.responseClasses,
    answers: input.materialized.answers,
    ...(input.materialized.eventLocation ? { eventLocation: input.materialized.eventLocation } : {}),
    startsAt: input.materialized.startsAt.toISOString(),
    startsAtUtc: input.materialized.startsAt.toISOString(),
    endsAt: input.materialized.endsAt.toISOString(),
    lifecycleCompleteAt: input.materialized.lifecycleCompleteAt.toISOString(),
    spanKind: input.materialized.spanKind,
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

  input.db.transaction(() => {
    insertEvent(input.db, intent);
    if (input.profile.startTimeAgreement.enabled && input.materialized.spanKind === 'day_trip' && !input.materialized.localTime) {
      createEventStartTimeAgreement(input.db, {
        eventId: intent.id,
        profile: input.profile,
        createdAt: nowIso,
        nextRunAt: nowIso
      });
    }
  });
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
    event: intent
  });
  if (result.status !== 'completed') {
    return result;
  }
  const created = result.created;
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
  return { status: 'completed' };
}

type ProvisionUnplannedEventSubgroupResult =
  | ({ status: 'completed' } & Awaited<ReturnType<typeof completeEventCommunitySubgroup>>)
  | {
      status: 'recovery_scheduled' | 'operator_required';
      eventId: string;
      subgroupChatId?: string | undefined;
      subgroupTitle: string;
    };

async function provisionUnplannedEventSubgroup(input: {
  context: EventFlowCompletionContext;
  runtime: OfficialPluginCommandRuntime;
  db: ReturnType<typeof eventsDatabase>;
  event: StoredEventRecord;
}): Promise<ProvisionUnplannedEventSubgroupResult> {
  const scheduledCursor = eventProvisioningRecoveryCursor(input.event);
  const generation = scheduledCursor?.nextRunAt ? scheduledCursor.generation : randomUUID();
  const attempt = scheduledCursor?.nextRunAt ? scheduledCursor.attempt : 1;
  const claimedAt = new Date();
  const cleanupAt = new Date(input.event.cleanupAt);
  if (
    !Number.isFinite(cleanupAt.getTime()) ||
    claimedAt.getTime() >= cleanupAt.getTime()
  ) {
    throw new Error(`Unplanned event ${input.event.id} reached its cleanup deadline before subgroup creation.`);
  }
  const claimed = scheduledCursor?.nextRunAt
    ? claimScheduledEventPreCreateProvisioningAttempt(input.db, {
        eventId: input.event.id,
        scopeId: input.event.scopeId,
        generation,
        attempt,
        expectedNextRunAt: scheduledCursor.nextRunAt,
        claimedAt: claimedAt.toISOString()
      })
    : claimInitialEventPreCreateProvisioningAttempt(input.db, {
        eventId: input.event.id,
        scopeId: input.event.scopeId,
        expectedUpdatedAt: input.event.updatedAt,
        generation,
        attempt,
        claimedAt: claimedAt.toISOString()
      });
  if (!claimed) {
    throw new Error(
      `Unplanned event ${input.event.id} already has a claimed subgroup creation attempt; ` +
      'automatic creation is halted pending reconciliation.'
    );
  }
  appendEventLog(input.db, {
    eventId: input.event.id,
    action: 'events.provisioning.precreate_claimed',
    metadata: {
      generation,
      attempt,
      claimedAt: claimedAt.toISOString(),
      origin: 'unplanned',
      scheduledBeforeProviderCall: Boolean(scheduledCursor?.nextRunAt)
    }
  });

  let created: Awaited<ReturnType<typeof createEventCommunitySubgroupCandidate>>['created'] | undefined;
  try {
    const candidateResult = await createEventCommunitySubgroupCandidate({
      context: input.context,
      scopeId: input.event.scopeId,
      actorIdentityId: requireStoredEventActorIdentityId(input.event),
      title: input.event.groupTitle
    });
    created = candidateResult.created;
    const boundAt = new Date().toISOString();
    const bound = checkpointClaimedEventProvisioningChild(input.db, {
      eventId: input.event.id,
      scopeId: input.event.scopeId,
      generation,
      expectedAttempt: attempt,
      nextAttempt: attempt,
      subgroupChatId: created.chatId,
      subgroupTitle: created.title,
      participants: created.participants,
      creator: created.requiredCreator,
      checkpointedAt: boundAt
    });
    if (!bound) {
      throw new Error(
        `Unplanned event ${input.event.id} rejected the exact child checkpoint ${created.chatId}.`
      );
    }
    const checkpointedEvent = getEvent(input.db, input.event.id);
    if (!checkpointedEvent || checkpointedEvent.subgroupChatId !== created.chatId) {
      throw new Error(
        `Unplanned event ${input.event.id} lost exact child ${created.chatId} before cleanup was scheduled.`
      );
    }
    await input.runtime.enqueuePluginJob(eventCleanupJobRequest(checkpointedEvent));
    const creatorLeaseEvent = getEvent(input.db, input.event.id);
    if (!creatorLeaseEvent || creatorLeaseEvent.subgroupChatId !== created.chatId) {
      throw new Error(
        `Unplanned event ${input.event.id} lost its exact claimed subgroup before creator reconciliation.`
      );
    }
    const creatorLeaseRenewedAt = nextEventRevisionTimestamp(creatorLeaseEvent.updatedAt);
    if (!renewClaimedKnownChildEventProvisioningLease(input.db, {
      eventId: creatorLeaseEvent.id,
      scopeId: creatorLeaseEvent.scopeId,
      subgroupChatId: created.chatId,
      expectedEventStatus: creatorLeaseEvent.eventStatus,
      expectedGroupLifecycleStatus: creatorLeaseEvent.groupLifecycleStatus,
      expectedUpdatedAt: creatorLeaseEvent.updatedAt,
      generation,
      attempt,
      renewedAt: creatorLeaseRenewedAt
    })) {
      throw new Error(
        `Unplanned event ${input.event.id} lost its claimed creator-reconciliation lease before provider reconciliation.`
      );
    }
    const creatorResult = await reconcileEventCommunitySubgroupCreator({
      context: input.context,
      scopeId: input.event.scopeId,
      actorIdentityId: requireStoredEventActorIdentityId(input.event),
      subgroupChatId: created.chatId,
      subgroupTitle: created.title,
      requiredCreator: created.requiredCreator,
      participants: created.participants,
      parentCommunityWid: created.intendedParentCommunityJid
    });
    if (creatorResult.created.chatId.trim().toLowerCase() !== created.chatId.trim().toLowerCase()) {
      throw new Error(
        `Unplanned event creator reconciliation returned ${creatorResult.created.chatId}; expected ${created.chatId}.`
      );
    }
    created = {
      ...created,
      title: creatorResult.created.title.trim() || created.title,
      participants: creatorResult.created.participants,
      requiredCreator: creatorResult.created.requiredCreator
    };
    const creatorCheckpointed = checkpointClaimedEventParticipantOutcomes(input.db, {
      eventId: input.event.id,
      scopeId: input.event.scopeId,
      subgroupChatId: created.chatId,
      subgroupTitle: created.title,
      participants: created.participants,
      creator: created.requiredCreator,
      recoveryGeneration: generation,
      recoveryAttempt: attempt,
      checkpointedAt: nextEventRevisionTimestamp(creatorLeaseRenewedAt)
    });
    if (!creatorCheckpointed) {
      throw new Error(
        `Unplanned event ${input.event.id} changed before creator membership was checkpointed.`
      );
    }
    await configureEventCommunitySubgroup({
      context: input.context,
      scopeId: input.event.scopeId,
      actorIdentityId: requireStoredEventActorIdentityId(input.event),
      subgroupChatId: created.chatId,
      subgroupTitle: created.title,
      requiredCreator: created.requiredCreator,
      participants: created.participants,
      parentCommunityWid: created.intendedParentCommunityJid
    });
    const preparedAt = new Date().toISOString();
    const fenced = markClaimedEventReadyForCommunityLink(input.db, {
      eventId: input.event.id,
      scopeId: input.event.scopeId,
      subgroupChatId: created.chatId,
      subgroupTitle: created.title,
      recoveryGeneration: generation,
      recoveryAttempt: attempt,
      closedAt: preparedAt,
      preparedAt
    });
    if (!fenced) {
      throw new Error(
        `Unplanned event ${input.event.id} changed before its community-link fence was persisted.`
      );
    }
    const linkReadyEvent = getEvent(input.db, input.event.id);
    if (!linkReadyEvent) {
      throw new Error(
        `Unplanned event ${input.event.id} disappeared after its community-link fence was persisted.`
      );
    }
    await publishEventCalendarBeforeCommunityLink({
      context: input.context,
      config: parseEventsConfig(await input.runtime.configFor(
        input.event.scopeId,
        requireStoredEventActorIdentityId(input.event)
      )),
      event: linkReadyEvent
    });
    await input.runtime.enqueuePluginJob(eventCleanupJobRequest(linkReadyEvent));
    const linkLeaseRenewedAt = nextEventRevisionTimestamp(linkReadyEvent.updatedAt);
    if (!renewClaimedEventCommunityLinkLease(input.db, {
      eventId: linkReadyEvent.id,
      scopeId: linkReadyEvent.scopeId,
      subgroupChatId: created.chatId,
      expectedUpdatedAt: linkReadyEvent.updatedAt,
      generation,
      attempt,
      renewedAt: linkLeaseRenewedAt
    })) {
      throw new Error(
        `Unplanned event ${input.event.id} lost its claimed community-link lease before provider completion.`
      );
    }
    const result = await completeEventCommunitySubgroup({
      context: input.context,
      scopeId: input.event.scopeId,
      actorIdentityId: requireStoredEventActorIdentityId(input.event),
      subgroupChatId: created.chatId,
      subgroupTitle: created.title,
      requiredCreator: created.requiredCreator,
      participantWids: [],
      participants: created.participants,
      parentCommunityWid: created.intendedParentCommunityJid
    });
    created = {
      ...created,
      title: result.created.title,
      participants: result.created.participants,
      requiredCreator: result.created.requiredCreator
    };
    const completedAt = new Date().toISOString();
    const completed = completeUnplannedEventProvisioning(input.db, {
      eventId: input.event.id,
      scopeId: input.event.scopeId,
      subgroupChatId: created.chatId,
      subgroupTitle: created.title,
      participants: created.participants,
      creator: created.requiredCreator,
      recoveryGeneration: generation,
      recoveryAttempt: attempt,
      recoveryNextRunAt: null,
      completedAt
    });
    if (!completed) {
      throw new Error(
        `Unplanned event ${input.event.id} rejected completion for claimed subgroup ${created.chatId}.`
      );
    }
    return { status: 'completed', ...result };
  } catch (error) {
    const failedAt = new Date();
    const nextAttempt = attempt + 1;
    const knownChild = isManagedCommunitySubgroupProvisioningError(error)
      ? error.created
      : created;
    const recoveryDisposition = isManagedCommunitySubgroupProvisioningError(error)
      ? error.recoveryDisposition
      : undefined;
    const creatorMembershipPauseKind = eventCreatorMembershipPauseKindForFailure(error);
    const retryableLinkDisposition = recoveryDisposition === 'verify_only' ||
      recoveryDisposition === 'creator_membership_verify_only' ||
      recoveryDisposition === 'mutation_allowed';
    const operatorRequired = Boolean(knownChild) && !retryableLinkDisposition;
    const providerHealthDeferral = isBaileysEventPreCreateProviderUnavailableFailure(error);
    const recoveryAttempt = operatorRequired || providerHealthDeferral ? attempt : nextAttempt;
    const runAt = providerHealthDeferral
      ? eventProvisioningProviderHealthRunAt(failedAt)
      : eventCommunityLinkRecoveryRunAt(
          recoveryDisposition,
          failedAt,
          nextAttempt
        );
    let checkpointed = false;
    if (knownChild) {
      const latest = getEvent(input.db, input.event.id);
      if (!latest?.subgroupChatId) {
        checkpointed = checkpointClaimedEventProvisioningChild(input.db, {
          eventId: input.event.id,
          scopeId: input.event.scopeId,
          generation,
          expectedAttempt: attempt,
          nextAttempt: recoveryAttempt,
          ...(!operatorRequired ? { nextRunAt: runAt.toISOString() } : {}),
          subgroupChatId: knownChild.chatId,
          subgroupTitle: knownChild.title,
          participants: knownChild.participants,
          creator: knownChild.requiredCreator,
          checkpointedAt: failedAt.toISOString(),
          reason: error instanceof Error ? error.message : String(error),
          ...(operatorRequired ? { haltedAt: failedAt.toISOString() } : {})
        });
      } else if (latest.subgroupChatId === knownChild.chatId) {
        const outcomesCheckpointed = checkpointClaimedEventParticipantOutcomes(input.db, {
          eventId: input.event.id,
          scopeId: input.event.scopeId,
          subgroupChatId: knownChild.chatId,
          subgroupTitle: knownChild.title,
          participants: knownChild.participants,
          creator: knownChild.requiredCreator,
          recoveryGeneration: generation,
          recoveryAttempt: attempt,
          checkpointedAt: failedAt.toISOString(),
          reason: error instanceof Error ? error.message : String(error)
        });
        checkpointed = outcomesCheckpointed && (operatorRequired
          ? haltClaimedKnownChildEventProvisioning(input.db, {
              eventId: input.event.id,
              scopeId: input.event.scopeId,
              subgroupChatId: knownChild.chatId,
              generation,
              expectedAttempt: attempt,
              reason: error instanceof Error ? error.message : String(error),
              haltedAt: failedAt.toISOString()
            })
          : advanceEventProvisioningRecovery(input.db, {
              eventId: input.event.id,
              scopeId: input.event.scopeId,
              subgroupChatId: knownChild.chatId,
              generation,
              expectedAttempt: attempt,
              expectedNextRunAt: null,
              nextAttempt,
              nextRunAt: runAt.toISOString(),
              updatedAt: failedAt.toISOString()
            }));
      }
    } else if (isManagedCommunitySubgroupPreCreateError(error)) {
      const retryBeforeCleanup = error.retryableWithoutCheckpoint && runAt.getTime() < cleanupAt.getTime();
      const retryAttemptsRemain = providerHealthDeferral ||
        nextAttempt <= EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS;
      const retryScheduled = retryBeforeCleanup && retryAttemptsRemain;
      checkpointed = retryScheduled
        ? rearmClaimedEventPreCreateProvisioningAttempt(input.db, {
            eventId: input.event.id,
            scopeId: input.event.scopeId,
            generation,
            expectedAttempt: attempt,
            nextAttempt: recoveryAttempt,
            nextRunAt: runAt.toISOString(),
            reason: error.message,
            rearmedAt: failedAt.toISOString()
          })
        : error.retryableWithoutCheckpoint && !retryBeforeCleanup
          ? markClaimedEventPreCreateProvisioningMissed(input.db, {
              eventId: input.event.id,
              scopeId: input.event.scopeId,
              generation,
              expectedAttempt: attempt,
              expectedCleanupAt: input.event.cleanupAt,
              reason: 'Event subgroup creation retries reached the cleanup deadline.',
              missedAt: failedAt.toISOString()
            })
          : haltClaimedEventPreCreateProvisioning(input.db, {
              eventId: input.event.id,
              scopeId: input.event.scopeId,
              generation,
              expectedAttempt: attempt,
              reason: error.retryableWithoutCheckpoint && !retryAttemptsRemain
                ? `Event subgroup creation reached the maximum of ${EVENT_PROVISIONING_PRECREATE_MAX_ATTEMPTS} deterministic attempts: ${error.message}`
                : error.message,
              haltedAt: failedAt.toISOString()
            });
      if (!retryScheduled) {
        throw error;
      }
    } else {
      haltClaimedEventPreCreateProvisioning(input.db, {
        eventId: input.event.id,
        scopeId: input.event.scopeId,
        generation,
        expectedAttempt: attempt,
        reason: error instanceof Error ? error.message : String(error),
        haltedAt: failedAt.toISOString()
      });
      throw error;
    }
    const failedEvent = getEvent(input.db, input.event.id);
    if (
      !checkpointed ||
      !failedEvent ||
      failedEvent.provisioningRecoveryGeneration !== generation ||
      failedEvent.provisioningRecoveryAttempt !== recoveryAttempt ||
      failedEvent.provisioningRecoveryNextRunAt !== (
        operatorRequired ? undefined : runAt.toISOString()
      ) ||
      (knownChild && failedEvent.subgroupChatId !== knownChild.chatId)
    ) {
      throw new Error(
        `Unplanned event ${input.event.id} lost its durable provisioning recovery checkpoint.`
      );
    }
    if (knownChild) {
      await input.runtime.enqueuePluginJob(eventCleanupJobRequest(failedEvent));
    }
    appendEventLog(input.db, {
      eventId: failedEvent.id,
      action: 'events.unplanned.provisioning_failed',
      metadata: {
        reason: error instanceof Error ? error.message : String(error),
        ...(knownChild ? {
          subgroupChatId: knownChild.chatId,
          subgroupTitle: knownChild.title,
          participants: knownChild.participants
        } : {}),
        generation,
        failedAttempt: attempt,
        recoveryAttempt,
        providerHealthDeferral,
        ...(recoveryDisposition
          ? { recoveryDisposition }
          : {}),
        ...(isManagedCommunitySubgroupProvisioningError(error) || isManagedCommunitySubgroupPreCreateError(error)
          ? { stage: error.stage }
          : {})
      }
    });
    if (operatorRequired) {
      appendEventLog(input.db, {
        eventId: failedEvent.id,
        action: 'events.provisioning.operator_required',
        metadata: {
          subgroupChatId: knownChild?.chatId,
          generation,
          attempt: recoveryAttempt,
          stage: isManagedCommunitySubgroupProvisioningError(error) ? error.stage : undefined,
          recoveryDisposition: 'operator_required',
          origin: 'unplanned'
        }
      });
      return {
        status: 'operator_required',
        eventId: failedEvent.id,
        ...(knownChild ? { subgroupChatId: knownChild.chatId } : {}),
        subgroupTitle: knownChild?.title ?? failedEvent.groupTitle,
        ...(creatorMembershipPauseKind ? { creatorMembershipPauseKind } : {})
      };
    }
    try {
      await input.runtime.enqueuePluginJob({
        jobName: EVENTS_JOBS.provisioningRecovery,
        scopeId: failedEvent.scopeId,
        ...(failedEvent.groupId ? { groupId: failedEvent.groupId } : {}),
        ...(failedEvent.groupWid ? { groupWid: failedEvent.groupWid } : {}),
        runAt,
        payload: {
          eventId: failedEvent.id,
          ...(knownChild ? { subgroupChatId: knownChild.chatId } : {}),
          generation,
          attempt: recoveryAttempt
        },
        dedupeKey: eventProvisioningRecoveryDedupeKey(failedEvent, {
          generation,
          attempt: recoveryAttempt,
          nextRunAt: runAt.toISOString()
        })
      });
      appendEventLog(input.db, {
        eventId: failedEvent.id,
        action: 'events.provisioning.recovery_scheduled',
        metadata: {
          ...(knownChild ? { subgroupChatId: knownChild.chatId } : {}),
          generation,
          attempt: recoveryAttempt,
          runAt: runAt.toISOString(),
          providerHealthDeferral,
          ...(isManagedCommunitySubgroupProvisioningError(error) || isManagedCommunitySubgroupPreCreateError(error)
            ? { stage: error.stage }
            : {}),
          ...(recoveryDisposition ? { recoveryDisposition } : {}),
          origin: 'unplanned'
        }
      });
    } catch (enqueueError) {
      appendEventLog(input.db, {
        eventId: failedEvent.id,
        action: 'events.provisioning.recovery_enqueue_failed',
        metadata: {
          ...(knownChild ? { subgroupChatId: knownChild.chatId } : {}),
          generation,
          attempt: nextAttempt,
          runAt: runAt.toISOString(),
          reason: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
          origin: 'unplanned'
        }
      });
      throw new Error(
        `Unplanned event ${failedEvent.id} preserved its durable provisioning checkpoint, ` +
        'but its durable provisioning recovery job could not be enqueued.',
        { cause: enqueueError }
      );
    }
    return {
      status: 'recovery_scheduled',
      eventId: failedEvent.id,
      ...(knownChild ? { subgroupChatId: knownChild.chatId } : {}),
      subgroupTitle: knownChild?.title ?? failedEvent.groupTitle,
      ...(creatorMembershipPauseKind ? { creatorMembershipPauseKind } : {})
    };
  }
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
  topicId: 'overview-events' | 'create-events' | 'inspect-events' | 'cancel-events' | 'edit-events' | 'list-events' | 'close-event-polls';
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
    ...(context.services ? { services: context.services } : {}),
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
    enqueuePluginJob: (input) => enqueueRuntimePluginJob(context, {
      pluginId: context.pluginId!,
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

function eventUpdateCommandIdempotencyKey(
  scopeId: string,
  actorIdentityId: string,
  messageId: string,
  eventId: string
): string {
  return `event-update:command:${scopeId}:${actorIdentityId}:${messageId}:${eventId}`;
}

function eventUpdateSelectionIdempotencyKey(
  scopeId: string,
  actorIdentityId: string,
  selectionId: string,
  eventId: string
): string {
  return `event-update:selection:${scopeId}:${actorIdentityId}:${selectionId}:${eventId}`;
}

function eventUpdateFlowInstanceId(externalIdempotencyKey: string): string {
  return createHash('sha256').update(externalIdempotencyKey).digest('hex').slice(0, 24);
}

function eventEditRefinementSelectionId(selectionId: string, query: string): string {
  return createHash('sha256')
    .update(`${selectionId}\0${normalizeEventSearchText(query)}`)
    .digest('hex')
    .slice(0, 32);
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

function eventEditSelectionKey(id: string): string {
  return `event-edit-selection:${id}`;
}

function eventEditSelectionActiveIdentityKey(identityId: string): string {
  return `event-edit-selection-active-identity:${identityId}`;
}

async function rememberActiveEventEditSelection(
  runtime: OfficialPluginCommandRuntime,
  pending: PendingEventEditSelection
): Promise<void> {
  await Promise.all([
    runtime.ephemeralStore.set(
      eventEditSelectionKey(pending.id),
      pending,
      EVENT_EDIT_SELECTION_TTL_SECONDS
    ),
    runtime.ephemeralStore.set(
      eventEditSelectionActiveIdentityKey(pending.actorIdentityId),
      pending.id,
      EVENT_EDIT_SELECTION_TTL_SECONDS
    )
  ]);
}

async function clearActiveEventEditSelection(
  runtime: OfficialPluginCommandRuntime,
  pending: PendingEventEditSelection
): Promise<void> {
  const activeKey = eventEditSelectionActiveIdentityKey(pending.actorIdentityId);
  const activeId = await runtime.ephemeralStore.get<string>(activeKey);
  await runtime.ephemeralStore.delete(eventEditSelectionKey(pending.id));
  if (activeId === pending.id) {
    await runtime.ephemeralStore.delete(activeKey);
  }
}

async function findActiveEventEditSelection(
  runtime: OfficialPluginCommandRuntime,
  actorIdentityId: string
): Promise<PendingEventEditSelection | undefined> {
  const identityId = actorIdentityId.trim();
  if (!identityId) {
    return undefined;
  }
  const activeKey = eventEditSelectionActiveIdentityKey(identityId);
  const pendingId = await runtime.ephemeralStore.get<string>(activeKey);
  if (!pendingId) {
    return undefined;
  }
  const pending = await runtime.ephemeralStore.get<PendingEventEditSelection>(
    eventEditSelectionKey(pendingId)
  );
  if (pending?.actorIdentityId === identityId) {
    return pending;
  }
  await runtime.ephemeralStore.delete(activeKey);
  return undefined;
}

async function cancelActiveEventEditSelectionForActor(
  context: PluginOperationContext,
  runtime: OfficialPluginCommandRuntime,
  actorIdentityId: string
): Promise<{ cancelled: number; scopeId?: string | undefined }> {
  const pending = await findActiveEventEditSelection(runtime, actorIdentityId);
  if (!pending) {
    return { cancelled: 0 };
  }
  await clearActiveEventEditSelection(runtime, pending);
  await context.flowEngine.cancelPromptBySubject({
    purpose: EVENT_EDIT_SELECTION_PURPOSE,
    subjectId: pending.id
  });
  return {
    cancelled: 1,
    scopeId: pending.scopeId
  };
}

function eventEditSelectionActor(pending: PendingEventEditSelection): EventAuthorizationActor {
  return {
    identityId: pending.actorIdentityId,
    canonicalWid: pending.actorWid,
    deliveryChatId: pending.actorDeliveryChatId,
    mentionWid: pending.actorMentionWid
  };
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
  context: PluginOperationContext,
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
    startsAt: answers.startsAt.toISOString(),
    endsAt: answers.endsAt.toISOString()
  };
}

function eventFlowAnswersFromPending(answers: PendingEventFlowAnswers): EventFlowAnswers | undefined {
  const startsAt = new Date(answers.startsAt);
  const endsAt = new Date(answers.endsAt);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) {
    return undefined;
  }
  return {
    ...answers,
    startsAt,
    endsAt
  };
}
