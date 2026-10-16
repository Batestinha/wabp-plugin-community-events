const { test } = require('node:test');
const assert = require('node:assert/strict');
const { eventsConfigSchema, localizeDefaultEventProfiles } = require('../dist/config');
const { eventsStoredConfigSchema, materializeEventText, migrateEventTextLayers, eventMessageSeeds } = require('../dist/savedText');
const { resolveLocalizedTextTree, preserveLocalizedTextTree } = require('@wabs/plugin-sdk/configuration');

test('migration materializes every shipped message and the legacy default profile in both languages', () => {
  const legacy = eventsConfigSchema.parse({});
  const saved = materializeEventText(legacy);
  for (const [locale, catalog] of Object.entries(eventMessageSeeds)) {
    assert.deepEqual(saved.messages.catalogs[locale], catalog);
    const resolved = eventsConfigSchema.parse(resolveLocalizedTextTree(saved, locale));
    const expected = localizeDefaultEventProfiles(legacy.eventProfiles, key => catalog[key]);
    assert.deepEqual(resolved.eventProfiles.map(({ textVersion, ...profile }) => profile), expected);
    assert.deepEqual(localizeDefaultEventProfiles(resolved.eventProfiles, () => 'NEW PACKAGE TEXT'), resolved.eventProfiles);
  }
});

test('custom profile text keeps its original bytes in each initial language', () => {
  const legacy = eventsConfigSchema.parse({});
  legacy.eventProfiles[0].id = 'topomareevents';
  legacy.eventProfiles[0].label = 'Topo & Maré Events';
  legacy.eventProfiles[0].poll.titleTemplate = '  {place}\n{startDate}  ';
  const saved = materializeEventText(legacy);
  assert.equal(saved.eventProfiles[0].poll.titleTemplate.$text.en, legacy.eventProfiles[0].poll.titleTemplate);
  assert.equal(saved.eventProfiles[0].poll.titleTemplate.$text['pt-PT'], legacy.eventProfiles[0].poll.titleTemplate);
  assert.deepEqual(materializeEventText(saved), saved);
});

test('installed scope translations take precedence over global and package seeds', () => {
  const key = Object.keys(eventMessageSeeds.en)[0];
  const patches = migrateEventTextLayers({ scopes: [{ id: 'one', parentScopeId: null }], layers: [{ id: 'instance', scopeId: 'one', config: {} }],
    languagePacks: [
      { scopeKind: 'GLOBAL', scopeId: 'global', locale: 'pt-PT', catalogs: { 'official.community-events': { [key]: 'global wording' } } },
      { scopeKind: 'SCOPE', scopeId: 'one', locale: 'pt-PT', catalogs: { 'official.community-events': { [key]: 'my wording' } } },
      { scopeKind: 'SCOPE', scopeId: 'another', locale: 'pt-PT', catalogs: { 'official.community-events': { [key]: 'another community' } } }
    ] });
  assert.equal(patches[0].config.messages.catalogs['pt-PT'][key], 'my wording');
});

test('saves and package updates retain edits, and validate every language', () => {
  const saved = materializeEventText({});
  const key = 'official.community-events.cancelled';
  saved.messages.catalogs.en[key] = 'Saved custom cancellation.';
  saved.eventProfiles[0].questions[0].prompt.$text['pt-PT'] = 'O teu local?';
  assert.deepEqual(eventsStoredConfigSchema.parse(saved), saved);
  const resolved = resolveLocalizedTextTree(saved, 'pt-PT');
  resolved.eventProfiles[0].weather.enabled = true;
  const preserved = preserveLocalizedTextTree(resolved, saved);
  assert.deepEqual(preserved.eventProfiles[0].questions[0].prompt, saved.eventProfiles[0].questions[0].prompt);
  saved.eventProfiles[0].poll.titleTemplate.$text['pt-PT'] = '{unsupportedToken}';
  assert.equal(eventsStoredConfigSchema.safeParse(saved).success, false);
});

test('new required catalog keys are added without replacing any saved key', () => {
  const saved = materializeEventText({});
  const key = 'official.community-events.cancelled';
  delete saved.messages.catalogs.en[key];
  saved.messages.catalogs.en['official.community-events.invalid'] = 'Keep this.';
  const next = eventsStoredConfigSchema.parse(saved);
  assert.equal(next.messages.catalogs.en[key], eventMessageSeeds.en[key]);
  assert.equal(next.messages.catalogs.en['official.community-events.invalid'], 'Keep this.');
});
