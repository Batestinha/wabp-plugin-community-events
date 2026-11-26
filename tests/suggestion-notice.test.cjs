const assert = require('node:assert/strict');
const { test } = require('node:test');
const { previewTemplateFragment } = require('@wabs/plugin-sdk/templates');
const { parseEventsConfig } = require('../dist/config');
const { renderSuggestionRefusalNotice } = require('../dist/eventCreationFlowStarter');

test('the suggestion notice follows the connected identity and its current name', async () => {
  const template = 'Hello {creatorDisplayName}. {{#if botDisplayName}}From {botDisplayName}.{{else}}From this bot.{{/if}}';
  parseEventsConfig({ subgroupSuggestionConversion: { preFlowNotice: { template } } });
  const profiles = new Map([['first@c.us', 'Bot A'], ['second@c.us', 'Bot B']]);
  let wid = 'first@c.us';
  const context = { getCurrentBotWid: async () => wid, resolveIdentityAddress: async id => ({ displayName: profiles.get(id) }) };
  const text = async () => previewTemplateFragment(await renderSuggestionRefusalNotice(template, 'Ana', context));
  assert.equal(await text(), 'Hello Ana. From Bot A.');
  profiles.set(wid, 'New name');
  assert.equal(await text(), 'Hello Ana. From New name.');
  wid = 'second@c.us';
  assert.equal(await text(), 'Hello Ana. From Bot B.');
  profiles.clear();
  assert.equal(await text(), 'Hello Ana. From this bot.');
  const plain = await renderSuggestionRefusalNotice('Hello {creatorDisplayName}.', 'Ana', {
    getCurrentBotWid: () => { throw new Error('Unexpected profile lookup'); }
  });
  assert.equal(previewTemplateFragment(plain), 'Hello Ana.');
});
