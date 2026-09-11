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
import { localizeDefaultEventProfiles, parseEventsConfig, type EventProfile } from './config';
import { eventDateAndTimeToUtc, type EventDateParts } from './datetime';
import { materializeEventLifecycle } from './materialize';
import { EventConditionalTextConfigurationError } from './template';
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
  getEventWeatherDelivery,
  nextEventRevisionTimestamp,
  resolvedEventCalendarId,
  updateEventStructuredData,
  type StoredEventRecord
} from './store';
import {
  eventWeatherForecastJobActions,
  eventWeatherForecastJobRequests,
  eventWeatherForecastRecoveryJobRequest
} from './weather';

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
    if (event.spanKind === 'multi_day') {
      await cancelEventStartTimeAgreementPolls(context, event, agreement, 'multi-day events do not use start-time agreement');
      agreement.status = 'cancelled';
      agreement.cancelledAt = now.toISOString();
      saveClaimedEventStartTimeAgreement(db, agreement, { now, lastError: 'multi_day_event' });
      return [audit('events.start_time_agreement.cancelled', { eventId, reason: 'multi_day_event' })];
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
    const locale = await context.i18n.resolveIdentityLocale(event.actorIdentityId, event.scopeId);
    const t = await context.i18n.translatorForIdentity(event.actorIdentityId, event.scopeId);
    const profile = localizeDefaultEventProfiles(config.eventProfiles, t)
      .find((candidate) => candidate.id === event.profileId);
    if (!profile) {
      return blockAgreement(context, db, event, agreement, now, 'profile_removed');
    }
    if (!agreement.resolvedLocalTime) {
      const eventDayStartsAt = eventLocalDayStartsAt(event);
      if (eventDayStartsAt && now.getTime() >= eventDayStartsAt.getTime()) {
        return requireEventDayOrganizerTime(context, db, event, agreement, now, t);
      }
    }
    const weatherGate = waitForInitialWeatherForecast(db, event, profile, agreement, now);
    if (weatherGate) {
      return weatherGate;
    }
    if (agreement.status === 'pending_subgroup') {
      if (!await hasEligibleStartTimeParticipant(context, event)) {
        const retryAt = eventLocalDayStartsAt(event)
          ?? new Date(now.getTime() + SUBGROUP_RETRY_MS);
        return saveAndRetry(db, event, agreement, now, retryAt, 'waiting_for_participant');
      }
      agreement.status = 'band_pending';
    }
    return advanceAgreement(context, db, event, profile, agreement, now, locale.locale, t);
  } catch (error) {
    const event = getEvent(db, eventId);
    if (isEventConditionalTextConfigurationError(error) && event) {
      const t = event.actorIdentityId
        ? await context.i18n.translatorForIdentity(event.actorIdentityId, event.scopeId).catch(() => undefined)
        : undefined;
      const blocked = await blockAgreement(
        context,
        db,
        event,
        agreement,
        now,
        'template_configuration_invalid',
        t
      );
      return [
        ...blocked,
        audit('events.start_time_agreement.template_configuration_invalid', {
          eventId,
          field: error.field,
          code: error.code
        })
      ];
    }
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
  if (organizerOnly && !closesAt) {
    const deadline = roundDeadline(event, now, agreement.config.bandVotingWindowMinutes);
    if (!deadline) {
      return requireManualOrganizerTime(context, db, event, agreement, now, t);
    }
    closesAt = deadline.toISOString();
    agreement[closesField] = closesAt;
    return saveAndRetry(db, event, agreement, now, now);
  }
  const activationCutoffAt = organizerOnly
    ? undefined
    : roundActivationCutoff(event, now, agreement.config.bandVotingWindowMinutes);
  if (!organizerOnly && !activationCutoffAt) {
    agreement.status = 'organizer_band_pending';
    return saveAndRetry(db, event, agreement, now, now, 'participant_window_cannot_fit');
  }
  const round: AgreementRound = organizerOnly ? 'organizer-band' : 'band';
  let result: PollAssistantEnsurePollOutput;
  try {
    result = await ensurePoll(context, event, agreement, round, {
      question: t(organizerOnly
        ? 'official.community-events.startTimeAgreement.organizerBand.question'
        : 'official.community-events.startTimeAgreement.band.question'),
      options: bands.map((band, index) => ({
        id: band,
        label: t(`official.community-events.startTimeAgreement.band.${band}`),
        ordinal: index + 1
      })),
      ...(closesAt ? { closesAt } : {}),
      durationMinutes: agreement.config.bandVotingWindowMinutes,
      ...(activationCutoffAt ? { activationCutoffAt } : {}),
      organizerOnly
    });
  } catch (error) {
    if (!organizerOnly && isWorkingHoursCutoffError(error)) {
      agreement.status = 'organizer_band_pending';
      return saveAndRetry(db, event, agreement, now, now, 'participant_window_cannot_fit');
    }
    throw error;
  }
  agreement[pollField] = result.pollId;
  agreement[closesField] = result.closesAt ?? undefined;
  agreement.status = organizerOnly ? 'organizer_band_open' : 'band_open';
  const retryAt = result.closesAt
    ? new Date(Date.parse(result.closesAt) + FINALIZATION_GRACE_MS)
    : new Date(now.getTime() + AGREEMENT_RETRY_MS);
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
    if (result.kind === 'found') {
      agreement[organizerOnly ? 'organizerBandClosesAt' : 'bandClosesAt'] = result.closesAt ?? undefined;
    }
    return saveAndRetry(db, event, agreement, now, agreementPollRetryAt(result, now));
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
  if (organizerOnly && !closesAt) {
    const deadline = roundDeadline(event, now, agreement.config.exactTimeVotingWindowMinutes);
    if (!deadline) {
      return requireManualOrganizerTime(context, db, event, agreement, now, t);
    }
    closesAt = deadline.toISOString();
    agreement[closesField] = closesAt;
    return saveAndRetry(db, event, agreement, now, now);
  }
  const activationCutoffAt = organizerOnly
    ? undefined
    : roundActivationCutoff(event, now, agreement.config.exactTimeVotingWindowMinutes);
  if (!organizerOnly && !activationCutoffAt) {
    agreement.status = 'organizer_time_pending';
    return saveAndRetry(db, event, agreement, now, now, 'participant_window_cannot_fit');
  }
  const round: AgreementRound = organizerOnly ? 'organizer-time' : 'exact';
  let result: PollAssistantEnsurePollOutput;
  try {
    result = await ensurePoll(context, event, agreement, round, {
      question: t(organizerOnly
        ? 'official.community-events.startTimeAgreement.organizerTime.question'
        : 'official.community-events.startTimeAgreement.exact.question', {
          band: t(`official.community-events.startTimeAgreement.band.${agreement.winningBand}`)
        }),
      options: times.map((time, index) => ({ id: timeOptionId(time), label: time, ordinal: index + 1 })),
      ...(closesAt ? { closesAt } : {}),
      durationMinutes: agreement.config.exactTimeVotingWindowMinutes,
      ...(activationCutoffAt ? { activationCutoffAt } : {}),
      organizerOnly
    });
  } catch (error) {
    if (!organizerOnly && isWorkingHoursCutoffError(error)) {
      agreement.status = 'organizer_time_pending';
      return saveAndRetry(db, event, agreement, now, now, 'participant_window_cannot_fit');
    }
    throw error;
  }
  agreement[pollField] = result.pollId;
  agreement[closesField] = result.closesAt ?? undefined;
  agreement.status = organizerOnly ? 'organizer_time_open' : 'exact_open';
  return saveAndRetry(db, event, agreement, now, result.closesAt
    ? new Date(Date.parse(result.closesAt) + FINALIZATION_GRACE_MS)
    : new Date(now.getTime() + AGREEMENT_RETRY_MS));
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
    if (result.kind === 'found') {
      agreement[organizerOnly ? 'organizerTimeClosesAt' : 'exactClosesAt'] = result.closesAt ?? undefined;
    }
    return saveAndRetry(db, event, agreement, now, agreementPollRetryAt(result, now));
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
    poll: {
      ...profile.poll,
      options: (event.pollOptions.length > 0 ? event.pollOptions : profile.poll.options)
        .map((option) => ({ ...option }))
    },
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
    pollQuestion: event.pollQuestion ? materialized.pollQuestion : null,
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
    closesAt?: string | undefined;
    durationMinutes: number;
    activationCutoffAt?: string | undefined;
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
    closing: input.organizerOnly
      ? { kind: 'deadline', deadline: { mode: 'at', closesAt: input.closesAt! } }
      : {
          kind: 'deadline',
          deadline: {
            mode: 'after_first_non_creator_response',
            durationMinutes: input.durationMinutes,
            activationTimeoutMinutes: 120,
            ...(input.activationCutoffAt ? { activationCutoffAt: input.activationCutoffAt } : {})
          }
        },
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
      workingHoursTimezone: event.timezone,
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
  const eventDayStartsAt = eventLocalDayStartsAt(event)?.getTime() ?? lifecycleEnd;
  const deadline = new Date(Math.min(
    now.getTime() + windowMinutes * 60_000,
    lifecycleEnd,
    eventDayStartsAt
  ));
  return deadline.getTime() > now.getTime() + 5_000 ? deadline : undefined;
}

function roundActivationCutoff(
  event: StoredEventRecord,
  now: Date,
  responseWindowMinutes: number
): string | undefined {
  const lifecycleEnd = Date.parse(event.lifecycleCompleteAt);
  const eventDayStartsAt = eventLocalDayStartsAt(event)?.getTime() ?? lifecycleEnd;
  const cutoff = Math.min(lifecycleEnd, eventDayStartsAt)
    - responseWindowMinutes * 60_000
    - 5 * 60_000;
  return cutoff > now.getTime() ? new Date(cutoff).toISOString() : undefined;
}

function isWorkingHoursCutoffError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /working window starts after the lifecycle activation cutoff/i.test(message);
}

function agreementPollRetryAt(
  result: PollAssistantResolvePollOutput,
  now: Date
): Date {
  if (result.kind !== 'found' || !result.closesAt) {
    return new Date(now.getTime() + AGREEMENT_RETRY_MS);
  }
  return new Date(Math.max(
    Date.parse(result.closesAt) + FINALIZATION_GRACE_MS,
    now.getTime() + AGREEMENT_RETRY_MS
  ));
}

function waitForInitialWeatherForecast(
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  profile: EventProfile,
  agreement: StoredEventStartTimeAgreement,
  now: Date
): PluginAction[] | undefined {
  const request = eventWeatherForecastJobRequests({ event, profile, now })
    .find((candidate) => Date.parse(candidate.payload.scheduledAt) <= now.getTime());
  if (!request) {
    return undefined;
  }
  const delivery = getEventWeatherDelivery(
    db,
    event.id,
    request.payload.deliveryKind,
    request.payload.eventUpdatedAt
  );
  if (delivery?.status === 'sent' || delivery?.status === 'skipped') {
    return undefined;
  }
  const weatherRequest = delivery
    ? eventWeatherForecastRecoveryJobRequest({ event, delivery, now })
    : request;
  const weatherRunAt = weatherRequest.runAt ?? now;
  const agreementRetryAt = new Date(Math.max(
    now.getTime() + AGREEMENT_RETRY_MS,
    weatherRunAt.getTime() + 1_000
  ));
  const agreementActions = saveAndRetry(
    db,
    event,
    agreement,
    now,
    agreementRetryAt,
    'waiting_for_weather'
  );
  return [
    {
      type: 'plugin.enqueueJob',
      pluginId: EVENTS_PLUGIN_ID,
      ...weatherRequest,
      runAt: weatherRunAt,
      abortBatchOnFailure: true
    },
    ...agreementActions,
    audit('events.start_time_agreement.weather_pending', {
      eventId: event.id,
      deliveryKind: weatherRequest.payload.deliveryKind,
      weatherRunAt: weatherRunAt.toISOString()
    })
  ];
}

async function hasEligibleStartTimeParticipant(
  context: PluginRuntimeContext,
  event: StoredEventRecord
): Promise<boolean> {
  if (
    !event.subgroupChatId
    || !event.actorIdentityId
    || !context.getAuthoritativeGroupParticipantSnapshot
    || !context.resolveIdentityAddress
  ) {
    throw new Error('Authoritative event-group membership and identity reads are unavailable.');
  }
  const snapshot = await context.getAuthoritativeGroupParticipantSnapshot(event.subgroupChatId);
  if (
    snapshot.providerId !== 'whatsmeow'
    || Number.isNaN(snapshot.observedAt.getTime())
    || !snapshot.botWid.trim()
  ) {
    throw new Error('Authoritative event-group membership evidence is invalid.');
  }
  const botIdentity = await context.resolveIdentityAddress(snapshot.botWid);
  if (!botIdentity.identityId.trim()) {
    throw new Error('The event-group bot identity could not be resolved.');
  }
  const excludedIdentityIds = new Set([botIdentity.identityId, event.actorIdentityId]);
  for (const participant of snapshot.participants) {
    const wid = participant.wid.trim();
    if (!wid) {
      throw new Error('The event-group membership snapshot contained an empty participant address.');
    }
    const identity = await context.resolveIdentityAddress(wid);
    if (!identity.identityId.trim()) {
      throw new Error('An event-group participant identity could not be resolved.');
    }
    if (!excludedIdentityIds.has(identity.identityId)) {
      return true;
    }
  }
  return false;
}

function eventLocalDayStartsAt(event: StoredEventRecord): Date | undefined {
  if (!event.localDate) {
    return undefined;
  }
  return eventDateAndTimeToUtc(parseLocalDate(event.localDate), { hour: 0, minute: 0 }, event.timezone);
}

async function requireEventDayOrganizerTime(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  agreement: StoredEventStartTimeAgreement,
  now: Date,
  t: TranslateFn
): Promise<PluginAction[]> {
  await cancelEventStartTimeAgreementPolls(context, event, agreement, 'event day arrived before a time was agreed');
  agreement.status = 'blocked';
  agreement.lastError = 'event_day_arrived_without_time';
  saveClaimedEventStartTimeAgreement(db, agreement, { now, lastError: agreement.lastError });
  const actor = event.actorIdentityId
    ? await context.resolveStableIdentityById?.(event.actorIdentityId).catch(() => undefined)
    : undefined;
  return [
    ...(actor ? [{
      type: 'message.sendText' as const,
      chatId: actor.deliveryChatId,
      text: t('official.community-events.startTimeAgreement.eventDayManualRequired', { eventId: event.id }),
      idempotencyKey: `start-time-agreement:${event.id}:${agreement.generation}:event-day-manual-required`
    }] : []),
    audit('events.start_time_agreement.event_day_manual_required', { eventId: event.id })
  ];
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

function isEventConditionalTextConfigurationError(
  error: unknown
): error is EventConditionalTextConfigurationError {
  return error instanceof EventConditionalTextConfigurationError || Boolean(
    error
    && typeof error === 'object'
    && (error as { name?: unknown }).name === 'EventConditionalTextConfigurationError'
    && typeof (error as { field?: unknown }).field === 'string'
    && typeof (error as { code?: unknown }).code === 'string'
  );
}

function audit(action: string, metadataJson: Record<string, unknown>): PluginAction {
  return { type: 'audit.record', action, metadataJson };
}
