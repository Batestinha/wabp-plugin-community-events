import { z } from 'zod';
import type {
  FlowEngine,
  FlowStartOrigin,
  FlowStartResult
} from '../../../adminBot/flows/flowEngine';
import type { TranslateFn, I18nService } from '../../../platform/i18n';
import type { StableIdentityAddressResolution } from '../../../platform/identity/identityAddressService';
import type { PluginDataStore } from '../../../platform/pluginRuntime/manager/pluginDataStore';
import type { PluginPermissionExplanation } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { CurrentManagedGroupMembershipMode } from '../../../platform/governance/authz/accessPlanes';
import type { PrivateDeliveryFallback } from '../../../platform/transport/transportTypes';
import {
  eventProfilePermission,
  eventCalendarResourceSchema,
  eventProfileSchema,
  localizeDefaultEventProfiles,
  localizeSubgroupSuggestionPreFlowNotice,
  parseEventsConfig,
  type EventCalendarResource,
  type EventProfile
} from './config';
import {
  createEventFlowDefinition,
  EVENT_CREATION_FLOW_TYPE_PREFIX,
  eventInitialFlowData,
  isEventCreationFlowType,
  restoreEventFlowDefinition,
  type EventFlowPrefill
} from './flow';
import { EVENTS_PLUGIN_ID } from './manifest';

export interface EventDraft {
  schemaVersion: 1;
  flowSessionId: string;
  flowType: string;
  scopeId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
  chatId: string;
  actorWid: string;
  actorIdentityId: string;
  actorLabel: string;
  privateDeliveryFallback?: PrivateDeliveryFallback | undefined;
  defaultAnnouncementGroupWid?: string | undefined;
  timezone: string;
  locale: string;
  profiles: EventProfile[];
  calendars: EventCalendarResource[];
  prefill: EventFlowPrefill;
  initialData: Record<string, unknown>;
  createdAt: string;
}

const eventFlowPrefillSchema = z.object({
  profileId: z.string().trim().min(1).optional(),
  answers: z.record(z.string())
}).strict();

const privateDeliveryFallbackSchema = z.object({
  chatId: z.string().trim().min(1),
  mentionedWids: z.array(z.string().trim().min(1)),
  quotePolicy: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('required'),
      messageId: z.string().trim().min(1),
      sourceChatId: z.string().trim().min(1).optional(),
      reason: z.string().optional()
    }).strict(),
    z.object({
      mode: z.literal('optional'),
      messageId: z.string().trim().min(1),
      sourceChatId: z.string().trim().min(1).optional(),
      reason: z.string().optional()
    }).strict(),
    z.object({
      mode: z.literal('none'),
      reason: z.string()
    }).strict()
  ]).optional(),
  quotedMessageId: z.string().trim().min(1).optional()
}).strict();

export const eventDraftSchema = z.object({
  schemaVersion: z.literal(1),
  flowSessionId: z.string().trim().min(1),
  flowType: z.string().trim().refine(
    isEventCreationFlowType,
    'Expected an event creation flow type'
  ),
  scopeId: z.string().trim().min(1),
  groupId: z.string().trim().min(1).optional(),
  groupWid: z.string().trim().min(1).optional(),
  chatId: z.string().trim().min(1),
  actorWid: z.string().trim().min(1),
  actorIdentityId: z.string().trim().min(1),
  actorLabel: z.string().trim().min(1),
  privateDeliveryFallback: privateDeliveryFallbackSchema.optional(),
  defaultAnnouncementGroupWid: z.string().trim().min(1).optional(),
  timezone: z.string().trim().min(1),
  locale: z.string().trim().min(1),
  profiles: z.array(eventProfileSchema).min(1),
  calendars: z.array(eventCalendarResourceSchema).min(1),
  prefill: eventFlowPrefillSchema,
  initialData: z.record(z.unknown()),
  createdAt: z.string().datetime()
}).strict();

export interface EventCreationFlowStarterContext {
  flowEngine: FlowEngine;
  dataStore: PluginDataStore;
  i18n: Pick<I18nService, 'resolveIdentityLocale' | 'translator'>;
  configFor(scopeId: string, actorIdentityId?: string | undefined): Promise<Record<string, unknown>>;
  enabledFor?(scopeId: string): Promise<boolean>;
  resolveStableIdentityById?(identityId: string): Promise<StableIdentityAddressResolution>;
  communityAnnouncementGroupWidForScope?(scopeId: string): Promise<string | undefined>;
  explainPermission?(input: {
    actorIdentityId: string;
    action: string;
    scopeId: string;
    pluginId?: string | undefined;
    groupId?: string | undefined;
    groupWid?: string | undefined;
    requiresCurrentManagedGroupMembership?: boolean | undefined;
    currentManagedGroupMembershipMode?: CurrentManagedGroupMembershipMode | undefined;
    allowCurrentManagedGroupMember?: boolean | undefined;
  }): Promise<PluginPermissionExplanation>;
}

export interface EventCreationTarget {
  scopeId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
}

export type EventCreationPreflightUnavailableReason =
  | 'plugin_disabled'
  | 'disabled'
  | 'not_configured'
  | 'identity_unavailable'
  | 'authorization_unavailable'
  | 'permission_denied'
  | 'active_private_flow'
  | 'flow_recovery_unavailable'
  | 'already_started';

export type EventCreationPreflightResult =
  | {
      kind: 'ready';
      actor: StableIdentityAddressResolution;
      locale: string;
      t: TranslateFn;
      profiles: EventProfile[];
      calendars: EventCalendarResource[];
      timezone: string;
      suggestionRefusalNoticeText?: string | undefined;
      defaultAnnouncementGroupWid?: string | undefined;
    }
  | {
      kind: 'unavailable';
      reason: EventCreationPreflightUnavailableReason;
      flowSessionId?: string | undefined;
    };

export interface AutomaticEventCreationPreflightInput extends EventCreationTarget {
  actorIdentityId: string;
  externalIdempotencyKey?: string | undefined;
}

export interface AutomaticEventCreationStartInput extends EventCreationTarget {
  actorIdentityId: string;
  actorLabel?: string | undefined;
  externalIdempotencyKey: string;
  origin: FlowStartOrigin;
  includeSuggestionRefusalNotice?: boolean | undefined;
  privateDeliveryFallback?: PrivateDeliveryFallback | undefined;
}

export interface CommandEventCreationStartInput extends EventCreationTarget {
  actor: StableIdentityAddressResolution;
  actorLabel: string;
  externalIdempotencyKey: string;
  locale: string;
  t: TranslateFn;
  origin: FlowStartOrigin;
  prefillArgs?: string[] | undefined;
  privateDeliveryFallback?: PrivateDeliveryFallback | undefined;
}

export type EventCreationStartResult =
  | ({ kind: 'started'; usedPrivateDeliveryFallback: boolean } & FlowStartResult)
  | { kind: 'unavailable'; reason: EventCreationPreflightUnavailableReason; flowSessionId?: string | undefined };

export type RegisterEventCreationCompletionHandlers = (
  flowType: string,
  profiles: EventProfile[],
  t: TranslateFn
) => void;

export class EventCreationFlowStarter {
  constructor(
    private readonly context: EventCreationFlowStarterContext,
    private readonly registerCompletionHandlers: RegisterEventCreationCompletionHandlers
  ) {}

  async preflightAutomatic(input: AutomaticEventCreationPreflightInput): Promise<EventCreationPreflightResult> {
    const actorIdentityId = input.actorIdentityId.trim();
    if (!actorIdentityId || !this.context.resolveStableIdentityById) {
      return { kind: 'unavailable', reason: 'identity_unavailable' };
    }
    const actor = await this.context.resolveStableIdentityById(actorIdentityId).catch(() => undefined);
    if (!actor || actor.identityId !== actorIdentityId) {
      return { kind: 'unavailable', reason: 'identity_unavailable' };
    }
    const base = await this.prepareBase(input, actor);
    if (base.kind === 'unavailable') {
      return base;
    }
    if (!this.context.explainPermission) {
      return { kind: 'unavailable', reason: 'authorization_unavailable' };
    }
    const allowed = await Promise.all(base.profiles.map(async (profile) => ({
      profile,
      allowed: (await this.context.explainPermission!({
        actorIdentityId,
        action: eventProfilePermission(profile),
        scopeId: input.scopeId,
        pluginId: EVENTS_PLUGIN_ID,
        ...(input.groupId ? { groupId: input.groupId } : {}),
        ...(input.groupWid ? { groupWid: input.groupWid } : {}),
        requiresCurrentManagedGroupMembership: true,
        currentManagedGroupMembershipMode: 'effective_scope',
        ...(profile.allowScopeMemberCreation ? { allowCurrentManagedGroupMember: true } : {})
      })).allowed
    })));
    const profiles = allowed.filter((candidate) => candidate.allowed).map((candidate) => candidate.profile);
    if (profiles.length === 0) {
      return { kind: 'unavailable', reason: 'permission_denied' };
    }
    if (!base.defaultAnnouncementGroupWid && !profiles.some((profile) => profile.announcementGroupWid)) {
      return { kind: 'unavailable', reason: 'not_configured' };
    }
    const inspection = await this.context.flowEngine.inspectIdentityFlowStart({
      actorIdentityId,
      ...(input.externalIdempotencyKey ? { externalIdempotencyKey: input.externalIdempotencyKey } : {})
    });
    if (inspection.kind !== 'available') {
      return {
        kind: 'unavailable',
        reason: inspection.kind === 'duplicate'
          ? 'already_started'
          : 'active_private_flow',
        flowSessionId: inspection.session.id
      };
    }
    return { ...base, profiles };
  }

  async startAutomatic(input: AutomaticEventCreationStartInput): Promise<EventCreationStartResult> {
    const prepared = await this.preflightAutomatic(input);
    if (prepared.kind === 'unavailable') {
      if (prepared.reason === 'already_started' && prepared.flowSessionId) {
        const promptDelivered = await this.context.flowEngine.ensureInitialPromptDelivered(
          prepared.flowSessionId
        ).catch(() => false);
        if (!promptDelivered) {
          return {
            kind: 'unavailable',
            reason: 'flow_recovery_unavailable',
            flowSessionId: prepared.flowSessionId
          };
        }
        return {
          kind: 'started',
          flowSessionId: prepared.flowSessionId,
          deduplicated: true,
          usedPrivateDeliveryFallback: false
        };
      }
      return prepared;
    }
    return this.startPrepared({
      ...input,
      prepared,
      actorLabel: input.actorLabel?.trim() || prepared.actor.displayName || prepared.actor.canonicalWid,
      prefill: { answers: {} }
    });
  }

  async startCommand(input: CommandEventCreationStartInput): Promise<EventCreationStartResult> {
    const prepared = await this.prepareBase(input, input.actor, input.locale, input.t);
    if (prepared.kind === 'unavailable') {
      return prepared;
    }
    const prefill = parseEventPrefillArgs(input.prefillArgs ?? [], prepared.profiles);
    return this.startPrepared({
      ...input,
      actorIdentityId: input.actor.identityId,
      actorLabel: input.actorLabel,
      prepared,
      prefill
    });
  }

  private async prepareBase(
    input: EventCreationTarget,
    actor: StableIdentityAddressResolution,
    selectedLocale?: string | undefined,
    selectedT?: TranslateFn | undefined
  ): Promise<Extract<EventCreationPreflightResult, { kind: 'ready' }> | Extract<EventCreationPreflightResult, { kind: 'unavailable' }>> {
    if (selectedLocale === undefined && (
      !this.context.enabledFor || !(await this.context.enabledFor(input.scopeId))
    )) {
      return { kind: 'unavailable', reason: 'plugin_disabled' };
    }
    const config = parseEventsConfig(await this.context.configFor(input.scopeId, actor.identityId));
    if (!config.enabled) {
      return { kind: 'unavailable', reason: 'disabled' };
    }
    if (config.eventProfiles.length === 0) {
      return { kind: 'unavailable', reason: 'not_configured' };
    }
    const resolvedLocale = selectedLocale && selectedT
      ? undefined
      : await this.context.i18n.resolveIdentityLocale(actor.identityId, input.scopeId);
    const locale = selectedLocale ?? resolvedLocale!.locale;
    const t = selectedT ?? this.context.i18n.translator(
      resolvedLocale!.locale,
      resolvedLocale!.languagePackScopes
    );
    const profiles = localizeDefaultEventProfiles(config.eventProfiles, t);
    const suggestionPreFlowNotice = localizeSubgroupSuggestionPreFlowNotice(
      config.subgroupSuggestionConversion.preFlowNotice,
      t
    );
    const defaultAnnouncementGroupWid = await this.context.communityAnnouncementGroupWidForScope?.(input.scopeId)
      || input.groupWid;
    if (!defaultAnnouncementGroupWid && !profiles.some((profile) => profile.announcementGroupWid)) {
      return { kind: 'unavailable', reason: 'not_configured' };
    }
    return {
      kind: 'ready',
      actor,
      locale,
      t,
      profiles,
      calendars: config.calendars,
      timezone: config.timezone,
      ...(suggestionPreFlowNotice.enabled
        ? { suggestionRefusalNoticeText: suggestionPreFlowNotice.template.trim() }
        : {}),
      ...(defaultAnnouncementGroupWid ? { defaultAnnouncementGroupWid } : {})
    };
  }

  private async startPrepared(input: AutomaticEventCreationStartInput & {
    prepared: Extract<EventCreationPreflightResult, { kind: 'ready' }>;
    actorLabel: string;
    prefill: EventFlowPrefill;
  }): Promise<EventCreationStartResult> {
    const startedAt = new Date();
    const initialData = eventInitialFlowData(input.prepared.profiles, input.prefill, {
      timezone: input.prepared.timezone,
      locale: input.prepared.locale,
      now: startedAt
    });
    const definition = createEventFlowDefinition({
      t: input.prepared.t,
      profiles: input.prepared.profiles,
      prefill: input.prefill,
      timezone: input.prepared.timezone,
      locale: input.prepared.locale,
      initialData,
      completeMessageKey: false
    });
    this.registerCompletionHandlers(definition.flowType, input.prepared.profiles, input.prepared.t);
    let draftCreated = false;
    const flowStart = await this.context.flowEngine.startFlowForIdentity({
      definition,
      actorIdentityId: input.actorIdentityId,
      externalIdempotencyKey: input.externalIdempotencyKey,
      origin: input.origin,
      scopeId: input.scopeId,
      initialData,
      ...(input.includeSuggestionRefusalNotice && input.prepared.suggestionRefusalNoticeText
        ? { initialPromptPreface: input.prepared.suggestionRefusalNoticeText }
        : {}),
      ...(input.privateDeliveryFallback ? { privateDeliveryFallback: input.privateDeliveryFallback } : {}),
      onSessionCreated: async (session) => {
        const draft: EventDraft = {
          schemaVersion: 1,
          flowSessionId: session.id,
          flowType: definition.flowType,
          scopeId: input.scopeId,
          ...(input.groupId ? { groupId: input.groupId } : {}),
          ...(input.groupWid ? { groupWid: input.groupWid } : {}),
          chatId: input.prepared.actor.deliveryChatId,
          actorWid: input.prepared.actor.canonicalWid,
          actorIdentityId: input.actorIdentityId,
          actorLabel: input.actorLabel,
          ...(input.privateDeliveryFallback ? { privateDeliveryFallback: input.privateDeliveryFallback } : {}),
          ...(input.prepared.defaultAnnouncementGroupWid
            ? { defaultAnnouncementGroupWid: input.prepared.defaultAnnouncementGroupWid }
            : {}),
          timezone: input.prepared.timezone,
          locale: input.prepared.locale,
          profiles: input.prepared.profiles,
          calendars: input.prepared.calendars,
          prefill: input.prefill,
          initialData,
          createdAt: startedAt.toISOString()
        };
        await this.context.dataStore.set(
          eventDraftKey(input.scopeId, session.id),
          eventDraftSchema.parse(draft)
        );
        draftCreated = true;
      },
      onSessionStartFailed: async (session) => {
        if (draftCreated) {
          await this.context.dataStore.delete(eventDraftKey(input.scopeId, session.id));
        }
      }
    });
    if (flowStart.deduplicated) {
      const promptDelivered = await this.context.flowEngine.ensureInitialPromptDelivered(
        flowStart.flowSessionId
      ).catch(() => false);
      if (!promptDelivered) {
        return {
          kind: 'unavailable',
          reason: 'flow_recovery_unavailable',
          flowSessionId: flowStart.flowSessionId
        };
      }
    }
    return {
      kind: 'started',
      ...flowStart,
      usedPrivateDeliveryFallback: Boolean(flowStart.privateDeliveryFallback)
    };
  }
}

const eventCreationResolverRegistrations = new WeakSet<FlowEngine>();

export function registerEventCreationFlowDefinitionResolver(
  context: Pick<EventCreationFlowStarterContext, 'flowEngine' | 'dataStore' | 'i18n'>,
  registerCompletionHandlers: RegisterEventCreationCompletionHandlers
): void {
  if (eventCreationResolverRegistrations.has(context.flowEngine)) {
    return;
  }
  context.flowEngine.registerDefinitionResolver({
    ownerId: EVENTS_PLUGIN_ID,
    flowTypePrefix: EVENT_CREATION_FLOW_TYPE_PREFIX,
    async resolve(session) {
      if (!session.scopeId) {
        throw new Error(`Event creation flow ${session.id} has no scope.`);
      }
      const rawDraft = await context.dataStore.get(
        eventDraftKey(session.scopeId, session.id)
      );
      const parsed = eventDraftSchema.safeParse(rawDraft);
      if (!parsed.success) {
        throw new Error(`Event creation flow ${session.id} has no valid durable draft recipe.`);
      }
      const draft = parsed.data;
      if (
        draft.flowSessionId !== session.id
        || draft.flowType !== session.flowType
        || draft.scopeId !== session.scopeId
        || draft.actorIdentityId !== session.identityId
      ) {
        throw new Error(`Event creation flow ${session.id} durable draft does not match its session.`);
      }
      const t = await translatorForEventDraft(context.i18n, draft);
      const definition = restoreEventFlowDefinition({
        flowType: draft.flowType,
        t,
        profiles: draft.profiles,
        prefill: draft.prefill,
        timezone: draft.timezone,
        locale: draft.locale,
        initialData: draft.initialData
      });
      registerCompletionHandlers(definition.flowType, draft.profiles, t);
      return definition;
    }
  });
  eventCreationResolverRegistrations.add(context.flowEngine);
}

async function translatorForEventDraft(
  i18n: EventCreationFlowStarterContext['i18n'],
  draft: EventDraft
): Promise<TranslateFn> {
  const service = i18n as EventCreationFlowStarterContext['i18n'] & Pick<I18nService, 'translatorForIdentity'>;
  if (typeof service.translatorForIdentity === 'function') {
    return service.translatorForIdentity(draft.actorIdentityId, draft.scopeId);
  }
  const locale = await i18n.resolveIdentityLocale(draft.actorIdentityId, draft.scopeId);
  return i18n.translator(locale.locale, locale.languagePackScopes);
}

export function eventDraftKey(scopeId: string, flowSessionId: string): string {
  return `event-draft:${scopeId}:${flowSessionId}`;
}

export function parseEventPrefillArgs(args: string[], profiles: EventProfile[]): EventFlowPrefill {
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
    if (!arg.startsWith('--') || arg === '--') continue;
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
  return { ...(validProfileId ? { profileId: validProfileId } : {}), answers };
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
  if (equals <= 0) return undefined;
  const key = value.slice(0, equals).trim();
  const answer = value.slice(equals + 1).trim();
  return key && answer ? { key, value: answer } : undefined;
}
