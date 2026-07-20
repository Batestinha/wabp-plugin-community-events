import type { TranslateFn } from '../../../platform/i18n';
import type { PluginServiceCallInput } from '../../../platform/pluginRuntime/pluginServices';
import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { PluginJobEvent } from '../../../platform/pluginRuntime/types';
import type { WeatherForecastOutput, WeatherMetricValue } from '../weather/serviceApi';
import {
  WEATHER_FORECAST_METHOD,
  WEATHER_SERVICE_ID
} from '../weather/serviceApi';
import { eventDateAndTimeToUtc } from './datetime';
import { renderEventTemplate } from './flow';
import { appendScopeEventJsonLog } from './log';
import { EVENTS_JOBS, EVENTS_PLUGIN_ID } from './manifest';
import type { EventProfile } from './config';
import type { StoredEventRecord } from './store';
import {
  appendEventLog,
  eventsDatabase,
  getEvent,
  getEventWeatherDelivery,
  recordEventWeatherDelivery
} from './store';

export const EVENT_WEATHER_FORECAST_KIND = 'forecast';

type PluginEnqueueJobAction = Extract<PluginAction, { type: 'plugin.enqueueJob' }>;
type WeatherForecastDay = WeatherForecastOutput['days'][number];

export interface EventWeatherForecastJobRequest {
  jobName: string;
  scopeId: string;
  groupId?: string | undefined;
  groupWid?: string | undefined;
  payload: { eventId: string };
  runAt?: Date | undefined;
  dedupeKey: string;
}

export function eventWeatherForecastJobRequest(input: {
  event: StoredEventRecord;
  profile: EventProfile | undefined;
  now?: Date | undefined;
}): EventWeatherForecastJobRequest | undefined {
  const { event, profile } = input;
  if (!profile?.weather.enabled || !event.subgroupChatId) {
    return undefined;
  }
  const scheduledAt = eventWeatherForecastScheduledAt(event, profile);
  if (!scheduledAt) {
    return undefined;
  }
  const cleanupAt = new Date(event.cleanupAt);
  const now = input.now ?? new Date();
  if (Number.isFinite(cleanupAt.getTime()) && cleanupAt.getTime() <= now.getTime()) {
    return undefined;
  }
  if (Number.isFinite(cleanupAt.getTime()) && scheduledAt.getTime() >= cleanupAt.getTime()) {
    return undefined;
  }
  return {
    jobName: EVENTS_JOBS.weatherForecast,
    scopeId: event.scopeId,
    ...(event.groupId ? { groupId: event.groupId } : {}),
    ...(event.groupWid ? { groupWid: event.groupWid } : {}),
    ...(scheduledAt.getTime() > now.getTime() ? { runAt: scheduledAt } : {}),
    payload: { eventId: event.id },
    dedupeKey: eventWeatherForecastDedupeKey(event.id, scheduledAt)
  };
}

export function eventWeatherForecastJobAction(input: {
  event: StoredEventRecord;
  profile: EventProfile | undefined;
  now?: Date | undefined;
}): PluginEnqueueJobAction | undefined {
  const request = eventWeatherForecastJobRequest(input);
  return request
    ? { type: 'plugin.enqueueJob', pluginId: EVENTS_PLUGIN_ID, ...request, runAt: request.runAt ?? new Date() }
    : undefined;
}

export function eventWeatherForecastScheduledAt(
  event: StoredEventRecord,
  profile: EventProfile
): Date | undefined {
  const dateParts = parseLocalDate(event.localDate ?? localDateKey(new Date(event.startsAtUtc || event.startsAt), event.timezone));
  const timeParts = parseLocalTime(profile.weather.sendAtLocalTime);
  if (!dateParts || !timeParts) {
    return undefined;
  }
  return eventDateAndTimeToUtc(dateParts, timeParts, event.timezone);
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
  if (!profile?.weather.enabled) {
    await markWeatherSkipped(context, db, event, profile, 'profile_weather_disabled');
    return [audit('events.weather_forecast.skipped', { eventId, reason: 'profile_weather_disabled' })];
  }
  const scheduledAt = eventWeatherForecastScheduledAt(event, profile);
  if (!scheduledAt) {
    await markWeatherSkipped(context, db, event, profile, 'invalid_schedule');
    return [audit('events.weather_forecast.skipped', { eventId, reason: 'invalid_schedule' })];
  }

  const existing = getEventWeatherDelivery(db, event.id, EVENT_WEATHER_FORECAST_KIND);
  if (existing?.status === 'queued' || existing?.status === 'skipped') {
    return [audit('events.weather_forecast.skipped', { eventId, reason: `already_${existing.status}` })];
  }

  const now = new Date();
  if (scheduledAt.getTime() > now.getTime()) {
    const action = eventWeatherForecastJobAction({ event, profile, now });
    return [
      audit('events.weather_forecast.deferred', { eventId, scheduledAt: scheduledAt.toISOString() }),
      ...(action ? [action] : [])
    ];
  }

  const skipReason = weatherRuntimeSkipReason(event, scheduledAt, now);
  if (skipReason) {
    await markWeatherSkipped(context, db, event, profile, skipReason, scheduledAt);
    return [audit('events.weather_forecast.skipped', { eventId, reason: skipReason })];
  }

  if (!context.services) {
    await markWeatherFailed(context, db, event, profile, scheduledAt, 'plugin_services_unavailable');
    return [audit('events.weather_forecast.failed', { eventId, reason: 'plugin_services_unavailable' })];
  }

  try {
    const report = await context.services.call<WeatherForecastOutput>(weatherForecastServiceInput(event, profile));
    const forecastDay = selectForecastDay(report, event);
    if (!forecastDay) {
      await markWeatherFailed(context, db, event, profile, scheduledAt, 'event_day_forecast_unavailable');
      return [audit('events.weather_forecast.failed', { eventId, reason: 'event_day_forecast_unavailable' })];
    }
    const t = await context.i18n.translatorForIdentity(event.subgroupChatId ?? event.scopeId, event.scopeId);
    const text = renderEventWeatherForecast({
      event,
      profile,
      report,
      forecastDay,
      t
    });
    if (!text.trim()) {
      await markWeatherSkipped(context, db, event, profile, 'empty_rendered_text', scheduledAt);
      return [audit('events.weather_forecast.skipped', { eventId, reason: 'empty_rendered_text' })];
    }
    const queuedAt = new Date().toISOString();
    recordEventWeatherDelivery(db, {
      eventId: event.id,
      kind: EVENT_WEATHER_FORECAST_KIND,
      scheduledAt: scheduledAt.toISOString(),
      status: 'queued',
      at: queuedAt
    });
    appendEventLog(db, {
      eventId: event.id,
      action: 'events.weather_forecast.queued',
      metadata: {
        scheduledAt: scheduledAt.toISOString(),
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
        scheduledAt: scheduledAt.toISOString(),
        forecastDate: forecastDay.date,
        location: report.location
      }
    });
    return [{
      type: 'message.sendText',
      chatId: event.subgroupChatId!,
      text
    }, audit('events.weather_forecast.queued', { eventId: event.id, scheduledAt: scheduledAt.toISOString() })];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markWeatherFailed(context, db, event, profile, scheduledAt, reason);
    return [audit('events.weather_forecast.failed', { eventId: event.id, reason })];
  }
}

export function renderEventWeatherForecast(input: {
  event: StoredEventRecord;
  profile: EventProfile;
  report: WeatherForecastOutput;
  forecastDay: WeatherForecastDay;
  t: TranslateFn;
}): string {
  const summary = weatherSummary(input.forecastDay, input.t);
  return renderEventTemplate({
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
}

function weatherForecastServiceInput(event: StoredEventRecord, profile: EventProfile): PluginServiceCallInput {
  return {
    serviceId: WEATHER_SERVICE_ID,
    method: WEATHER_FORECAST_METHOD,
    scopeId: event.scopeId,
    actorWid: event.actorWid,
    ...(event.groupId ? { groupId: event.groupId } : {}),
    ...(event.groupWid ? { groupWid: event.groupWid } : {}),
    input: {
      days: 1,
      metrics: {
        temperature: profile.weather.metrics.temperature,
        apparentTemperature: false,
        relativeHumidity: false,
        wind: profile.weather.metrics.wind,
        precipitation: profile.weather.metrics.precipitation,
        weatherCode: profile.weather.metrics.weatherCode,
        tide: false,
        wave: false,
        oceanCurrent: false,
        seaSurfaceTemperature: false
      },
      ...(profile.weather.locationSource === 'profile-override'
        ? {
            location: {
              label: profile.weather.location.label,
              latitude: profile.weather.location.latitude,
              longitude: profile.weather.location.longitude,
              timezone: profile.weather.location.timezone
            }
          }
        : {})
    }
  };
}

function selectForecastDay(report: WeatherForecastOutput, event: StoredEventRecord): WeatherForecastDay | undefined {
  const eventDate = event.localDate ?? localDateKey(new Date(event.startsAtUtc || event.startsAt), event.timezone);
  return report.days.find((day) => day.date === eventDate);
}

function weatherSummary(day: WeatherForecastDay, t: TranslateFn): string {
  const parts = [
    labeledMetric(t, 'official.community-events.weather.metric.temperatureMax', day.temperatureMax),
    labeledMetric(t, 'official.community-events.weather.metric.temperatureMin', day.temperatureMin),
    labeledMetric(t, 'official.community-events.weather.metric.precipitation', day.precipitationSum),
    labeledMetric(t, 'official.community-events.weather.metric.precipitationProbability', day.precipitationProbabilityMax),
    labeledMetric(t, 'official.community-events.weather.metric.windSpeed', day.windSpeedMax),
    labeledMetric(t, 'official.community-events.weather.metric.windGust', day.windGustsMax),
    labeledMetric(t, 'official.community-events.weather.metric.windDirection', day.windDirectionDominant),
    day.weatherCode !== undefined
      ? `${t('official.community-events.weather.metric.weatherCode')}: ${day.weatherCode}`
      : undefined
  ].filter((value): value is string => Boolean(value));
  return parts.join(', ') || t('official.community-events.weather.none');
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
  reason: string,
  scheduledAt?: Date | undefined
): Promise<void> {
  const at = new Date().toISOString();
  recordEventWeatherDelivery(db, {
    eventId: event.id,
    kind: EVENT_WEATHER_FORECAST_KIND,
    scheduledAt: scheduledAt?.toISOString() ?? at,
    status: 'skipped',
    at,
    error: reason
  });
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.weather_forecast.skipped',
    metadata: { reason, scheduledAt: scheduledAt?.toISOString() }
  });
  await appendWeatherJsonLog(context, {
    action: 'event.weather_forecast_skipped',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: event.actorWid,
    profileId: event.profileId,
    ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
    ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
    metadata: { reason, scheduledAt: scheduledAt?.toISOString() }
  });
}

async function markWeatherFailed(
  context: PluginRuntimeContext,
  db: ReturnType<typeof eventsDatabase>,
  event: StoredEventRecord,
  profile: EventProfile,
  scheduledAt: Date,
  reason: string
): Promise<void> {
  const at = new Date().toISOString();
  recordEventWeatherDelivery(db, {
    eventId: event.id,
    kind: EVENT_WEATHER_FORECAST_KIND,
    scheduledAt: scheduledAt.toISOString(),
    status: 'failed',
    at,
    error: reason
  });
  appendEventLog(db, {
    eventId: event.id,
    action: 'events.weather_forecast.failed',
    metadata: { reason, scheduledAt: scheduledAt.toISOString(), profileId: profile.id }
  });
  await appendWeatherJsonLog(context, {
    action: 'event.weather_forecast_failed',
    scopeId: event.scopeId,
    eventId: event.id,
    actorWid: event.actorWid,
    profileId: event.profileId,
    ...(event.pollWaMsgId ? { pollWaMsgId: event.pollWaMsgId } : {}),
    ...(event.subgroupChatId ? { subgroupChatId: event.subgroupChatId } : {}),
    metadata: { reason, scheduledAt: scheduledAt.toISOString() }
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

function eventWeatherForecastDedupeKey(eventId: string, scheduledAt: Date): string {
  return `${EVENTS_JOBS.weatherForecast}:${eventId}:${scheduledAt.toISOString()}`;
}

function jobPayloadEventId(payload: unknown): string | undefined {
  return payload && typeof payload === 'object' && typeof (payload as { eventId?: unknown }).eventId === 'string'
    ? (payload as { eventId: string }).eventId
    : undefined;
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
