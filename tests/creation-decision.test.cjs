const assert = require('node:assert/strict');
const { test } = require('node:test');
const { beginFinalEventCreation, registerFinalEventCreationFlow } = require('../dist/creationDecision');
const { eventFlowAnswersFromRaw } = require('../dist/flow');
const { parseEventsConfig } = require('../dist/config');
const { materializeEventLifecycle } = require('../dist/materialize');
const { eventsMessages } = require('../dist/messages');
const { resolveFlowStepInput } = require('@wabs/plugin-sdk/flow-input');
const t = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), eventsMessages[key] ?? key);

function fixture() {
  const profile = parseEventsConfig({}).eventProfiles[0];
  const answers = eventFlowAnswersFromRaw({ profile, answers: { place: 'Tokyo', startDate: '2026-10-18', startTime: '09:30', style: 'Bouldering' },
    timezone: 'Asia/Tokyo', locale: 'en', spanKind: 'day_trip', now: new Date('2026-10-01T00:00:00Z') });
  const starts = [], handlers = new Map(), resolvers = [], acknowledgements = [], publications = [];
  let session;
  const engine = {
    registerDefinitionResolver: value => resolvers.push(value),
    registerPromptHandler: (purpose, handler, options) => handlers.set(purpose, { handler, options }),
    getSessionSnapshot: async () => session,
    acknowledgePromptLock: async id => acknowledgements.push(id),
    startFlowForIdentity: async input => { starts.push(input); return { flowSessionId: 'final-session' }; }
  };
  const runtime = {};
  const context = { flowEngine: engine, i18n: { translatorForIdentity: async () => t } };
  const input = { context, runtime, activeTransport: {}, responseChatId: 'creator@c.us', profile, answers,
    draft: { schemaVersion: 2, flowSessionId: 'original-session', actorIdentityId: 'creator', scopeId: 'scope', actorLabel: 'Creator', actorWid: 'creator@c.us', locale: 'en' },
    announcementGroupWid: 'announce@g.us', eventLocation: { source: 'question', displayLabel: 'Tokyo', timezone: 'Asia/Tokyo', latitude: 35, longitude: 139 }, t };
  const closeAt = materializeEventLifecycle({ ...input, timezone: 'Asia/Tokyo', locale: 'en', creatorDisplayName: 'Creator' }).closeAt.getTime();
  return { input, closeAt, starts, handlers, resolvers, publications, acknowledgements, engine,
    publish: async value => publications.push(value), setSession: value => { session = value; } };
}

test('asks only after resolved location and persists the actual event clock and original creation ID', async test => {
  const f = fixture(); test.mock.method(Date, 'now', () => f.closeAt - 1);
  await beginFinalEventCreation(f.input, f.publish);
  assert.equal(f.publications.length, 0);
  assert.equal(f.starts.length, 1);
  const start = f.starts[0];
  assert.equal(start.externalIdempotencyKey, 'community-events:publication:original-session');
  const step = start.definition.steps[start.definition.initialStepId];
  assert.match(step.prompt, /09:30/);
  assert.deepEqual(step.options.map(option => option.value), ['poll', 'unplanned']);
  assert.equal(resolveFlowStepInput(start.definition, { currentStepId: step.id, data: start.initialData, history: [] }, '=').status, 'error');
  assert.equal(resolveFlowStepInput(start.definition, { currentStepId: step.id, data: start.initialData, history: [] }, '/skip').status, 'error');
});

for (const delta of [0, 1]) test(`omits the final choice when the poll deadline is reached (${delta} ms)`, async test => {
  const f = fixture(); test.mock.method(Date, 'now', () => f.closeAt + delta);
  await beginFinalEventCreation(f.input, f.publish);
  assert.equal(f.starts.length, 0);
  assert.equal(f.publications.length, 1);
  assert.equal(f.publications[0].draft.flowSessionId, 'original-session');
});

for (const phase of ['poll', 'unplanned']) test(`preserves a legacy ${phase} choice without adding a new prompt`, async test => {
  const f = fixture(); test.mock.method(Date, 'now', () => f.closeAt - 1);
  f.input.draft.schemaVersion = 1; f.input.answers.pollPhase = phase;
  await beginFinalEventCreation(f.input, f.publish);
  assert.equal(f.starts.length, 0);
  assert.equal(f.publications[0].answers.pollPhase, phase);
});

test('recovers a serialized completed choice after restart, binds it to its creator and retries until acknowledged', async test => {
  const f = fixture(); test.mock.method(Date, 'now', () => f.closeAt - 1);
  await beginFinalEventCreation(f.input, f.publish);
  const start = f.starts[0];
  const state = resolveFlowStepInput(start.definition, { currentStepId: start.definition.initialStepId, history: [], data: start.initialData }, '1').state;
  const snapshot = JSON.parse(JSON.stringify({ id: 'final-session', flowType: start.definition.flowType, status: 'COMPLETED', identityId: 'creator', scopeId: 'scope', chatId: 'fallback@g.us', state }));
  const recovered = fixture(); recovered.setSession(snapshot);
  let failed = true;
  registerFinalEventCreationFlow(recovered.input.context, recovered.input.runtime, async input => {
    if (failed) { failed = false; throw new Error('temporary publication error'); }
    await recovered.publish(input);
  });
  const restored = await recovered.resolvers[0].resolve(snapshot);
  const registration = recovered.handlers.get(`flow.${restored.flowType}.${restored.initialStepId}`);
  assert.deepEqual(registration.options, { recoverLocked: true });
  const lock = { flowSessionId: 'final-session', flowPromptId: 'prompt', voterIdentityId: 'creator' };
  assert.equal(await registration.handler({ ...lock, voterIdentityId: 'someone-else' }, {}), false);
  await assert.rejects(registration.handler(lock, {}), /temporary/);
  assert.equal(recovered.acknowledgements.length, 0);
  await registration.handler(lock, {});
  assert.deepEqual(recovered.acknowledgements, ['prompt']);
  assert.equal(recovered.publications[0].responseChatId, 'fallback@g.us');
  assert.equal(recovered.publications[0].answers.pollPhase, 'poll');
  assert.equal(recovered.publications[0].answers.startsAt.toISOString(), f.input.answers.startsAt.toISOString());
  await assert.rejects(recovered.resolvers[0].resolve({ ...snapshot, identityId: 'other' }), /does not match/);
  recovered.setSession({ ...snapshot, status: 'CANCELLED' });
  assert.equal(await registration.handler(lock, {}), false);
});
