import type { TranslateFn } from './runtime';
import type { PluginServiceCallInput } from '../../../../packages/plugin-sdk/src/services';
import type { PluginAction } from '../../../../packages/plugin-sdk/src/actions';
import type { PluginRuntimeContext } from './runtime';
import type { PluginJobEvent } from './runtime';
import { enqueuePluginJob } from '../../../../packages/plugin-sdk/src/jobs';
import type {
  WeatherForecastOutput,
  WeatherMetricValue,
  WeatherQueryOutput
} from './contracts/weather/serviceApi';
import {
  WEATHER_MAX_DAY_OFFSET,
  WEATHER_QUERY_METHOD,
  WEATHER_SERVICE_ID
} from './contracts/weather/serviceApi';
import { renderMarineForecast } from './contracts/weather/marineForecast';
import { eventDateAndTimeToUtc } from './datetime';
import { eventDateTemplateTokens } from './templateDates';
import { renderEventTemplate } from './flow';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import { localizeDefaultEventProfiles, type EventProfile } from './config';
import type { StoredEventRecord } from './store';
import {
  appendEventLog,
  claimEventWeatherDelivery,
  completeEventWeatherDelivery,
  deferEventWeatherDelivery,
  eventsDatabase,
  getEvent,
  getEventWeatherDelivery,
  hasSentEventWeatherDeliveryForKind,
  prepareEventWeatherDelivery,
  skipEventWeatherDelivery,
  supersedeEventWeatherDelivery,
  type EventWeatherDeliveryScheduleKind,
  type StoredEventWeatherDelivery
} from './store';

export const EVENT_WEATHER_FORECAST_POLL_CLOSE_KIND = 'forecast.poll-close';
export const EVENT_WEATHER_FORECAST_DAILY_KIND_PREFIX = 'forecast.daily';
// Open-Meteo counts today as the first of its 16 forecast days.
export const EVENT_WEATHER_FORECAST_LEAD_DAYS = [WEATHER_MAX_DAY_OFFSET, 12, 7, 2, 1, 0] as const;

type PluginEnqueueJobAction = Extract<PluginAction, { type: 'plugin.enqueueJob' }>;
type WeatherForecastDay = WeatherForecastOutput['days'][number];

interface EventWeatherForecastSchedule {
  deliveryKind: string;
  scheduleKind: EventWeatherDeliveryScheduleKind;
  scheduledAt: Date;
}

export interface EventWeatherForecastJobRequest {
  jobName: string;
  scopeId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
  payload: {
    eventId: string;
    eventUpdatedAt: string;
    deliveryKind: string;
    scheduleKind: EventWeatherDeliveryScheduleKind;
    scheduledAt: string;
  };
  runAt?: Date | undefined;
  dedupeKey: string;
}

export function eventWeatherForecastJobRequests(input: {
  event: StoredEventRecord;
  profile: EventProfile | undefined;
  now?: Date | undefined;
}): EventWeatherForecastJobRequest[] {
  const { event, profile } = input;
  if (!profile?.weather.enabled || !event.subgroupChatId || !event.eventLocation) {
    return [];
  }
  const now = input.now ?? new Date();
  return eventWeatherForecastSchedules({ event, profile, now }).map((schedule) =>
    eventWeatherForecastJobRequestForSchedule(event, schedule, now)
  );
}

export function eventWeatherForecastJobRequest(input: {
  event: StoredEventRecord;
  profile: EventProfile | undefined;
  now?: Date | undefined;
}): EventWeatherForecastJobRequest | undefined {
  return eventWeatherForecastJobRequests(input)[0];
}

export function eventWeatherForecastRecoveryJobRequest(input: {
  event: StoredEventRecord;
  delivery: StoredEventWeatherDelivery;
  now?: Date | undefined;
}): EventWeatherForecastJobRequest {
  const now = input.now ?? new Date();
  const scheduledAt = new Date(input.delivery.scheduledAt);
  if (!Number.isFinite(scheduledAt.getTime())) {
    throw new Error(
      `Weather delivery ${input.delivery.eventId}/${input.delivery.kind} has an invalid schedule.`
    );
  }
  const retryAt = laterDate(
    scheduledAt.getTime() > now.getTime() ? scheduledAt : undefined,
    weatherDeliveryRecoveryAt(input.delivery, now)
  ) ?? now;
  const schedule = {
    deliveryKind: input.delivery.kind,
    scheduleKind: input.delivery.scheduleKind,
    scheduledAt
  } satisfies EventWeatherForecastSchedule;
  return {
    ...eventWeatherForecastJobRequestForSchedule(
      input.event,
      schedule,
      now,
      retryAt,
      input.delivery.eventUpdatedAt
    ),
    dedupeKey: eventWeatherForecastRetryDedupeKey(
      input.event.id,
      input.delivery.eventUpdatedAt,
      schedule,
      input.delivery.attempt,
      retryAt
    )
  };
}

export function eventWeatherForecastJobActions(input: {
  event: StoredEventRecord;
  profile: EventProfile | undefined;
  now?: Date | undefined;
}): PluginEnqueueJobAction[] {
  const now = input.now ?? new Date();
  return eventWeatherForecastJobRequests({ ...input, now }).map((request) => ({
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    ...request,
    runAt: request.runAt ?? now
  }));
}

export function eventWeatherForecastJobAction(input: {
  event: StoredEventRecord;
  profile: EventProfile | undefined;
  now?: Date | undefined;
}): PluginEnqueueJobAction | undefined {
  return eventWeatherForecastJobActions(input)[0];
}

export function eventWeatherForecastSchedules(input: {
  event: StoredEventRecord;
  profile: EventProfile;
  now?: Date | undefined;
}): EventWeatherForecastSchedule[] {
  const { event, profile } = input;
  const now = input.now ?? new Date();
  const schedules: EventWeatherForecastSchedule[] = [];
  const today = localDateKey(now, event.timezone);
  const initial = eventWeatherPollCloseScheduledAt(event);
  const initialDate = initial && localDateKey(initial, event.timezone);
  if (initial && initialDate && today && initialDate >= today
      && weatherForecastScheduleAllowed(event, initial, now)) {
    schedules.push({
      deliveryKind: EVENT_WEATHER_FORECAST_POLL_CLOSE_KIND,
      scheduleKind: 'poll-close',
      scheduledAt: initial
    });
  }
  for (const scheduledAt of eventWeatherCalendarForecastDates(event, profile)) {
    const date = localDateKey(scheduledAt, event.timezone);
    // An immediate creation-time forecast replaces that day's scheduled update.
    if (date && today && date >= today && date !== initialDate
        && weatherForecastScheduleAllowed(event, scheduledAt, now)) {
      schedules.push({
        deliveryKind: eventWeatherDailyForecastKind(scheduledAt, event),
        scheduleKind: 'daily',
        scheduledAt
      });
    }
  }
  return schedules.sort((left, right) => left.scheduledAt.getTime() - right.scheduledAt.getTime());
}

export function eventWeatherForecastScheduledAt(
  event: StoredEventRecord,
  profile: EventProfile
): Date | undefined {
  return eventWeatherForecastSchedules({ event, profile })[0]?.scheduledAt;
}

function eventWeatherForecastJobRequestForSchedule(
  event: StoredEventRecord,
  schedule: EventWeatherForecastSchedule,
  now: Date,
  requestedRunAt?: Date | undefined,
  expectedEventUpdatedAt: string = event.updatedAt
): EventWeatherForecastJobRequest {
  const runAt = requestedRunAt ?? schedule.scheduledAt;
  return {
    jobName: EVENTS_JOBS.weatherForecast,
    scopeId: event.scopeId,
    ...(event.groupId ? { groupId: event.groupId } : {}),
    ...(event.groupWid ? { groupWid: event.groupWid } : {}),
    ...(runAt.getTime() > now.getTime() ? { runAt } : {}),
    payload: {
      eventId: event.id,
      eventUpdatedAt: expectedEventUpdatedAt,
      deliveryKind: schedule.deliveryKind,
      scheduleKind: schedule.scheduleKind,
      scheduledAt: schedule.scheduledAt.toISOString()
    },
    dedupeKey: eventWeatherForecastDedupeKey(event.id, expectedEventUpdatedAt, schedule)
  };
}

export async function handleEventWeatherForecastJob(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  job: PluginJobEvent,
  profile: EventProfile | undefined
): Promise<PluginAction[]> {
  const eventId = jobPayloadEventId(job.payload);
  if (!eventId) {
    return [audit('events.weather_forecast.skipped', { jobName: job.jobName, reason: 'missing eventId' })];
  }
  const event = getEvent(db, eventId);
  if (!event) {
    return [audit('events.weather_forecast.skipped', { jobName: job.jobName, eventId, reason: 'event missing' })];
  }
  if (event.scopeId !== job.scopeId) {
    return [audit('events.weather_forecast.skipped', {
      jobName: job.jobName,
      eventId,
      eventScopeId: event.scopeId,
      jobScopeId: job.scopeId,
      reason: 'scope_mismatch'
    })];
  }
  const expectedEventUpdatedAt = jobPayloadEventUpdatedAt(job.payload);
  if (!expectedEventUpdatedAt) {
    return [audit('events.weather_forecast.skipped', {
      jobName: job.jobName,
      eventId,
      reason: 'missing eventUpdatedAt'
    })];
  }
  const payloadDeliveryKind = jobPayloadDeliveryKind(job.payload);
  if (!payloadDeliveryKind) {
    return [audit('events.weather_forecast.skipped', {
      jobName: job.jobName,
      eventId,
      reason: 'missing deliveryKind'
    })];
  }
  if (event.updatedAt !== expectedEventUpdatedAt) {
    supersedeEventWeatherDelivery(db, {
      eventId,
      eventUpdatedAt: expectedEventUpdatedAt,
      kind: payloadDeliveryKind,
      reason: 'event_version_changed'
    });
    return [audit('events.weather_forecast.skipped', {
      jobName: job.jobName,
      eventId,
      deliveryKind: payloadDeliveryKind,
      expectedEventUpdatedAt,
      currentEventUpdatedAt: event.updatedAt,
      reason: 'event_version_changed'
    })];
  }
  if (!profile?.weather.enabled) {
    await markWeatherSkipped(context, db, event, payloadDeliveryKind, 'profile_weather_disabled');
    return [audit('events.weather_forecast.skipped', { eventId, reason: 'profile_weather_disabled' })];
  }
  const schedule = eventWeatherForecastScheduleForJob(job.payload, event, profile);
  if (!schedule) {
    await markWeatherSkipped(context, db, event, payloadDeliveryKind, 'invalid_schedule');
    return [
      audit('events.weather_forecast.skipped', { eventId, reason: 'invalid_schedule' }),
      ...eventWeatherForecastJobActions({ event, profile })
    ];
  }
  if (hasSentEventWeatherDeliveryForKind(db, event.id, schedule.deliveryKind)) {
    await markWeatherSkipped(
      context,
      db,
      event,
      schedule.deliveryKind,
      'event_date_already_sent',
      schedule.scheduledAt,
      schedule.scheduleKind
    );
    return [
      audit('events.weather_forecast.skipped', {
        eventId,
        deliveryKind: schedule.deliveryKind,
        reason: 'event_date_already_sent'
      }),
      ...nextDailyWeatherForecastActions(event, profile, schedule, new Date())
    ];
  }

  const now = new Date();
  if (localDateKey(schedule.scheduledAt, event.timezone)! < localDateKey(now, event.timezone)!) {
    await markWeatherSkipped(context, db, event, schedule.deliveryKind, 'forecast_date_passed', schedule.scheduledAt, schedule.scheduleKind);
    return [
      audit('events.weather_forecast.skipped', { eventId, reason: 'forecast_date_passed' }),
      ...nextDailyWeatherForecastActions(event, profile, schedule, now)
    ];
  }
  const existing = getEventWeatherDelivery(
    db,
    event.id,
    schedule.deliveryKind,
    expectedEventUpdatedAt
  );
  if (existing?.status === 'sent' || existing?.status === 'skipped') {
    return [
      audit('events.weather_forecast.skipped', { eventId, deliveryKind: schedule.deliveryKind, reason: `already_${existing.status}` }),
      ...nextDailyWeatherForecastActions(event, profile, schedule, now)
    ];
  }

  const deferredUntil = laterDate(
    schedule.scheduledAt.getTime() > now.getTime() ? schedule.scheduledAt : undefined,
    existing ? weatherDeliveryRecoveryAt(existing, now) : undefined
  );
  if (deferredUntil && deferredUntil.getTime() > now.getTime()) {
    const request = existing
      ? eventWeatherForecastRecoveryJobRequest({ event, delivery: existing, now })
      : eventWeatherForecastJobRequestForSchedule(event, schedule, now, deferredUntil);
    return [
      audit('events.weather_forecast.deferred', {
        eventId,
        deliveryKind: schedule.deliveryKind,
        scheduledAt: schedule.scheduledAt.toISOString(),
        retryAt: deferredUntil.toISOString()
      }),
      {
        type: 'plugin.enqueueJob',
        pluginId: EVENTS_PLUGIN_ID,
        ...request,
        runAt: request.runAt ?? deferredUntil,
        abortBatchOnFailure: true
      }
    ];
  }

  const skipReason = weatherRuntimeSkipReason(event, schedule.scheduledAt, now);
  if (skipReason) {
    await markWeatherSkipped(context, db, event, schedule.deliveryKind, skipReason, schedule.scheduledAt, schedule.scheduleKind);
    return [audit('events.weather_forecast.skipped', { eventId, deliveryKind: schedule.deliveryKind, reason: skipReason })];
  }

  if (!event.eventLocation) {
    await markWeatherSkipped(
      context,
      db,
      event,
      schedule.deliveryKind,
      'event_location_unresolved',
      schedule.scheduledAt,
      schedule.scheduleKind
    );
    return [audit('events.weather_forecast.skipped', {
      eventId,
      deliveryKind: schedule.deliveryKind,
      reason: 'event_location_unresolved'
    })];
  }

  let prepared: StoredEventWeatherDelivery;
  try {
    prepared = hasCompleteWeatherDeliveryIntent(existing)
      ? existing
      : await prepareWeatherDeliveryIntent(context, db, event, profile, schedule, now);
  } catch (error) {
    const fenceReason = error instanceof WeatherDeliveryFenceError
      ? error.reason
      : weatherEventSnapshotFenceReason(db, event, schedule);
    if (fenceReason) {
      await terminateFencedWeatherSnapshot(
        context,
        db,
        event,
        schedule,
        fenceReason
      );
      return [audit('events.weather_forecast.skipped', {
        eventId: event.id,
        deliveryKind: schedule.deliveryKind,
        reason: fenceReason
      })];
    }
    const reason = error instanceof Error ? error.message : String(error);
    await deferWeatherDeliveryAfterFailure(context, db, event, schedule, reason);
    return [audit('events.weather_forecast.failed', {
      eventId: event.id,
      deliveryKind: schedule.deliveryKind,
      reason
    })];
  }
  if (prepared.status === 'skipped' || prepared.status === 'sent') {
    return [audit('events.weather_forecast.skipped', {
      eventId,
      deliveryKind: schedule.deliveryKind,
      reason: prepared.status === 'skipped' && prepared.error
        ? prepared.error
        : `already_${prepared.status}`
    })];
  }
  return deliverPreparedWeatherForecast(context, db, event, profile, schedule, prepared, now);
}

async function prepareWeatherDeliveryIntent(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  profile: EventProfile,
  schedule: EventWeatherForecastSchedule,
  now: Date
): Promise<StoredEventWeatherDelivery> {
  if (!context.services) {
    throw new Error('plugin_services_unavailable');
  }
  const result = await context.services.call<WeatherQueryOutput>(weatherForecastServiceInput(event, now));
  if (result.kind !== 'forecast') {
    throw new Error('weather query returned current conditions for a forecast request');
  }
  const postQueryFenceReason = weatherEventSnapshotFenceReason(db, event, schedule);
  if (postQueryFenceReason) {
    throw new WeatherDeliveryFenceError(postQueryFenceReason);
  }
  const report = result.report;
  const forecastDays = selectEventWeatherForecastDays(report, event, now);
  if (forecastDays.length === 0) {
    throw new Error('event_day_forecast_unavailable');
  }
  const t = await context.i18n.translatorForScope(event.scopeId);
  const resolvedLocale = await context.i18n.resolveScopeLocale(event.scopeId);
  const localizedProfile = localizeDefaultEventProfiles([profile], t)[0] ?? profile;
  const messages = renderEventWeatherForecastDays({
    event,
    profile: localizedProfile,
    report,
    forecastDays,
    t,
    locale: resolvedLocale.locale
  });
  if (!messages.meteorologicalText.trim() && !messages.marineText?.trim()) {
    await markWeatherSkipped(
      context,
      db,
      event,
      schedule.deliveryKind,
      'empty_rendered_text',
      schedule.scheduledAt,
      schedule.scheduleKind
    );
    const skipped = getEventWeatherDelivery(
      db,
      event.id,
      schedule.deliveryKind,
      event.updatedAt
    );
    if (!skipped) {
      throw new Error(`Could not persist skipped weather delivery ${event.id}/${schedule.deliveryKind}.`);
    }
    return skipped;
  }
  const prepared = prepareEventWeatherDelivery(db, {
    eventId: event.id,
    eventUpdatedAt: event.updatedAt,
    kind: schedule.deliveryKind,
    scheduleKind: schedule.scheduleKind,
    scheduledAt: schedule.scheduledAt.toISOString(),
    chatId: event.subgroupChatId!,
    ...(messages.meteorologicalText.trim()
      ? {
          meteorologicalText: messages.meteorologicalText,
          meteorologicalIdempotencyKey: eventWeatherTransportIdempotencyKey(
            event.id,
            event.updatedAt,
            schedule.deliveryKind,
            'meteorological'
          )
        }
      : {}),
    ...(messages.marineText?.trim()
      ? {
          marineText: messages.marineText,
          marineIdempotencyKey: eventWeatherTransportIdempotencyKey(
            event.id,
            event.updatedAt,
            schedule.deliveryKind,
            'marine'
          )
        }
      : {})
  });
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.weather_forecast.delivery_prepared',
    metadata: {
      deliveryKind: schedule.deliveryKind,
      scheduleKind: schedule.scheduleKind,
      scheduledAt: schedule.scheduledAt.toISOString(),
      subgroupChatId: event.subgroupChatId,
      provider: report.provider,
      fetchedAt: report.fetchedAt,
      forecastDates: forecastDays.map((day) => day.date),
      location: report.location
    }
  });
  await appendWeatherJsonLog(context, {
    action: 'event.weather_forecast_delivery_prepared',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: event.actorWid,
    profileId: event.profileId,
    ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
    ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
    metadata: {
      deliveryKind: schedule.deliveryKind,
      scheduleKind: schedule.scheduleKind,
      scheduledAt: schedule.scheduledAt.toISOString(),
      forecastDates: forecastDays.map((day) => day.date),
      location: report.location
    }
  });
  return prepared;
}

async function deliverPreparedWeatherForecast(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  profile: EventProfile,
  schedule: EventWeatherForecastSchedule,
  prepared: StoredEventWeatherDelivery,
  now: Date
): Promise<PluginAction[]> {
  const claim = claimEventWeatherDelivery(db, {
    eventId: event.id,
    eventUpdatedAt: prepared.eventUpdatedAt,
    kind: schedule.deliveryKind,
    claimedAt: new Date().toISOString()
  });
  if (!claim) {
    const current = getEventWeatherDelivery(
      db,
      event.id,
      schedule.deliveryKind,
      prepared.eventUpdatedAt
    ) ?? prepared;
    const fenceReason = weatherDeliveryFenceReason(db, event, current, schedule);
    if (fenceReason) {
      return terminateFencedWeatherDelivery(db, event, current, fenceReason);
    }
    if (current.status === 'sent' || current.status === 'skipped') {
      return [
        audit('events.weather_forecast.skipped', {
          eventId: event.id,
          deliveryKind: schedule.deliveryKind,
          reason: `already_${current.status}`
        }),
        ...nextDailyWeatherForecastActions(event, profile, schedule, now)
      ];
    }
    const retryAt = weatherDeliveryRecoveryAt(current, now);
    const request = eventWeatherForecastRecoveryJobRequest({ event, delivery: current, now });
    return [
      audit('events.weather_forecast.deferred', {
        eventId: event.id,
        deliveryKind: schedule.deliveryKind,
        retryAt: retryAt.toISOString(),
        reason: 'delivery_claim_unavailable'
      }),
      {
        type: 'plugin.enqueueJob',
        pluginId: EVENTS_PLUGIN_ID,
        ...request,
        runAt: request.runAt ?? retryAt,
        abortBatchOnFailure: true
      }
    ];
  }

  try {
    if (!context.sendText) {
      throw new Error('Plugin runtime does not expose durable text delivery.');
    }
    let fenceReason = weatherDeliveryFenceReason(
      db,
      event,
      claim.delivery,
      schedule
    );
    if (fenceReason) {
      return terminateFencedWeatherDelivery(db, event, claim.delivery, fenceReason);
    }
    const meteorologicalMessageId = claim.delivery.meteorologicalText
      ? requireWeatherMessageId(await context.sendText(
          claim.delivery.chatId!,
          claim.delivery.meteorologicalText,
          { idempotencyKey: claim.delivery.meteorologicalIdempotencyKey! }
        ), 'meteorological')
      : undefined;
    fenceReason = weatherDeliveryFenceReason(db, event, claim.delivery, schedule);
    if (fenceReason) {
      return terminateFencedWeatherDelivery(db, event, claim.delivery, fenceReason);
    }
    const marineMessageId = claim.delivery.marineText
      ? requireWeatherMessageId(await context.sendText(
          claim.delivery.chatId!,
          claim.delivery.marineText,
          { idempotencyKey: claim.delivery.marineIdempotencyKey! }
        ), 'marine')
      : undefined;
    fenceReason = weatherDeliveryFenceReason(db, event, claim.delivery, schedule);
    if (fenceReason) {
      return terminateFencedWeatherDelivery(db, event, claim.delivery, fenceReason);
    }
    const sentAt = new Date().toISOString();
    if (!completeEventWeatherDelivery(db, {
      eventId: event.id,
      eventUpdatedAt: claim.delivery.eventUpdatedAt,
      kind: schedule.deliveryKind,
      claimId: claim.claimId,
      ...(meteorologicalMessageId ? { meteorologicalMessageId } : {}),
      ...(marineMessageId ? { marineMessageId } : {}),
      completedAt: sentAt
    })) {
      fenceReason = weatherDeliveryFenceReason(db, event, claim.delivery, schedule);
      if (fenceReason) {
        return terminateFencedWeatherDelivery(db, event, claim.delivery, fenceReason);
      }
      throw new Error(`Weather delivery ${event.id}/${schedule.deliveryKind} lost its send claim.`);
    }
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.weather_forecast.sent',
      metadata: {
        deliveryKind: schedule.deliveryKind,
        scheduleKind: schedule.scheduleKind,
        scheduledAt: schedule.scheduledAt.toISOString(),
        subgroupChatId: claim.delivery.chatId,
        meteorologicalMessageId,
        marineMessageId
      }
    });
    await appendWeatherJsonLog(context, {
      action: 'event.weather_forecast_sent',
      scopeId: event.scopeId,
      eventId: event.id,
      actorWid: event.actorWid,
      profileId: event.profileId,
      ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
      ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
      metadata: {
        deliveryKind: schedule.deliveryKind,
        scheduleKind: schedule.scheduleKind,
        scheduledAt: schedule.scheduledAt.toISOString(),
        meteorologicalMessageId,
        marineMessageId
      }
    });
    return [
      audit('events.weather_forecast.sent', {
        eventId: event.id,
        deliveryKind: schedule.deliveryKind,
        scheduledAt: schedule.scheduledAt.toISOString()
      }),
      ...nextDailyWeatherForecastActions(event, profile, schedule, now)
    ];
  } catch (error) {
    const fenceReason = weatherDeliveryFenceReason(db, event, claim.delivery, schedule);
    if (fenceReason) {
      return terminateFencedWeatherDelivery(db, event, claim.delivery, fenceReason);
    }
    const reason = error instanceof Error ? error.message : String(error);
    await deferWeatherDeliveryAfterFailure(context, db, event, schedule, reason, claim.claimId);
    return [audit('events.weather_forecast.failed', {
      eventId: event.id,
      deliveryKind: schedule.deliveryKind,
      reason
    })];
  }
}

function weatherDeliveryFenceReason(
  db: ReturnType<typeof eventsDatabase>,
  expectedEvent: StoredEventRecord,
  delivery: StoredEventWeatherDelivery,
  schedule: EventWeatherForecastSchedule
): string | undefined {
  const currentEvent = getEvent(db, expectedEvent.id);
  if (!currentEvent) {
    return 'event_missing';
  }
  if (currentEvent.scopeId !== expectedEvent.scopeId) {
    return 'event_scope_changed';
  }
  if (currentEvent.updatedAt !== delivery.eventUpdatedAt) {
    return 'event_version_changed';
  }
  if (currentEvent.subgroupChatId !== delivery.chatId) {
    return 'event_subgroup_changed';
  }
  return weatherRuntimeSkipReason(currentEvent, schedule.scheduledAt, new Date());
}

function weatherEventSnapshotFenceReason(
  db: ReturnType<typeof eventsDatabase>,
  expectedEvent: StoredEventRecord,
  schedule: EventWeatherForecastSchedule
): string | undefined {
  const currentEvent = getEvent(db, expectedEvent.id);
  if (!currentEvent) {
    return 'event_missing';
  }
  if (currentEvent.scopeId !== expectedEvent.scopeId) {
    return 'event_scope_changed';
  }
  if (currentEvent.updatedAt !== expectedEvent.updatedAt) {
    return 'event_version_changed';
  }
  if (currentEvent.subgroupChatId !== expectedEvent.subgroupChatId) {
    return 'event_subgroup_changed';
  }
  return weatherRuntimeSkipReason(currentEvent, schedule.scheduledAt, new Date());
}

async function terminateFencedWeatherSnapshot(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  schedule: EventWeatherForecastSchedule,
  reason: string
): Promise<void> {
  const currentEvent = getEvent(db, event.id);
  if (
    currentEvent &&
    currentEvent.scopeId === event.scopeId &&
    currentEvent.updatedAt === event.updatedAt
  ) {
    await markWeatherSkipped(
      context,
      db,
      currentEvent,
      schedule.deliveryKind,
      reason,
      schedule.scheduledAt,
      schedule.scheduleKind
    );
    return;
  }
  supersedeEventWeatherDelivery(db, {
    eventId: event.id,
    eventUpdatedAt: event.updatedAt,
    kind: schedule.deliveryKind,
    reason
  });
}

class WeatherDeliveryFenceError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'WeatherDeliveryFenceError';
  }
}

function terminateFencedWeatherDelivery(
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  delivery: StoredEventWeatherDelivery,
  reason: string
): PluginAction[] {
  supersedeEventWeatherDelivery(db, {
    eventId: event.id,
    eventUpdatedAt: delivery.eventUpdatedAt,
    kind: delivery.kind,
    reason
  });
  return [audit('events.weather_forecast.skipped', {
    eventId: event.id,
    deliveryKind: delivery.kind,
    eventUpdatedAt: delivery.eventUpdatedAt,
    reason
  })];
}

export function renderEventWeatherForecastDays(input: {
  event: StoredEventRecord;
  profile: EventProfile;
  report: WeatherForecastOutput;
  forecastDays: WeatherForecastDay[];
  t: TranslateFn;
  locale: string;
}): { meteorologicalText: string; marineText?: string | undefined } {
  const rendered = input.forecastDays.map((forecastDay) => renderEventWeatherForecast({
    ...input,
    forecastDay
  }));
  const marineText = rendered.map((day) => day.marineText).filter(Boolean).join('\n\n');
  return {
    meteorologicalText: rendered.map((day) => day.meteorologicalText).filter(Boolean).join('\n\n'),
    ...(marineText ? { marineText } : {})
  };
}

export function eventWeatherForecastRecoverySkipReason(input: {
  event: StoredEventRecord;
  profile: EventProfile | undefined;
  delivery: StoredEventWeatherDelivery;
  now: Date;
}): string | undefined {
  if (!input.profile?.weather.enabled) return 'profile_weather_disabled';
  const schedule = eventWeatherForecastScheduleForJob({
    deliveryKind: input.delivery.kind,
    scheduleKind: input.delivery.scheduleKind,
    scheduledAt: input.delivery.scheduledAt
  }, input.event, input.profile);
  if (!schedule) return 'forecast_schedule_changed';
  return weatherRuntimeSkipReason(input.event, schedule.scheduledAt, input.now);
}

export function renderEventWeatherForecast(input: {
  event: StoredEventRecord;
  profile: EventProfile;
  report: WeatherForecastOutput;
  forecastDay: WeatherForecastDay;
  t: TranslateFn;
  locale: string;
}): {
  meteorologicalText: string;
  marineText?: string | undefined;
} {
  const summary = weatherSummary(input.forecastDay, input.t, input.locale);
  const forecastDate = parseLocalDate(input.forecastDay.date);
  const forecastNoon = forecastDate && eventDateAndTimeToUtc(forecastDate, { hour: 12, minute: 0 }, input.event.timezone);
  const forecastDateTokens = forecastNoon ? eventDateTemplateTokens(forecastNoon, input.event.timezone, input.locale) : {};
  const meteorologicalText = renderEventTemplate({
    template: input.profile.weather.template,
    profile: input.profile,
    answers: input.event.answers,
    startsAt: new Date(input.event.startsAtUtc || input.event.startsAt),
    endsAt: new Date(input.event.endsAt),
    spanKind: input.event.spanKind,
    timezone: input.event.timezone,
    locale: input.locale,
    creatorDisplayName: input.event.actorLabel || input.event.actorWid,
    extraTokens: {
      // Existing weather templates use these date tokens instead of weatherDate.
      ...Object.fromEntries(['weekday', 'dd', 'mm', 'yy', 'yyyy'].map((key) => [key, forecastDateTokens[key]])),
      eventId: input.event.id,
      groupDisplayName: input.event.subgroupTitle || input.event.groupTitle,
      subgroupChatId: input.event.subgroupChatId,
      weatherDate: input.forecastDay.date,
      weatherLocation: input.report.location.label,
      weatherSummary: summary,
      temperatureMax: formatMetric(input.forecastDay.temperatureMax, input.locale),
      temperatureMin: formatMetric(input.forecastDay.temperatureMin, input.locale),
      precipitation: formatMetric(input.forecastDay.precipitationSum, input.locale),
      precipitationProbability: formatMetric(input.forecastDay.precipitationProbabilityMax, input.locale),
      windSpeed: formatMetric(input.forecastDay.windSpeedMax, input.locale),
      windGust: formatMetric(input.forecastDay.windGustsMax, input.locale),
      windDirection: formatMetric(input.forecastDay.windDirectionDominant, input.locale),
      weatherCode: input.forecastDay.weatherCode !== undefined ? String(input.forecastDay.weatherCode) : undefined
    }
  }).trim();
  const marineText = renderMarineForecast({
    ...input.report,
    location: {
      ...input.report.location,
      label: input.event.eventLocation?.displayLabel ?? input.report.location.label
    },
    days: [input.forecastDay]
  }, input.t, input.locale);
  return {
    meteorologicalText,
    ...(marineText ? { marineText } : {})
  };
}

function weatherForecastServiceInput(event: StoredEventRecord, now: Date): PluginServiceCallInput {
  if (!event.eventLocation) {
    throw new Error('event location is unresolved');
  }
  return {
    serviceId: WEATHER_SERVICE_ID,
    method: WEATHER_QUERY_METHOD,
    scopeId: event.scopeId,
    actorIdentityId: requireWeatherEventActorIdentityId(event),
    ...(event.groupId ? { groupId: event.groupId } : {}),
    ...(event.groupWid ? { groupWid: event.groupWid } : {}),
    input: {
      selection: eventWeatherForecastDaySelection(event, now),
      includeMarine: true,
      location: {
        label: event.eventLocation.displayLabel,
        latitude: event.eventLocation.latitude,
        longitude: event.eventLocation.longitude,
        timezone: event.timezone
      }
    }
  };
}

function requireWeatherEventActorIdentityId(event: StoredEventRecord): string {
  const actorIdentityId = event.actorIdentityId?.trim();
  if (!actorIdentityId) {
    throw new Error(`Event ${event.id} has no authoritative creator identity for weather delivery.`);
  }
  return actorIdentityId;
}

export function selectEventWeatherForecastDays(
  report: WeatherForecastOutput,
  event: StoredEventRecord,
  now: Date
): WeatherForecastDay[] {
  const occupied = eventOccupiedLocalDateRange(event);
  const today = localDateKey(now, event.timezone);
  if (!occupied || !today) return [];
  const start = datePartsKey(occupied.start) > today ? datePartsKey(occupied.start) : today;
  const end = datePartsKey(occupied.end);
  return report.days.filter((day) => day.date >= start && day.date <= end)
    .sort((left, right) => left.date.localeCompare(right.date));
}

function weatherSummary(day: WeatherForecastDay, t: TranslateFn, locale: string): string {
  const sections = [
    weatherMetricSection(t, 'official.community-events.weather.section.temperature', [
      labeledMetric(t, locale, 'official.community-events.weather.metric.temperatureMax', day.temperatureMax),
      labeledMetric(t, locale, 'official.community-events.weather.metric.temperatureMin', day.temperatureMin)
    ]),
    weatherMetricSection(t, 'official.community-events.weather.section.relativeHumidity', [
      labeledMetric(t, locale, 'official.community-events.weather.metric.relativeHumidityMax', day.relativeHumidityMax),
      labeledMetric(t, locale, 'official.community-events.weather.metric.relativeHumidityMin', day.relativeHumidityMin),
      labeledMetric(t, locale, 'official.community-events.weather.metric.relativeHumidityMean', day.relativeHumidityMean)
    ]),
    weatherMetricSection(t, 'official.community-events.weather.section.precipitation', [
      formatMetric(day.precipitationSum, locale),
      labeledMetric(
        t,
        locale,
        'official.community-events.weather.metric.precipitationProbability',
        day.precipitationProbabilityMax
      )
    ]),
    weatherMetricSection(t, 'official.community-events.weather.section.wind', [
      labeledMetric(t, locale, 'official.community-events.weather.metric.windSpeed', day.windSpeedMax),
      labeledMetric(t, locale, 'official.community-events.weather.metric.windGust', day.windGustsMax),
      labeledMetric(t, locale, 'official.community-events.weather.metric.windDirection', day.windDirectionDominant)
    ])
  ].filter((value): value is string => Boolean(value));
  return sections.join('\n') || t('official.community-events.weather.none');
}

function weatherMetricSection(t: TranslateFn, key: string, metrics: Array<string | undefined>): string | undefined {
  const values = metrics.filter((value): value is string => Boolean(value));
  return values.length > 0 ? `*${t(key)}*: ${values.join(', ')}` : undefined;
}

function labeledMetric(
  t: TranslateFn,
  locale: string,
  key: string,
  metric?: WeatherMetricValue | undefined
): string | undefined {
  const formatted = formatMetric(metric, locale);
  return formatted ? `${t(key)}: ${formatted}` : undefined;
}

function formatMetric(metric?: WeatherMetricValue | undefined, locale?: string | undefined): string | undefined {
  if (!metric) {
    return undefined;
  }
  const value = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(metric.value);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

export function eventWeatherForecastScheduleForJob(
  payload: unknown,
  event: StoredEventRecord,
  profile: EventProfile
): EventWeatherForecastSchedule | undefined {
  const deliveryKind = jobPayloadDeliveryKind(payload);
  const scheduleKind = jobPayloadScheduleKind(payload);
  const payloadScheduledAt = jobPayloadScheduledAt(payload);
  if (!deliveryKind || !scheduleKind || !payloadScheduledAt) {
    return undefined;
  }
  if (scheduleKind === 'poll-close') {
    if (deliveryKind !== EVENT_WEATHER_FORECAST_POLL_CLOSE_KIND) {
      return undefined;
    }
    const scheduledAt = eventWeatherPollCloseScheduledAt(event);
    return scheduledAt ? { deliveryKind, scheduleKind, scheduledAt } : undefined;
  }
  const initial = eventWeatherPollCloseScheduledAt(event);
  const initialDate = initial && localDateKey(initial, event.timezone);
  const scheduledAt = eventWeatherCalendarForecastDates(event, profile).find((candidate) =>
    eventWeatherDailyForecastKind(candidate, event) === deliveryKind
    && localDateKey(candidate, event.timezone) !== initialDate
  );
  return scheduledAt ? { deliveryKind, scheduleKind, scheduledAt } : undefined;
}

function nextDailyWeatherForecastActions(
  event: StoredEventRecord,
  profile: EventProfile,
  completedSchedule: EventWeatherForecastSchedule,
  now: Date
): PluginEnqueueJobAction[] {
  return eventWeatherForecastJobActions({ event, profile, now }).filter((action) =>
    jobPayloadDeliveryKind(action.payload) !== completedSchedule.deliveryKind
    && (action.runAt ?? now).getTime() > completedSchedule.scheduledAt.getTime()
  );
}

function eventWeatherPollCloseScheduledAt(event: StoredEventRecord): Date | undefined {
  const scheduledAt = new Date(event.closedAt ?? event.closeAt);
  const occupied = eventOccupiedLocalDateRange(event);
  const date = parseLocalDate(localDateKey(scheduledAt, event.timezone));
  if (!occupied || !date || datePartsKey(date) > datePartsKey(occupied.end)) return undefined;
  return dateDiffDays(date, occupied.start) <= WEATHER_MAX_DAY_OFFSET ? scheduledAt : undefined;
}

function eventWeatherCalendarForecastDates(
  event: StoredEventRecord,
  profile: EventProfile
): Date[] {
  const occupied = eventOccupiedLocalDateRange(event);
  const time = parseLocalTime(profile.weather.sendAtLocalTime);
  if (!occupied || !time) return [];
  const dates = EVENT_WEATHER_FORECAST_LEAD_DAYS.map((lead) => addLocalDays(occupied.start, -lead));
  for (let day = addLocalDays(occupied.start, 1); datePartsKey(day) <= datePartsKey(occupied.end); day = addLocalDays(day, 1)) {
    dates.push(day);
  }
  const endsAt = eventWeatherEndsAt(event);
  return dates.flatMap((date) => {
    let scheduledAt = eventDateAndTimeToUtc(date, time, event.timezone);
    // Early events still get an event-day forecast before they end.
    if (scheduledAt && scheduledAt.getTime() >= endsAt.getTime()) {
      scheduledAt = eventDateAndTimeToUtc(date, { hour: 0, minute: 0 }, event.timezone);
    }
    return scheduledAt ? [scheduledAt] : [];
  });
}

function eventWeatherEndsAt(event: StoredEventRecord): Date {
  return new Date(!event.localTime && event.spanKind === 'day_trip' ? event.lifecycleCompleteAt : event.endsAt);
}

function eventOccupiedLocalDateRange(event: StoredEventRecord): {
  start: { year: number; month: number; day: number };
  end: { year: number; month: number; day: number };
} | undefined {
  const start = parseLocalDate(event.localDate ?? localDateKey(new Date(event.startsAtUtc || event.startsAt), event.timezone));
  let end = parseLocalDate(localDateKey(new Date(event.endsAt), event.timezone));
  if (!start || !end) {
    return undefined;
  }
  const endLocalTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: event.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(event.endsAt));
  if (endLocalTime === '00:00' && datePartsKey(end) > datePartsKey(start)) {
    end = addLocalDays(end, -1);
  }
  return { start, end };
}

function weatherForecastScheduleAllowed(event: StoredEventRecord, scheduledAt: Date, now: Date): boolean {
  const endsAt = eventWeatherEndsAt(event);
  if (Number.isFinite(endsAt.getTime()) && endsAt.getTime() <= now.getTime()) {
    return false;
  }
  if (Number.isFinite(endsAt.getTime()) && scheduledAt.getTime() >= endsAt.getTime()) {
    return false;
  }
  const cleanupAt = new Date(event.cleanupAt);
  if (Number.isFinite(cleanupAt.getTime()) && cleanupAt.getTime() <= now.getTime()) {
    return false;
  }
  if (Number.isFinite(cleanupAt.getTime()) && scheduledAt.getTime() >= cleanupAt.getTime()) {
    return false;
  }
  return true;
}

function eventWeatherDailyForecastKind(scheduledAt: Date, event: StoredEventRecord): string {
  const dateKey = localDateKey(scheduledAt, event.timezone) ?? scheduledAt.toISOString().slice(0, 10);
  return `${EVENT_WEATHER_FORECAST_DAILY_KIND_PREFIX}.${dateKey}`;
}

export function eventWeatherForecastDaySelection(event: StoredEventRecord, now: Date): {
  startDay: number; endDay: number;
} {
  const occupied = eventOccupiedLocalDateRange(event);
  const today = parseLocalDate(localDateKey(now, event.timezone));
  if (!occupied || !today) throw new Error('invalid_event_forecast_dates');
  const startDay = Math.max(0, dateDiffDays(today, occupied.start));
  const endDay = Math.min(WEATHER_MAX_DAY_OFFSET, dateDiffDays(today, occupied.end));
  if (startDay > endDay) throw new Error('event_outside_forecast_window');
  return { startDay, endDay };
}

function weatherRuntimeSkipReason(event: StoredEventRecord, scheduledAt: Date, now: Date): string | undefined {
  if (event.eventStatus !== 'active') {
    return `event_status_${event.eventStatus}`;
  }
  if (event.groupLifecycleStatus !== 'poll_closed' && event.groupLifecycleStatus !== 'cleanup_failed') {
    return `group_lifecycle_${event.groupLifecycleStatus}`;
  }
  if (!event.subgroupChatId) {
    return 'no_event_group';
  }
  if (localDateKey(scheduledAt, event.timezone)! < localDateKey(now, event.timezone)!) {
    return 'forecast_date_passed';
  }
  const endsAt = eventWeatherEndsAt(event);
  if (Number.isFinite(endsAt.getTime()) && endsAt.getTime() <= now.getTime()) {
    return 'event_ended';
  }
  if (Number.isFinite(endsAt.getTime()) && scheduledAt.getTime() >= endsAt.getTime()) {
    return 'scheduled_after_event_end';
  }
  const cleanupAt = new Date(event.cleanupAt);
  if (Number.isFinite(cleanupAt.getTime()) && cleanupAt.getTime() <= now.getTime()) {
    return 'cleanup_due_or_past';
  }
  if (Number.isFinite(cleanupAt.getTime()) && scheduledAt.getTime() >= cleanupAt.getTime()) {
    return 'scheduled_after_cleanup';
  }
  return undefined;
}

function hasCompleteWeatherDeliveryIntent(
  delivery: StoredEventWeatherDelivery | undefined
): delivery is StoredEventWeatherDelivery {
  return Boolean(
    delivery &&
    (delivery.status === 'pending' || delivery.status === 'sending') &&
    delivery.chatId &&
    (delivery.meteorologicalText || delivery.marineText) &&
    (!delivery.meteorologicalText || delivery.meteorologicalIdempotencyKey) &&
    (!delivery.marineText || delivery.marineIdempotencyKey)
  );
}

function eventWeatherTransportIdempotencyKey(
  eventId: string,
  eventUpdatedAt: string,
  deliveryKind: string,
  part: 'meteorological' | 'marine'
): string {
  return `community-events:weather:${eventId}:${eventUpdatedAt}:${deliveryKind}:${part}`;
}

function requireWeatherMessageId(
  result: { messageId?: string | undefined },
  part: 'meteorological' | 'marine'
): string {
  const messageId = result.messageId?.trim();
  if (!messageId) {
    throw new Error(`${part} weather transport send returned no WhatsApp message id.`);
  }
  return messageId;
}

function weatherDeliveryRecoveryAt(delivery: StoredEventWeatherDelivery, now: Date): Date {
  const persisted = delivery.status === 'sending'
    ? delivery.leaseExpiresAt
    : delivery.nextRunAt;
  const candidate = persisted ? new Date(persisted) : now;
  return Number.isFinite(candidate.getTime()) && candidate.getTime() > now.getTime()
    ? candidate
    : now;
}

function laterDate(left: Date | undefined, right: Date | undefined): Date | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.getTime() >= right.getTime() ? left : right;
}

function weatherDeliveryRetryDelayMs(attempt: number): number {
  return Math.min(30 * 60_000, 60_000 * (2 ** Math.min(Math.max(0, attempt), 4)));
}

async function deferWeatherDeliveryAfterFailure(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  schedule: EventWeatherForecastSchedule,
  reason: string,
  claimId?: string | undefined
): Promise<void> {
  const now = new Date();
  const fenceReason = weatherEventSnapshotFenceReason(db, event, schedule);
  if (fenceReason) {
    supersedeEventWeatherDelivery(db, {
      eventId: event.id,
      eventUpdatedAt: event.updatedAt,
      kind: schedule.deliveryKind,
      reason: fenceReason,
      supersededAt: now.toISOString()
    });
    return;
  }
  const existing = getEventWeatherDelivery(
    db,
    event.id,
    schedule.deliveryKind,
    event.updatedAt
  );
  const nextRunAt = new Date(now.getTime() + weatherDeliveryRetryDelayMs(existing?.attempt ?? 0));
  const pending = deferEventWeatherDelivery(db, {
    eventId: event.id,
    eventUpdatedAt: event.updatedAt,
    kind: schedule.deliveryKind,
    scheduleKind: schedule.scheduleKind,
    scheduledAt: schedule.scheduledAt.toISOString(),
    nextRunAt: nextRunAt.toISOString(),
    reason,
    ...(claimId ? { claimId } : {}),
    updatedAt: now.toISOString()
  });
  if (!pending || pending.status === 'sent' || pending.status === 'skipped') {
    return;
  }
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.weather_forecast.retry_pending',
    metadata: {
      deliveryKind: schedule.deliveryKind,
      scheduleKind: schedule.scheduleKind,
      scheduledAt: schedule.scheduledAt.toISOString(),
      attempt: pending.attempt,
      nextRunAt: pending.nextRunAt,
      reason
    }
  });
  await appendWeatherJsonLog(context, {
    action: 'event.weather_forecast_retry_pending',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: event.actorWid,
    profileId: event.profileId,
    ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
    ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
    metadata: {
      deliveryKind: schedule.deliveryKind,
      scheduleKind: schedule.scheduleKind,
      scheduledAt: schedule.scheduledAt.toISOString(),
      attempt: pending.attempt,
      nextRunAt: pending.nextRunAt,
      reason
    }
  });
  try {
    await enqueuePluginJob(context, {
      pluginId: EVENTS_PLUGIN_ID,
      jobName: EVENTS_JOBS.weatherForecast,
      scopeId: event.scopeId,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(event.groupWid ? { groupWid: event.groupWid } : {}),
      runAt: nextRunAt,
      payload: {
        eventId: event.id,
        eventUpdatedAt: event.updatedAt,
        deliveryKind: schedule.deliveryKind,
        scheduleKind: schedule.scheduleKind,
        scheduledAt: schedule.scheduledAt.toISOString()
      },
      dedupeKey: eventWeatherForecastRetryDedupeKey(
        event.id,
        event.updatedAt,
        schedule,
        pending.attempt,
        nextRunAt
      )
    });
  } catch (error) {
    context.logger.error({
      error,
      eventId: event.id,
      deliveryKind: schedule.deliveryKind,
      nextRunAt: nextRunAt.toISOString()
    }, 'Unable to enqueue pending event weather delivery retry');
    throw error;
  }
}

async function markWeatherSkipped(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  deliveryKind: string,
  reason: string,
  scheduledAt?: Date | undefined,
  scheduleKind?: EventWeatherDeliveryScheduleKind | undefined
): Promise<void> {
  const at = new Date().toISOString();
  skipEventWeatherDelivery(db, {
    eventId: event.id,
    eventUpdatedAt: event.updatedAt,
    kind: deliveryKind,
    scheduleKind: scheduleKind ?? weatherDeliveryScheduleKind(deliveryKind),
    scheduledAt: scheduledAt?.toISOString() ?? at,
    skippedAt: at,
    reason
  });
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.weather_forecast.skipped',
    metadata: { deliveryKind, reason, scheduledAt: scheduledAt?.toISOString() }
  });
  await appendWeatherJsonLog(context, {
    action: 'event.weather_forecast_skipped',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: event.actorWid,
    profileId: event.profileId,
    ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
    ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
    metadata: { deliveryKind, reason, scheduledAt: scheduledAt?.toISOString() }
  });
}

function weatherDeliveryScheduleKind(deliveryKind: string): EventWeatherDeliveryScheduleKind {
  return deliveryKind.startsWith(`${EVENT_WEATHER_FORECAST_DAILY_KIND_PREFIX}.`)
    ? 'daily'
    : 'poll-close';
}

function parseLocalDate(value: string | undefined): { year: number; month: number; day: number } | undefined {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day)
  };
}

function parseLocalTime(value: string): { hour: number; minute: number } | undefined {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    return undefined;
  }
  const [, hour, minute] = match;
  return {
    hour: Number(hour),
    minute: Number(minute)
  };
}

function localDateKey(date: Date, timezone: string): string | undefined {
  if (!Number.isFinite(date.getTime())) {
    return undefined;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    const year = value('year');
    const month = value('month');
    const day = value('day');
    return year && month && day ? `${year}-${month}-${day}` : undefined;
  } catch {
    return undefined;
  }
}

function addLocalDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days, 12, 0, 0, 0));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate()
  };
}

function datePartsKey(date: { year: number; month: number; day: number }): string {
  return [
    String(date.year).padStart(4, '0'),
    String(date.month).padStart(2, '0'),
    String(date.day).padStart(2, '0')
  ].join('-');
}

function dateDiffDays(start: { year: number; month: number; day: number }, end: { year: number; month: number; day: number }): number {
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  return Math.round((endMs - startMs) / 86_400_000);
}

function eventWeatherForecastDedupeKey(
  eventId: string,
  eventUpdatedAt: string,
  schedule: EventWeatherForecastSchedule
): string {
  return [
    EVENTS_JOBS.weatherForecast,
    eventId,
    eventUpdatedAt,
    schedule.deliveryKind,
    schedule.scheduledAt.toISOString()
  ].join(':');
}

function eventWeatherForecastRetryDedupeKey(
  eventId: string,
  eventUpdatedAt: string,
  schedule: EventWeatherForecastSchedule,
  attempt: number,
  retryAt: Date
): string {
  return `${eventWeatherForecastDedupeKey(eventId, eventUpdatedAt, schedule)}:retry:${attempt}:${retryAt.toISOString()}`;
}

function jobPayloadEventId(payload: unknown): string | undefined {
  return payload && typeof payload === 'object' && typeof (payload as { eventId?: unknown }).eventId === 'string'
    ? (payload as { eventId: string }).eventId
    : undefined;
}

function jobPayloadEventUpdatedAt(payload: unknown): string | undefined {
  return payload &&
    typeof payload === 'object' &&
    typeof (payload as { eventUpdatedAt?: unknown }).eventUpdatedAt === 'string' &&
    (payload as { eventUpdatedAt: string }).eventUpdatedAt.trim()
    ? (payload as { eventUpdatedAt: string }).eventUpdatedAt
    : undefined;
}

function jobPayloadDeliveryKind(payload: unknown): string | undefined {
  return payload && typeof payload === 'object' && typeof (payload as { deliveryKind?: unknown }).deliveryKind === 'string'
    ? (payload as { deliveryKind: string }).deliveryKind
    : undefined;
}

function jobPayloadScheduleKind(payload: unknown): EventWeatherDeliveryScheduleKind | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const scheduleKind = (payload as { scheduleKind?: unknown }).scheduleKind;
  return scheduleKind === 'poll-close' || scheduleKind === 'daily' ? scheduleKind : undefined;
}

function jobPayloadScheduledAt(payload: unknown): Date | undefined {
  if (!payload || typeof payload !== 'object' || typeof (payload as { scheduledAt?: unknown }).scheduledAt !== 'string') {
    return undefined;
  }
  const scheduledAt = new Date((payload as { scheduledAt: string }).scheduledAt);
  return Number.isFinite(scheduledAt.getTime()) ? scheduledAt : undefined;
}

async function appendWeatherJsonLog(
  context: PluginRuntimeContext,
  entry: Parameters<typeof appendScopeEventJsonLog>[0]['entry']
): Promise<void> {
  try {
    await appendScopeEventJsonLog({ appConfig: context.config, entry });
  } catch (error) {
    context.logger.warn({ error, action: entry.action, scopeId: entry.scopeId }, 'Unable to append official.community-events weather JSONL log');
  }
}

function audit(action: string, metadataJson: unknown): PluginAction {
  return {
    type: 'audit.record',
    action,
    metadataJson
  };
}
