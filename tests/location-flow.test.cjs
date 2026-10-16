const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createEventFlowDefinition, restoreEventFlowDefinition, eventInitialFlowData, eventFlowAnswers, eventFlowLocation } = require('../dist/flow');
const { resolveFlowStepInputForEngine } = require('@wabs/plugin-sdk/flow-input');
const { parseEventsConfig } = require('../dist/config');
const { eventsMessages } = require('../dist/messages');
const t = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), eventsMessages[key] ?? key);
function fixture(overrides = {}) {
  const profile = structuredClone(parseEventsConfig({}).eventProfiles[0]);
  Object.assign(profile, overrides.profile);
  const values = new Map(), calls = [];
  const services = { call: async input => {
    calls.push(input);
    if (input.method === 'timezoneForPoint') return { timezone: 'Asia/Tokyo', candidates: ['Asia/Tokyo'] };
    return { provider: 'fixture', fetchedAt: '2026-10-16T09:00:00.000Z', results: [
      { label: `${input.input.query}, Tokyo`, point: { latitude: 35, longitude: 139 }, address: {}, attribution: { text: 'fixture', url: 'https://example.test' } },
      { label: `${input.input.query}, Lisbon`, point: { latitude: 38, longitude: -9 }, timezone: 'Europe/Lisbon', address: {}, attribution: { text: 'fixture', url: 'https://example.test' } }
    ] };
  }};
  const ephemeralStore = { get: async key => values.get(key), set: async (key, value, ttl) => {
    assert.equal(ttl, 3600); values.set(key, structuredClone(value));
  }};
  const initialData = eventInitialFlowData([profile], { profileId: profile.id, answers: overrides.answers ?? {}, spanKind: 'day_trip' });
  const input = { t, profiles: [profile], initialData, timezone: 'UTC', locale: 'en', now: () => new Date('2026-10-16T23:30:00Z'),
    locationResolution: { services, ephemeralStore, scopeId: 'scope', actorIdentityId: 'creator' } };
  let definition = createEventFlowDefinition(input);
  let state = { currentStepId: definition.initialStepId, data: initialData, history: [], navigationStack: [] };
  return { profile, calls, values, services, get definition() { return definition; }, get state() { return state; },
    prompt: () => definition.steps[state.currentStepId].promptMessageForState(state),
    async answer(text) {
      const result = await resolveFlowStepInputForEngine(definition, state, text);
      if (result.state) state = result.state;
      if (result.status === 'back') {
        // The host owns checkpoint restoration after the SDK's back request.
        const checkpoint = state.navigationStack.at(-1);
        const data = { ...state.data };
        if (checkpoint.priorValuePresent) data[checkpoint.stepId] = checkpoint.priorValue;
        else delete data[checkpoint.stepId];
        state = { ...state, data, currentStepId: checkpoint.stepId,
          navigationStack: state.navigationStack.slice(0, -1), history: state.history.slice(0, -1) };
      }
      return result;
    },
    restart() { state = JSON.parse(JSON.stringify(state)); definition = restoreEventFlowDefinition({ ...input, flowType: definition.flowType }); }
  };
}

test('disambiguates immediately after place, survives restart and parses later dates in that timezone', async () => {
  const f = fixture();
  await f.answer('Praia');
  assert.equal(f.state.currentStepId, 'location-climbing');
  assert.match((await f.prompt()).text, /1\. Praia, Tokyo/);
  f.restart();
  await f.answer('1');
  assert.equal(f.state.currentStepId, 'q-climbing-startDate');
  assert.equal(f.state.data['q-climbing-place'], 'Praia');
  assert.equal(eventFlowLocation(f.state.data, f.profile).timezone, 'Asia/Tokyo');
  await f.answer('2026-10-20'); await f.answer('09:30'); await f.answer('Bouldering');
  assert.equal(f.state.currentStepId, 'confirm-climbing');
  const answers = eventFlowAnswers({ state: f.state, flowType: f.definition.flowType }, f.profile, 'UTC');
  assert.equal(answers.startsAt.toISOString(), '2026-10-20T00:30:00.000Z');
  assert.equal(answers.answers.place, 'Praia');
  assert.equal(f.calls.filter(call => call.method === 'geocode').length, 1);
  assert(f.calls.every(call => call.scopeId === 'scope' && call.actorIdentityId === 'creator'));
});

test('refines the coordinate search without changing the chosen event place', async () => {
  const f = fixture(); await f.answer('Praia'); await f.prompt();
  const result = await f.answer('Sesimbra');
  assert.equal(result.status, 'error'); assert.match(result.reply, /1\. Sesimbra, Tokyo/);
  f.restart(); await f.answer('2');
  assert.equal(f.state.currentStepId, 'q-climbing-startDate');
  assert.equal(eventFlowLocation(f.state.data, f.profile).displayLabel, 'Praia');
  assert.equal(eventFlowLocation(f.state.data, f.profile).query, 'Sesimbra');
});

test('back navigation and a changed place require a new location confirmation', async () => {
  const f = fixture(); await f.answer('Praia'); await f.prompt(); await f.answer('1');
  await f.answer('/back'); assert.equal(f.state.currentStepId, 'location-climbing');
  await f.answer('/back'); assert.equal(f.state.currentStepId, 'q-climbing-place');
  await f.answer('Porto'); assert.equal(f.state.currentStepId, 'location-climbing');
  assert.equal(eventFlowLocation(f.state.data, f.profile), undefined);
  assert.match((await f.prompt()).text, /1\. Porto, Tokyo/);
});

test('prefilled places are confirmed before asking the remaining questions', () => {
  const f = fixture({ answers: { place: 'Praia' } });
  assert.equal(f.state.currentStepId, 'location-climbing');
});

test('fixed locations bypass geocoding', async () => {
  const f = fixture({ profile: { location: { source: 'fixed', label: 'Tokyo', latitude: 35, longitude: 139, timezone: 'Asia/Tokyo' } } });
  await f.answer('Praia'); assert.equal(f.state.currentStepId, 'q-climbing-startDate'); assert.equal(f.calls.length, 0);
});

test('expired results and invalid numbers cannot select a different or unseen place', async () => {
  const f = fixture(); await f.answer('Praia'); await f.prompt();
  assert.equal((await f.answer('99')).status, 'error'); assert.equal(f.state.currentStepId, 'location-climbing');
  f.values.clear(); const expired = await f.answer('1');
  assert.equal(expired.status, 'error'); assert.match(expired.reply, /1\. Praia, Tokyo/);
  assert.equal(eventFlowLocation(f.state.data, f.profile), undefined);
  await f.answer('1'); assert.equal(f.state.currentStepId, 'q-climbing-startDate');
});

test('service failure and cancellation never advance the questionnaire', async () => {
  const f = fixture(); await f.answer('Praia');
  f.services.call = async () => { throw new Error('unavailable'); };
  assert.equal((await f.prompt()).text, t('official.community-events.location.failed'));
  assert.equal((await f.answer('1')).status, 'error');
  assert.equal(f.state.currentStepId, 'location-climbing');
  assert.equal((await f.answer('/cancel')).status, 'cancelled');
});

test('editing a changed place inserts disambiguation before later review questions', async () => {
  const f = fixture();
  const initialData = eventInitialFlowData([f.profile], { profileId: f.profile.id, spanKind: 'day_trip', answers: { place: 'Old beach' } });
  const definition = createEventFlowDefinition({ t, profiles: [f.profile], initialData, askPrefilledQuestions: true,
    flowTypePrefix: 'official.community-events.update', prefill: { profileId: f.profile.id, answers: { place: 'Old beach' } },
    locationResolution: { services: f.services, ephemeralStore: { get: async () => undefined, set: async () => {} }, scopeId: 'scope', actorIdentityId: 'creator' } });
  const result = await resolveFlowStepInputForEngine(definition, { currentStepId: 'q-climbing-place', data: initialData, history: [], navigationStack: [] }, 'New beach');
  assert.equal(result.state.currentStepId, 'location-climbing');
});

test('a kept edit location retains its confirmed coordinates without another search', async () => {
  const f = fixture();
  const prefill = { profileId: f.profile.id, spanKind: 'day_trip', answers: { place: 'Praia' } };
  const initialData = eventInitialFlowData([f.profile], prefill);
  initialData['location-climbing'] = { source: 'question', displayLabel: 'Praia', resolvedLabel: 'Praia, Tokyo', timezone: 'Asia/Tokyo', latitude: 35, longitude: 139 };
  const definition = createEventFlowDefinition({ t, profiles: [f.profile], initialData, prefill, askPrefilledQuestions: true,
    flowTypePrefix: 'official.community-events.update', locationResolution: { scopeId: 'scope', actorIdentityId: 'creator' } });
  const result = await resolveFlowStepInputForEngine(definition, { currentStepId: 'q-climbing-place', data: initialData, history: [], navigationStack: [] }, '/keep');
  assert.equal(result.state.currentStepId, 'q-climbing-startDate');
  assert.equal(eventFlowLocation(result.state.data, f.profile).timezone, 'Asia/Tokyo');
});
