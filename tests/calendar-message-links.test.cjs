const assert = require('node:assert/strict');
const { test } = require('node:test');
const { calendarPageForMessage, requiresCalendarSubscription } = require('../dist/calendarMessageLink');
const { renderEventGroupAnnouncement, renderEventEditAnnouncement } = require('../dist/announcements');
const { parseEventsConfig } = require('../dist/config');

const profile = parseEventsConfig({}).eventProfiles[0];
const event = { id: 'event', scopeId: 'scope', calendarId: 'events', calendarOwnershipStatus: 'assigned',
  startsAt: '2026-11-26T12:00:00Z', endsAt: '2026-11-26T14:00:00Z', timezone: 'UTC', answers: {}, groupTitle: 'Group' };
const calendars = [{ id: 'events', enabled: true }];
const page = 'https://gallery.example/index.php?/created-monthly-calendar';
const template = 'Event details{{#if calendarPageUrl}} — {calendarPageUrl}{{/if}}';

test('group and edit announcements resolve the scoped page and keep their base text on disconnect', async () => {
  const calls = [];
  let connected = true;
  const context = { services: { call: async request => {
    calls.push(request);
    if (!connected) throw new Error('offline');
    return { url: page };
  } } };
  for (const expected of [page, undefined]) {
    const calendarPageUrl = await calendarPageForMessage(context, template, event, calendars);
    assert.equal(calendarPageUrl, expected);
    const input = { event, profile, template, calendarPageUrl, groupDisplayName: 'Group', groupJoinUrl: '', subgroupChatId: '',
      previousGroupDisplayName: 'Group', editorDisplayName: 'Editor' };
    for (const render of [renderEventGroupAnnouncement, renderEventEditAnnouncement]) {
      assert.equal(render(input), connected ? 'Event details — ' + page : 'Event details');
    }
    connected = false;
  }
  assert.deepEqual(calls[0], { serviceId: 'official.integration-manager.message-links.v1', method: 'resolve',
    scopeId: 'scope', input: { target: 'calendarPage', resourceKey: 'events' } });
});

test('condition-only references trigger lookup and absent, disabled or unrelated calendars stay empty', async () => {
  let calls = 0;
  const context = { services: { call: async () => { calls++; return { url: page }; } } };
  const predicate = '{{#if calendarPageUrl}}Online{{else}}Offline{{/if}}';
  assert.equal(await calendarPageForMessage(context, predicate, event, calendars), page);
  assert.equal(await calendarPageForMessage(context, 'ordinary text', event, calendars), undefined);
  assert.equal(await calendarPageForMessage({}, predicate, event, calendars), undefined);
  assert.equal(await calendarPageForMessage(context, predicate, event, [{ id: 'events', enabled: false }]), undefined);
  assert.equal(await calendarPageForMessage(context, predicate, { ...event, calendarId: 'other' }, calendars), undefined);
  assert.equal(calls, 1);
  assert.equal(requiresCalendarSubscription('{calendarSubscriptionUrl}'), true);
  assert.equal(requiresCalendarSubscription('{{#if calendarSubscriptionUrl}}Subscribe: {calendarSubscriptionUrl}{{else}}See the announcement{{/if}}'), false);
});
