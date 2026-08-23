import type { TranslateFn } from '../../../platform/i18n';
import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { PluginJobEvent } from '../../../platform/pluginRuntime/types';
import { enqueuePluginJob } from '../../../platform/jobs/queue';
import {
  POLL_ASSISTANT_AUTOMATION_SERVICE_ID,
  POLL_ASSISTANT_CANCEL_POLL_METHOD,
  POLL_ASSISTANT_ENSURE_POLL_METHOD,
  POLL_ASSISTANT_RESOLVE_POLL_METHOD,
  type PollAssistantCancelPollOutput,
  type PollAssistantEnsurePollInput,
  type PollAssistantEnsurePollOutput,
  type PollAssistantResolvePollOutput
} from '../poll-assistant/serviceApi';
import { POLL_ASSISTANT_SCHEMA_VERSION } from '../poll-assistant/domain';
import { parseEventsConfig, type EventProfile } from './config';
import { eventDateAndTimeToUtc, type EventDateParts } from './datetime';
import { materializeEventLifecycle } from './materialize';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import { eventProfileQuestionSchemaRevision } from './profileRevision';
import {
  claimEventStartTimeAgreement,
  EVENT_START_TIME_BANDS,
  getEventStartTimeAgreement,
  listRecoverableEventStartTimeAgreements,
  saveClaimedEventStartTimeAgreement,
  type EventStartTimeBand,
  type StoredEventStartTimeAgreement
} from './startTimeAgreementStore';
import {
  appendEventLog,
  eventsDatabase,
  getEvent,
  nextEventRevisionTimestamp,
  resolvedEventCalendarId,
  updateEventStructuredData,
  type StoredEventRecord
} from './store';
import { eventWeatherForecastJobActions } from './weather';

type EnqueueAction = Extract<PluginAction, { type: 'plugin.enqueueJob' }>;
type AgreementRound = 'band' | 'exact' | 'organizer-band' | 'organizer-time';

const AGREEMENT_RETRY_MS = 30_000;
const SUBGROUP_RETRY_MS = 5 * 60_000;
const FINALIZATION_GRACE_MS = 15_000;

export async function recoverEventStartTimeAgreementJobs(
  context: PluginRuntimeContext,
  now = new Date()
): Promise<number> {
  const agreements = listRecoverableEventStartTimeAgreements(
    eventsDatabase(context.databases),
    now.toISOString()
  );
  for (const agreement of agreements) {
    const event = getEvent(eventsDatabase(context.databases), agreement.eventId);
    if (!event) {
      continue;
    }
    await enqueuePluginJob(context.queue, agreementJobRequest(event, agreement, now, 'recovery'));
  }
  return agreements.length;
}

export async function handleEventStartTimeAgreementJob(
  context: PluginRuntimeContext,
  job: PluginJobEvent
): Promise<PluginAction[]> {
  const eventId = payloadEventId(job.payload);
  if (!eventId) {
    return [audit('events.start_time_agreement.skipped', { reason: 'missing_event_id' })];
  }
  const db = eventsDatabase(context.databases);
  const now = new Date();
  const agreement = claimEventStartTimeAgreement(db, { eventId, now });
  if (!agreement) {
    return [];
  }
  try {
    const event = getEvent(db, eventId);
    if (!event || event.scopeId !== job.scopeId) {
      agreement.status = 'cancelled';
      agreement.cancelledAt = now.toISOString();
      saveClaimedEventStartTimeAgreement(db, agreement, { now, lastError: 'event_missing_or_scope_mismatch' });
      return [audit('events.start_time_agreement.cancelled', { eventId, reason: 'event_missing_or_scope_mismatch' })];
    }
    if (event.localTime) {
      await cancelEventStartTimeAgreementPolls(context, event, agreement, 'event time configured outside agreement');
      agreement.status = 'applied';
      agreement.resolvedLocalTime = event.localTime;
      agreement.resolvedAt = agreement.resolvedAt ?? now.toISOString();
      saveClaimedEventStartTimeAgreement(db, agreement, { now });
      return [audit('events.start_time_agreement.reconciled', { eventId, localTime: event.localTime })];
    }
    if (event.eventStatus !== 'active') {
      await cancelEventStartTimeAgreementPolls(context, event, agreement, `event is ${event.eventStatus}`);
      agreement.status = event.eventStatus === 'cancelled' ? 'cancelled' : 'expired';
      agreement.cancelledAt = event.eventStatus === 'cancelled' ? now.toISOString() : agreement.cancelledAt;
      saveClaimedEventStartTimeAgreement(db, agreement, { now, lastError: `event_${event.eventStatus}` });
      return [audit('events.start_time_agreement.cancelled', { eventId, reason: `event_${event.eventStatus}` })];
    }
    if (Date.parse(event.lifecycleCompleteAt) <= now.getTime()) {
      await cancelEventStartTimeAgreementPolls(context, event, agreement, 'event lifecycle ended');
      agreement.status = 'expired';
      saveClaimedEventStartTimeAgreement(db, agreement, { now, lastError: 'event_lifecycle_ended' });
      return [audit('events.start_time_agreement.expired', { eventId })];
    }
    if (!event.subgroupChatId) {
      agreement.status = 'pending_subgroup';
      return saveAndRetry(db, event, agreement, now, new Date(now.getTime() + SUBGROUP_RETRY_MS));
    }
    if (!event.actorIdentityId) {
      return blockAgreement(context, db, event, agreement, now, 'creator_identity_unavailable');
    }
    const config = parseEventsConfig(await context.configFor(event.scopeId, event.actorIdentityId));
    const profile = config.eventProfiles.find((candidate) => candidate.id === event.profileId);
    if (!profile) {
      return blockAgreement(context, db, event, agreement, now, 'profile_removed');
    }
    const locale = await context.i18n.resolveIdentityLocale(event.actorIdentityId, event.scopeId);
    const t = await context.i18n.translatorForIdentity(event.actorIdentityId, event.scopeId);
    return advanceAgreement(context, db, event, profile, agreement, now, locale.locale, t);
  } catch (error) {
    const event = getEvent(db, eventId);
    const reason = error instanceof Error ? error.message : String(error);
    const retryAt = new Date(now.getTime() + AGREEMENT_RETRY_MS);
    agreement.lastError = reason;
    saveClaimedEventStartTimeAgreement(db, agreement, { now, nextRunAt: retryAt, lastError: reason });
    context.logger.warn({ error, eventId }, 'Community-event start-time agreement deferred');
    return event
      ? [agreementJobAction(event, agreement, retryAt, 'error-retry'), audit('events.start_time_agreement.deferred', { eventId, reason })]
      : [audit('events.start_time_agreement.deferred', { eventId, reason })];
  }
}

async function advanceAgreement(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  profile: EventProfile,
  agreement: StoredEventStartTimeAgreement,
  now: Date,
  locale: string,
  t: TranslateFn
): Promise<PluginAction[]> {
  switch (agreement.status) {
    case 'pending_subgroup':
      agreement.status = 'band_pending';
      return saveAndRetry(db, event, agreement, now, now);
    case 'band_pending':
      return ensureBandRound(context, db, event, agreement, now, t, false);
    case 'band_open':
      return resolveBandRound(context, db, event, agreement, now, t, false);
    case 'organizer_band_pending':
      return ensureBandRound(context, db, event, agreement, now, t, true);
    case 'organizer_band_open':
      return resolveBandRound(context, db, event, agreement, now, t, true);
    case 'exact_pending':
      return ensureExactRound(context, db, event, agreement, now, t, false);
    case 'exact_open':
      return resolveExactRound(context, db, event, agreement, now, t, false);
    case 'organizer_time_pending':
      return ensureExactRound(context, db, event, agreement, now, t, true);
    case 'organizer_time_open':
      return resolveExactRound(context, db, event, agreement, now, t, true);
    case 'applying':
      return applyAgreement(context, db, event, profile, agreement, now, locale, t);
    case 'blocked':
    case 'applied':
    case 'cancelled':
    case 'expired':
      saveClaimedEventStartTimeAgreement(db, agreement, { now });
      return [];
  }
}

async function ensureBandRound(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  now: Date,
  t: TranslateFn,
  organizerOnly: boolean
): Promise<PluginAction[]> {
  const bands = availableBands(event, agreement, now);
  if (bands.length === 0) {
    return requireManualOrganizerTime(context, db, event, agreement, now, t);
  }
  if (bands.length === 1) {
    agreement.winningBand = bands[0];
    agreement.status = organizerOnly ? 'organizer_time_pending' : 'exact_pending';
    return saveAndRetry(db, event, agreement, now, now);
  }
  const closesField = organizerOnly ? 'organizerBandClosesAt' : 'bandClosesAt';
  const pollField = organizerOnly ? 'organizerBandPollId' : 'bandPollId';
  let closesAt = agreement[closesField];
  if (!closesAt) {
    const deadline = roundDeadline(event, now, agreement.config.bandVotingWindowMinutes);
    if (!deadline) {
      return requireManualOrganizerTime(context, db, event, agreement, now, t);
    }
    closesAt = deadline.toISOString();
    agreement[closesField] = closesAt;
    return saveAndRetry(db, event, agreement, now, now);
  }
  const round: AgreementRound = organizerOnly ? 'organizer-band' : 'band';
  const result = await ensurePoll(context, event, agreement, round, {
    question: t(organizerOnly
      ? 'official.community-events.startTimeAgreement.organizerBand.question'
      : 'official.community-events.startTimeAgreement.band.question'),
    options: bands.map((band, index) => ({
      id: band,
      label: t(`official.community-events.startTimeAgreement.band.${band}`),
      ordinal: index + 1
    })),
    closesAt,
    organizerOnly
  });
  agreement[pollField] = result.pollId;
  agreement.status = organizerOnly ? 'organizer_band_open' : 'band_open';
  const retryAt = new Date(Date.parse(closesAt) + FINALIZATION_GRACE_MS);
  return saveAndRetry(db, event, agreement, now, retryAt);
}

async function resolveBandRound(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  now: Date,
  t: TranslateFn,
  organizerOnly: boolean
): Promise<PluginAction[]> {
  const round: AgreementRound = organizerOnly ? 'organizer-band' : 'band';
  const result = await resolvePoll(context, event, agreement, round);
  if (result.kind === 'unavailable' || result.outcome.kind === 'open' || result.outcome.kind === 'not_finalized') {
    return saveAndRetry(db, event, agreement, now, new Date(now.getTime() + AGREEMENT_RETRY_MS));
  }
  if (result.outcome.kind === 'no_response') {
    if (organizerOnly) {
      return blockAgreement(context, db, event, agreement, now, 'organizer_did_not_choose_band', t);
    }
    agreement.status = 'organizer_band_pending';
    return saveAndRetry(db, event, agreement, now, now);
  }
  if (result.outcome.kind === 'decided') {
    const band = result.outcome.selectedOptionIds.find(isEventStartTimeBand);
    if (!band) {
      return blockAgreement(context, db, event, agreement, now, 'invalid_band_result', t);
    }
    agreement.winningBand = band;
    agreement.status = organizerOnly ? 'organizer_time_pending' : 'exact_pending';
    return saveAndRetry(db, event, agreement, now, now);
  }
  return blockAgreement(context, db, event, agreement, now, `band_${result.outcome.kind}`, t);
}

async function ensureExactRound(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  now: Date,
  t: TranslateFn,
  organizerOnly: boolean
): Promise<PluginAction[]> {
  if (!agreement.winningBand) {
    agreement.status = 'organizer_band_pending';
    return saveAndRetry(db, event, agreement, now, now);
  }
  const times = availableTimes(event, agreement, agreement.winningBand, now);
  if (times.length === 0) {
    return requireManualOrganizerTime(context, db, event, agreement, now, t);
  }
  if (times.length === 1) {
    agreement.resolvedLocalTime = times[0];
    agreement.resolvedAt = now.toISOString();
    agreement.status = 'applying';
    return saveAndRetry(db, event, agreement, now, now);
  }
  const closesField = organizerOnly ? 'organizerTimeClosesAt' : 'exactClosesAt';
  const pollField = organizerOnly ? 'organizerTimePollId' : 'exactPollId';
  let closesAt = agreement[closesField];
  if (!closesAt) {
    const deadline = roundDeadline(event, now, agreement.config.exactTimeVotingWindowMinutes);
    if (!deadline) {
      return requireManualOrganizerTime(context, db, event, agreement, now, t);
    }
    closesAt = deadline.toISOString();
    agreement[closesField] = closesAt;
    return saveAndRetry(db, event, agreement, now, now);
  }
  const round: AgreementRound = organizerOnly ? 'organizer-time' : 'exact';
  const result = await ensurePoll(context, event, agreement, round, {
    question: t(organizerOnly
      ? 'official.community-events.startTimeAgreement.organizerTime.question'
      : 'official.community-events.startTimeAgreement.exact.question', {
        band: t(`official.community-events.startTimeAgreement.band.${agreement.winningBand}`)
      }),
    options: times.map((time, index) => ({ id: timeOptionId(time), label: time, ordinal: index + 1 })),
    closesAt,
    organizerOnly
  });
  agreement[pollField] = result.pollId;
  agreement.status = organizerOnly ? 'organizer_time_open' : 'exact_open';
  return saveAndRetry(db, event, agreement, now, new Date(Date.parse(closesAt) + FINALIZATION_GRACE_MS));
}

async function resolveExactRound(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  now: Date,
  t: TranslateFn,
  organizerOnly: boolean
): Promise<PluginAction[]> {
  const round: AgreementRound = organizerOnly ? 'organizer-time' : 'exact';
  const result = await resolvePoll(context, event, agreement, round);
  if (result.kind === 'unavailable' || result.outcome.kind === 'open' || result.outcome.kind === 'not_finalized') {
    return saveAndRetry(db, event, agreement, now, new Date(now.getTime() + AGREEMENT_RETRY_MS));
  }
  if (result.outcome.kind === 'no_response') {
    if (organizerOnly) {
      return blockAgreement(context, db, event, agreement, now, 'organizer_did_not_choose_time', t);
    }
    agreement.status = 'organizer_time_pending';
    return saveAndRetry(db, event, agreement, now, now);
  }
  if (result.outcome.kind === 'decided') {
    const localTime = result.outcome.selectedOptionIds
      .map(timeFromOptionId)
      .find((time): time is string => Boolean(time));
    if (!localTime) {
      return blockAgreement(context, db, event, agreement, now, 'invalid_time_result', t);
    }
    agreement.resolvedLocalTime = localTime;
    agreement.resolvedAt = now.toISOString();
    agreement.status = 'applying';
    return saveAndRetry(db, event, agreement, now, now);
  }
  return blockAgreement(context, db, event, agreement, now, `time_${result.outcome.kind}`, t);
}

async function applyAgreement(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  profile: EventProfile,
  agreement: StoredEventStartTimeAgreement,
  now: Date,
  locale: string,
  t: TranslateFn
): Promise<PluginAction[]> {
  const localTime = agreement.resolvedLocalTime;
  const localDate = event.localDate;
  if (!localTime || !localDate) {
    return blockAgreement(context, db, event, agreement, now, 'resolved_time_or_event_date_missing', t);
  }
  const startsAt = eventDateAndTimeToUtc(parseLocalDate(localDate), parseLocalTime(localTime), event.timezone);
  if (!startsAt || startsAt.getTime() <= now.getTime()) {
    return requireManualOrganizerTime(context, db, event, agreement, now, t);
  }
  const durationProfile: EventProfile = {
    ...profile,
    calendar: { ...profile.calendar, durationMinutes: agreement.config.configuredDurationMinutes }
  };
  const answers = {
    ...event.answers,
    [agreement.config.timeQuestionKey]: localTime,
    [profile.startsAtTimeQuestionKey]: localTime
  };
  const materialized = materializeEventLifecycle({
    profile: durationProfile,
    answers: {
      profileId: profile.id,
      answers,
      startsAt,
      ...(event.spanKind === 'multi_day' ? { endsAt: new Date(event.endsAt) } : {}),
      spanKind: event.spanKind,
      localDate,
      localTime
    },
    timezone: event.timezone,
    locale,
    creatorDisplayName: event.actorLabel || event.actorWid,
    ...(event.eventLocation ? { eventLocation: event.eventLocation } : {})
  });
  const updatedAt = nextEventRevisionTimestamp(event.updatedAt, now);
  const operationId = `start-time-agreement:${event.id}:${agreement.generation}`;
  const updated = updateEventStructuredData(db, {
    eventId: event.id,
    profileRevision: eventProfileQuestionSchemaRevision(profile),
    pollQuestion: materialized.pollQuestion,
    pollOptions: event.pollOptions,
    responseClasses: event.responseClasses,
    answers: materialized.answers,
    ...(materialized.eventLocation ? { eventLocation: materialized.eventLocation } : {}),
    startsAt: materialized.startsAt.toISOString(),
    startsAtUtc: materialized.startsAt.toISOString(),
    endsAt: materialized.endsAt.toISOString(),
    lifecycleCompleteAt: materialized.lifecycleCompleteAt.toISOString(),
    spanKind: materialized.spanKind,
    timezone: event.timezone,
    localDate: materialized.localDate,
    localTime,
    ...(materialized.place ? { place: materialized.place } : {}),
    closeAt: materialized.closeAt.toISOString(),
    cleanupAt: materialized.cleanupAt.toISOString(),
    groupTitle: materialized.groupTitle,
    calendarDurationMinutes: materialized.calendarDurationMinutes,
    ...(materialized.calendarLocation ? { calendarLocation: materialized.calendarLocation } : {}),
    ...(materialized.calendarDescription ? { calendarDescription: materialized.calendarDescription } : {}),
    expectedUpdatedAt: event.updatedAt,
    updatedAt,
    repairIntent: {
      operationId,
      scopeId: event.scopeId,
      ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
      targetGroupTitle: materialized.groupTitle,
      calendarId: resolvedEventCalendarId(event) ?? ''
    }
  });
  if (!updated) {
    return saveAndRetry(db, event, agreement, now, new Date(now.getTime() + AGREEMENT_RETRY_MS), 'event_update_conflict');
  }
  agreement.status = 'applied';
  agreement.resolvedAt = agreement.resolvedAt ?? now.toISOString();
  agreement.lastError = undefined;
  saveClaimedEventStartTimeAgreement(db, agreement, { now });
  const updatedEvent = getEvent(db, event.id);
  if (!updatedEvent) {
    throw new Error(`Event ${event.id} disappeared after start-time agreement application.`);
  }
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.start_time_agreement.applied',
    metadata: { localTime, winningBand: agreement.winningBand, voterDisclosure: agreement.config.voterDisclosure }
  });
  return [
    {
      type: 'message.sendText',
      chatId: event.subgroupChatId!,
      text: t('official.community-events.startTimeAgreement.applied', { time: localizedTime(localTime, locale) }),
      idempotencyKey: `${operationId}:announcement`
    },
    {
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.editRepair,
      scopeId: event.scopeId,
      runAt: now,
      payload: { operationId, attempt: 0 },
      dedupeKey: `${EVENTS_JOBS.editRepair}:${operationId}:start-time`
    },
    {
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.complete,
      scopeId: event.scopeId,
      runAt: new Date(updatedEvent.lifecycleCompleteAt),
      payload: { eventId: event.id },
      dedupeKey: `${EVENTS_JOBS.complete}:${event.id}:${updatedEvent.lifecycleCompleteAt}`
    },
    {
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.cleanup,
      scopeId: event.scopeId,
      runAt: new Date(updatedEvent.cleanupAt),
      payload: { eventId: event.id, attempt: 0 },
      dedupeKey: `${EVENTS_JOBS.cleanup}:${event.id}:start-time:${updatedEvent.cleanupAt}`
    },
    ...eventWeatherForecastJobActions({ event: updatedEvent, profile, now }),
    audit('events.start_time_agreement.applied', { eventId: event.id, localTime })
  ];
}

async function ensurePoll(
  context: PluginRuntimeContext,
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  round: AgreementRound,
  input: {
    question: string;
    options: Array<{ id: string; label: string; ordinal: number }>;
    closesAt: string;
    organizerOnly: boolean;
  }
): Promise<PollAssistantEnsurePollOutput> {
  if (!context.services || !event.actorIdentityId || !event.subgroupChatId) {
    throw new Error('Poll Assistant automation runtime is unavailable.');
  }
  const definition: PollAssistantEnsurePollInput['definition'] = {
    schemaVersion: POLL_ASSISTANT_SCHEMA_VERSION,
    id: sourceKey(event.id, agreement.generation, round),
    purpose: 'decide',
    question: input.question,
    options: input.options,
    closing: { kind: 'deadline', deadline: { mode: 'at', closesAt: input.closesAt } },
    quorum: { kind: 'none' },
    electorate: { kind: input.organizerOnly ? 'actor' : 'group_members_until_cutoff' },
    ballotDelivery: 'private',
    voterDisclosure: agreement.config.voterDisclosure,
    rule: { kind: 'plurality' },
    tiePolicy: { kind: 'random_draw' }
  };
  return context.services.call<PollAssistantEnsurePollOutput>({
    serviceId: POLL_ASSISTANT_AUTOMATION_SERVICE_ID,
    method: POLL_ASSISTANT_ENSURE_POLL_METHOD,
    scopeId: event.scopeId,
    actorIdentityId: event.actorIdentityId,
    groupWid: event.subgroupChatId,
    input: {
      groupWid: event.subgroupChatId,
      sourceIdempotencyKey: sourceKey(event.id, agreement.generation, round),
      definition
    } satisfies PollAssistantEnsurePollInput
  });
}

async function resolvePoll(
  context: PluginRuntimeContext,
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  round: AgreementRound
): Promise<PollAssistantResolvePollOutput> {
  if (!context.services || !event.actorIdentityId || !event.subgroupChatId) {
    throw new Error('Poll Assistant automation runtime is unavailable.');
  }
  return context.services.call<PollAssistantResolvePollOutput>({
    serviceId: POLL_ASSISTANT_AUTOMATION_SERVICE_ID,
    method: POLL_ASSISTANT_RESOLVE_POLL_METHOD,
    scopeId: event.scopeId,
    actorIdentityId: event.actorIdentityId,
    groupWid: event.subgroupChatId,
    input: {
      groupWid: event.subgroupChatId,
      sourceIdempotencyKey: sourceKey(event.id, agreement.generation, round)
    }
  });
}

export async function cancelEventStartTimeAgreementPolls(
  context: Pick<PluginRuntimeContext, 'services'> & { logger?: PluginRuntimeContext['logger'] | undefined },
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  reason: string
): Promise<void> {
  if (!context.services || !event.actorIdentityId || !event.subgroupChatId) {
    return;
  }
  const rounds: AgreementRound[] = ['band', 'exact', 'organizer-band', 'organizer-time'];
  await Promise.all(rounds.map(async (round) => {
    try {
      await context.services!.call<PollAssistantCancelPollOutput>({
        serviceId: POLL_ASSISTANT_AUTOMATION_SERVICE_ID,
        method: POLL_ASSISTANT_CANCEL_POLL_METHOD,
        scopeId: event.scopeId,
        actorIdentityId: event.actorIdentityId,
        groupWid: event.subgroupChatId,
        input: {
          groupWid: event.subgroupChatId,
          sourceIdempotencyKey: sourceKey(event.id, agreement.generation, round),
          cancellationIdempotencyKey: `${sourceKey(event.id, agreement.generation, round)}:cancel`,
          reason
        }
      });
    } catch (error) {
      context.logger?.warn({ error, eventId: event.id, round }, 'Unable to cancel a Community Events start-time poll');
    }
  }));
}

function availableBands(
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  now: Date
): EventStartTimeBand[] {
  return EVENT_START_TIME_BANDS.filter((band) => availableTimes(event, agreement, band, now).length > 0);
}

function availableTimes(
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  band: EventStartTimeBand,
  now: Date
): string[] {
  if (!event.localDate) {
    return [];
  }
  const date = parseLocalDate(event.localDate);
  const lifecycleEnd = Date.parse(event.lifecycleCompleteAt);
  return agreement.config.candidateTimes[band].filter((time) => {
    const instant = eventDateAndTimeToUtc(date, parseLocalTime(time), event.timezone);
    return Boolean(instant && instant.getTime() > now.getTime() && instant.getTime() < lifecycleEnd);
  });
}

function roundDeadline(event: StoredEventRecord, now: Date, windowMinutes: number): Date | undefined {
  const lifecycleEnd = Date.parse(event.lifecycleCompleteAt);
  const deadline = new Date(Math.min(now.getTime() + windowMinutes * 60_000, lifecycleEnd));
  return deadline.getTime() > now.getTime() + 5_000 ? deadline : undefined;
}

async function requireManualOrganizerTime(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  now: Date,
  t: TranslateFn
): Promise<PluginAction[]> {
  agreement.status = 'blocked';
  agreement.lastError = 'no_future_configured_candidate';
  saveClaimedEventStartTimeAgreement(db, agreement, { now, lastError: agreement.lastError });
  const actor = event.actorIdentityId
    ? await context.resolveStableIdentityById?.(event.actorIdentityId).catch(() => undefined)
    : undefined;
  return [
    ...(actor ? [{
      type: 'message.sendText' as const,
      chatId: actor.deliveryChatId,
      text: t('official.community-events.startTimeAgreement.manualRequired', { eventId: event.id }),
      idempotencyKey: `start-time-agreement:${event.id}:${agreement.generation}:manual-required`
    }] : []),
    audit('events.start_time_agreement.manual_required', { eventId: event.id })
  ];
}

async function blockAgreement(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  now: Date,
  reason: string,
  t?: TranslateFn
): Promise<PluginAction[]> {
  agreement.status = 'blocked';
  agreement.lastError = reason;
  saveClaimedEventStartTimeAgreement(db, agreement, { now, lastError: reason });
  const actor = t && event.actorIdentityId
    ? await context.resolveStableIdentityById?.(event.actorIdentityId).catch(() => undefined)
    : undefined;
  return [
    ...(actor && t ? [{
      type: 'message.sendText' as const,
      chatId: actor.deliveryChatId,
      text: t('official.community-events.startTimeAgreement.blocked', { eventId: event.id }),
      idempotencyKey: `start-time-agreement:${event.id}:${agreement.generation}:blocked`
    }] : []),
    audit('events.start_time_agreement.blocked', { eventId: event.id, reason })
  ];
}

function saveAndRetry(
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  now: Date,
  retryAt: Date,
  error?: string
): PluginAction[] {
  saveClaimedEventStartTimeAgreement(db, agreement, {
    now,
    nextRunAt: retryAt,
    ...(error ? { lastError: error } : {})
  });
  return [agreementJobAction(event, agreement, retryAt, error ? 'retry' : 'advance')];
}

function agreementJobAction(
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  runAt: Date,
  reason: string
): EnqueueAction {
  return {
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    jobName: EVENTS_JOBS.startTimeAgreement,
    scopeId: event.scopeId,
    ...(event.groupId ? { groupId: event.groupId } : {}),
    ...(event.groupWid ? { groupWid: event.groupWid } : {}),
    runAt,
    payload: { eventId: event.id },
    dedupeKey: `${EVENTS_JOBS.startTimeAgreement}:${event.id}:${agreement.generation}:${agreement.status}:${reason}:${runAt.toISOString()}`
  };
}

function agreementJobRequest(
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  runAt: Date,
  reason: string
) {
  const action = agreementJobAction(event, agreement, runAt, reason);
  const { type: _type, ...request } = action;
  return request;
}

function sourceKey(eventId: string, generation: number, round: AgreementRound): string {
  return `community-event:${eventId}:start-time:${generation}:${round}`;
}

function timeOptionId(time: string): string {
  return `time-${time.replace(':', '')}`;
}

function timeFromOptionId(optionId: string): string | undefined {
  const match = /^time-([01]\d|2[0-3])([0-5]\d)$/.exec(optionId);
  return match ? `${match[1]}:${match[2]}` : undefined;
}

function parseLocalDate(value: string): EventDateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid event local date ${value}.`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function parseLocalTime(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid event local time ${value}.`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function isEventStartTimeBand(value: string): value is EventStartTimeBand {
  return EVENT_START_TIME_BANDS.includes(value as EventStartTimeBand);
}

function localizedTime(localTime: string, locale: string): string {
  return locale.toLowerCase().startsWith('pt') ? localTime.replace(':', 'h') : localTime;
}

function payloadEventId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>).eventId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function audit(action: string, metadataJson: Record<string, unknown>): PluginAction {
  return { type: 'audit.record', action, metadataJson };
}
