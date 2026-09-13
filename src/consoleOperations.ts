import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { PluginConsoleChoice, PluginConsoleContext, PluginConsoleOperationRegistration } from '@wabs/plugin-sdk/console-operations';
import type { PluginDatabaseRegistry } from '@wabs/plugin-sdk/database';
import { EVENTS_PLUGIN_ID } from './manifest';
import { eventProfileSchema, parseEventsConfig } from './config';
import {
  renameEventConditionalTextToken,
  renameEventTemplateToken
} from './template';
import {
  eventQuestionKeyRenameRecoveryDecision,
  eventQuestionKeyRenameAuthority,
  eventQuestionKeyRenameAuthorityRevision
} from './questionKeyRenameRecovery';
import { eventProfileQuestionSchemaRevision } from './profileRevision';
import { renderCurrentScopeCalendarDocument } from './calendarStatus';
import { calendarPublicationTarget, type CalendarPublicationOutcome } from './calendarPublication';
import { eventsCalendarSubscriptionUrl } from './calendarSubscription';
import { eventCalendarHintReplayResultSchema } from './operatorActions';
import { eventAttendanceVotesFromSnapshot } from './attendanceLifecycle';
import { scopeCalendarPathInPluginDirectory } from './ics';
import {
  assertScopeEventCalendarOwnershipResolved,
  assignUnassignedEventCalendarOwnership,
  beginEventQuestionKeyRename,
  EventQuestionKeyRenameConflictError,
  eventsDatabase,
  getEvent,
  getCalendarPublicationStatus,
  listCalendarEvents,
  listUnassignedEventCalendarOwnership,
  listPendingEventQuestionKeyRenames,
  listScopeEvents,
  listEventAnnouncementMessages,
  listVotes,
  resolvedEventCalendarId,
  renewEventQuestionKeyRenameLease,
  settleEventQuestionKeyRename,
  updateEventCalendarStatus,
  type StoredCalendarPublicationStatus,
  type StoredEventRecord,
  type StoredEventVote
} from './store';
type SelectedRuntimeContext = Pick<PluginConsoleContext, 'runtimeBindingId' | 'whatsAppAccountId'>;
type OfficialEventsAdoptionOption = PluginConsoleChoice & { eventId?: string | undefined };

const EVENT_QUESTION_KEY_RENAME_LEASE_MS = 5 * 60 * 1000;

const requiredRuntimeBindingIdSchema = z.preprocess(firstQueryValue, z.string().trim().min(1));

const selectedRuntimeSchema = z.object({
  runtimeBindingId: requiredRuntimeBindingIdSchema
});

const groupChatIdSchema = z.string()
  .trim()
  .regex(/^[^\s@]+@g\.us$/i)
  .transform((value) => value.toLowerCase());

const eventCalendarParamsSchema = z.object({
  scopeId: z.string().trim().min(1),
  calendarId: z.string().trim().min(1)
});

const eventCalendarRuntimeParamsSchema = eventCalendarParamsSchema.merge(selectedRuntimeSchema);

const eventCalendarFeedParamsSchema = eventCalendarParamsSchema.merge(selectedRuntimeSchema);

const eventProfileOptionsRuntimeParamsSchema = z.object({
  scopeId: z.string().trim().min(1)
}).merge(selectedRuntimeSchema);

const eventScopeRuntimeParamsSchema = eventProfileOptionsRuntimeParamsSchema;

const eventQuestionRenameInputSchema = eventScopeRuntimeParamsSchema.extend({
  profileId: z.string().trim().min(1),
  oldKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  newKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  expectedProfile: z.record(z.unknown()),
  confirm: z.literal(true)
}).strict();

const eventTerminateInputSchema = eventScopeRuntimeParamsSchema.extend({
  eventId: z.string().trim().min(1),
  confirm: z.literal(true),
  reason: z.string().trim().min(1).max(500).optional(),
  calendarDisposition: z.enum(['cancelled', 'hidden']).default('hidden'),
  deleteAnnouncementMessages: z.boolean().default(true)
}).strict();

const eventCalendarHintReplayOperatorInputSchema = eventScopeRuntimeParamsSchema.extend({
  eventId: z.string().trim().min(1)
}).strict();

const eventCalendarDispositionInputSchema = eventScopeRuntimeParamsSchema.extend({
  eventId: z.string().trim().min(1),
  calendarDisposition: z.enum(['cancelled', 'hidden']),
  reason: z.string().trim().min(1).max(500).optional()
}).strict();

const eventCalendarOwnershipInputSchema = eventScopeRuntimeParamsSchema.extend({
  eventId: z.string().trim().min(1),
  calendarId: z.string().trim().min(1).max(128).nullable(),
  confirm: z.literal(true)
}).strict();

const eventAdoptionRuntimeParamsSchema = eventProfileOptionsRuntimeParamsSchema.extend({
  profileId: z.preprocess(firstQueryValue, z.string().trim().min(1))
});

const eventCalendarSubscriptionQuerySchema = z.object({
  token: z.preprocess(firstQueryValue, z.string().trim().min(1))
}).strict();

const eventAdoptionInputSchema = selectedRuntimeSchema.extend({
  eventId: z.string().trim().min(1).optional(),
  scopeId: z.string().trim().min(1),
  mode: z.enum(['poll', 'group']),
  profileId: z.string().trim().min(1),
  answers: z.record(z.string()).default({}),
  locale: z.string().trim().min(1).optional(),
  pollWaMsgId: z.string().trim().min(1).optional(),
  subgroupChatId: groupChatIdSchema.optional()
}).strict();

interface OfficialEventsScopeEventSummary {
  id: string;
  title: string;
  profileId: string;
  profileLabel: string;
  origin: string;
  eventStatus: string;
  groupLifecycleStatus: string;
  calendarStatus: string;
  calendarId: string;
  calendarOwnershipStatus: string;
  actorLabel: string;
  actorWid: string;
  startsAt: string;
  startsAtUtc: string;
  endsAt: string;
  spanKind: string;
  timezone: string;
  localDate: string;
  localTime: string;
  place: string;
  answers: Record<string, string>;
  closeAt: string;
  cleanupAt: string;
  pollWaMsgId: string;
  pollQuestion: string;
  subgroupChatId: string;
  subgroupTitle: string;
  groupTitle: string;
  voteCount: number;
  attendanceCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string;
  cleanedAt: string;
  cancelledAt: string;
  cancelledByLabel: string;
  cancelReason: string;
  error: string;
  cancellationArtifactCleanup: {
    pending: number;
    confirmed: number;
    unconfirmed: number;
    rejected: number;
    failed: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function calendarEventsOrEmpty(
  registry: PluginDatabaseRegistry,
  scopeId: string,
  calendarId: string
) {
  try {
    return listCalendarEvents(eventsDatabase(registry), scopeId, calendarId);
  } catch (error) {
    if (isMissingPluginDatabaseTable(error)) {
      return [];
    }
    throw error;
  }
}

function officialEventsScopeEventSummary(
  event: StoredEventRecord,
  votes: EventVoteSummarySelection[],
  artifacts: ReturnType<typeof listEventAnnouncementMessages>
): OfficialEventsScopeEventSummary {
  const attendanceOptionIds = new Set(event.pollOptions
    .filter((option) => {
      const responseClass = event.responseClasses.find((candidate) => candidate.id === option.responseClassId);
      return responseClass?.includeInAttendanceCount === true;
    })
    .map((option) => option.id));
  const attendanceCount = attendanceOptionIds.size
    ? votes.filter((vote) => vote.selectedOptionIds.some((optionId) => attendanceOptionIds.has(optionId))).length
    : 0;
  return {
    id: event.id,
    title: event.subgroupTitle || event.groupTitle || event.pollQuestion || event.id,
    profileId: event.profileId,
    profileLabel: event.profileLabel,
    origin: event.origin,
    eventStatus: event.eventStatus,
    groupLifecycleStatus: event.groupLifecycleStatus,
    calendarStatus: event.calendarStatus,
    calendarId: event.calendarId ?? '',
    calendarOwnershipStatus: event.calendarOwnershipStatus,
    actorLabel: event.actorLabel,
    actorWid: event.actorWid,
    startsAt: event.startsAt,
    startsAtUtc: event.startsAtUtc || event.startsAt,
    endsAt: event.endsAt,
    spanKind: event.spanKind,
    timezone: event.timezone,
    localDate: event.localDate ?? '',
    localTime: event.localTime ?? '',
    place: event.place ?? '',
    answers: event.answers,
    closeAt: event.closeAt,
    cleanupAt: event.cleanupAt,
    pollWaMsgId: event.pollWaMsgId ?? '',
    pollQuestion: event.pollQuestion ?? '',
    subgroupChatId: event.subgroupChatId ?? '',
    subgroupTitle: event.subgroupTitle ?? '',
    groupTitle: event.groupTitle,
    voteCount: votes.length,
    attendanceCount,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    closedAt: event.closedAt ?? '',
    cleanedAt: event.cleanedAt ?? '',
    cancelledAt: event.cancelledAt ?? '',
    cancelledByLabel: event.cancelledByLabel ?? '',
    cancelReason: event.cancelReason ?? '',
    error: event.error ?? '',
    cancellationArtifactCleanup: {
      pending: artifacts.filter((artifact) => artifact.deletionStatus === 'pending').length,
      confirmed: artifacts.filter((artifact) => artifact.deletionStatus === 'confirmed').length,
      unconfirmed: artifacts.filter((artifact) => artifact.deletionStatus === 'unconfirmed').length,
      rejected: artifacts.filter((artifact) => artifact.deletionStatus === 'rejected').length,
      failed: artifacts.filter((artifact) => artifact.deletionStatus === 'failed').length
    }
  };
}

type EventVoteSummarySelection = Pick<StoredEventVote, 'selectedOptionIds'>;

async function calendarFileUpdatedAt(
  pluginDirectory: string,
  config: ReturnType<typeof parseEventsConfig>,
  scopeId: string,
  calendarId: string
): Promise<string> {
  const calendar = config.calendars.find((candidate) => candidate.id === calendarId);
  if (!calendar) {
    return '';
  }
  try {
    return (await stat(scopeCalendarPathInPluginDirectory(pluginDirectory, calendar, scopeId))).mtime.toISOString();
  } catch (error) {
    if (isMissingFile(error)) {
      return '';
    }
    throw error;
  }
}

function publicationStateFromStored(status: StoredCalendarPublicationStatus | undefined): Partial<{
  endpointUrl: string;
  feedId: string;
  label: string;
  subscriptionUrl: string;
  calendarUrl: string;
  updatedAt: string;
  error: string;
  lastSuccessAt: string;
  lastErrorAt: string;
}> {
  if (!status) {
    return {};
  }
  const updatedAt = status.targetUpdatedAt ?? status.lastSuccessAt;
  return {
    ...(status.endpointUrl ? { endpointUrl: status.endpointUrl } : {}),
    ...(status.feedId ? { feedId: status.feedId } : {}),
    ...(status.label ? { label: status.label } : {}),
    ...(status.subscriptionUrl ? { subscriptionUrl: status.subscriptionUrl } : {}),
    ...(status.calendarUrl ? { calendarUrl: status.calendarUrl } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(status.lastError ? { error: status.lastError } : {}),
    ...(status.lastSuccessAt ? { lastSuccessAt: status.lastSuccessAt } : {}),
    ...(status.lastErrorAt ? { lastErrorAt: status.lastErrorAt } : {})
  };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

function eventsProfileOrThrow(config: ReturnType<typeof parseEventsConfig>, profileId: string): ReturnType<typeof parseEventsConfig>['eventProfiles'][number] {
  const profile = config.eventProfiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    throw httpError(404, `Unknown event profile: ${profileId}`);
  }
  return profile;
}

function eventProfileWithRenamedQuestionKey(
  profile: ReturnType<typeof parseEventsConfig>['eventProfiles'][number],
  oldKey: string,
  newKey: string
): ReturnType<typeof parseEventsConfig>['eventProfiles'][number] {
  const renameTemplateToken = (template: string | undefined): string | undefined => template === undefined
    ? undefined
    : renameEventTemplateToken(template, oldKey, newKey);
  const conditionalTokens = profile.questions.map((question) => question.key);
  const renameConditionalTextToken = (source: string): string => renameEventConditionalTextToken(
    source,
    oldKey,
    newKey,
    conditionalTokens
  );
  const renamed = eventProfileSchema.safeParse({
    ...profile,
    optionalPromptSuffix: renameConditionalTextToken(profile.optionalPromptSuffix),
    startsAtDateQuestionKey: profile.startsAtDateQuestionKey === oldKey ? newKey : profile.startsAtDateQuestionKey,
    startsAtTimeQuestionKey: profile.startsAtTimeQuestionKey === oldKey ? newKey : profile.startsAtTimeQuestionKey,
    location: profile.location.source === 'question' && profile.location.questionKey === oldKey
      ? { ...profile.location, questionKey: newKey }
      : profile.location,
    questions: profile.questions.map((question) => ({
      ...question,
      key: question.key === oldKey ? newKey : question.key,
      prompt: renameConditionalTextToken(question.prompt),
      choices: question.choices.map((choice) => ({
        ...choice,
        label: renameConditionalTextToken(choice.label)
      }))
    })),
    poll: {
      ...profile.poll,
      titleTemplate: renameTemplateToken(profile.poll.titleTemplate),
      options: profile.poll.options.map((option) => ({
        ...option,
        label: renameConditionalTextToken(option.label)
      }))
    },
    group: {
      ...profile.group,
      titleTemplate: renameTemplateToken(profile.group.titleTemplate)
    },
    eventGroupHint: {
      ...profile.eventGroupHint,
      template: renameTemplateToken(profile.eventGroupHint.template)
    },
    eventEditAnnouncement: {
      ...profile.eventEditAnnouncement,
      template: renameTemplateToken(profile.eventEditAnnouncement.template)
    },
    calendar: {
      ...profile.calendar,
      titleTemplate: renameTemplateToken(profile.calendar.titleTemplate),
      descriptionTemplate: renameTemplateToken(profile.calendar.descriptionTemplate),
      hint: {
        ...profile.calendar.hint,
        template: renameTemplateToken(profile.calendar.hint.template)
      }
    },
    weather: {
      ...profile.weather,
      template: renameTemplateToken(profile.weather.template)
    }
  });
  if (!renamed.success) {
    throw httpError(400, renamed.error.issues[0]?.message ?? 'The renamed event profile is invalid.');
  }
  return renamed.data;
}

function eventsCalendarOrThrow(config: ReturnType<typeof parseEventsConfig>, calendarId: string): ReturnType<typeof parseEventsConfig>['calendars'][number] {
  const calendar = config.calendars.find((candidate) => candidate.id === calendarId);
  if (!calendar) {
    throw httpError(404, `Unknown event calendar: ${calendarId}`);
  }
  return calendar;
}

function eventsConfigWithUpdatedCalendar(
  config: ReturnType<typeof parseEventsConfig>,
  calendarId: string,
  update: (calendar: ReturnType<typeof parseEventsConfig>['calendars'][number]) => ReturnType<typeof parseEventsConfig>['calendars'][number]
): ReturnType<typeof parseEventsConfig> {
  return {
    ...config,
    calendars: config.calendars.map((calendar) => calendar.id === calendarId ? update(calendar) : calendar)
  };
}

function isMissingPluginDatabaseTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bno such table\b/i.test(message);
}

function safeFilename(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '') || 'calendar';
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function firstQueryValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

export class EventsConsoleOperations {

  constructor(private readonly host: PluginConsoleContext) {}
  private async resolveRuntimeContext(input: { runtimeBindingId?: string | undefined }): Promise<SelectedRuntimeContext> {
    if (input.runtimeBindingId && input.runtimeBindingId !== this.host.runtimeBindingId) throw httpError(403, 'Console operation runtime does not match its host context.');
    return this.host;
  }
  private async assertScopeForRuntime(_context: SelectedRuntimeContext, scopeId: string): Promise<void> { await this.host.assertScope(scopeId); }
  private async executeRuntimeBridgeActionForBinding(actionId: string, input: unknown, runtimeBindingId: string, options?: { requireWhatsappReady?: boolean | undefined }): Promise<unknown> {
    await this.resolveRuntimeContext({ runtimeBindingId });
    return this.host.executeRuntimeAction(actionId, input, options);
  }
  private get operatorConsoleActorWid(): string { return this.host.actorWid(); }
  private async ensureOperatorConsoleActorIdentityId(): Promise<string> { return this.host.actorIdentityId(); }
  private auditOperatorConsoleAction(action: string, body: unknown, target: Record<string, unknown> = {}): Promise<void> { return this.host.audit(action, body, target); }
  private operatorConsolePublicOrigin(): string { return this.host.publicOrigin; }
  private eventsCommunityGroupForScope(context: SelectedRuntimeContext, scopeId: string) { return this.host.groups.communityForScope(scopeId); }
  private eventsGroupOptionForChatId(context: SelectedRuntimeContext, chatId: string, fallbackLabel: string) { return this.host.groups.lookup(chatId, fallbackLabel); }
  private eventsAnnouncementGroupForCommunity(context: SelectedRuntimeContext, communityGroup: OfficialEventsAdoptionOption | null) { return this.host.groups.announcementForCommunity(communityGroup); }
  private eventsAdoptionPollOptions(context: SelectedRuntimeContext, announcementGroup: OfficialEventsAdoptionOption | null) { return this.host.groups.archivedPolls(announcementGroup); }
  private eventsAdoptionGroupOptions(context: SelectedRuntimeContext, communityGroup: OfficialEventsAdoptionOption | null, announcementGroup: OfficialEventsAdoptionOption | null) { return this.host.groups.nonAnnouncementChildren(communityGroup, announcementGroup); }
  private eventsCommunityChildGroupOptions(context: SelectedRuntimeContext, communityGroup: OfficialEventsAdoptionOption | null) { return this.host.groups.children(communityGroup); }

async eventsCalendarSubscriptionInfo(input: unknown = {}) {
    const { scopeId, calendarId, runtimeBindingId } = eventCalendarRuntimeParamsSchema.parse(input ?? {});
    const context = await this.resolveRuntimeContext({ runtimeBindingId });
    const config = await this.eventsConfigForScope(scopeId, context);
    const calendar = eventsCalendarOrThrow(config, calendarId);
    const token = calendar.subscriptionToken.trim();
    const exportStatus = await this.eventsCalendarExportStatus(context, config, scopeId, calendarId);
    return {
      scopeId,
      calendarId,
      label: calendar.label,
      enabled: calendar.enabled,
      tokenConfigured: Boolean(token),
      subscriptionToken: token,
      url: token ? this.eventsCalendarSubscriptionUrl(scopeId, calendarId, runtimeBindingId, token) : '',
      exportStatus,
      publication: this.eventsCalendarPublicationState(scopeId, calendar, publicationStateFromStored(exportStatus.publicationStatus))
    };
  }

async publishEventsCalendar(input: unknown = {}) {
    const { scopeId, calendarId, runtimeBindingId } = eventCalendarRuntimeParamsSchema.parse(input ?? {});
    const context = await this.resolveRuntimeContext({ runtimeBindingId });
    const config = await this.eventsConfigForScope(scopeId, context);
    const calendar = eventsCalendarOrThrow(config, calendarId);
    const registry = this.host.openDatabases();
    try {
      assertScopeEventCalendarOwnershipResolved(eventsDatabase(registry), scopeId);
    } finally {
      registry.closeAll();
    }
    const outcome = await this.publishEventsCalendarForRuntime(context, scopeId, calendarId);
    if (!outcome) {
      throw httpError(400, 'Calendar publication is not enabled for this calendar.');
    }
    if (!outcome.ok) {
      throw httpError(outcome.attempted ? 502 : 400, outcome.error || 'Calendar publication failed.');
    }
    const exportStatus = await this.eventsCalendarExportStatus(context, config, scopeId, calendarId);
    const publication = this.eventsCalendarPublicationState(
      scopeId,
      calendar,
      publicationStateFromStored(exportStatus.publicationStatus)
    );
    await this.auditOperatorConsoleAction('official.community-events.calendar.published', {
      scopeId,
      calendarId,
      runtimeBindingId,
      feedId: outcome.feedId,
      endpointUrl: publication.endpointUrl,
      subscriptionUrl: publication.subscriptionUrl
    });
    const token = calendar.subscriptionToken.trim();
    return {
      scopeId,
      calendarId,
      label: calendar.label,
      enabled: calendar.enabled,
      tokenConfigured: Boolean(token),
      subscriptionToken: token,
      url: token ? this.eventsCalendarSubscriptionUrl(scopeId, calendarId, runtimeBindingId, token) : '',
      exportStatus,
      publication
    };
  }

async rotateEventsCalendarSubscriptionToken(input: unknown = {}) {
    const { scopeId, calendarId, runtimeBindingId } = eventCalendarRuntimeParamsSchema.parse(input ?? {});
    const context = await this.resolveRuntimeContext({ runtimeBindingId });
    const current = parseEventsConfig(await this.host.configuration.resolve(scopeId));
    const calendar = eventsCalendarOrThrow(current, calendarId);
    const token = randomBytes(32).toString('base64url');
    await this.host.configuration.configure(scopeId, eventsConfigWithUpdatedCalendar(current, calendarId, (candidate) => ({
      ...candidate,
      subscriptionToken: token
    })));
    await this.auditOperatorConsoleAction('official.community-events.calendar.token.rotated', { scopeId, calendarId, runtimeBindingId });
    return {
      scopeId,
      calendarId,
      label: calendar.label,
      enabled: calendar.enabled,
      tokenConfigured: true,
      subscriptionToken: token,
      url: this.eventsCalendarSubscriptionUrl(scopeId, calendarId, runtimeBindingId, token)
    };
  }

async officialEventsProfileOptions(input: unknown = {}) {
    const { scopeId, runtimeBindingId } = eventProfileOptionsRuntimeParamsSchema.parse(input ?? {});
    const context = await this.resolveRuntimeContext({ runtimeBindingId });
    await this.assertScopeForRuntime(context, scopeId);
    const locale = { locale: await this.host.localeFor(scopeId) };
    const communityGroup = await this.eventsCommunityGroupForScope(context, scopeId);
    const config = await this.eventsConfigForScope(scopeId, context);
    const questionKeyRenameRecovery = this.inspectOfficialEventQuestionKeyRenames(context, scopeId, config);
    const [announcementGroup, childGroupOptions] = await Promise.all([
      this.eventsAnnouncementGroupForCommunity(context, communityGroup),
      this.eventsCommunityChildGroupOptions(context, communityGroup)
    ]);
    const warnings = [
      !communityGroup ? 'No scoped community group is registered for this scope.' : '',
      communityGroup && childGroupOptions.length === 0 ? 'No child groups were found under the scoped community.' : '',
      ...questionKeyRenameRecovery.warnings
    ].filter(Boolean);
    return {
      scopeId,
      runtimeBindingId,
      communityGroup,
      locale: locale.locale,
      announcementGroup,
      childGroupOptions,
      calendarOptions: config.calendars.map((calendar) => ({
        value: calendar.id,
        label: calendar.label && calendar.label !== calendar.id ? `${calendar.label} / ${calendar.id}` : calendar.id,
        calendarId: calendar.id,
        enabled: calendar.enabled,
        directory: calendar.directory,
        tokenConfigured: Boolean(calendar.subscriptionToken.trim())
      })),
      warnings
    };
  }

async renameOfficialEventProfileQuestion(input: unknown = {}) {
    const parsed = eventQuestionRenameInputSchema.parse(input ?? {});
    if (parsed.oldKey === parsed.newKey) {
      throw httpError(400, 'The new question key must differ from the current key.');
    }
    const context = await this.resolveRuntimeContext({ runtimeBindingId: parsed.runtimeBindingId });
    await this.assertScopeForRuntime(context, parsed.scopeId);
    const instance = await this.host.configuration.read(parsed.scopeId);
    if (!instance) {
      throw httpError(404, 'Configure the events plugin directly on this scope before renaming a question key.');
    }

    const registry = this.host.openDatabases();
    const eventDb = eventsDatabase(registry);
    let currentConfig = parseEventsConfig(instance.configJson);
    let renamedProfile: ReturnType<typeof parseEventsConfig>['eventProfiles'][number] | undefined;
    let nextConfig: ReturnType<typeof parseEventsConfig> | undefined;
    let operationId: string | undefined;
    let migratedEvents = 0;
    let recoveredCommittedMutation = false;
    try {
      const pending = listPendingEventQuestionKeyRenames(eventDb, { scopeId: parsed.scopeId });
      const now = new Date();
      for (const rename of pending) {
        if (new Date(rename.leaseExpiresAt).getTime() > now.getTime()) {
          throw httpError(
            409,
            `Question-key rename ${rename.operationId} is still in progress for event profile ${rename.profileId}.`
          );
        }
        const authority = eventQuestionKeyRenameAuthority(currentConfig, rename);
        const authorityRevision = eventQuestionKeyRenameAuthorityRevision(currentConfig, rename);
        if (!authority || !authorityRevision) {
          throw httpError(
            409,
            `Question-key rename ${rename.operationId} cannot be recovered because the authoritative profile contains both or neither key.`
          );
        }
        settleEventQuestionKeyRename(eventDb, {
          operationId: rename.operationId,
          authority,
          authorityRevision,
          settledAt: now.toISOString()
        });
      }

      const profileIndex = currentConfig.eventProfiles.findIndex((profile) => profile.id === parsed.profileId);
      if (profileIndex < 0) {
        throw httpError(404, `Unknown event profile: ${parsed.profileId}`);
      }
      const currentProfile = currentConfig.eventProfiles[profileIndex]!;
      const expectedProfile = eventProfileSchema.parse(parsed.expectedProfile);
      if (JSON.stringify(expectedProfile) !== JSON.stringify(currentProfile)) {
        throw httpError(409, 'The event profile changed while the question rename was being prepared. Refresh and try again.');
      }
      if (!currentProfile.questions.some((question) => question.key === parsed.oldKey)) {
        throw httpError(404, `Unknown event question key: ${parsed.oldKey}`);
      }
      if (currentProfile.questions.some((question) => question.key === parsed.newKey)) {
        throw httpError(409, `Event question key already exists: ${parsed.newKey}`);
      }

      renamedProfile = eventProfileWithRenamedQuestionKey(currentProfile, parsed.oldKey, parsed.newKey);
      nextConfig = parseEventsConfig({
        ...currentConfig,
        eventProfiles: currentConfig.eventProfiles.map((profile, index) => index === profileIndex ? renamedProfile : profile)
      });
      operationId = `evt-question-rename-${randomUUID()}`;
      const expandedAt = new Date();
      const rename = beginEventQuestionKeyRename(eventDb, {
        operationId,
        scopeId: parsed.scopeId,
        profileId: parsed.profileId,
        oldKey: parsed.oldKey,
        newKey: parsed.newKey,
        oldProfileRevision: eventProfileQuestionSchemaRevision(currentProfile),
        newProfileRevision: eventProfileQuestionSchemaRevision(renamedProfile),
        createdAt: expandedAt.toISOString(),
        leaseExpiresAt: new Date(expandedAt.getTime() + EVENT_QUESTION_KEY_RENAME_LEASE_MS).toISOString()
      });
      migratedEvents = rename.migratedEventCount;
      const casStartedAt = new Date();
      if (!renewEventQuestionKeyRenameLease(eventDb, {
        operationId,
        updatedAt: casStartedAt.toISOString(),
        leaseExpiresAt: new Date(casStartedAt.getTime() + EVENT_QUESTION_KEY_RENAME_LEASE_MS).toISOString()
      })) {
        throw httpError(409, 'The question-key rename lost its mutation lease before the profile could be updated.');
      }
      const configUpdate = await this.host.configuration.compareAndSet(parsed.scopeId, { id: instance.id, updatedAt: instance.updatedAt }, nextConfig);
      if (configUpdate.count !== 1) {
        throw httpError(409, 'The event profile changed during the question rename. The expanded answers will be recovered from the authoritative profile.');
      }
      settleEventQuestionKeyRename(eventDb, {
        operationId,
        authority: 'new',
        authorityRevision: eventProfileQuestionSchemaRevision(renamedProfile)
      });
    } catch (error) {
      if (operationId) {
        try {
          const authoritative = await this.host.configuration.read(parsed.scopeId);
          if (authoritative) {
            currentConfig = parseEventsConfig(authoritative.configJson);
            const pending = listPendingEventQuestionKeyRenames(eventDb, { operationId })[0];
            const authority = pending ? eventQuestionKeyRenameAuthority(currentConfig, pending) : undefined;
            const authorityRevision = pending
              ? eventQuestionKeyRenameAuthorityRevision(currentConfig, pending)
              : undefined;
            if (authority && authorityRevision) {
              settleEventQuestionKeyRename(eventDb, { operationId, authority, authorityRevision });
              const authoritativeProfile = currentConfig.eventProfiles.find((profile) => profile.id === parsed.profileId);
              recoveredCommittedMutation = authority === 'new' && Boolean(
                renamedProfile && authoritativeProfile &&
                JSON.stringify(authoritativeProfile) === JSON.stringify(renamedProfile)
              );
            }
          }
        } catch {
          // Preserve the original failure. The expanded answer state remains readable
          // through either key and startup recovery will converge it later.
        }
      }
      // A lost CAS response is successful only when the re-read profile is the
      // exact requested profile and the answer contraction also completed.
      if (!recoveredCommittedMutation) {
        if (error instanceof EventQuestionKeyRenameConflictError) {
          throw httpError(409, error.message);
        }
        throw error;
      }
    } finally {
      registry.closeAll();
    }

    if (!renamedProfile || !nextConfig) {
      throw new Error('The event question-key rename completed without a materialized profile.');
    }

    await this.auditOperatorConsoleAction('official.community-events.profile.question_key_renamed', {
      runtimeBindingId: parsed.runtimeBindingId,
      scopeId: parsed.scopeId,
      profileId: parsed.profileId,
      oldKey: parsed.oldKey,
      newKey: parsed.newKey,
      operationId,
      migratedEvents
    });
    return {
      ok: true,
      scopeId: parsed.scopeId,
      profileId: parsed.profileId,
      oldKey: parsed.oldKey,
      newKey: parsed.newKey,
      migratedEvents,
      profile: renamedProfile,
      config: nextConfig
    };
  }

async officialEventsForScope(input: unknown = {}) {
    const { scopeId, runtimeBindingId } = eventScopeRuntimeParamsSchema.parse(input ?? {});
    const context = await this.resolveRuntimeContext({ runtimeBindingId });
    await this.assertScopeForRuntime(context, scopeId);
    const config = await this.eventsConfigForScope(scopeId, context);
    const registry = this.host.openDatabases();
    try {
      const db = eventsDatabase(registry);
      const warnings: string[] = [];
      let events: StoredEventRecord[] = [];
      let votesByEvent = new Map<string, EventVoteSummarySelection[]>();
      try {
        events = listScopeEvents(db, scopeId);
      } catch (error) {
        if (!isMissingPluginDatabaseTable(error)) {
          throw error;
        }
        warnings.push('Event records are not available until the events plugin database is initialized.');
      }
      if (events.length) {
        try {
          votesByEvent = new Map(events.map((event) => [
            event.id,
            event.attendanceLifecycle?.owner === 'poll_assistant'
              && event.attendanceLifecycle.snapshot
              ? eventAttendanceVotesFromSnapshot(event, event.attendanceLifecycle.snapshot)
              : listVotes(db, event.id)
          ]));
        } catch (error) {
          if (!isMissingPluginDatabaseTable(error)) {
            throw error;
          }
          warnings.push('Event vote counts are not available until the events plugin database is initialized.');
        }
      }
      const rows = events.map((event) => officialEventsScopeEventSummary(
        event,
        votesByEvent.get(event.id) ?? [],
        listEventAnnouncementMessages(db, event.id, { includeDeleted: true })
      ));
      const unresolvedCalendarOwnership = listUnassignedEventCalendarOwnership(db, scopeId);
      if (unresolvedCalendarOwnership.length > 0) {
        warnings.push(
          `${unresolvedCalendarOwnership.length} event(s) require an explicit calendar ownership assignment before this scope can be published.`
        );
      }
      return {
        pluginId: EVENTS_PLUGIN_ID,
        scopeId,
        runtimeBindingId,
        enabled: config.enabled,
        timezone: config.timezone,
        generatedAt: new Date().toISOString(),
        eventCount: rows.length,
        events: rows,
        calendars: config.calendars.map((calendar) => ({
          id: calendar.id,
          label: calendar.label || calendar.id,
          enabled: calendar.enabled
        })),
        warnings
      };
    } finally {
      registry.closeAll();
    }
  }

async terminateOfficialEvent(input: unknown = {}) {
    const { scopeId, eventId, runtimeBindingId, reason, calendarDisposition, deleteAnnouncementMessages } = eventTerminateInputSchema.parse(input ?? {});
    const result = await this.executeRuntimeBridgeActionForBinding('official.community-events.terminate', {
      scopeId,
      eventId,
      actorWid: this.operatorConsoleActorWid,
      actorLabel: 'Operator Console',
      reason: reason ?? 'manual operator-console termination',
      calendarDisposition,
      deleteAnnouncementMessages
    }, runtimeBindingId);
    await this.auditOperatorConsoleAction('official.community-events.event.terminated', {
      scopeId,
      eventId,
      runtimeBindingId,
      calendarDisposition,
      deleteAnnouncementMessages,
      resultStatus: isRecord(result) ? result.status : undefined,
      announcementMessageDeletion: isRecord(result)
        ? result.announcementMessageDeletion
        : undefined
    });
    return {
      scopeId,
      eventId,
      runtimeBindingId,
      ...(isRecord(result) ? result : { result })
    };
  }

async retryOfficialEventCancellationCleanup(input: unknown = {}) {
    const parsed = eventCalendarHintReplayOperatorInputSchema.parse(input ?? {});
    const result = await this.executeRuntimeBridgeActionForBinding(
      'official.community-events.retryCancellationCleanup',
      { scopeId: parsed.scopeId, eventId: parsed.eventId },
      parsed.runtimeBindingId,
      { requireWhatsappReady: true }
    );
    await this.auditOperatorConsoleAction('official.community-events.event.cancellation_cleanup_retried', parsed, {
      resultStatus: isRecord(result) ? result.status : undefined
    });
    return { ...parsed, ...(isRecord(result) ? result : { result }) };
  }

async replayOfficialEventCalendarHint(input: unknown = {}) {
    const parsed = eventCalendarHintReplayOperatorInputSchema.parse(input ?? {});
    let result;
    try {
      result = eventCalendarHintReplayResultSchema.parse(
        await this.executeRuntimeBridgeActionForBinding(
          'official.community-events.calendarHintReplay',
          { scopeId: parsed.scopeId, eventId: parsed.eventId },
          parsed.runtimeBindingId,
          { requireWhatsappReady: true }
        )
      );
    } catch (error) {
      await this.auditOperatorConsoleAction(
        'official.community-events.event.calendar_hint_replayed',
        parsed,
        {
          scopeId: parsed.scopeId,
          eventId: parsed.eventId,
          runtimeBindingId: parsed.runtimeBindingId,
          resultStatus: 'bridge_failed',
          error: error instanceof Error ? error.message : String(error)
        }
      );
      throw error;
    }

    await this.auditOperatorConsoleAction(
      'official.community-events.event.calendar_hint_replayed',
      parsed,
      {
        scopeId: parsed.scopeId,
        eventId: parsed.eventId,
        runtimeBindingId: parsed.runtimeBindingId,
        resultStatus: result.status,
        ...('profileId' in result ? { profileId: result.profileId } : {}),
        ...('announcementGroupWid' in result ? { announcementGroupWid: result.announcementGroupWid } : {}),
        ...('trigger' in result ? { trigger: result.trigger } : {}),
        ...('deliveryKey' in result ? { deliveryKey: result.deliveryKey } : {}),
        ...('reason' in result ? { reason: result.reason } : {})
      }
    );
    if (result.status === 'not_found') {
      throw httpError(404, result.reason);
    }
    if (result.status === 'rejected') {
      throw httpError(409, result.reason);
    }
    return {
      ok: result.status === 'sent' || result.status === 'already_sent',
      runtimeBindingId: parsed.runtimeBindingId,
      ...result
    };
  }

async setOfficialEventCalendarDisposition(input: unknown = {}) {
    const { scopeId, eventId, runtimeBindingId, calendarDisposition, reason } = eventCalendarDispositionInputSchema.parse(input ?? {});
    const context = await this.resolveRuntimeContext({ runtimeBindingId });
    const config = await this.eventsConfigForScope(scopeId, context);
    const registry = this.host.openDatabases();
    let changed = false;
    let calendarId = '';
    let publication: CalendarPublicationOutcome | undefined;
    try {
      const db = eventsDatabase(registry);
      const event = getEvent(db, eventId);
      if (!event || event.scopeId !== scopeId) {
        throw httpError(404, `Unknown event: ${eventId}`);
      }
      if (event.eventStatus !== 'cancelled') {
        throw httpError(400, 'Only cancelled events can switch between hidden and cancelled calendar entries.');
      }
      try {
        calendarId = resolvedEventCalendarId(event) ?? '';
      } catch (error) {
        throw httpError(409, error instanceof Error ? error.message : String(error));
      }
      if (!calendarId) {
        throw httpError(400, 'This event is intentionally not assigned to a calendar.');
      }
      eventsCalendarOrThrow(config, calendarId);
      assertScopeEventCalendarOwnershipResolved(db, scopeId);
      const updatedAt = new Date().toISOString();
      if (event.calendarStatus !== calendarDisposition) {
        updateEventCalendarStatus(db, { eventId, calendarStatus: calendarDisposition, updatedAt });
        changed = true;
      }
      publication = await this.publishEventsCalendarForRuntime(context, scopeId, calendarId);
    } finally {
      registry.closeAll();
    }
    await this.auditOperatorConsoleAction('official.community-events.event.calendar_disposition_changed', {
      scopeId,
      eventId,
      runtimeBindingId,
      calendarId,
      calendarDisposition,
      changed,
      reason,
      publication
    });
    return {
      scopeId,
      eventId,
      runtimeBindingId,
      calendarId,
      calendarDisposition,
      changed,
      ...(publication ? { publication } : {})
    };
  }

async assignOfficialEventCalendarOwnership(input: unknown = {}) {
    const parsed = eventCalendarOwnershipInputSchema.parse(input ?? {});
    const context = await this.resolveRuntimeContext({ runtimeBindingId: parsed.runtimeBindingId });
    const config = await this.eventsConfigForScope(parsed.scopeId, context);
    const requestedCalendarId = parsed.calendarId?.trim() || null;
    if (requestedCalendarId) {
      eventsCalendarOrThrow(config, requestedCalendarId);
    }
    const registry = this.host.openDatabases();
    let changed = false;
    let unresolvedCount = 0;
    const publications: Array<{
      calendarId: string;
      publication?: CalendarPublicationOutcome | undefined;
      error?: string | undefined;
    }> = [];
    try {
      const db = eventsDatabase(registry);
      const event = getEvent(db, parsed.eventId);
      if (!event || event.scopeId !== parsed.scopeId) {
        throw httpError(404, `Unknown event: ${parsed.eventId}`);
      }
      if (event.calendarOwnershipStatus === 'unresolved') {
        changed = assignUnassignedEventCalendarOwnership(db, {
          eventId: event.id,
          scopeId: event.scopeId,
          profileId: event.profileId,
          calendarId: requestedCalendarId,
          source: 'operator-console-explicit-calendar-ownership'
        });
        if (!changed) {
          const current = getEvent(db, event.id);
          const currentCalendarId = current ? resolvedEventCalendarId(current) ?? null : undefined;
          if (currentCalendarId !== requestedCalendarId) {
            throw httpError(409, 'Event calendar ownership changed concurrently. Refresh and try again.');
          }
        }
      } else {
        const currentCalendarId = resolvedEventCalendarId(event) ?? null;
        if (currentCalendarId !== requestedCalendarId) {
          throw httpError(409, 'Event calendar ownership is already resolved and immutable.');
        }
      }

      unresolvedCount = listUnassignedEventCalendarOwnership(db, parsed.scopeId).length;
      if (unresolvedCount === 0) {
        for (const calendar of config.calendars.filter((candidate) => candidate.enabled)) {
          try {
            const publication = await this.publishEventsCalendarForRuntime(context, parsed.scopeId, calendar.id);
            publications.push({
              calendarId: calendar.id,
              ...(publication ? { publication } : {})
            });
          } catch (error) {
            publications.push({
              calendarId: calendar.id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    } finally {
      registry.closeAll();
    }
    await this.auditOperatorConsoleAction('official.community-events.event.calendar_ownership_assigned', {
      scopeId: parsed.scopeId,
      eventId: parsed.eventId,
      runtimeBindingId: parsed.runtimeBindingId,
      calendarId: requestedCalendarId,
      changed,
      unresolvedCount,
      publications
    });
    const publicationFailures = publications.filter((entry) =>
      Boolean(entry.error) || entry.publication?.ok === false
    );
    return {
      ok: publicationFailures.length === 0,
      scopeId: parsed.scopeId,
      eventId: parsed.eventId,
      runtimeBindingId: parsed.runtimeBindingId,
      calendarId: requestedCalendarId,
      changed,
      unresolvedCount,
      publicationFailures: publicationFailures.length,
      publications
    };
  }

async officialEventsAdoptionOptions(input: unknown = {}) {
    const { scopeId, profileId, runtimeBindingId } = eventAdoptionRuntimeParamsSchema.parse(input ?? {});
    const context = await this.resolveRuntimeContext({ runtimeBindingId });
    await this.assertScopeForRuntime(context, scopeId);
    const config = await this.eventsConfigForScope(scopeId, context);
    const profile = eventsProfileOrThrow(config, profileId);
    const communityGroup = await this.eventsCommunityGroupForScope(context, scopeId);
    const announcementGroup = profile.announcementGroupWid
      ? await this.eventsGroupOptionForChatId(context, profile.announcementGroupWid, 'Announcement group override')
      : await this.eventsAnnouncementGroupForCommunity(context, communityGroup);
    const [pollOptions, groupOptions] = await Promise.all([
      this.eventsAdoptionPollOptions(context, announcementGroup),
      this.eventsAdoptionGroupOptions(context, communityGroup, announcementGroup)
    ]);
    const reconciliation = this.eventsAdoptionReconciliationEvents(context, scopeId, profileId);
    const annotatedGroupOptions = groupOptions.map((option) => {
      const eventId = reconciliation.eventIdBySubgroupChatId.get(option.value.trim().toLowerCase());
      return eventId ? { ...option, eventId } : option;
    });
    const warnings = [
      !communityGroup ? 'No scoped community group is registered for this scope.' : '',
      !announcementGroup ? 'No announcement group is registered for this scope.' : '',
      announcementGroup && pollOptions.length === 0 ? 'No archived poll messages were found in the announcement group.' : '',
      communityGroup && groupOptions.length === 0 ? 'No child event groups were found under the scoped community.' : '',
      ...reconciliation.warnings
    ].filter(Boolean);
    return {
      scopeId,
      profileId,
      runtimeBindingId,
      communityGroup,
      announcementGroup,
      pollOptions,
      groupOptions: annotatedGroupOptions,
      warnings
    };
  }

async adoptOfficialEvent(input: unknown = {}) {
    const parsed = eventAdoptionInputSchema.parse(input ?? {});
    const { runtimeBindingId, ...runtimeBody } = parsed;
    const actorIdentityId = await this.ensureOperatorConsoleActorIdentityId();
    const result = await this.executeRuntimeBridgeActionForBinding('official.community-events.adopt', {
      ...runtimeBody,
      actorIdentityId
    }, runtimeBindingId);
    const reconciliationAuditTarget = parsed.eventId ? { eventId: parsed.eventId } : {};
    await this.auditOperatorConsoleAction('official.community-events.adopted', {
      runtimeBindingId,
      scopeId: parsed.scopeId,
      mode: parsed.mode,
      profileId: parsed.profileId,
      ...reconciliationAuditTarget,
      pollWaMsgId: parsed.pollWaMsgId,
      subgroupChatId: parsed.subgroupChatId
    }, reconciliationAuditTarget);
    return result;
  }

async eventsCalendarSubscriptionDocument(params: unknown = {}, query: unknown = {}) {
    const { scopeId, calendarId, runtimeBindingId } = eventCalendarFeedParamsSchema.parse(params ?? {});
    const { token } = eventCalendarSubscriptionQuerySchema.parse(query ?? {});
    const context = await this.resolveRuntimeContext({ runtimeBindingId });
    const config = await this.eventsConfigForScope(scopeId, context);
    const calendar = eventsCalendarOrThrow(config, calendarId);
    if (!calendar.enabled) {
      throw httpError(404, 'Calendar subscription is disabled for this calendar.');
    }
    const expected = calendar.subscriptionToken.trim();
    if (!expected || !constantTimeEqual(expected, token)) {
      throw httpError(403, 'Invalid calendar subscription token.');
    }
    const body = await this.renderEventsCalendarDocument(context, config, scopeId, calendarId);
    return {
      filename: `${safeFilename(scopeId)}-${safeFilename(calendarId)}.ics`,
      mimeType: 'text/calendar; charset=utf-8',
      body
    };
  }

private eventsAdoptionReconciliationEvents(
    context: SelectedRuntimeContext,
    scopeId: string,
    profileId: string
  ): { eventIdBySubgroupChatId: Map<string, string>; warnings: string[] } {
    const registry = this.host.openDatabases();
    try {
      let events: StoredEventRecord[];
      try {
        events = listScopeEvents(eventsDatabase(registry), scopeId);
      } catch (error) {
        if (!isMissingPluginDatabaseTable(error)) {
          throw error;
        }
        return {
          eventIdBySubgroupChatId: new Map(),
          warnings: ['Adopted event reconciliation records are not available until the events plugin database is initialized.']
        };
      }

      const matchesBySubgroupChatId = new Map<string, string[]>();
      for (const event of events) {
        const subgroupChatId = event.subgroupChatId?.trim().toLowerCase() ?? '';
        if (
          event.scopeId !== scopeId
          || event.profileId !== profileId
          || event.origin !== 'adopted_group'
          || event.eventStatus !== 'active'
          || event.groupLifecycleStatus !== 'poll_closed'
          || !subgroupChatId
        ) {
          continue;
        }
        matchesBySubgroupChatId.set(subgroupChatId, [
          ...(matchesBySubgroupChatId.get(subgroupChatId) ?? []),
          event.id
        ]);
      }

      const eventIdBySubgroupChatId = new Map<string, string>();
      const warnings: string[] = [];
      for (const [subgroupChatId, eventIds] of matchesBySubgroupChatId) {
        if (eventIds.length === 1) {
          eventIdBySubgroupChatId.set(subgroupChatId, eventIds[0]!);
          continue;
        }
        warnings.push(`Multiple active adopted events match child group ${subgroupChatId}; resolve the duplicate records before completing adoption.`);
      }
      return { eventIdBySubgroupChatId, warnings };
    } finally {
      registry.closeAll();
    }
  }

private async publishEventsCalendarForRuntime(
    context: SelectedRuntimeContext,
    scopeId: string,
    calendarId: string
  ): Promise<CalendarPublicationOutcome | undefined> {
    return await this.executeRuntimeBridgeActionForBinding(
      'official.community-events.publishCalendar',
      { scopeId, calendarId },
      context.runtimeBindingId
    ) as CalendarPublicationOutcome | undefined;
  }

private async eventsConfigForScope(scopeId: string, context?: SelectedRuntimeContext | undefined) {
    return parseEventsConfig(await this.host.configuration.resolve(scopeId));
  }

private inspectOfficialEventQuestionKeyRenames(
    context: SelectedRuntimeContext,
    scopeId: string,
    config: ReturnType<typeof parseEventsConfig>,
    now = new Date()
  ): { warnings: string[] } {
    const registry = this.host.openDatabases();
    const warnings: string[] = [];
    try {
      const db = eventsDatabase(registry);
      for (const rename of listPendingEventQuestionKeyRenames(db, { scopeId })) {
        const decision = eventQuestionKeyRenameRecoveryDecision(config, rename, now);
        if (decision.status === 'leased') {
          warnings.push(
            `Event profile ${rename.profileId} question-key rename ${rename.operationId} is still in progress until ${rename.leaseExpiresAt}.`
          );
          continue;
        }
        if (decision.status !== 'settle') {
          warnings.push(
            `Event profile ${rename.profileId} question-key rename ${rename.operationId} requires operator repair: ` +
            `the authoritative profile contains both or neither of ${rename.oldKey} and ${rename.newKey}.`
          );
          continue;
        }
        warnings.push(
          `Event profile ${rename.profileId} question-key rename ${rename.operationId} is awaiting audited runtime recovery ` +
          `using the authoritative ${decision.authority} key.`
        );
      }
      return { warnings };
    } finally {
      registry.closeAll();
    }
  }

private async renderEventsCalendarDocument(
    context: SelectedRuntimeContext,
    config: ReturnType<typeof parseEventsConfig>,
    scopeId: string,
    calendarId: string
  ): Promise<string> {
    return (await this.renderEventsCalendarDocumentState(context, config, scopeId, calendarId)).body;
  }

private async renderEventsCalendarDocumentState(
    context: SelectedRuntimeContext,
    config: ReturnType<typeof parseEventsConfig>,
    scopeId: string,
    calendarId: string
  ): Promise<{ body: string; generatedAt: string; eventCount: number }> {
    const registry = this.host.openDatabases();
    try {
      const db = eventsDatabase(registry);
      return renderCurrentScopeCalendarDocument({
        db,
        config,
        scopeId,
        calendarId
      });
    } finally {
      registry.closeAll();
    }
  }

private eventsCalendarSubscriptionUrl(scopeId: string, calendarId: string, runtimeBindingId: string, token: string): string {
    return eventsCalendarSubscriptionUrl({
      operatorConsolePublicOrigin: this.operatorConsolePublicOrigin(),
      runtimeBindingId,
      scopeId,
      calendarId,
      token
    });
  }

private eventsCalendarPublicationState(
    scopeId: string,
    calendar: ReturnType<typeof parseEventsConfig>['calendars'][number],
    published: Partial<{
      endpointUrl: string;
      feedId: string;
      label: string;
      subscriptionUrl: string;
      calendarUrl: string;
      updatedAt: string;
      error: string;
      lastSuccessAt: string;
      lastErrorAt: string;
    }> = {}
  ) {
    const target = calendarPublicationTarget(scopeId, calendar);
    const endpointUrl = published.endpointUrl ?? target.endpointUrl;
    return {
      enabled: target.enabled,
      configured: Boolean(endpointUrl),
      scopeId: target.scopeId,
      endpointUrl,
      feedId: published.feedId ?? target.feedId,
      label: published.label ?? target.label,
      subscriptionUrl: published.subscriptionUrl ?? '',
      calendarUrl: published.calendarUrl ?? target.calendarUrl,
      updatedAt: published.updatedAt ?? '',
      lastSuccessAt: published.lastSuccessAt ?? '',
      lastErrorAt: published.lastErrorAt ?? '',
      message: target.enabled
        ? endpointUrl
          ? 'Calendar publisher is configured for the selected bot.'
          : 'Configure calendar publication for the selected bot before publishing.'
        : 'Calendar publication is not enabled for this calendar.',
      lastError: published.error ?? null as string | null
    };
  }

private async eventsCalendarExportStatus(
    context: SelectedRuntimeContext,
    config: ReturnType<typeof parseEventsConfig>,
    scopeId: string,
    calendarId: string
  ): Promise<{
    generatedAt: string;
    generatedEventCount: number;
    icsFileUpdatedAt: string;
    publicationStatus?: StoredCalendarPublicationStatus | undefined;
  }> {
    const registry = this.host.openDatabases();
    try {
      const events = calendarEventsOrEmpty(registry, scopeId, calendarId);
      let publicationStatus: StoredCalendarPublicationStatus | undefined;
      try {
        publicationStatus = getCalendarPublicationStatus(eventsDatabase(registry), scopeId, calendarId);
      } catch (error) {
        if (!isMissingPluginDatabaseTable(error)) {
          throw error;
        }
      }
      const fileUpdatedAt = await calendarFileUpdatedAt(this.host.dataDirectory, config, scopeId, calendarId);
      return {
        generatedAt: publicationStatus?.generatedAt ?? fileUpdatedAt,
        generatedEventCount: publicationStatus?.generatedEventCount ?? events.length,
        icsFileUpdatedAt: fileUpdatedAt,
        ...(publicationStatus ? { publicationStatus } : {})
      };
    } finally {
      registry.closeAll();
    }
  }
}

export function registerEventsConsoleOperations(context: PluginConsoleContext): PluginConsoleOperationRegistration[] {
 const operations = new EventsConsoleOperations(context);
 return [
  { operationId: 'official.community-events.eventsCalendarSubscriptionInfo', handler: input => operations.eventsCalendarSubscriptionInfo(input) },
  { operationId: 'official.community-events.publishEventsCalendar', handler: input => operations.publishEventsCalendar(input) },
  { operationId: 'official.community-events.rotateEventsCalendarSubscriptionToken', handler: input => operations.rotateEventsCalendarSubscriptionToken(input) },
  { operationId: 'official.community-events.officialEventsProfileOptions', handler: input => operations.officialEventsProfileOptions(input) },
  { operationId: 'official.community-events.renameOfficialEventProfileQuestion', handler: input => operations.renameOfficialEventProfileQuestion(input) },
  { operationId: 'official.community-events.officialEventsForScope', handler: input => operations.officialEventsForScope(input) },
  { operationId: 'official.community-events.terminateOfficialEvent', handler: input => operations.terminateOfficialEvent(input) },
  { operationId: 'official.community-events.retryOfficialEventCancellationCleanup', handler: input => operations.retryOfficialEventCancellationCleanup(input) },
  { operationId: 'official.community-events.replayOfficialEventCalendarHint', handler: input => operations.replayOfficialEventCalendarHint(input) },
  { operationId: 'official.community-events.setOfficialEventCalendarDisposition', handler: input => operations.setOfficialEventCalendarDisposition(input) },
  { operationId: 'official.community-events.assignOfficialEventCalendarOwnership', handler: input => operations.assignOfficialEventCalendarOwnership(input) },
  { operationId: 'official.community-events.officialEventsAdoptionOptions', handler: input => operations.officialEventsAdoptionOptions(input) },
  { operationId: 'official.community-events.adoptOfficialEvent', handler: input => operations.adoptOfficialEvent(input) },
  { operationId: 'official.community-events.eventsCalendarSubscriptionDocument', handler(input) { const request = z.object({params:z.unknown(),query:z.unknown()}).parse(input); return operations.eventsCalendarSubscriptionDocument(request.params, request.query); } }
 ];
}
