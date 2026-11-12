const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseEventsConfig } = require('../dist/config');
const { renderEventWeatherForecastDays } = require('../dist/weather');

const m = (value, unit) => ({ value, unit });
const event = {
  id: 'evt-fixture', scopeId: 'fixture-scope', groupId: 'source-group', groupWid: 'source@g.us',
  profileId: 'climbing', profileRevision: 'fixture-revision', profileLabel: 'Climbing',
  actorIdentityId: 'fixture-actor', actorWid: 'creator@lid', actorLabel: 'Creator',
  pollOptions: [], responseClasses: [], answers: { place: 'Climb UP' },
  startsAt: '2026-11-08T09:00:00.000Z', endsAt: '2026-11-09T18:00:00.000Z', spanKind: 'multi_day',
  timezone: 'Europe/Lisbon', groupTitle: 'Climb UP', subgroupChatId: 'climb@g.us',
  createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z'
};
const report = {
  provider: 'open-meteo', fetchedAt: '2026-11-07T07:00:00.000Z',
  location: { label: 'Climb UP', latitude: 38.7, longitude: -9.4, timezone: 'Europe/Lisbon' },
  units: { temperatureUnit: 'celsius', windSpeedUnit: 'kmh', precipitationUnit: 'mm' },
  days: [
    { date: '2026-11-08', weatherCode: 61, temperatureMax: m(21.1, '°C'), temperatureMin: m(17.1, '°C') },
    { date: '2026-11-09', weatherCode: 3 }
  ]
};
const presentation = {
  locale: 'pt-PT', style: 'emoji', title: '*Climb UP* · previsão',
  days: [{
    date: '2026-11-08', label: 'dom, 8 nov', condition: { code: 61, text: 'Chuva', emoji: '🌧️' },
    weatherText: '🌧️ Chuva\n🌡️ 17–21 °C · 💧 63–91 %\n☔ 85 % · 4,2 mm\n💨 34 km/h de SE · rajadas 75 km/h',
    marineText: '🌊 ⬆️ 02h09 3,7 m · ⬇️ 07h56 0,8 m\n🌊 ⬆️ 14h28 3,7 m · ⬇️ 20h13 0,8 m',
    text: 'unused'
  }, {
    date: '2026-11-09', label: 'seg, 9 nov', condition: { code: 3, text: 'Encoberto', emoji: '☁️' },
    weatherText: '☁️ Encoberto', text: 'unused'
  }],
  footnote: '_Marés: previsão FCUL calibrada para Cascais, zero hidrográfico._',
  text: 'unused'
};

function profileWith(template) {
  const profile = structuredClone(parseEventsConfig({}).eventProfiles[0]);
  profile.weather = { ...profile.weather, enabled: true, template };
  return profile;
}

test('an event delivery is one message: each day through the profile template with its tides, then one source note', () => {
  const profile = profileWith("Previsão do tempo para '{place}: {weekday}, {dd}-{mm}-{yy}':\n{weatherSummary}");
  const { meteorologicalText } = renderEventWeatherForecastDays({
    event, profile, report, presentation, forecastDays: report.days, locale: 'pt-PT'
  });
  assert.equal(meteorologicalText, [
    "Previsão do tempo para 'Climb UP: dom, 08-11-26':",
    '🌧️ Chuva',
    '🌡️ 17–21 °C · 💧 63–91 %',
    '☔ 85 % · 4,2 mm',
    '💨 34 km/h de SE · rajadas 75 km/h',
    '🌊 ⬆️ 02h09 3,7 m · ⬇️ 07h56 0,8 m',
    '🌊 ⬆️ 14h28 3,7 m · ⬇️ 20h13 0,8 m',
    '',
    "Previsão do tempo para 'Climb UP: seg, 09-11-26':",
    '☁️ Encoberto',
    '',
    '_Marés: previsão FCUL calibrada para Cascais, zero hidrográfico._'
  ].join('\n'));
});

test('weatherDate is the weather day label, the condition tokens are available, and inland days get no source note', () => {
  const template = '{weatherEmoji} {weatherCondition} on {weatherDate}\n{weatherSummary}';
  assert.doesNotThrow(() => parseEventsConfig({ eventProfiles: [profileWith(template)] }));
  const inland = { ...presentation, days: presentation.days.map(({ marineText, ...day }) => day) };
  const { meteorologicalText } = renderEventWeatherForecastDays({
    event, profile: profileWith(template), report, presentation: inland, forecastDays: [report.days[0]], locale: 'pt-PT'
  });
  assert.equal(meteorologicalText, [
    '🌧️ Chuva on dom, 8 nov',
    '🌧️ Chuva',
    '🌡️ 17–21 °C · 💧 63–91 %',
    '☔ 85 % · 4,2 mm',
    '💨 34 km/h de SE · rajadas 75 km/h'
  ].join('\n'));
});
