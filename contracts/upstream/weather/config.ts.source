import { z } from 'zod';

export const WEATHER_PROVIDERS = ['open-meteo'] as const;
export const WEATHER_TEMPERATURE_UNITS = ['celsius', 'fahrenheit'] as const;
export const WEATHER_WIND_SPEED_UNITS = ['kmh', 'mph', 'ms', 'kn'] as const;
export const WEATHER_PRECIPITATION_UNITS = ['mm', 'inch'] as const;

export const weatherUnitsSchema = z.object({
  temperatureUnit: z.enum(WEATHER_TEMPERATURE_UNITS).default('celsius'),
  windSpeedUnit: z.enum(WEATHER_WIND_SPEED_UNITS).default('kmh'),
  precipitationUnit: z.enum(WEATHER_PRECIPITATION_UNITS).default('mm')
}).default({});

export const weatherMetricFlagsShapeSchema = z.object({
  temperature: z.boolean().default(true),
  apparentTemperature: z.boolean().default(false),
  relativeHumidity: z.boolean().default(true),
  wind: z.boolean().default(true),
  precipitation: z.boolean().default(true),
  weatherCode: z.boolean().default(true),
  tide: z.boolean().default(false),
  wave: z.boolean().default(false),
  oceanCurrent: z.boolean().default(false),
  seaSurfaceTemperature: z.boolean().default(false)
});

export const weatherMetricFlagsSchema = weatherMetricFlagsShapeSchema.default({});

export const weatherProviderSettingsSchema = z.object({
  openMeteo: z.object({
    forecastBaseUrl: z.string().url().default('https://api.open-meteo.com/v1/forecast'),
    marineBaseUrl: z.string().url().default('https://marine-api.open-meteo.com/v1/marine')
  }).default({})
}).default({});

export const weatherConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(WEATHER_PROVIDERS).default('open-meteo'),
  cacheTtlSeconds: z.number().int().min(0).max(3600).default(600),
  units: weatherUnitsSchema,
  metrics: weatherMetricFlagsSchema,
  providerSettings: weatherProviderSettingsSchema
}).default({});

export type WeatherConfig = z.infer<typeof weatherConfigSchema>;
export type WeatherUnits = z.infer<typeof weatherUnitsSchema>;
export type WeatherMetricFlags = z.infer<typeof weatherMetricFlagsSchema>;

export function parseWeatherConfig(input: unknown): WeatherConfig {
  return weatherConfigSchema.parse(input);
}
