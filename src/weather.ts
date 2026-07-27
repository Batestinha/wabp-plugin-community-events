import type { TranslateFn } from '../../../platform/i18n';
import type { PluginServiceCallInput } from '../../../platform/pluginRuntime/pluginServices';
import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { PluginJobEvent } from '../../../platform/pluginRuntime/types';
import type {
  WeatherForecastOutput,
  WeatherMetricValue,
  WeatherQueryOutput
} from '../weather/serviceApi';
import {
  WEATHER_QUERY_METHOD,
  WEATHER_SERVICE_ID
} from '../weather/serviceApi';
import { renderMarineForecast } from '../weather/marineForecast';
import { eventDateAndTimeToUtc } from './datetime';
import { renderEventTemplate } from './flow';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import { localizeDefaultEventProfiles, type EventProfile } from './config';
import type { StoredEventRecord } from './store';
import {
  appendEventLog,
  eventsDatabase,
  getEvent,
  getEventWeatherDelivery,
  recordEventWeatherDelivery
} from './store';

export const EVENT_WEATHER_FORECAST_POLL_CLOSE_KIND = 'forecast.poll-close';
export const EVENT_WEATHER_FORECAST_DAILY_KIND_PREFIX = 'forecast.daily';

type PluginEnqueueJobAction = Extract<PluginAction, { type: 'plugin.enqueueJob' }>;
type WeatherForecastDay = WeatherForecastOutput['days'][number];
type EventWeatherForecastScheduleKind = 'poll-close' | 'daily';

interface EventWeatherForecastSchedule {
  deliveryKind: string;
  scheduleKind: EventWeatherForecastScheduleKind;
  scheduledAt: Date;
}

export interface EventWeatherForecastJobRequest {
  jobName: string;
  scopeId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
  payload: {
    eventId: string;
    deliveryKind: string;
    scheduleKind: EventWeatherForecastScheduleKind;
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
  if (profile.weather.sendOnPollClose) {
    const scheduledAt = eventWeatherPollCloseScheduledAt(event);
    if (scheduledAt && weatherForecastScheduleAllowed(event, scheduledAt, now)) {
      schedules.push({
        deliveryKind: EVENT_WEATHER_FORECAST_POLL_CLOSE_KIND,
        scheduleKind: 'poll-close',
        scheduledAt
      });
    }
  }
  if (profile.weather.sendDaily) {
    const scheduledAt = eventWeatherNextDailyForecastScheduledAt(event, profile, now);
    if (scheduledAt && weatherForecastScheduleAllowed(event, scheduledAt, now)) {
      schedules.push({
        deliveryKind: eventWeatherDailyForecastKind(scheduledAt, event),
        scheduleKind: 'daily',
        scheduledAt
      });
    }
  }
  return schedules;
}

export function eventWeatherForecastScheduledAt(
  event: StoredEventRecord,
  profile: EventProfile
): Date | undefined {
  if (profile.weather.sendOnPollClose) {
    return eventWeatherPollCloseScheduledAt(event);
  }
  return eventWeatherNextDailyForecastScheduledAt(event, profile, new Date());
}

function eventWeatherForecastJobRequestForSchedule(
  event: StoredEventRecord,
  schedule: EventWeatherForecastSchedule,
  now: Date
): EventWeatherForecastJobRequest {
  return {
    jobName: EVENTS_JOBS.weatherForecast,
    scopeId: event.scopeId,
    ...(event.groupId ? { groupId: event.groupId } : {}),
    ...(event.groupWid ? { groupWid: event.groupWid } : {}),
    ...(schedule.scheduledAt.getTime() > now.getTime() ? { runAt: schedule.scheduledAt } : {}),
    payload: {
      eventId: event.id,
      deliveryKind: schedule.deliveryKind,
      scheduleKind: schedule.scheduleKind,
      scheduledAt: schedule.scheduledAt.toISOString()
    },
    dedupeKey: eventWeatherForecastDedupeKey(event.id, schedule)
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
  const payloadDeliveryKind = jobPayloadDeliveryKind(job.payload) ?? EVENT_WEATHER_FORECAST_POLL_CLOSE_KIND;
  if (!profile?.weather.enabled) {
    await markWeatherSkipped(context, db, event, profile, payloadDeliveryKind, 'profile_weather_disabled');
    return [audit('events.weather_forecast.skipped', { eventId, reason: 'profile_weather_disabled' })];
  }
  const schedule = eventWeatherForecastScheduleForJob(job.payload, event, profile);
  if (!schedule) {
    await markWeatherSkipped(context, db, event, profile, payloadDeliveryKind, 'invalid_schedule');
    return [audit('events.weather_forecast.skipped', { eventId, reason: 'invalid_schedule' })];
  }

  const now = new Date();
  const existing = getEventWeatherDelivery(db, event.id, schedule.deliveryKind);
  if (existing?.status === 'queued' || existing?.status === 'skipped') {
    return [
      audit('events.weather_forecast.skipped', { eventId, deliveryKind: schedule.deliveryKind, reason: `already_${existing.status}` }),
      ...nextDailyWeatherForecastActions(event, profile, schedule, now)
    ];
  }

  if (schedule.scheduledAt.getTime() > now.getTime()) {
    const request = eventWeatherForecastJobRequestForSchedule(event, schedule, now);
    return [
      audit('events.weather_forecast.deferred', { eventId, deliveryKind: schedule.deliveryKind, scheduledAt: schedule.scheduledAt.toISOString() }),
      { type: 'plugin.enqueueJob', pluginId: EVENTS_PLUGIN_ID, ...request, runAt: request.runAt ?? schedule.scheduledAt }
    ];
  }

  const skipReason = weatherRuntimeSkipReason(event, schedule.scheduledAt, now);
  if (skipReason) {
    await markWeatherSkipped(context, db, event, profile, schedule.deliveryKind, skipReason, schedule.scheduledAt);
    return [audit('events.weather_forecast.skipped', { eventId, deliveryKind: schedule.deliveryKind, reason: skipReason })];
  }

  if (!event.eventLocation) {
    await markWeatherSkipped(
      context,
      db,
      event,
      profile,
      schedule.deliveryKind,
      'event_location_unresolved',
      schedule.scheduledAt
    );
    return [audit('events.weather_forecast.skipped', {
      eventId,
      deliveryKind: schedule.deliveryKind,
      reason: 'event_location_unresolved'
    })];
  }
  if (!context.services) {
    await markWeatherFailed(context, db, event, profile, schedule.deliveryKind, schedule.scheduledAt, 'plugin_services_unavailable');
    return [audit('events.weather_forecast.failed', { eventId, deliveryKind: schedule.deliveryKind, reason: 'plugin_services_unavailable' })];
  }

  try {
    const result = await context.services.call<WeatherQueryOutput>(weatherForecastServiceInput(event, now));
    if (result.kind !== 'forecast') {
      throw new Error('weather query returned current conditions for a forecast request');
    }
    const report = result.report;
    const forecastDay = selectForecastDay(report, event);
    if (!forecastDay) {
      await markWeatherFailed(context, db, event, profile, schedule.deliveryKind, schedule.scheduledAt, 'event_day_forecast_unavailable');
      return [
        audit('events.weather_forecast.failed', { eventId, deliveryKind: schedule.deliveryKind, reason: 'event_day_forecast_unavailable' }),
        ...nextDailyWeatherForecastActions(event, profile, schedule, now)
      ];
    }
    const t = await context.i18n.translatorForIdentity(event.subgroupChatId ?? event.scopeId, event.scopeId);
    const resolvedLocale = await context.i18n.resolveIdentityLocale(
      event.subgroupChatId ?? event.scopeId,
      event.scopeId
    );
    const localizedProfile = localizeDefaultEventProfiles([profile], t)[0] ?? profile;
    const messages = renderEventWeatherForecast({
      event,
      profile: localizedProfile,
      report,
      forecastDay,
      t,
      locale: resolvedLocale.locale
    });
    if (!messages.meteorologicalText.trim() && !messages.marineText?.trim()) {
      await markWeatherSkipped(context, db, event, profile, schedule.deliveryKind, 'empty_rendered_text', schedule.scheduledAt);
      return [audit('events.weather_forecast.skipped', { eventId, deliveryKind: schedule.deliveryKind, reason: 'empty_rendered_text' })];
    }
    const queuedAt = new Date().toISOString();
    recordEventWeatherDelivery(db, {
      eventId: event.id,
      kind: schedule.deliveryKind,
      scheduledAt: schedule.scheduledAt.toISOString(),
      status: 'queued',
      at: queuedAt
    });
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.weather_forecast.queued',
      metadata: {
        deliveryKind: schedule.deliveryKind,
        scheduleKind: schedule.scheduleKind,
        scheduledAt: schedule.scheduledAt.toISOString(),
        subgroupChatId: event.subgroupChatId,
        provider: report.provider,
        fetchedAt: report.fetchedAt,
        forecastDate: forecastDay.date,
        location: report.location
      }
    });
    await appendWeatherJsonLog(context, {
      action: 'event.weather_forecast_queued',
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
        forecastDate: forecastDay.date,
        location: report.location
      }
    });
    return [
      ...(messages.meteorologicalText.trim()
        ? [{
            type: 'message.sendText' as const,
            chatId: event.subgroupChatId!,
            text: messages.meteorologicalText
          }]
        : []),
      ...(messages.marineText?.trim()
        ? [{
            type: 'message.sendText' as const,
            chatId: event.subgroupChatId!,
            text: messages.marineText
          }]
        : []),
      audit('events.weather_forecast.queued', {
        eventId: event.id,
        deliveryKind: schedule.deliveryKind,
        scheduledAt: schedule.scheduledAt.toISOString()
      }),
      ...nextDailyWeatherForecastActions(event, profile, schedule, now)
    ];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markWeatherFailed(context, db, event, profile, schedule.deliveryKind, schedule.scheduledAt, reason);
    return [
      audit('events.weather_forecast.failed', { eventId: event.id, deliveryKind: schedule.deliveryKind, reason }),
      ...nextDailyWeatherForecastActions(event, profile, schedule, now)
    ];
  }
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
  const summary = weatherSummary(input.forecastDay, input.t);
  const meteorologicalText = renderEventTemplate({
    template: input.profile.weather.template,
    profile: input.profile,
    answers: input.event.answers,
    startsAt: new Date(input.event.startsAtUtc || input.event.startsAt),
    timezone: input.event.timezone,
    creatorDisplayName: input.event.actorLabel || input.event.actorWid,
    extraTokens: {
      eventId: input.event.id,
      groupDisplayName: input.event.subgroupTitle || input.event.groupTitle,
      subgroupChatId: input.event.subgroupChatId,
      weatherDate: input.forecastDay.date,
      weatherLocation: input.report.location.label,
      weatherSummary: summary,
      temperatureMax: formatMetric(input.forecastDay.temperatureMax),
      temperatureMin: formatMetric(input.forecastDay.temperatureMin),
      precipitation: formatMetric(input.forecastDay.precipitationSum),
      precipitationProbability: formatMetric(input.forecastDay.precipitationProbabilityMax),
      windSpeed: formatMetric(input.forecastDay.windSpeedMax),
      windGust: formatMetric(input.forecastDay.windGustsMax),
      windDirection: formatMetric(input.forecastDay.windDirectionDominant),
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
    actorWid: event.actorWid,
    ...(event.groupId ? { groupId: event.groupId } : {}),
    ...(event.groupWid ? { groupWid: event.groupWid } : {}),
    input: {
      selection: {
        startDay: 0,
        endDay: forecastDaysForEvent(event, now) - 1
      },
      includeMarine: true,
      location: {
        label: event.eventLocation.displayLabel,
        latitude: event.eventLocation.latitude,
        longitude: event.eventLocation.longitude,
        timezone: event.eventLocation.timezone
      }
    }
  };
}

function selectForecastDay(report: WeatherForecastOutput, event: StoredEventRecord): WeatherForecastDay | undefined {
  const eventDate = event.localDate ?? localDateKey(new Date(event.startsAtUtc || event.startsAt), event.timezone);
  return report.days.find((day) => day.date === eventDate);
}

function weatherSummary(day: WeatherForecastDay, t: TranslateFn): string {
  const sections = [
    weatherMetricSection(t, 'official.community-events.weather.section.temperature', [
      labeledMetric(t, 'official.community-events.weather.metric.temperatureMax', day.temperatureMax),
      labeledMetric(t, 'official.community-events.weather.metric.temperatureMin', day.temperatureMin)
    ]),
    weatherMetricSection(t, 'official.community-events.weather.section.relativeHumidity', [
      labeledMetric(t, 'official.community-events.weather.metric.relativeHumidityMax', day.relativeHumidityMax),
      labeledMetric(t, 'official.community-events.weather.metric.relativeHumidityMin', day.relativeHumidityMin),
      labeledMetric(t, 'official.community-events.weather.metric.relativeHumidityMean', day.relativeHumidityMean)
    ]),
    weatherMetricSection(t, 'official.community-events.weather.section.precipitation', [
      formatMetric(day.precipitationSum),
      labeledMetric(
        t,
        'official.community-events.weather.metric.precipitationProbability',
        day.precipitationProbabilityMax
      )
    ]),
    weatherMetricSection(t, 'official.community-events.weather.section.wind', [
      labeledMetric(t, 'official.community-events.weather.metric.windSpeed', day.windSpeedMax),
      labeledMetric(t, 'official.community-events.weather.metric.windGust', day.windGustsMax),
      labeledMetric(t, 'official.community-events.weather.metric.windDirection', day.windDirectionDominant)
    ])
  ].filter((value): value is string => Boolean(value));
  return sections.join('\n') || t('official.community-events.weather.none');
}

function weatherMetricSection(t: TranslateFn, key: string, metrics: Array<string | undefined>): string | undefined {
  const values = metrics.filter((value): value is string => Boolean(value));
  return values.length > 0 ? `*${t(key)}*: ${values.join(', ')}` : undefined;
}

function labeledMetric(t: TranslateFn, key: string, metric?: WeatherMetricValue | undefined): string | undefined {
  const formatted = formatMetric(metric);
  return formatted ? `${t(key)}: ${formatted}` : undefined;
}

function formatMetric(metric?: WeatherMetricValue | undefined): string | undefined {
  if (!metric) {
    return undefined;
  }
  const value = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(metric.value);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

function eventWeatherForecastScheduleForJob(
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
    if (deliveryKind !== EVENT_WEATHER_FORECAST_POLL_CLOSE_KIND || !profile.weather.sendOnPollClose) {
      return undefined;
    }
    const scheduledAt = eventWeatherPollCloseScheduledAt(event);
    return scheduledAt ? { deliveryKind, scheduleKind, scheduledAt } : undefined;
  }
  if (!profile.weather.sendDaily || !deliveryKind.startsWith(`${EVENT_WEATHER_FORECAST_DAILY_KIND_PREFIX}.`)) {
    return undefined;
  }
  const expectedKind = eventWeatherDailyForecastKind(payloadScheduledAt, event);
  return deliveryKind === expectedKind
    ? { deliveryKind, scheduleKind, scheduledAt: payloadScheduledAt }
    : undefined;
}

function nextDailyWeatherForecastActions(
  event: StoredEventRecord,
  profile: EventProfile,
  completedSchedule: EventWeatherForecastSchedule,
  now: Date
): PluginEnqueueJobAction[] {
  if (!profile.weather.sendDaily) {
    return [];
  }
  const searchFrom = completedSchedule.scheduleKind === 'daily'
    ? new Date(Math.max(now.getTime(), completedSchedule.scheduledAt.getTime() + 60_000))
    : now;
  const scheduledAt = eventWeatherNextDailyForecastScheduledAt(event, profile, searchFrom);
  if (!scheduledAt || !weatherForecastScheduleAllowed(event, scheduledAt, now)) {
    return [];
  }
  const schedule: EventWeatherForecastSchedule = {
    deliveryKind: eventWeatherDailyForecastKind(scheduledAt, event),
    scheduleKind: 'daily',
    scheduledAt
  };
  if (schedule.deliveryKind === completedSchedule.deliveryKind) {
    return [];
  }
  const request = eventWeatherForecastJobRequestForSchedule(event, schedule, now);
  return [{
    type: 'plugin.enqueueJob',
    pluginId: EVENTS_PLUGIN_ID,
    ...request,
    runAt: request.runAt ?? scheduledAt
  }];
}

function eventWeatherPollCloseScheduledAt(event: StoredEventRecord): Date | undefined {
  const scheduledAt = new Date(event.closeAt);
  return Number.isFinite(scheduledAt.getTime()) ? scheduledAt : undefined;
}

function eventWeatherNextDailyForecastScheduledAt(
  event: StoredEventRecord,
  profile: EventProfile,
  now: Date
): Date | undefined {
  const eventDateKey = event.localDate ?? localDateKey(new Date(event.startsAtUtc || event.startsAt), event.timezone);
  const eventDate = parseLocalDate(eventDateKey);
  const nowDate = parseLocalDate(localDateKey(now, event.timezone));
  const time = parseLocalTime(profile.weather.sendAtLocalTime);
  if (!eventDate || !nowDate || !time) {
    return undefined;
  }
  let candidateDate = nowDate;
  let scheduledAt = eventDateAndTimeToUtc(candidateDate, time, event.timezone);
  if (!scheduledAt) {
    return undefined;
  }
  if (scheduledAt.getTime() <= now.getTime()) {
    candidateDate = addLocalDays(candidateDate, 1);
    scheduledAt = eventDateAndTimeToUtc(candidateDate, time, event.timezone);
    if (!scheduledAt) {
      return undefined;
    }
  }
  return datePartsKey(candidateDate) <= datePartsKey(eventDate) ? scheduledAt : undefined;
}

function weatherForecastScheduleAllowed(event: StoredEventRecord, scheduledAt: Date, now: Date): boolean {
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

function forecastDaysForEvent(event: StoredEventRecord, now: Date): number {
  const eventDate = parseLocalDate(event.localDate ?? localDateKey(new Date(event.startsAtUtc || event.startsAt), event.timezone));
  const today = parseLocalDate(localDateKey(now, event.timezone));
  if (!eventDate || !today) {
    return 1;
  }
  const days = dateDiffDays(today, eventDate) + 1;
  return Math.min(16, Math.max(1, days));
}

function weatherRuntimeSkipReason(event: StoredEventRecord, scheduledAt: Date, now: Date): string | undefined {
  if (event.eventStatus !== 'scheduled') {
    return `event_status_${event.eventStatus}`;
  }
  if (event.groupLifecycleStatus !== 'poll_closed' && event.groupLifecycleStatus !== 'cleanup_failed') {
    return `group_lifecycle_${event.groupLifecycleStatus}`;
  }
  if (!event.subgroupChatId) {
    return 'no_event_group';
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

async function markWeatherSkipped(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  profile: EventProfile | undefined,
  deliveryKind: string,
  reason: string,
  scheduledAt?: Date | undefined
): Promise<void> {
  const at = new Date().toISOString();
  recordEventWeatherDelivery(db, {
    eventId: event.id,
    kind: deliveryKind,
    scheduledAt: scheduledAt?.toISOString() ?? at,
    status: 'skipped',
    at,
    error: reason
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

async function markWeatherFailed(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  profile: EventProfile,
  deliveryKind: string,
  scheduledAt: Date,
  reason: string
): Promise<void> {
  const at = new Date().toISOString();
  recordEventWeatherDelivery(db, {
    eventId: event.id,
    kind: deliveryKind,
    scheduledAt: scheduledAt.toISOString(),
    status: 'failed',
    at,
    error: reason
  });
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.weather_forecast.failed',
    metadata: { deliveryKind, reason, scheduledAt: scheduledAt.toISOString(), profileId: profile.id }
  });
  await appendWeatherJsonLog(context, {
    action: 'event.weather_forecast_failed',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: event.actorWid,
    profileId: event.profileId,
    ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
    ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
    metadata: { deliveryKind, reason, scheduledAt: scheduledAt.toISOString() }
  });
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

function eventWeatherForecastDedupeKey(eventId: string, schedule: EventWeatherForecastSchedule): string {
  return `${EVENTS_JOBS.weatherForecast}:${eventId}:${schedule.deliveryKind}:${schedule.scheduledAt.toISOString()}`;
}

function jobPayloadEventId(payload: unknown): string | undefined {
  return payload && typeof payload === 'object' && typeof (payload as { eventId?: unknown }).eventId === 'string'
    ? (payload as { eventId: string }).eventId
    : undefined;
}

function jobPayloadDeliveryKind(payload: unknown): string | undefined {
  return payload && typeof payload === 'object' && typeof (payload as { deliveryKind?: unknown }).deliveryKind === 'string'
    ? (payload as { deliveryKind: string }).deliveryKind
    : undefined;
}

function jobPayloadScheduleKind(payload: unknown): EventWeatherForecastScheduleKind | undefined {
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
