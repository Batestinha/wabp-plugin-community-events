const assert = require('node:assert/strict');
const { test } = require('node:test');
const manifest = require('../wa-plugin.json');
const { eventTextDefinitions } = require('../dist/messageDefinitions');
const { eventsMessages } = require('../dist/messages');
const { eventsControls } = require('../dist/controls');
const { materializeEventText } = require('../dist/savedText');

test('every catalog entry has exactly one reachable inline placement', () => {
  assert.deepEqual(eventTextDefinitions.map(row => row.key).sort(), Object.keys(eventsMessages).sort());
  const ui = manifest.operatorConsole;
  assert.deepEqual(ui.settings.sections.map(row => row.id), ['general', 'event-profiles', 'calendars', 'events-recovery']);
  assert.equal(ui.pages.length, 0, 'The platform owns the settings page');
  for (const definition of eventTextDefinitions) {
    const { placement } = definition;
    const section = ui.settings.sections.find(section => section.id === placement.sectionId);
    assert.ok(section, definition.key);
    if (placement.controlId) {
      assert.ok(section.controlIds.includes(placement.controlId), definition.key);
      const owner = ui.controls.find(control => control.id === placement.controlId);
      if (placement.slotId) assert.ok(owner.ui.builderTextSlots.includes(placement.slotId), definition.key);
    }
  }
  assert.deepEqual(ui.controls.find(control => control.path === 'messages').ui.textDefinitions, eventTextDefinitions);
  for (const path of ['eventProfiles', 'subgroupSuggestionConversion.preFlowNotice.template']) {
    assert.deepEqual(ui.controls.find(control => control.path === path).ui,
      eventsControls.find(control => control.storage.path === path).descriptor?.ui ?? eventsControls.find(control => control.storage.path === path).ui);
  }
});

test('upgrading the settings layout preserves all saved wording and profile identities', () => {
  const saved = materializeEventText({});
  saved.messages.catalogs.en['official.community-events.cancelled'] = '  My exact wording\n';
  saved.messages.catalogs['pt-PT']['official.community-events.cancelled'] = '  O meu texto\n';
  saved.eventProfiles[0].label.$text.en = '  Profile  ';
  saved.eventProfiles[0].label.$text['pt-PT'] = '  Perfil  ';
  assert.deepEqual(materializeEventText(saved), saved);
});


test('runtime compatibility and identity agree with the installable package', () => {
  const runtime = require('../dist/index').default.manifest;
  for (const field of ['pluginId', 'version', 'coreApiRange', 'dataVersion']) assert.equal(runtime[field], manifest[field], field);
});
