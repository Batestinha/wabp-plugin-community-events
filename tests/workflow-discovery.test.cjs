const assert = require('node:assert/strict');
const { test } = require('node:test');
const store = require('../dist/store');
const commands = require('../dist/commands');
const { registerEventWorkflowServices } = require('../dist/workflowActions');
const { parseEventsConfig } = require('../dist/config');

function fixture(t, events) {
  const config = parseEventsConfig({ enabled: true });
  const profile = config.eventProfiles[0];
  t.mock.method(store, 'listScopeEvents', (_db, scopeId) => events.filter(e => e.scopeId === scopeId));
  t.mock.method(store, 'getEvent', (_db, id) => events.find(e => e.id === id));
  t.mock.method(commands, 'eventUpdateAllowed', async (_ctx, { event }) => event.allowed !== false);
  t.mock.method(commands, 'eventIsEditable', event => event.eventStatus === 'active');
  t.mock.method(commands, 'eventUpdatePrefill', () => ({}));
  const calls = [];
  const context = { pluginId: 'official.community-events', enabledFor: async () => true, configFor: async () => config,
    resolveStableIdentityById: async id => ({ identityId: id }), flowEngine: {}, enqueuePluginJob: async () => {},
    databases: { open: () => ({}) }, platform: { transport: {} },
    i18n: { resolveScopeLocale: async () => ({ locale: 'pt-PT' }), translatorForIdentity: async () => key => key },
    services: { call: async input => { calls.push(input); return { provider: 'fixture', fetchedAt: '2026-10-04T00:00:00Z',
      results: [{ label: 'Éden, Sintra', point: { latitude: 38.8, longitude: -9.4 }, timezone: 'Europe/Lisbon',
        address: {}, providerRef: 'eden', attribution: { text: 'Fixture', url: 'https://example.test' } }] }; } } };
  const methods = registerEventWorkflowServices(context)[0].methods;
  const describe = async (input = {}, overrides = {}) => {
    const method = methods.find(m => m.name === 'editDescribe');
    return method.handler(method.inputSchema.parse({ input }), { scopeId: 'scope', actorIdentityId: 'requester',
      groupWid: 'event@g.us', ...overrides });
  };
  const event = overrides => ({ id: 'event', scopeId: 'scope', eventStatus: 'active', profileId: profile.id,
    subgroupChatId: 'event@g.us', groupWid: 'announcements@g.us', groupTitle: 'Original event title',
    startsAt: '2027-10-04T14:00:00Z', timezone: 'Europe/Lisbon', answers: {}, updatedAt: 'revision', ...overrides });
  return { describe, event, calls, context };
}

test('resolves this event by exact subgroup, independently of title, query and candidate limit', async t => {
  const events = [], f = fixture(t, events);
  for (let n = 0; n < 105; n++) events.push(f.event({ id: `old-${n}`, subgroupChatId: `old-${n}@g.us` }));
  events.push(f.event({}));
  const result = await f.describe({ query: 'A renamed WhatsApp title' });
  assert.equal(result.currentGroupEvent.id, 'event');
  assert.deepEqual(result.candidates, []);
  assert.equal((await f.describe()).candidates.length, 100);
  assert.equal((await f.describe({}, { groupWid: 'announcements@g.us' })).currentGroupEvent, null);
});

test('does not guess absent, unauthorized, cross-scope, inactive or duplicate bindings', async t => {
  const events = [], f = fixture(t, events);
  assert.equal((await f.describe()).currentGroupEvent, null);
  events.push(f.event({ allowed: false }), f.event({ id: 'other-scope', scopeId: 'other' }),
    f.event({ id: 'cancelled', eventStatus: 'cancelled' }));
  assert.equal((await f.describe()).currentGroupEvent, null);
  assert.deepEqual((await f.describe()).candidates, []);
  events.push(f.event({ id: 'one' }), f.event({ id: 'two' }));
  assert.equal((await f.describe()).currentGroupEvent, null);
});

test('explicit event selection is preserved and place lookup returns authoritative full location objects', async t => {
  const events = [], f = fixture(t, events);
  events.push(f.event({}), f.event({ id: 'explicit', subgroupChatId: 'elsewhere@g.us' }));
  const result = await f.describe({ eventId: 'explicit', locationQuery: 'Éden' });
  assert.equal(result.eventId, 'explicit');
  assert.deepEqual(result.locationCandidates[0].location, { source: 'question', displayLabel: 'Éden',
    resolvedLabel: 'Éden, Sintra', latitude: 38.8, longitude: -9.4, timezone: 'Europe/Lisbon',
    query: 'Éden', provider: 'fixture', providerRef: 'eden' });
  assert.equal(f.calls[0].actorIdentityId, 'requester');
  assert.equal(f.calls[0].scopeId, 'scope');
  assert.equal(f.calls[0].method, 'geocode');
  assert.ok(result.describeInputSchema.properties.locationQuery);
});

test('authorization precedes geocoding and timezone lookup never invents a fallback', async t => {
  const events = [], f = fixture(t, events);
  events.push(f.event({ allowed: false }));
  await assert.rejects(f.describe({ eventId: 'event', locationQuery: 'Éden' }), /permissionDenied/);
  assert.equal(f.calls.length, 0);
  events[0].allowed = true;
  f.context.services.call = async input => input.method === 'geocode'
    ? { provider: 'fixture', fetchedAt: '2026-10-04T00:00:00Z', results: [{ label: 'Ambiguous place',
      point: { latitude: 1, longitude: 1 }, address: {}, attribution: { text: 'Fixture', url: 'https://example.test' } }] }
    : { timezone: null, candidates: [] };
  await assert.rejects(f.describe({ eventId: 'event', locationQuery: 'Éden' }));
});
