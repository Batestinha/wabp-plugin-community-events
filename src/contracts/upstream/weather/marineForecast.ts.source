import type { TranslateFn } from '../../../../packages/plugin-sdk/src/i18n';
import type { WeatherForecastOutput, WeatherMetricValue } from './serviceApi';

export function renderMarineForecast(
  report: WeatherForecastOutput,
  t: TranslateFn,
  locale: string
): string | undefined {
  const sections = report.days
    .map((day) => marineForecastDayLines(report.location.label, day, t, locale))
    .filter((lines) => lines.length > 0);
  return sections.length > 0
    ? sections.map((lines) => lines.join('\n')).join('\n\n')
    : undefined;
}

function marineForecastDayLines(
  location: string,
  day: WeatherForecastOutput['days'][number],
  t: TranslateFn,
  locale: string
): string[] {
  const marine = day.marine;
  if (!marine || marine.requested.length === 0) {
    return [];
  }
  const lines: Array<string | undefined> = [];
  const tideRequested = marine.requested.includes('tide');
  if (tideRequested) {
    lines.push(t('official.weather.tideTimes.title', {
      place: location,
      startDate: formatForecastDate(day.date)
    }));
    if (marine.unavailable.includes('tide')) {
      lines.push(t('official.weather.metric.unavailable', {
        metric: t('official.weather.metric.tide')
      }));
    } else {
      lines.push(...marine.tideEvents.map((event) => t(
        event.type === 'high'
          ? 'official.weather.tideTimes.high'
          : 'official.weather.tideTimes.low',
        {
          time: formatTideTime(event.time),
          height: formatMetric(event.height, locale, 2)
        }
      )));
    }
  } else {
    lines.push(t('official.weather.marine.forecastTitle', {
      location,
      date: formatForecastDate(day.date)
    }));
  }

  if (marine.requested.includes('wave')) {
    lines.push(
      marine.unavailable.includes('wave')
        ? t('official.weather.metric.unavailable', { metric: t('official.weather.metric.wave') })
        : nonEmpty([
            metricLine(t, locale, 'official.weather.metric.waveHeightMax', marine.waveHeightMax),
            metricLine(t, locale, 'official.weather.metric.waveDirection', marine.waveDirectionDominant),
            metricLine(t, locale, 'official.weather.metric.wavePeriodMax', marine.wavePeriodMax)
          ]).join(', ')
    );
  }
  if (marine.requested.includes('oceanCurrent')) {
    lines.push(
      marine.unavailable.includes('oceanCurrent')
        ? t('official.weather.metric.unavailable', { metric: t('official.weather.metric.oceanCurrentVelocity') })
        : nonEmpty([
            metricLine(t, locale, 'official.weather.metric.oceanCurrentVelocityMax', marine.oceanCurrentVelocityMax),
            metricLine(t, locale, 'official.weather.metric.oceanCurrentDirection', marine.oceanCurrentDirectionAtMax),
            marine.oceanCurrentTime
              ? t('official.weather.metric.atTime', { time: formatTideTime(marine.oceanCurrentTime) })
              : undefined
          ]).join(', ')
    );
  }
  if (marine.requested.includes('seaSurfaceTemperature')) {
    lines.push(
      marine.unavailable.includes('seaSurfaceTemperature')
        ? t('official.weather.metric.unavailable', { metric: t('official.weather.metric.seaSurfaceTemperature') })
        : nonEmpty([
            metricLine(t, locale, 'official.weather.metric.seaSurfaceTemperatureMin', marine.seaSurfaceTemperatureMin),
            metricLine(t, locale, 'official.weather.metric.seaSurfaceTemperatureMax', marine.seaSurfaceTemperatureMax)
          ]).join(', ')
    );
  }
  return nonEmpty(lines);
}

function metricLine(t: TranslateFn, locale: string, key: string, metric?: WeatherMetricValue): string | undefined {
  return metric ? `${t(key)}: ${formatMetric(metric, locale)}` : undefined;
}

function formatMetric(metric: WeatherMetricValue, locale: string, fractionDigits = 1): string {
  const value = new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits === 2 ? 2 : 0,
    maximumFractionDigits: fractionDigits
  }).format(metric.value);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

function formatTideTime(value: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(value);
  return match ? `${match[1]}h${match[2]}` : value;
}

function formatForecastDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value;
}

function nonEmpty(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value?.trim()));
}
