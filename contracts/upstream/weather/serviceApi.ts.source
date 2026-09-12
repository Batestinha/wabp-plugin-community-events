import { z } from 'zod';
import {
  WEATHER_PRECIPITATION_UNITS,
  WEATHER_TEMPERATURE_UNITS,
  WEATHER_WIND_SPEED_UNITS
} from './config';

export const WEATHER_SERVICE_ID = 'official.weather.v2';
export const WEATHER_QUERY_METHOD = 'query';
export const WEATHER_MAX_FORECAST_DAYS = 16;
export const WEATHER_MAX_DAY_OFFSET = WEATHER_MAX_FORECAST_DAYS - 1;
export const WEATHER_MARINE_MODES = ['auto'] as const;

export const weatherServiceLocationSchema = z.object({
  label: z.string().trim().min(1).max(2048),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  timezone: z.string().trim().min(1).max(128)
}).strict();

export const weatherQueryLocationSchema = z.union([
  z.string().trim().min(2).max(256),
  weatherServiceLocationSchema
]);

export const weatherDaySelectionSchema = z.object({
  startDay: z.number().int().min(0).max(WEATHER_MAX_DAY_OFFSET),
  endDay: z.number().int().min(0).max(WEATHER_MAX_DAY_OFFSET)
}).strict().superRefine((selection, context) => {
  if (selection.startDay > selection.endDay) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startDay'],
      message: 'startDay must not be greater than endDay'
    });
  }
});

export const weatherServiceMetricOverridesSchema = z.object({
  temperature: z.boolean().optional(),
  apparentTemperature: z.boolean().optional(),
  relativeHumidity: z.boolean().optional(),
  wind: z.boolean().optional(),
  precipitation: z.boolean().optional(),
  weatherCode: z.boolean().optional(),
  tide: z.boolean().optional(),
  wave: z.boolean().optional(),
  oceanCurrent: z.boolean().optional(),
  seaSurfaceTemperature: z.boolean().optional()
}).strict();

export const weatherQueryInputSchema = z.object({
  location: weatherQueryLocationSchema,
  selection: weatherDaySelectionSchema.optional(),
  language: z.string().trim().min(2).max(35).optional(),
  includeMarine: z.union([z.boolean(), z.enum(WEATHER_MARINE_MODES)]).default(false),
  metrics: weatherServiceMetricOverridesSchema.optional()
}).strict();

export const weatherMetricValueSchema = z.object({
  value: z.number(),
  unit: z.string()
}).strict();

export const weatherMarineMetricKeySchema = z.enum([
  'tide',
  'wave',
  'oceanCurrent',
  'seaSurfaceTemperature'
]);

export const weatherTideEventSchema = z.object({
  type: z.enum(['high', 'low']),
  time: z.string(),
  height: weatherMetricValueSchema
}).strict();

export const weatherReportLocationSchema = weatherServiceLocationSchema;

export const weatherReportUnitsSchema = z.object({
  temperatureUnit: z.enum(WEATHER_TEMPERATURE_UNITS),
  windSpeedUnit: z.enum(WEATHER_WIND_SPEED_UNITS),
  precipitationUnit: z.enum(WEATHER_PRECIPITATION_UNITS)
}).strict();

export const weatherCurrentConditionsSchema = z.object({
  time: z.string(),
  temperature2m: weatherMetricValueSchema.optional(),
  apparentTemperature: weatherMetricValueSchema.optional(),
  relativeHumidity2m: weatherMetricValueSchema.optional(),
  precipitation: weatherMetricValueSchema.optional(),
  weatherCode: z.number().int().optional(),
  windSpeed10m: weatherMetricValueSchema.optional(),
  windDirection10m: weatherMetricValueSchema.optional(),
  windGusts10m: weatherMetricValueSchema.optional()
}).strict();

export const weatherCurrentReportSchema = z.object({
  provider: z.literal('open-meteo'),
  fetchedAt: z.string(),
  location: weatherReportLocationSchema,
  units: weatherReportUnitsSchema,
  current: weatherCurrentConditionsSchema
}).strict();

export const weatherForecastDaySchema = z.object({
  date: z.string(),
  weatherCode: z.number().int().optional(),
  temperatureMax: weatherMetricValueSchema.optional(),
  temperatureMin: weatherMetricValueSchema.optional(),
  relativeHumidityMax: weatherMetricValueSchema.optional(),
  relativeHumidityMin: weatherMetricValueSchema.optional(),
  relativeHumidityMean: weatherMetricValueSchema.optional(),
  precipitationSum: weatherMetricValueSchema.optional(),
  precipitationProbabilityMax: weatherMetricValueSchema.optional(),
  windSpeedMax: weatherMetricValueSchema.optional(),
  windGustsMax: weatherMetricValueSchema.optional(),
  windDirectionDominant: weatherMetricValueSchema.optional(),
  marine: z.object({
    requested: z.array(weatherMarineMetricKeySchema),
    unavailable: z.array(weatherMarineMetricKeySchema),
    tideEvents: z.array(weatherTideEventSchema),
    waveHeightMax: weatherMetricValueSchema.optional(),
    waveDirectionDominant: weatherMetricValueSchema.optional(),
    wavePeriodMax: weatherMetricValueSchema.optional(),
    oceanCurrentTime: z.string().optional(),
    oceanCurrentVelocityMax: weatherMetricValueSchema.optional(),
    oceanCurrentDirectionAtMax: weatherMetricValueSchema.optional(),
    seaSurfaceTemperatureMin: weatherMetricValueSchema.optional(),
    seaSurfaceTemperatureMax: weatherMetricValueSchema.optional()
  }).strict().optional()
}).strict();

export const weatherForecastReportSchema = z.object({
  provider: z.literal('open-meteo'),
  fetchedAt: z.string(),
  location: weatherReportLocationSchema,
  units: weatherReportUnitsSchema,
  days: z.array(weatherForecastDaySchema)
}).strict();

export const weatherQueryOutputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('current'),
    report: weatherCurrentReportSchema
  }).strict(),
  z.object({
    kind: z.literal('forecast'),
    selection: weatherDaySelectionSchema,
    report: weatherForecastReportSchema
  }).strict()
]);

export type WeatherServiceLocation = z.infer<typeof weatherServiceLocationSchema>;
export type WeatherDaySelection = z.infer<typeof weatherDaySelectionSchema>;
export type WeatherQueryInput = z.infer<typeof weatherQueryInputSchema>;
export type WeatherMarineMode = WeatherQueryInput['includeMarine'];
export type WeatherMetricValue = z.infer<typeof weatherMetricValueSchema>;
export type WeatherMarineMetricKey = z.infer<typeof weatherMarineMetricKeySchema>;
export type WeatherTideEvent = z.infer<typeof weatherTideEventSchema>;
export type WeatherCurrentOutput = z.infer<typeof weatherCurrentReportSchema>;
export type WeatherForecastOutput = z.infer<typeof weatherForecastReportSchema>;
export type WeatherQueryOutput = z.infer<typeof weatherQueryOutputSchema>;
