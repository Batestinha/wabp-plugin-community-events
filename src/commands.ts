import { randomUUID } from 'node:crypto';
import { PollSelectionRule } from '@prisma/client';
import type { FlowDefinition, FlowState } from '../../../adminBot/flows/flowTypes';
import type { CommandMetadata, CommandTargetSpec } from '../../../adminBot/router/commandMetadata';
import type { CommandContext } from '../../../adminBot/router/commandRouter';
import type { PluginCancellationRegistration, PluginCommandContext, PluginGroupTitleChangeIntent } from '../../../platform/pluginRuntime/types';
import {
  isManagedCommunitySubgroupProvisioningError,
  type ManagedCommunitySubgroupProvisioningError
} from '../../../platform/pluginRuntime/runtime/pluginCommunityOperations';
import type { PrivateDeliveryFallback } from '../../../platform/transport/transportTypes';
import { requireOfficialCommandRuntime, requireScopeId, type OfficialPluginCommandRuntime } from '../shared';
import { cancelEventLifecycle } from './cancellation';
import { sendClaimedEventAnnouncement } from './announcementDelivery';
import { calendarResourceForProfile, eventProfilePermission, localizeDefaultEventProfiles, parseEventsConfig, type EventCalendarResource, type EventProfile } from './config';
import { sendEventCalendarHint } from './calendarHint';
import { formatEventDateTime } from './datetime';
import { writePublishAndRecordScopeCalendar } from './calendarStatus';
import {
  createEventFlowDefinition,
  eventConfirmPurpose,
  eventFlowAnswers,
  eventFlowConfirmed,
  eventInitialFlowData,
  eventFlowSelectedProfileId,
  renderEventTemplate,
  selectedOptionLabels,
  type EventFlowAnswers,
  type EventFlowPrefill
} from './flow';
import { appendScopeEventJsonLog } from './log';
import { eventGroupHintEnabled, eventGroupJoinUrl, renderEventGroupAnnouncement } from './announcements';
import { materializeEventLifecycle, type MaterializedEventLifecycle } from './materialize';
import { eventLocationQuery, fixedEventLocation, geocodedEventLocation } from './eventLocation';
import { EVENTS_JOBS, EVENTS_PERMISSIONS, EVENTS_PLUGIN_ID } from './manifest';
import { createEventCommunitySubgroup, resumeEventCommunitySubgroup } from './subgroups';
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
  getEventBySubgroupChatId,
  insertEvent,
  listCancellableEvents,
  listCalendarEvents,
  newEventId,
  recordEventAnnouncementMessage,
  updateEventStructuredData,
  type StoredEventLocation,
  type StoredEventRecord,
} from './store';

const CHAT_TARGET: CommandTargetSpec = {
  kind: 'group',
  name: 'chat',
  flag: 'chat',
  position: 0
};

const SCOPE_TARGET: CommandTargetSpec = {
  kind: 'scope',
  flag: ['scope', 'scope-id'],
  fallback: 'current_scope'
};

interface EventDraft {
  flowSessionId: string;
  flowType: string;
  scopeId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
  chatId: string;
  actorWid: string;
  actorAliases?: string[] | undefined;
  actorLabel: string;
  defaultAnnouncementGroupWid?: string | undefined;
  timezone: string;
  locale: string;
  profiles: EventProfile[];
  calendars: EventCalendarResource[];
  prefill: EventFlowPrefill;
  createdAt: string;
}

interface EventCancelDraft {
  flowSessionId: string;
  flowType: string;
  scopeId: string;
  chatId: string;
  actorWid: string;
  actorAliases: string[];
  actorLabel: string;
  candidateEventIds: string[];
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
  requestedTitle: string;
  sourcePluginId: string;
  actorWid: string;
  actorAliases: string[];
  actorLabel: string;
  timezone: string;
  locale: string;
  profile: EventProfile;
  profiles: EventProfile[];
  calendars: EventCalendarResource[];
  prefill: EventFlowPrefill;
  createdAt: string;
}

interface EventTextTransport {
  sendText(chatId: string, text: string): Promise<{ messageId?: string | undefined }>;
  setGroupSubject(chatId: string, subject: string): Promise<void>;
}

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
  place?: string | undefined;
  query?: string | undefined;
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
  place?: string | undefined;
  query?: string | undefined;
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
    const config = parseEventsConfig(await runtime.configFor(requireScopeId(ctx), ctx.message.senderWid));
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

  router.register('event', '*', eventCommand({
    auditAction: 'events.create',
    usage: '/event [groupName|--chat groupName]',
    topicId: 'create-events',
    descriptionKey: 'official.community-events.help.command',
    exampleKey: 'official.community-events.help.create.example'
  }), async (ctx) => startEventFlow(context, ctx));
}

export function registerEventsCancellations(context: PluginCommandContext): PluginCancellationRegistration[] {
  const runtime = requireOfficialCommandRuntime(context);
  return [{
    workflowId: EVENT_LOCATION_SELECTION_CANCELLATION_WORKFLOW_ID,
    cancel: async (input) => {
      const result = await cancelActiveEventLocationSelectionsForActor(context, runtime, {
        actorWids: input.actorWids,
        chatId: input.message.chatId
      });
      if (result.cancelled === 0) {
        return undefined;
      }
      const t = await context.i18n.translatorForIdentity(input.actor.wid, result.scopeId);
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
  await cancelActiveEventLocationSelectionsForActor(context, runtime, {
    actorWids: eventActorWids(ctx),
    chatId: ctx.message.chatId
  });
  const scopeId = requireScopeId(ctx);
  const config = parseEventsConfig(await runtime.configFor(scopeId, ctx.message.senderWid));
  if (!config.enabled) {
    return { handled: true, text: ctx.t('official.community-events.disabled') };
  }
  if (config.eventProfiles.length === 0) {
    return { handled: true, text: ctx.t('official.community-events.notConfigured') };
  }
  const eventProfiles = localizeDefaultEventProfiles(config.eventProfiles, ctx.t);
  const defaultAnnouncementGroupWid = await context.communityAnnouncementGroupWidForScope?.(scopeId) ||
    ctx.groupWid;
  if (!defaultAnnouncementGroupWid && !eventProfiles.some((profile) => profile.announcementGroupWid)) {
    return { handled: true, text: ctx.t('official.community-events.notConfigured') };
  }

  const prefill = parseEventPrefillArgs(ctx.remainingArgs ?? ctx.command.args, eventProfiles);
  const startedAt = new Date();
  const initialData = eventInitialFlowData(eventProfiles, prefill, {
    timezone: config.timezone,
    locale: ctx.locale,
    now: startedAt
  });
  const definition = createEventFlowDefinition({
    t: ctx.t,
    profiles: eventProfiles,
    prefill,
    timezone: config.timezone,
    locale: ctx.locale,
    initialData,
    completeMessageKey: false
  });
  registerEventFlowCompletionHandlers(context, definition.flowType, eventProfiles, ctx.t);
  const actorAliases = eventActorWids(ctx);
  const privateActorWid = eventPrivateChatWid(actorAliases, ctx.actor?.wid ?? ctx.message.senderWid) ?? ctx.message.senderWid;
  const privateDeliveryFallback = privateFlowDeliveryFallback(ctx, actorAliases);
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
      scopeId,
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
        ? ctx.t('official.community-events.privateStartFailed')
        : ctx.t('official.community-events.startFailed')
    };
  }
  const draft: EventDraft = {
    flowSessionId,
    flowType: definition.flowType,
    scopeId,
    ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
    ...(ctx.groupWid ? { groupWid: ctx.groupWid } : {}),
    chatId: conversationChatId,
    actorWid: ctx.message.senderWid,
    actorAliases,
    actorLabel: ctx.message.senderDisplayName ?? ctx.message.senderWid,
    ...(defaultAnnouncementGroupWid ? { defaultAnnouncementGroupWid } : {}),
    timezone: config.timezone,
    locale: ctx.locale,
    profiles: eventProfiles,
    calendars: config.calendars,
    prefill,
    createdAt: new Date().toISOString()
  };
  await runtime.dataStore.set(eventDraftKey(scopeId, flowSessionId), draft);
  if (ctx.message.context !== 'group') {
    return { handled: true, response: { kind: 'none' as const } };
  }
  return {
    handled: true,
    text: ctx.t(usedPrivateDeliveryFallback
      ? 'official.community-events.startedInGroupFallback'
      : 'official.community-events.startedPrivate')
  };
}

async function startEventCancelFlow(context: PluginCommandContext, ctx: CommandContext) {
  const runtime = requireOfficialCommandRuntime(context);
  await cancelActiveEventLocationSelectionsForActor(context, runtime, {
    actorWids: eventActorWids(ctx),
    chatId: ctx.message.chatId
  });
  const scopeId = requireScopeId(ctx);
  const db = eventsDatabase(runtime.databases);
  const actorAliases = eventActorWids(ctx);
  const actorWid = eventPrivateChatWid(actorAliases, ctx.actor?.wid ?? ctx.message.senderWid) ?? ctx.message.senderWid;
  const privateDeliveryFallback = privateFlowDeliveryFallback(ctx, actorAliases);
  const actorLabel = ctx.message.senderDisplayName ?? actorWid;
  const query = ctx.command.args.join(' ').trim();
  const resolution = await resolveEventCancelCandidates(context, {
    db,
    scopeId,
    chatId: ctx.message.chatId,
    query,
    locale: ctx.locale,
    actorWids: actorAliases
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
    actorWid,
    actorAliases,
    actorLabel,
    candidateEventIds: resolution.candidates.map((event) => event.id),
    createdAt: new Date().toISOString()
  } satisfies EventCancelDraft);
  return { handled: true, text: ctx.t('official.community-events.cancel.started') };
}

export async function handleEventGroupTitleChangeIntent(
  context: PluginCommandContext,
  input: PluginGroupTitleChangeIntent
) {
  const ctx = input.commandContext;
  if (!ctx.groupWid) {
    return undefined;
  }
  const runtime = requireOfficialCommandRuntime(context);
  const scopeId = requireScopeId(ctx);
  const config = parseEventsConfig(await runtime.configFor(scopeId, ctx.message.senderWid));
  if (!config.enabled) {
    return undefined;
  }
  const db = eventsDatabase(runtime.databases);
  const event = getEventBySubgroupChatId(db, ctx.groupWid);
  if (!event || event.scopeId !== scopeId) {
    return undefined;
  }

  const actorAliases = eventActorWids(ctx);
  if (!await eventUpdateAllowed(context, { event, actorWids: actorAliases })) {
    return { handled: true, text: ctx.t('official.community-events.update.permissionDenied') };
  }

  return startEventUpdateFlow(context, ctx, {
    event,
    config,
    requestedTitle: input.requestedTitle,
    sourcePluginId: input.sourcePluginId
  });
}

async function startEventUpdateFlow(
  context: PluginCommandContext,
  ctx: CommandContext,
  input: {
    event: StoredEventRecord;
    config: ReturnType<typeof parseEventsConfig>;
    requestedTitle: string;
    sourcePluginId: string;
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
    now: startedAt
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
    completeMessageKey: false
  });
  registerEventUpdateFlowCompletionHandler(context, definition.flowType, profile, ctx.t);

  const actorAliases = eventActorWids(ctx);
  const privateActorWid = eventPrivateChatWid(actorAliases, ctx.actor?.wid ?? ctx.message.senderWid) ?? ctx.message.senderWid;
  const privateDeliveryFallback = privateFlowDeliveryFallback(ctx, actorAliases);
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
    requestedTitle: input.requestedTitle,
    sourcePluginId: input.sourcePluginId,
    actorWid: ctx.message.senderWid,
    actorAliases,
    actorLabel: ctx.message.senderDisplayName ?? ctx.message.senderWid,
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
    if (!event) {
      await activeTransport.sendText(responseChatId, t('official.community-events.update.invalid'));
      return true;
    }
    if (!await eventUpdateAllowed(context, { event, actorWids: draft.actorAliases })) {
      await activeTransport.sendText(responseChatId, t('official.community-events.update.permissionDenied'));
      return true;
    }

    const answers = eventFlowAnswers(snapshot, draft.profile, draft.timezone, draft.locale);
    if (!answers) {
      await activeTransport.sendText(responseChatId, t('official.community-events.update.invalid'));
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
    (input.event.eventLocation.displayLabel === place || input.event.eventLocation.query === place)
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
  try {
    const output = await input.context.services.call<GeocodeOutput>({
      serviceId: GEOCODER_SERVICE_ID,
      method: GEOCODER_GEOCODE_METHOD,
      scopeId: input.draft.scopeId,
      actorWid: input.draft.actorWid,
      ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
      ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
      input: {
        query: place,
        language: input.draft.locale,
        limit: 5
      }
    });
    if (!output.results.length) {
      await input.activeTransport.sendText(
        input.responseChatId,
        input.t('official.community-events.location.noResults', { query: place })
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
      place,
      query: place,
      provider: output.provider,
      candidates: output.results
    };
    await promptEventLocationConfirmation({ ...input, pending });
  } catch {
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.location.failed')
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
  t: CommandContext['t'];
}): Promise<void> {
  const db = eventsDatabase(input.runtime.databases);
  const event = getEvent(db, input.eventId);
  if (!event) {
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.update.invalid')
    );
    return;
  }
  if (!await eventUpdateAllowed(input.context, { event, actorWids: input.draft.actorAliases })) {
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.update.permissionDenied')
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
    const config = draftEventsConfig({
      timezone: input.draft.timezone,
      calendars: input.draft.calendars,
      profiles: input.draft.profiles
    });
    await updateEventLifecycle({
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
      requestedTitle: input.draft.requestedTitle,
      sourcePluginId: input.draft.sourcePluginId
    });
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.update.done', {
        title: materialized.groupTitle,
        eventId: event.id
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
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.update.failed', { reason })
    );
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
  requestedTitle: string;
  sourcePluginId?: string | undefined;
}): Promise<void> {
  const now = new Date();
  const updatedAt = now.toISOString();
  updateEventStructuredData(input.db, {
    eventId: input.event.id,
    pollQuestion: input.materialized.pollQuestion,
    pollOptions: input.materialized.pollOptions,
    responseClasses: input.materialized.responseClasses,
    answers: input.materialized.answers,
    ...(input.materialized.eventLocation ? { eventLocation: input.materialized.eventLocation } : {}),
    startsAt: input.materialized.startsAt.toISOString(),
    startsAtUtc: input.materialized.startsAt.toISOString(),
    timezone: input.event.timezone || input.config.timezone,
    localDate: input.materialized.localDate,
    ...(input.materialized.localTime ? { localTime: input.materialized.localTime } : {}),
    ...(input.materialized.place ? { place: input.materialized.place } : {}),
    ...(input.materialized.style ? { style: input.materialized.style } : {}),
    closeAt: input.materialized.closeAt.toISOString(),
    cleanupAt: input.materialized.cleanupAt.toISOString(),
    groupTitle: input.materialized.groupTitle,
    calendarDurationMinutes: input.materialized.calendarDurationMinutes,
    ...(input.materialized.calendarLocation ? { calendarLocation: input.materialized.calendarLocation } : {}),
    ...(input.materialized.calendarDescription ? { calendarDescription: input.materialized.calendarDescription } : {}),
    updatedAt
  });

  if (input.event.subgroupChatId) {
    const capabilities = await input.context.botCapabilitiesFor?.(input.event.subgroupChatId);
    if (capabilities && (!capabilities.botIsAdmin || !capabilities.canChangeInfo || !capabilities.canSetSubject)) {
      throw new Error('Bot cannot change the event subgroup subject.');
    }
    await input.activeTransport.setGroupSubject(input.event.subgroupChatId, input.materialized.groupTitle);
  }

  const calendar = calendarResourceForProfile(input.config, input.profile);
  const calendarEvents = listCalendarEvents(input.db, input.event.scopeId);
  const publication = await writePublishAndRecordScopeCalendar({
    appConfig: input.runtime.config,
    db: input.db,
    config: input.config,
    scopeId: input.event.scopeId,
    calendarId: input.profile.calendar.calendarId,
    events: calendarEvents
  });

  if (
    input.event.subgroupChatId &&
    input.event.eventStatus === 'active' &&
    (input.event.groupLifecycleStatus === 'poll_closed' || input.event.groupLifecycleStatus === 'cleanup_failed') &&
    input.materialized.cleanupAt.getTime() > now.getTime()
  ) {
    await input.runtime.enqueuePluginJob({
      jobName: EVENTS_JOBS.cleanup,
      scopeId: input.event.scopeId,
      ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
      ...(input.event.groupWid ? { groupWid: input.event.groupWid } : {}),
      runAt: input.materialized.cleanupAt,
      payload: { eventId: input.event.id, attempt: 0 },
      dedupeKey: `${EVENTS_JOBS.cleanup}:${input.event.id}:updated:${input.materialized.cleanupAt.toISOString()}`
    });
  }
  if (
    input.event.subgroupChatId &&
    input.event.eventStatus === 'active' &&
    (input.event.groupLifecycleStatus === 'poll_closed' || input.event.groupLifecycleStatus === 'cleanup_failed')
  ) {
    const weatherRequest = eventWeatherForecastJobRequest({
      event: {
        ...input.event,
        startsAt: input.materialized.startsAt.toISOString(),
        startsAtUtc: input.materialized.startsAt.toISOString(),
        timezone: input.event.timezone || input.config.timezone,
        ...(input.materialized.eventLocation ? { eventLocation: input.materialized.eventLocation } : {}),
        localDate: input.materialized.localDate,
        ...(input.materialized.localTime ? { localTime: input.materialized.localTime } : {}),
        closeAt: input.materialized.closeAt.toISOString(),
        cleanupAt: input.materialized.cleanupAt.toISOString(),
        groupTitle: input.materialized.groupTitle,
        ...(input.event.subgroupTitle || input.materialized.groupTitle ? { subgroupTitle: input.materialized.groupTitle } : {})
      },
      profile: input.profile
    });
    if (weatherRequest) {
      await input.runtime.enqueuePluginJob(weatherRequest);
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
      calendarId: input.profile.calendar.calendarId,
      publication
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
      ...(publication ? { publication } : {})
    }
  });
}

async function eventUpdateAllowed(
  context: PluginCommandContext,
  input: {
    event: StoredEventRecord;
    actorWids: string[];
  }
): Promise<boolean> {
  const actorWids = uniqueEventWids(input.actorWids);
  if (actorWids.includes(input.event.actorWid)) {
    return true;
  }
  if (!context.explainPermission) {
    return false;
  }
  for (const actorWid of actorWids) {
    const decision = await context.explainPermission({
      actorWid,
      action: EVENTS_PERMISSIONS.manage,
      scopeId: input.event.scopeId,
      pluginId: EVENTS_PLUGIN_ID,
      ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
      ...(input.event.groupWid ? { groupWid: input.event.groupWid } : {}),
      requiresCurrentManagedGroupMembership: false
    });
    if (decision.allowed) {
      return true;
    }
  }
  return false;
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
    if (!await eventCancellationAllowed(context, { event, actorWids: draft.actorAliases })) {
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
    actorWids: string[];
  }
): Promise<
  | { status: 'candidates'; candidates: StoredEventRecord[] }
  | { status: 'none' }
  | { status: 'permission_denied' }
> {
  const allCandidates = listCancellableEvents(input.db, input.scopeId);
  const subgroupCandidate = input.query
    ? undefined
    : getEventBySubgroupChatId(input.db, input.chatId);
  const directSubgroupCandidate = subgroupCandidate?.scopeId === input.scopeId ? subgroupCandidate : undefined;
  const matched = directSubgroupCandidate
    ? [directSubgroupCandidate]
    : input.query
      ? findEventCancelMatches(allCandidates, input.query, input.locale)
      : allCandidates;
  if (matched.length === 0) {
    return { status: 'none' };
  }

  const authorized: StoredEventRecord[] = [];
  for (const event of matched) {
    if (await eventCancellationAllowed(context, { event, actorWids: input.actorWids })) {
      authorized.push(event);
    }
  }
  if (authorized.length === 0) {
    return input.query || directSubgroupCandidate
      ? { status: 'permission_denied' }
      : { status: 'none' };
  }
  return { status: 'candidates', candidates: uniqueEvents(authorized) };
}

async function eventCancellationAllowed(
  context: PluginCommandContext,
  input: {
    event: StoredEventRecord;
    actorWids: string[];
  }
): Promise<boolean> {
  const actorWids = uniqueEventWids(input.actorWids);
  if (actorWids.includes(input.event.actorWid)) {
    return true;
  }
  if (!context.explainPermission) {
    return false;
  }
  for (const actorWid of actorWids) {
    const decision = await context.explainPermission({
      actorWid,
      action: EVENTS_PERMISSIONS.manage,
      scopeId: input.event.scopeId,
      pluginId: EVENTS_PLUGIN_ID,
      ...(input.event.groupId ? { groupId: input.event.groupId } : {}),
      ...(input.event.groupWid ? { groupWid: input.event.groupWid } : {}),
      requiresCurrentManagedGroupMembership: false
    });
    if (decision.allowed) {
      return true;
    }
  }
  return false;
}

function findEventCancelMatches(events: StoredEventRecord[], query: string, locale = 'en'): StoredEventRecord[] {
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

function registerEventFlowCompletionHandlers(
  context: PluginCommandContext,
  flowType: string,
  profiles: EventProfile[],
  t: CommandContext['t']
): void {
  const runtime = requireOfficialCommandRuntime(context);
  for (const profile of profiles) {
    context.flowEngine.registerPromptHandler(eventConfirmPurpose(flowType, profile), async (lock, activeTransport) => {
      if (!lock.flowSessionId) {
        return false;
      }
      const snapshot = await context.flowEngine.getSessionSnapshot(lock.flowSessionId);
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
      const permission = eventProfilePermission(profile);
      const permissionAllowed = await eventActorPermissionAllowed(context, {
        actorWids: draft.actorAliases ?? [draft.actorWid],
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
        draft,
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
    const t = await context.i18n.translatorForIdentity(pending.draft.actorWid, pending.draft.scopeId);
    const answers = eventFlowAnswersFromPending(pending.answers);
    if (!answers) {
      await clearActiveEventLocationSelection(runtime, pending);
      await activeTransport.sendText(
        pending.responseChatId,
        t('official.community-events.invalid')
      );
      return true;
    }
    const actorAliases = pending.draft.actorAliases ?? [pending.draft.actorWid];
    if (!actorAliases.includes(lock.voterWid)) {
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
    const query = eventLocationQuery(profile, answers.answers);
    if (!query) {
      await activeTransport.sendText(
        pending.responseChatId,
        t('official.community-events.location.invalid')
      );
      return true;
    }
    const displayLabel = pending.place ?? query;
    const eventLocation = geocodedEventLocation({
      query: pending.query ?? query,
      displayLabel,
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
        t
      });
    }
    return true;
  });
}

async function promptEventLocationConfirmation(input: {
  context: PluginCommandContext;
  runtime: OfficialPluginCommandRuntime;
  activeTransport: EventTextTransport;
  pending: PendingEventLocationSelection;
  t: CommandContext['t'];
}): Promise<void> {
  const options = eventLocationCandidateOptions(input.pending.candidates);
  const place = input.pending.place ?? input.pending.query ?? input.pending.candidates[0]?.label ?? '';
  const question = options.length > 0
    ? input.t('official.community-events.location.select', { query: place })
    : input.t('official.community-events.location.noResults', { query: input.pending.query ?? place });
  await rememberActiveEventLocationSelection(input.runtime, input.pending);
  try {
    await input.context.flowEngine.promptChoice({
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
      eligibleVoterWids: input.pending.draft.actorAliases ?? [input.pending.draft.actorWid],
      selectionRule: PollSelectionRule.SINGLE,
      minSelections: 1,
      maxSelections: 1,
      expiresAt: new Date(Date.now() + EVENT_LOCATION_SELECTION_TTL_SECONDS * 1000),
      t: input.t
    });
  } catch (error) {
    await clearActiveEventLocationSelection(input.runtime, input.pending);
    throw error;
  }
}

async function requeryEventLocationSelection(input: {
  context: PluginCommandContext;
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
  try {
    const output = await input.context.services.call<GeocodeOutput>({
      serviceId: GEOCODER_SERVICE_ID,
      method: GEOCODER_GEOCODE_METHOD,
      scopeId: input.pending.draft.scopeId,
      actorWid: input.pending.draft.actorWid,
      ...(input.pending.draft.groupId ? { groupId: input.pending.draft.groupId } : {}),
      ...(input.pending.draft.groupWid ? { groupWid: input.pending.draft.groupWid } : {}),
      input: {
        query: input.query,
        language: input.pending.draft.locale,
        limit: 5
      }
    });
    if (!output.results.length) {
      const replaceUnresolvedPlace = input.pending.candidates.length === 0;
      const pending = replaceUnresolvedPlace
        ? pendingWithReplacedEventLocationAnswer(input.pending, input.query)
        : input.pending;
      await promptEventLocationConfirmation({
        context: input.context,
        runtime: input.runtime,
        activeTransport: input.activeTransport,
        pending: {
          ...pending,
          id: randomUUID(),
          query: input.query,
          provider: output.provider,
          candidates: []
        },
        t: input.t
      });
      return;
    }
    const replaceUnresolvedPlace = input.pending.candidates.length === 0;
    const pending = replaceUnresolvedPlace
      ? pendingWithReplacedEventLocationAnswer(input.pending, input.query)
      : input.pending;
    await promptEventLocationConfirmation({
      context: input.context,
      runtime: input.runtime,
      activeTransport: input.activeTransport,
      pending: {
        ...pending,
        id: randomUUID(),
        query: input.query,
        provider: output.provider,
        candidates: output.results
      },
      t: input.t
    });
  } catch {
    await input.activeTransport.sendText(
      input.pending.responseChatId,
      input.t('official.community-events.location.failed')
    );
  }
}

async function beginEventLocationSelection(input: {
  context: PluginCommandContext;
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
  try {
    const output = await input.context.services.call<GeocodeOutput>({
      serviceId: GEOCODER_SERVICE_ID,
      method: GEOCODER_GEOCODE_METHOD,
      scopeId: input.draft.scopeId,
      actorWid: input.draft.actorWid,
      ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
      ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
      input: {
        query: place,
        language: input.draft.locale,
        limit: 5
      }
    });
    if (!output.results.length) {
      const pending: PendingEventLocationSelection = {
        kind: 'create',
        id: randomUUID(),
        responseChatId: input.responseChatId,
        draft: input.draft,
        profile: input.profile,
        answers: pendingEventFlowAnswers(input.answers),
        announcementGroupWid: input.announcementGroupWid,
        place,
        query: place,
        provider: output.provider,
        candidates: []
      };
      await promptEventLocationConfirmation({ ...input, pending });
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
      place,
      query: place,
      provider: output.provider,
      candidates: output.results
    };
    await promptEventLocationConfirmation({ ...input, pending });
  } catch {
    await input.activeTransport.sendText(
      input.responseChatId,
      input.t('official.community-events.location.failed')
    );
  }
}

async function publishConfirmedEvent(input: {
  context: PluginCommandContext;
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
      actorWid: input.draft.actorWid,
      ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
      ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
      input: {
        actorWid: input.draft.actorWid,
        scopeId: input.draft.scopeId,
        ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
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
    const event: StoredEventRecord = {
      id: eventId,
      scopeId: input.draft.scopeId,
      ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
      ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
      profileId: input.profile.id,
      profileLabel: input.profile.label,
      origin: 'created',
      eventStatus: 'active',
      groupLifecycleStatus: 'poll_open',
      calendarStatus: 'included',
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
      ...(materialized.style ? { style: materialized.style } : {}),
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

async function createUnplannedEventLifecycle(input: {
  context: PluginCommandContext;
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
  const intent: StoredEventRecord = {
    id: input.eventId,
    scopeId: input.draft.scopeId,
    ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
    ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
    profileId: input.profile.id,
    profileLabel: input.profile.label,
    origin: 'unplanned',
    eventStatus: 'failed',
    groupLifecycleStatus: 'none',
    calendarStatus: 'hidden',
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
    ...(input.materialized.style ? { style: input.materialized.style } : {}),
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

  try {
    const config = draftEventsConfig(input.draft);
    const calendar = calendarResourceForProfile(config, input.profile);
    const calendarEvents = listCalendarEvents(input.db, input.draft.scopeId);
    const publication = await writePublishAndRecordScopeCalendar({
      appConfig: input.runtime.config,
      db: input.db,
      config,
      scopeId: input.draft.scopeId,
      calendarId: input.profile.calendar.calendarId,
      events: calendarEvents
    });
    await appendEventJsonLog(input.context, {
      action: 'calendar.exported',
      scopeId: input.draft.scopeId,
      eventId: event.id,
      actorWid: input.draft.actorWid,
      profileId: input.profile.id,
      subgroupChatId: created.chatId,
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
      eventId: event.id,
      actorWid: input.draft.actorWid,
      profileId: input.profile.id,
      subgroupChatId: created.chatId,
      metadata: { reason: error instanceof Error ? error.message : String(error) }
    });
  }

  await appendEventJsonLog(input.context, {
    action: 'event.created',
    scopeId: input.draft.scopeId,
    eventId: event.id,
    actorWid: input.draft.actorWid,
    profileId: input.profile.id,
    subgroupChatId: created.chatId,
    metadata: {
      origin: 'unplanned',
      announcementGroupWid: input.announcementGroupWid,
      groupTitle: input.materialized.groupTitle,
      answers: input.materialized.answers,
      startsAt: input.materialized.startsAt.toISOString(),
      closeAt: input.materialized.closeAt.toISOString(),
      cleanupAt: input.materialized.cleanupAt.toISOString(),
      prefill: input.draft.prefill
    }
  });
  await input.runtime.enqueuePluginJob({
    jobName: EVENTS_JOBS.cleanup,
    scopeId: input.draft.scopeId,
    ...(input.draft.groupId ? { groupId: input.draft.groupId } : {}),
    ...(input.draft.groupWid ? { groupWid: input.draft.groupWid } : {}),
    runAt: input.materialized.cleanupAt,
    payload: { eventId: event.id, attempt: 0 },
    dedupeKey: `${EVENTS_JOBS.cleanup}:${event.id}:unplanned`
  });
  const weatherRequest = eventWeatherForecastJobRequest({ event, profile: input.profile, now: input.now });
  if (weatherRequest) {
    await input.runtime.enqueuePluginJob(weatherRequest);
  }

  const groupJoinUrl = eventGroupHintEnabled(input.profile, 'unplanned')
    ? await eventGroupJoinUrl(input.context, input.profile.eventGroupHint.template, created.chatId)
    : '';
  if (eventGroupHintEnabled(input.profile, 'unplanned')) {
    const announcementText = renderEventGroupAnnouncement({
      template: input.profile.eventGroupHint.template,
      profile: input.profile,
      event,
      groupDisplayName: created.title || input.materialized.groupTitle,
      groupJoinUrl,
      subgroupChatId: created.chatId,
      locale: input.draft.locale,
      creatorDisplayName: input.draft.actorLabel || input.draft.actorWid
    });
    const delivery = await sendClaimedEventAnnouncement({
      db: input.db,
      eventId: event.id,
      scopeId: event.scopeId,
      kind: 'event_group_hint',
      chatId: input.announcementGroupWid,
      text: announcementText,
      sender: input.activeTransport
    });
    if (delivery.status === 'sent') {
      await appendEventJsonLog(input.context, {
        action: 'event.unplanned_announcement_sent',
        scopeId: input.draft.scopeId,
        eventId: event.id,
        actorWid: input.draft.actorWid,
        profileId: input.profile.id,
        subgroupChatId: created.chatId,
        metadata: {
          announcementGroupWid: input.announcementGroupWid,
          messageId: delivery.messageId,
          groupJoinUrl
        }
      });
    }
  }
  await sendEventCalendarHint({
    context: input.context,
    runtime: input.runtime,
    activeTransport: input.activeTransport,
    trigger: 'unplanned_created',
    scopeId: input.draft.scopeId,
    announcementGroupWid: input.announcementGroupWid,
    event,
    profile: input.profile,
    calendars: input.draft.calendars,
    timezone: input.draft.timezone,
    locale: input.draft.locale,
    creatorDisplayName: input.draft.actorLabel || input.draft.actorWid,
    groupJoinUrl,
    subgroupChatId: created.chatId
  });
}

async function provisionUnplannedEventSubgroup(input: {
  context: PluginCommandContext;
  db: ReturnType<typeof eventsDatabase>;
  event: StoredEventRecord;
  creatorParticipantWid: string;
}): Promise<Awaited<ReturnType<typeof createEventCommunitySubgroup>>> {
  try {
    return await createEventCommunitySubgroup({
      context: input.context,
      scopeId: input.event.scopeId,
      actorWid: input.event.actorWid,
      title: input.event.groupTitle,
      participantWids: [input.creatorParticipantWid]
    });
  } catch (error) {
    if (!isManagedCommunitySubgroupProvisioningError(error)) {
      throw error;
    }
    checkpointManagedUnplannedProvisioningFailure(input.db, input.event, error);
    try {
      const resumed = await resumeEventCommunitySubgroup({
        context: input.context,
        scopeId: input.event.scopeId,
        actorWid: input.event.actorWid,
        subgroupChatId: error.created.chatId,
        subgroupTitle: error.created.title,
        participantWids: [input.creatorParticipantWid],
        participants: error.created.participants,
        parentCommunityWid: error.provisioning.parentCommunityWid
      });
      if (resumed.created.chatId !== error.created.chatId) {
        throw new Error(
          `Unplanned subgroup resume returned ${resumed.created.chatId}; ` +
          `expected the checkpointed subgroup ${error.created.chatId}.`
        );
      }
      return resumed;
    } catch (resumeError) {
      if (isManagedCommunitySubgroupProvisioningError(resumeError)) {
        checkpointManagedUnplannedProvisioningFailure(input.db, input.event, resumeError);
      }
      throw resumeError;
    }
  }
}

function checkpointManagedUnplannedProvisioningFailure(
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  error: ManagedCommunitySubgroupProvisioningError
): void {
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
    failedAt: new Date().toISOString()
  });
  if (!checkpointed) {
    throw new Error(
      `Unplanned event ${event.id} rejected provisioning output for subgroup ${error.created.chatId}; ` +
      'the event is already bound to another subgroup or left its recoverable state.'
    );
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
  const aliases = uniqueEventWids([draft.actorWid, ...(draft.actorAliases ?? [])]);
  return aliases.find((wid) => !wid.endsWith('@g.us')) ??
    draft.actorWid;
}

function eventCommand(input: {
  mutation?: CommandMetadata['mutation'] | undefined;
  auditAction: string;
  permission?: string | undefined;
  usage: string;
  topicId: 'create-events' | 'inspect-events' | 'cancel-events';
  descriptionKey: string;
  exampleKey: string;
  requiresCurrentManagedGroupMembership?: boolean | undefined;
  privateManagedTargetArgPosition?: number | false | undefined;
  assistant?: CommandMetadata['assistant'] | undefined;
}): CommandMetadata {
  return {
    plane: 'group_operation',
    interaction: 'either_same_chat',
    pluginId: EVENTS_PLUGIN_ID,
    ...(input.permission ? { permission: input.permission } : {}),
    requiresManagedGroup: true,
    ...(input.requiresCurrentManagedGroupMembership !== undefined
      ? { requiresCurrentManagedGroupMembership: input.requiresCurrentManagedGroupMembership }
      : {}),
    privateManagedTarget: {
      mode: 'infer_group_or_community',
      explicitTargetName: 'chat',
      ...(input.privateManagedTargetArgPosition !== false
        ? { explicitArgPosition: input.privateManagedTargetArgPosition ?? 0 }
        : {}),
      collapseCommunities: true
    },
    targets: [CHAT_TARGET, SCOPE_TARGET],
    mutation: input.mutation ?? 'durable',
    auditAction: input.auditAction,
    assistant: input.assistant ?? {
      intentTags: ['event'],
      argumentHints: [
        '--profile <profileId>',
        '--answer <questionKey=value>',
        '--<questionKey> <value>',
        'Example: /event --profile climbing --place "Sintra" --startDate "tomorrow" --startTime "09:30" --style "Bouldering"'
      ],
      examples: [
        '/event --profile climbing --place "Sintra" --startDate "tomorrow" --startTime "09:30" --style "Bouldering"'
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
      exampleKeys: [input.exampleKey],
      keywords: ['event', input.topicId]
    }
  };
}

async function eventActorPermissionAllowed(
  context: PluginCommandContext,
  input: {
    actorWids: string[];
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
  for (const actorWid of uniqueEventWids(input.actorWids)) {
    const decision = await context.explainPermission({
      actorWid,
      action: input.action,
      scopeId: input.scopeId,
      pluginId: EVENTS_PLUGIN_ID,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.groupWid ? { groupWid: input.groupWid } : {}),
      requiresCurrentManagedGroupMembership: true,
      ...(input.allowCurrentManagedGroupMember ? { allowCurrentManagedGroupMember: true } : {})
    });
    if (decision.allowed) {
      return true;
    }
  }
  return false;
}

function eventActorWids(ctx: CommandContext): string[] {
  return uniqueEventWids([
    ctx.actor?.wid,
    ...(ctx.actor?.aliases ?? []),
    ctx.message.senderWid,
    ctx.message.authorWid
  ]);
}

function privateFlowDeliveryFallback(ctx: CommandContext, actorWids: string[]): PrivateDeliveryFallback | undefined {
  const groupWid = ctx.groupWid?.trim() || (ctx.message.context === 'group' ? ctx.message.chatId : '');
  if (!groupWid.endsWith('@g.us')) {
    return undefined;
  }
  const mentionWid = eventMentionWid(actorWids);
  return mentionWid
    ? {
        chatId: groupWid,
        mentionedWids: [mentionWid],
        ...(ctx.message.context === 'group' ? { quotedMessageId: ctx.message.id } : {})
      }
    : undefined;
}

function eventPrivateChatWid(actorWids: string[], preferredWid?: string | undefined): string | undefined {
  const preferred = preferredWid?.trim();
  if (preferred && !preferred.endsWith('@g.us')) {
    return preferred;
  }
  return actorWids.find((wid) => wid.endsWith('@c.us')) ?? actorWids.find((wid) => !wid.endsWith('@g.us'));
}

function eventMentionWid(actorWids: string[]): string | undefined {
  return actorWids.find((wid) => wid.endsWith('@c.us')) ?? actorWids.find((wid) => wid.endsWith('@lid')) ?? actorWids[0];
}

function uniqueEventWids(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? '').filter(Boolean))];
}

function parseEventPrefillArgs(args: string[], profiles: EventProfile[]): EventFlowPrefill {
  const answers: Record<string, string> = {};
  let profileId: string | undefined;
  const questionKeys = new Map<string, string>();
  for (const profile of profiles) {
    for (const question of profile.questions) {
      questionKeys.set(question.key.toLowerCase(), question.key);
    }
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('--') || arg === '--') {
      continue;
    }
    const [rawFlag, inlineValue] = splitFlag(arg);
    const flag = rawFlag.toLowerCase();
    const next = inlineValue ?? args[index + 1];
    const consumedNext = inlineValue === undefined && next !== undefined && !next.startsWith('--');

    if (flag === 'profile') {
      if (next && !next.startsWith('--')) {
        profileId = next.trim();
        if (consumedNext) index += 1;
      }
      continue;
    }

    if (flag === 'answer') {
      const parsed = next && !next.startsWith('--') ? splitAnswer(next) : undefined;
      if (parsed) {
        const key = questionKeys.get(parsed.key.toLowerCase()) ?? parsed.key;
        answers[key] = parsed.value;
        if (consumedNext) index += 1;
      }
      continue;
    }

    const questionKey = questionKeys.get(flag);
    if (questionKey && next && !next.startsWith('--')) {
      answers[questionKey] = next.trim();
      if (consumedNext) index += 1;
    }
  }

  if (!profileId && profiles.length === 1 && Object.keys(answers).length > 0) {
    profileId = profiles[0]?.id;
  }
  const validProfileId = profileId && profiles.some((profile) => profile.id === profileId)
    ? profileId
    : undefined;
  return {
    ...(validProfileId ? { profileId: validProfileId } : {}),
    answers
  };
}

function splitFlag(arg: string): [string, string | undefined] {
  const body = arg.replace(/^--/, '');
  const equals = body.indexOf('=');
  return equals >= 0
    ? [body.slice(0, equals), body.slice(equals + 1)]
    : [body, undefined];
}

function splitAnswer(value: string): { key: string; value: string } | undefined {
  const equals = value.indexOf('=');
  if (equals <= 0) {
    return undefined;
  }
  const key = value.slice(0, equals).trim();
  const answer = value.slice(equals + 1).trim();
  return key && answer ? { key, value: answer } : undefined;
}

async function appendEventJsonLog(
  context: PluginCommandContext,
  entry: Parameters<typeof appendScopeEventJsonLog>[0]['entry']
): Promise<void> {
  try {
    await appendScopeEventJsonLog({ appConfig: context.config, entry });
  } catch {
    // Do not fail event creation just because the append-only operator log is unavailable.
  }
}

function eventDraftKey(scopeId: string, flowSessionId: string): string {
  return `event-draft:${scopeId}:${flowSessionId}`;
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

function eventLocationSelectionActiveKey(wid: string): string {
  return `event-location-selection-active:${wid}`;
}

async function rememberActiveEventLocationSelection(
  runtime: OfficialPluginCommandRuntime,
  pending: PendingEventLocationSelection
): Promise<void> {
  await Promise.all([
    runtime.ephemeralStore.set(
      eventLocationSelectionKey(pending.id),
      pending,
      EVENT_LOCATION_SELECTION_TTL_SECONDS
    ),
    ...eventLocationSelectionActorWids(pending).map((wid) =>
      runtime.ephemeralStore.set(
        eventLocationSelectionActiveKey(wid),
        pending.id,
        EVENT_LOCATION_SELECTION_TTL_SECONDS
      )
    )
  ]);
}

async function clearActiveEventLocationSelection(
  runtime: OfficialPluginCommandRuntime,
  pending: PendingEventLocationSelection
): Promise<void> {
  await Promise.all([
    runtime.ephemeralStore.delete(eventLocationSelectionKey(pending.id)),
    ...eventLocationSelectionActorWids(pending).map((wid) =>
      runtime.ephemeralStore.delete(eventLocationSelectionActiveKey(wid))
    )
  ]);
}

async function findActiveEventLocationSelection(
  runtime: OfficialPluginCommandRuntime,
  actorWids: Array<string | undefined>
): Promise<PendingEventLocationSelection | undefined> {
  for (const wid of uniqueEventWids(actorWids)) {
    const activeKey = eventLocationSelectionActiveKey(wid);
    const pendingId = await runtime.ephemeralStore.get<string>(activeKey);
    if (!pendingId) {
      continue;
    }
    const pending = await runtime.ephemeralStore.get<PendingEventLocationSelection>(eventLocationSelectionKey(pendingId));
    if (pending) {
      return pending;
    }
    await runtime.ephemeralStore.delete(activeKey);
  }
  return undefined;
}

async function cancelActiveEventLocationSelectionsForActor(
  context: PluginCommandContext,
  runtime: OfficialPluginCommandRuntime,
  input: {
    actorWids: string[];
    chatId?: string | undefined;
  }
): Promise<{ cancelled: number; scopeId?: string | undefined }> {
  const pending = await findActiveEventLocationSelection(runtime, [
    ...input.actorWids,
    input.chatId
  ]);
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

function eventLocationSelectionActorWids(pending: PendingEventLocationSelection): string[] {
  return uniqueEventWids([
    pending.responseChatId,
    pending.draft.actorWid,
    ...(pending.draft.actorAliases ?? [])
  ]);
}

function isCommandLikeLocationReply(value: string): boolean {
  return value.trim().startsWith('/');
}

function pendingWithReplacedEventLocationAnswer(
  pending: PendingEventLocationSelection,
  query: string
): PendingEventLocationSelection {
  const profile = pending.kind === 'create' ? pending.profile : pending.draft.profile;
  if (profile.location.source !== 'question') {
    return pending;
  }
  return {
    ...pending,
    place: query,
    answers: {
      ...pending.answers,
      answers: {
        ...pending.answers.answers,
        [profile.location.questionKey]: query
      }
    }
  };
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
