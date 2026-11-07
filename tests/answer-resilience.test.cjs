const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createEventFlowDefinition, eventInitialFlowData, eventFlowAnswers, eventFlowLocation } = require('../dist/flow');
const { resolveFlowStepInputForEngine } = require('@wabs/plugin-sdk/flow-input');
const { parseEventsConfig } = require('../dist/config');
const { eventsMessages } = require('../dist/messages');
const { findEmbeddedDateTime, normalizeNumberWords, eventReplyControl, EVENT_CARRIED_ANSWERS_KEY } = require('../dist/answerResilience');
const { eventPlaceSearchQuery, typedLocationChoice } = require('../dist/eventLocationFlow');
const { parseEventEditRequest, eventEditStart } = require('../dist/editRequest');
const { eventBiasBounds } = require('../dist/placeHints');

const t = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), eventsMessages[key] ?? key);
// 2026-11-01 19:14 UTC: the evening David created his event.
const NOW = new Date('2026-11-01T19:14:00Z');
const lisbon = { timezone: 'Europe/Lisbon', locale: 'pt-PT', now: NOW };

function place(label, extra = {}) {
  return { label, point: { latitude: 38.8, longitude: -9.4 }, timezone: 'Europe/Lisbon', address: {},
    attribution: { text: 'fixture', url: 'https://example.test' }, ...extra };
}

function fixture(options = {}) {
  const profile = structuredClone(parseEventsConfig({}).eventProfiles[0]);
  if (options.optionalTime) profile.questions.find(question => question.key === 'startTime').required = false;
  const values = new Map(), calls = [];
  // Like Nominatim: nothing is named after a date, plain names resolve.
  const geocode = options.geocode ?? (query => /\d/.test(query) ? [] : [place(`${query}, Lisboa, Portugal`)]);
  const services = { call: async input => {
    calls.push(input);
    if (input.method === 'timezoneForPoint') return { timezone: 'Europe/Lisbon', candidates: ['Europe/Lisbon'] };
    return { provider: 'fixture', fetchedAt: NOW.toISOString(), results: geocode(input.input.query) };
  } };
  const ephemeralStore = { get: async key => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)); } };
  const prefill = { profileId: profile.id, answers: options.answers ?? {}, spanKind: 'day_trip' };
  const initialData = options.initialData ?? eventInitialFlowData([profile], prefill, { ...lisbon });
  const definition = createEventFlowDefinition({ t, profiles: [profile], initialData, timezone: 'Europe/Lisbon', locale: 'pt-PT',
    now: () => NOW, knownPlaces: options.knownPlaces ?? [], ...(options.edit ? {
      askPrefilledQuestions: true, flowTypePrefix: 'official.community-events.update', prefill, allowPastStartsAt: true,
      ...(options.editFields ? { editFields: options.editFields } : {})
    } : {}),
    locationResolution: { services, ephemeralStore, scopeId: 'scope', actorIdentityId: 'creator' } });
  let state = { currentStepId: definition.initialStepId, data: options.startData ?? initialData, history: [], navigationStack: [] };
  return { profile, calls, definition, get state() { return state; },
    prompt: async () => {
      const step = definition.steps[state.currentStepId];
      return step.promptMessageForState ? (await step.promptMessageForState(state)).text : step.promptForState?.(state) ?? step.prompt;
    },
    async answer(text) {
      const result = await resolveFlowStepInputForEngine(definition, state, text);
      if (result.state) state = result.state;
      return result;
    },
    answers: () => eventFlowAnswers({ state, flowType: definition.flowType }, profile, 'Europe/Lisbon', 'pt-PT') };
}

test('finds dates typed into a place answer and leaves date-named places alone', () => {
  const cases = {
    'Sintra dia 4 de novembro': { remainder: 'Sintra', strong: true, date: '2026-11-4' },
    'Sintra, 4 de novembro': { remainder: 'Sintra', strong: true, date: '2026-11-4' },
    'Sintra 4 nov 13h': { remainder: 'Sintra', strong: true, date: '2026-11-4', time: '13:0' },
    'Sintra amanhã às 9': { remainder: 'Sintra', strong: true, date: '2026-11-2', time: '9:0' },
    'Peninha dia 8 às 15h00': { remainder: 'Peninha', strong: true, date: '2026-11-8', time: '15:0' },
    'Mexilhoeiro 2026-11-07': { remainder: 'Mexilhoeiro', strong: true, date: '2026-11-7' },
    'Ponte 25 de Abril': { remainder: 'Ponte', strong: false },
    'Praia de Domingo': { remainder: 'Praia', strong: false },
    'amanhã': { whole: true, date: '2026-11-2' },
    '15h00': { whole: true, time: '15:0' }
  };
  for (const [text, expected] of Object.entries(cases)) {
    const found = findEmbeddedDateTime(text, lisbon);
    if (expected.remainder !== undefined) assert.equal(found.remainder, expected.remainder, text);
    if (expected.strong !== undefined) assert.equal(found.strong, expected.strong, text);
    if (expected.whole) assert.equal(found.whole, true, text);
    if (expected.date) assert.equal(`${found.date.year}-${found.date.month}-${found.date.day}`, expected.date, text);
    if (expected.time) assert.equal(`${found.time.hour}:${found.time.minute}`, expected.time, text);
  }
  for (const text of ['Sintra', 'Tapada (maybe?)', 'Cascais/Sintra (Por decidir)', 'Prison Break & Talismã', 'Campo Base S', 'Inwall']) {
    assert.equal(findEmbeddedDateTime(text, lisbon).fragments.length, 0, text);
  }
  // 26/09 was in the future when Diogo typed it at "Onde?" on 09-21.
  const whole = findEmbeddedDateTime('26/09/2026', { ...lisbon, now: new Date('2026-09-21T20:12:00Z') });
  assert.equal(whole.whole, true);
  assert.deepEqual(whole.date, { year: 2026, month: 9, day: 26 });
});

test('reads spelled-out counts and bare control words', () => {
  assert.equal(normalizeNumberWords('Daqui a dois dias'), 'Daqui a 2 dias');
  assert.equal(normalizeNumberWords('daqui a vinte e um dias'), 'daqui a 21 dias');
  assert.equal(normalizeNumberWords('Praia a dois passos'), 'Praia a dois passos');
  assert.equal(eventReplyControl('Skip'), 'skip');
  assert.equal(eventReplyControl('Keep'), 'keep');
  assert.equal(eventReplyControl('/Manter'), 'keep');
  assert.equal(eventReplyControl('Sim!'), 'accept');
  assert.equal(eventReplyControl('não'), 'reject');
  assert.equal(eventReplyControl('Sintra'), undefined);
});

test('David: a date typed at "Where?" is split off, confirmed once and never asked again', async () => {
  const f = fixture();
  const proposal = await f.answer('Sintra dia 4 de novembro');
  assert.equal(proposal.status, 'error');
  assert.match(proposal.reply, /\*Sintra\*/);
  assert.equal(f.state.currentStepId, 'q-climbing-place');
  await f.answer('ok');
  assert.equal(f.state.data['q-climbing-place'], 'Sintra');
  assert.equal(f.state.currentStepId, 'location-climbing');
  assert.match(await f.prompt(), /1\. Sintra, Lisboa, Portugal/);
  await f.answer('1');
  // The date came from the place answer; the next question is the time.
  assert.equal(f.state.currentStepId, 'q-climbing-startTime');
  await f.answer('13:00');
  await f.answer('Bouldering');
  assert.equal(f.state.currentStepId, 'confirm-climbing');
  const answers = f.answers();
  assert.equal(answers.answers.place, 'Sintra');
  assert.equal(answers.localDate, '2026-11-04');
  assert.equal(answers.localTime, '13:00');
  assert.match(await f.prompt(), /Bouldering in Sintra: /);
  assert.equal(eventFlowLocation(f.state.data, f.profile).displayLabel, 'Sintra');
});

test('a split date also feeds multi-day end validation', async () => {
  const profile = structuredClone(parseEventsConfig({}).eventProfiles[0]);
  const initialData = eventInitialFlowData([profile], { profileId: profile.id, answers: {}, spanKind: 'multi_day' }, lisbon);
  const f = fixture({ initialData });
  await f.answer('Albarracín dia 26 de dezembro');
  await f.answer('ok');
  await f.prompt(); await f.answer('1');
  await f.answer('Bouldering');
  assert.equal(f.state.currentStepId, 'end-date-climbing');
  await f.answer('2027-01-01');
  assert.equal((await f.answer('12:00')).status, 'continue');
  assert.equal(f.answers().localDate, '2026-12-26');
  assert.equal(f.answers().endLocalDate, '2027-01-01');
});

test('answering "no" keeps the whole text as the place and asks the date normally', async () => {
  const f = fixture();
  await f.answer('Sintra dia 4 de novembro');
  await f.answer('não');
  assert.equal(f.state.data['q-climbing-place'], 'Sintra dia 4 de novembro');
  await f.prompt();
  // No coordinates for the full name: refine the search, keep the name.
  assert.equal((await f.answer('Sintra')).status, 'error');
  await f.answer('1');
  assert.equal(eventFlowLocation(f.state.data, f.profile).displayLabel, 'Sintra dia 4 de novembro');
  assert.equal(f.state.currentStepId, 'q-climbing-startDate');
});

test('typing the place again after the proposal replaces it without a split', async () => {
  const f = fixture();
  await f.answer('Sintra dia 4 de novembro');
  await f.answer('Peninha');
  assert.equal(f.state.data['q-climbing-place'], 'Peninha');
  await f.prompt(); await f.answer('1');
  assert.equal(f.state.currentStepId, 'q-climbing-startDate');
});

test('a bare date at "Where?" is kept as a suggestion for the date question', async () => {
  const f = fixture();
  const saved = await f.answer('dia 8');
  assert.equal(saved.status, 'error');
  assert.match(saved.reply, /saved/);
  assert.equal(f.state.currentStepId, 'q-climbing-place');
  await f.answer('Pedra Amarela');
  await f.prompt(); await f.answer('1');
  assert.equal(f.state.currentStepId, 'q-climbing-startDate');
  assert.match(await f.prompt(), /From your earlier answer/);
  await f.answer('ok');
  assert.equal(f.state.data['q-climbing-startDate'].normalized, '2026-11-08');
});

test('known places and geocoder matches keep date-named places intact', async () => {
  const known = fixture({ knownPlaces: ['Ponte 25 de Abril'] });
  assert.equal((await known.answer('Ponte 25 de Abril')).status, 'continue');
  assert.equal(known.state.data['q-climbing-place'], 'Ponte 25 de Abril');
  const geocoded = fixture({ geocode: query => [place(`${query}, Lisboa`, { name: query })] });
  assert.equal((await geocoded.answer('Ponte 25 de Abril')).status, 'continue');
  // No connector, no evidence that the date is separate: never split.
  const nothing = fixture({ geocode: () => [] });
  assert.equal((await nothing.answer('Praia de Domingo')).status, 'continue');
});

test('a weak date splits only when the full text is not a place but the rest is', async () => {
  const f = fixture({ geocode: query => (query === 'Sintra' ? [place('Sintra, Lisboa')] : []) });
  const proposal = await f.answer('Sintra 4 de novembro');
  assert.equal(proposal.status, 'error');
  assert.match(proposal.reply, /\*Sintra\*/);
});

test('plain words work like slash controls and time errors explain the problem', async () => {
  const f = fixture({ optionalTime: true });
  await f.answer('Sintra'); await f.prompt(); await f.answer('1');
  assert.equal((await f.answer('Daqui a dois dias')).status, 'continue');
  assert.equal(f.state.data['q-climbing-startDate'].normalized, '2026-11-03');
  const invalid = await f.answer('13:90');
  assert.equal(invalid.status, 'error');
  assert.match(invalid.reply, /minutes go up to 59/);
  assert.equal((await f.answer('Skip')).status, 'continue');
  assert.equal(f.state.data['q-climbing-startTime'], null);
  assert.match((await f.answer('cancelar')).reply, /\/cancel/);
});

test('"Keep" without the slash keeps the saved answer in an edit', async () => {
  const answers = { place: 'Sintra', startDate: '2026-11-04', startTime: '13:00', style: 'Bouldering' };
  const profile = parseEventsConfig({}).eventProfiles[0];
  const initialData = eventInitialFlowData([profile], { profileId: profile.id, answers, spanKind: 'day_trip' }, lisbon);
  const start = eventEditStart(profile, initialData, { roles: ['time'] }, lisbon);
  const f = fixture({ edit: true, answers, initialData, startData: start.data, editFields: start.fields });
  assert.equal(f.state.currentStepId, 'q-climbing-startTime');
  assert.equal((await f.answer('Keep')).status, 'continue');
  assert.equal(f.state.data['q-climbing-startTime'].normalized, '13:00');
  assert.equal(f.state.currentStepId, 'confirm-climbing');
});

test('edits ask what to change and review only those questions', async () => {
  const answers = { place: 'Sintra dia 4 de novembro', startDate: '2026-11-04', startTime: '13:00', style: 'Bouldering' };
  const f = fixture({ edit: true, answers });
  assert.equal(f.state.currentStepId, 'edit-fields');
  const options = f.definition.steps['edit-fields'].options.map(option => option.label);
  assert.ok(options.includes('Where'));
  await f.answer(String(options.indexOf('Where') + 1));
  assert.equal(f.state.currentStepId, 'q-climbing-place');
  await f.answer('Sintra'); await f.prompt(); await f.answer('1');
  assert.equal(f.state.currentStepId, 'confirm-climbing');
  assert.equal(f.answers().answers.place, 'Sintra');
  assert.equal(f.answers().localDate, '2026-11-04');
});

test('the what-to-change step never allows more selections than its non-exclusive options', () => {
  // 2026-11-07: the core rejected maxSelections=6 with 5 selectable options and every /event edit failed to start.
  const answers = { place: 'Sintra', startDate: '2026-11-04', startTime: '13:00', style: 'Bouldering' };
  const step = fixture({ edit: true, answers }).definition.steps['edit-fields'];
  const selectable = step.options.filter(option => !option.exclusive);
  assert.ok(step.options.some(option => option.exclusive));
  assert.equal(step.minSelections, 1);
  assert.equal(step.maxSelections, selectable.length);
});

test('"/event edit Albarracín hora 15h" selects the time and offers 15:00', async () => {
  const parsed = parseEventEditRequest(['Albarracín', 'hora', '15h']);
  assert.deepEqual(parsed, { query: 'Albarracín', request: { roles: ['time'], value: '15h' } });
  assert.deepEqual(parseEventEditRequest(['Sintra']), { query: 'Sintra' });
  const answers = { place: 'Sintra', startDate: '2026-11-04', startTime: '13:00', style: 'Bouldering' };
  const profile = parseEventsConfig({}).eventProfiles[0];
  const initialData = eventInitialFlowData([profile], { profileId: profile.id, answers, spanKind: 'day_trip' }, lisbon);
  const start = eventEditStart(profile, initialData, parsed.request, lisbon);
  assert.deepEqual(start.fields, ['startTime']);
  assert.equal(start.data[EVENT_CARRIED_ANSWERS_KEY].answers[0].input, '15:00');
  const f = fixture({ edit: true, answers, initialData, startData: start.data, editFields: start.fields });
  assert.equal(f.state.currentStepId, 'q-climbing-startTime');
  assert.match(await f.prompt(), /\*15:00\*/);
  await f.answer('ok');
  assert.equal(f.state.data['q-climbing-startTime'].normalized, '15:00');
  assert.equal(f.state.currentStepId, 'confirm-climbing');
});

test('location replies: notes stay out of the search, a typed result name or "ok" selects it', async () => {
  assert.equal(eventPlaceSearchQuery('Tapada (maybe?)'), 'Tapada');
  assert.equal(eventPlaceSearchQuery('Cascais/Sintra (Por decidir)'), 'Cascais');
  assert.equal(eventPlaceSearchQuery('Azóia ou outro pela margem sul'), 'Azóia');
  assert.equal(eventPlaceSearchQuery('Prison Break & Talismã'), 'Prison Break & Talismã');
  assert.equal(typedLocationChoice([{ label: 'Sintra, Lisboa' }, { label: 'Sintra, Minas Gerais' }], 'Sintra'), undefined);
  assert.equal(typedLocationChoice([{ label: 'Sintra, Lisboa' }, { label: 'Cascais, Lisboa' }], 'sintra'), 0);

  const tapada = fixture();
  await tapada.answer('Tapada (maybe?)'); await tapada.prompt();
  assert.equal(tapada.calls.at(-1).input.query, 'Tapada');
  assert.equal((await tapada.answer('ok')).status, 'continue');
  assert.equal(eventFlowLocation(tapada.state.data, tapada.profile).displayLabel, 'Tapada (maybe?)');

  const typed = fixture({ geocode: () => [place('Sintra'), place('Sintra, Minas Gerais')] });
  await typed.answer('Sintra'); await typed.prompt();
  // Ambiguous, and the same search again (Diogo, 10-17): ask for the number instead of repeating the list.
  const repeated = await typed.answer('Sintra');
  assert.equal(repeated.status, 'error');
  assert.match(repeated.reply, /Reply with the number of the right one \(1 to 2\)/);
  const single = fixture({ geocode: () => [place('Sintra, Lisboa, Portugal')] });
  await single.answer('Sintra'); await single.prompt();
  assert.equal((await single.answer('Sintra')).status, 'continue');
  assert.equal(single.state.currentStepId, 'q-climbing-startDate');
});

test('search bias covers the usual area and ignores one trip abroad', () => {
  const bounds = eventBiasBounds([{ latitude: 38.8, longitude: -9.4 }, { latitude: 38.4, longitude: -9.1 },
    { latitude: 38.7, longitude: -9.0 }, { latitude: 40.4, longitude: -1.4 }]);
  assert.ok(bounds.west < -9.3 && bounds.east < -8.5 && bounds.south < 38.4 && bounds.north > 38.8);
  assert.equal(eventBiasBounds([{ latitude: 38.8, longitude: -9.4 }]), undefined);
});
