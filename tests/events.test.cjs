const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const plugin = require('../dist').default;
const { eventFlowAnswersFromRaw } = require('../dist/flow');
const { eventAnswersInTimezone } = require('../dist/locationTimezone');
const { parseEventsConfig } = require('../dist/config');
const { insertEvent, getEvent } = require('../dist/store');
const { isBaileysEventPreCreateProviderUnavailableFailure } = require('../dist/provisioningRecovery');
const pt = require('../locales/pt-PT/official.community-events.json');
const migrations = fs.readdirSync('migrations/events').filter(name => name.endsWith('.sql')).sort();

function answers(overrides = {}) {
  return eventFlowAnswersFromRaw({ profile: parseEventsConfig({}).eventProfiles[0],
    answers: { place: 'Tokyo', startDate: 'tomorrow', startTime: '09:30', style: 'Bouldering' },
    timezone: 'America/New_York', locale: 'en', spanKind: 'day_trip',
    now: new Date('2026-09-12T23:30:00.000Z'), ...overrides });
}
function closeDirectory(directory) {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('wabs-events-')) throw new Error('Unexpected fixture cleanup path');
  fs.rmSync(directory, { recursive: true, force: true });
}
function open(filePath) {
  const sqlite = new DatabaseSync(filePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  return { name: 'events', filePath, exec: sql => sqlite.exec(sql), prepare: sql => sqlite.prepare(sql),
    get: (sql, ...args) => sqlite.prepare(sql).get(...args), all: (sql, ...args) => sqlite.prepare(sql).all(...args),
    run: (sql, ...args) => sqlite.prepare(sql).run(...args), close: () => sqlite.close(),
    transaction(operation) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const value = operation(); sqlite.exec('COMMIT'); return value; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } };
}
function fixture() {
  return { id: 'fixture-event', scopeId: 'fixture-scope', groupId: 'source-group', groupWid: 'source@g.us',
    profileId: 'climbing', profileRevision: 'fixture-revision', profileLabel: 'Climbing',
    actorIdentityId: 'fixture-actor', actorWid: 'creator@lid', actorLabel: 'Creator',
    announcementGroupWid: 'announce@g.us', pollOptions: [], responseClasses: [], answers: { place: 'Tokyo' },
    startsAt: '2026-09-14T00:30:00.000Z', timezone: 'Asia/Tokyo', closeAt: '2026-09-13T00:30:00.000Z',
    cleanupAt: '2026-09-15T00:30:00.000Z', groupTitle: 'Tokyo event', calendarDurationMinutes: 180,
    calendarId: 'events', calendarOwnershipStatus: 'assigned', origin: 'created', calendarStatus: 'included',
    eventStatus: 'active', groupLifecycleStatus: 'poll_closed', subgroupChatId: 'tokyo@g.us',
    createdAt: '2026-09-12T10:00:00.000Z', updatedAt: '2026-09-12T10:00:00.000Z' };
}

test('relative dates use the selected location and original reference time after restart', () => {
  const initial = answers();
  assert.equal(initial.localDate, '2026-09-13');
  const saved = JSON.parse(JSON.stringify(initial));
  const restored = { ...saved, startsAt: new Date(saved.startsAt), endsAt: new Date(saved.endsAt) };
  const located = eventAnswersInTimezone(restored, 'Asia/Tokyo');
  assert.equal(located.localDate, '2026-09-14');
  assert.equal(located.answers.startDate, '2026-09-14');
  assert.equal(located.startsAt.toISOString(), '2026-09-14T00:30:00.000Z');
  assert.deepEqual(eventAnswersInTimezone(located, 'Asia/Tokyo'), located);
  assert.equal(initial.localDate, '2026-09-13');
});

test('both dates in a multi-day event use the place while legacy civil dates remain fixed', () => {
  const initial = answers({ spanKind: 'multi_day', endLocalDate: 'in 3 days', endLocalTime: '18:00' });
  const located = eventAnswersInTimezone(initial, 'Asia/Tokyo');
  assert.equal(located.localDate, '2026-09-14');
  assert.equal(located.endLocalDate, '2026-09-16');
  assert.equal(located.endsAt.toISOString(), '2026-09-16T09:00:00.000Z');
  const legacy = eventAnswersInTimezone({ ...initial, startDateReference: undefined, endDateReference: undefined }, 'Asia/Tokyo');
  assert.equal(legacy.localDate, initial.localDate);
  assert.equal(legacy.endLocalDate, initial.endLocalDate);
});

test('Portugal location zones distinguish the Azores and reject nonexistent daylight-saving times', () => {
  const summer = answers({ now: new Date('2026-01-01T10:00:00.000Z'), answers: { place: 'Portugal', startDate: '2026-07-18', startTime: '09:30', style: 'Bouldering' } });
  assert.equal(eventAnswersInTimezone(summer, 'Europe/Lisbon').startsAt.toISOString(), '2026-07-18T08:30:00.000Z');
  assert.equal(eventAnswersInTimezone(summer, 'Atlantic/Madeira').startsAt.toISOString(), '2026-07-18T08:30:00.000Z');
  assert.equal(eventAnswersInTimezone(summer, 'Atlantic/Azores').startsAt.toISOString(), '2026-07-18T09:30:00.000Z');
  const spring = answers({ now: new Date('2026-01-01T10:00:00.000Z'), timezone: 'UTC', answers: { place: 'Lisbon', startDate: '2026-03-29', startTime: '01:30', style: 'Bouldering' } });
  assert.throws(() => eventAnswersInTimezone(spring, 'Europe/Lisbon'), /does not exist/);
});

test('persisted event snapshots survive reopening and only their live owning group overrides a clock', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wabs-events-data-'));
  let db;
  try {
    const file = path.join(directory, 'events.sqlite');
    db = open(file);
    for (const name of migrations) db.exec(fs.readFileSync(path.join('migrations/events', name), 'utf8'));
    const record = fixture();
    insertEvent(db, record);
    const before = { ...db.get('SELECT * FROM event_records WHERE id = ?', record.id) };
    db.close(); db = open(file);
    assert.deepEqual({ ...db.get('SELECT * FROM event_records WHERE id = ?', record.id) }, before);
    assert.equal(getEvent(db, record.id).startsAt, record.startsAt);
    assert.equal(getEvent(db, record.id).timezone, 'Asia/Tokyo');
    const context = { databases: { open: name => { assert.equal(name, 'events'); return db; } }, scopeId: record.scopeId, groupWid: record.subgroupChatId };
    assert.deepEqual(plugin.resolveGroupTimezone(context), { timezone: 'Asia/Tokyo', resourceId: record.id });
    assert.equal(plugin.resolveGroupTimezone({ ...context, scopeId: 'different-scope' }), undefined);
    assert.equal(plugin.resolveGroupTimezone({ ...context, groupWid: record.groupWid }), undefined);
    insertEvent(db, { ...record, id: 'duplicate-claim' });
    assert.throws(() => plugin.resolveGroupTimezone(context), /Multiple live events/);
    db.run("UPDATE event_records SET group_lifecycle_status = 'cleaned'");
    assert.equal(plugin.resolveGroupTimezone(context), undefined);
    assert.equal(getEvent(db, record.id).timezone, 'Asia/Tokyo');
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally { db?.close(); closeDirectory(directory); }
});

test('custom event profiles, cleanup policy, calendar resources and stored timezone stay loadable', () => {
  const stored = parseEventsConfig({ enabled: true, timezone: 'Atlantic/Azores', cleanup: { retryDelaysMinutes: [3, 19] } });
  stored.eventProfiles[0].label = 'Custom profile';
  stored.calendars[0].label = 'Custom calendar';
  const original = JSON.stringify(stored);
  assert.deepEqual(plugin.manifest.configSchema.parse(stored), stored);
  assert.equal(JSON.stringify(stored), original);
  assert.deepEqual(plugin.manifest.scopeClock.timezoneConfigPaths, ['timezone']);
  assert.equal(plugin.manifest.scopeClock.providesGroupTimezones, true);
});

test('installed SDK errors retain creation certainty and do not opt uncertain effects into recovery', () => {
  const { ManagedCommunitySubgroupPreCreateError } = require('@wabs/plugin-sdk/community-errors');
  const { TransportCommunitySubgroupPreCreateError, TransportProviderUnavailableError } = require('@wabs/plugin-sdk/transport-errors');
  const unavailable = new TransportProviderUnavailableError('baileys', 'offline');
  const transport = new TransportCommunitySubgroupPreCreateError('baileys', 'parent@g.us', 'not_created', { phase: 'require_provider' }, unavailable);
  const error = new ManagedCommunitySubgroupPreCreateError({ scopeId: 'fixture-scope', parentCommunityWid: 'parent@g.us', title: 'Fixture', creatorIdentityId: 'fixture-actor', providerId: 'baileys', certainty: 'not_created', details: { phase: 'require_provider' } }, transport);
  assert.equal(isBaileysEventPreCreateProviderUnavailableFailure(error), true);
  assert.equal(isBaileysEventPreCreateProviderUnavailableFailure(new Error('Unknown creation result')), false);
});

test('all migrations and translations are retained and vendored artifacts reconstruct exactly', () => {
  assert.equal(require('../wa-plugin.json').dataVersion, '19');
  assert.equal(migrations.length, 44);
  for (const name of migrations) assert.equal(fs.readFileSync(path.join('migrations/events', name), 'utf8'), fs.readFileSync(path.join('src/migrations/events', name), 'utf8'));
  for (const key of Object.keys(plugin.manifest.defaultMessages)) assert.ok(pt[key]?.trim(), key);
  assert.deepEqual(Object.keys(plugin.lifecycle), ['migrateData']);
  const provenance = require('../contracts/provenance.json');
  assert.equal(provenance.contracts.length, 14);
  for (const item of provenance.contracts) {
    const original = fs.readFileSync(path.join('contracts', item.upstreamPath));
    assert.equal(crypto.createHash('sha256').update(original).digest('hex'), item.upstreamSha256);
    let rebuilt = original.toString('utf8');
    for (const patch of item.patches) {
      assert.equal(patch.operation, 'replace-import');
      assert.ok(rebuilt.includes(patch.before));
      rebuilt = rebuilt.replaceAll(patch.before, patch.after);
    }
    assert.equal(rebuilt, fs.readFileSync(path.join('contracts', item.vendoredPath), 'utf8'));
  }
});

test('packaging rejects a changed pristine artifact before it can produce a release', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wabs-events-vendor-'));
  try {
    for (const file of ['package.json', 'wa-plugin.json', 'provenance.json']) fs.copyFileSync(file, path.join(directory, file));
    for (const folder of ['vendor', 'contracts', 'src/contracts', 'scripts']) fs.cpSync(folder, path.join(directory, folder), { recursive: true });
    const item = require('../contracts/provenance.json').contracts[0];
    fs.appendFileSync(path.join(directory, 'contracts', item.upstreamPath), '\n// unexpected upstream change\n');
    const result = spawnSync('python', ['scripts/package-release.py'], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Pristine upstream contract identity changed/);
    assert.equal(fs.existsSync(path.join(directory, '.cache')), false);
  } finally { closeDirectory(directory); }
});

test('canonical choice IDs survive reopening and a changed display label', () => {
  const { renderEventTemplate } = require('../dist/flow');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wabs-events-values-'));
  let db;
  try {
    const file = path.join(directory, 'events.sqlite'); db = open(file);
    for (const name of migrations) db.exec(fs.readFileSync(path.join('migrations/events', name), 'utf8'));
    const base = parseEventsConfig({}).eventProfiles[0];
    const profile = { ...base, questions: base.questions.map(question => question.key === 'style'
      ? { ...question, type: 'choice', choices: [{ id: 'bouldering', label: 'Bouldering' }, { id: 'rope', label: 'Rope' }] } : question) };
    const choiceQuestion = profile.questions.find(question => question.type === 'choice');
    const choice = choiceQuestion.choices[0];
    const record = { ...fixture(), answers: { [choiceQuestion.key]: 'Old translated label' }, rawAnswers: { [choiceQuestion.key]: choice.id } };
    insertEvent(db, record); db.close(); db = open(file);
    const stored = getEvent(db, record.id);
    assert.deepEqual(stored.rawAnswers, record.rawAnswers);
    const changed = { ...profile, questions: profile.questions.map(question => question.key === choiceQuestion.key
      ? { ...question, choices: question.choices.map(item => ({ ...item, label: 'New label ' + item.id })) } : question) };
    assert.equal(renderEventTemplate({ template: `{{#if ${choiceQuestion.key} == ${JSON.stringify(choice.id)}}}selected{{else}}other{{/if}}`,
      profile: changed, answers: stored.answers, rawAnswers: stored.rawAnswers, startsAt: new Date(stored.startsAt), timezone: stored.timezone, creatorDisplayName: '' }), 'selected');
  } finally { db?.close(); closeDirectory(directory); }
});

test('weather intent freezes text, people, native all, and group mentions in one row', () => {
  const { prepareEventWeatherDelivery } = require('../dist/store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wabs-events-mentions-'));
  const db = open(path.join(directory, 'events.sqlite'));
  try {
    for (const name of migrations) db.exec(fs.readFileSync(path.join('migrations/events', name), 'utf8'));
    const record = fixture(); insertEvent(db, record);
    const input = { eventId: record.id, eventUpdatedAt: getEvent(db, record.id).updatedAt, kind: 'daily:2026-09-14', scheduleKind: 'daily', scheduledAt: record.startsAt,
      chatId: '123@g.us', meteorologicalText: '@all @456 @789@g.us Forecast', meteorologicalIdempotencyKey: 'weather-native',
      mentions: { mentionedWids: ['456@c.us'], mentionAll: true, groupMentions: [{ groupJid: '789@g.us', groupSubject: 'Walks' }] } };
    const original = prepareEventWeatherDelivery(db, input);
    const retry = prepareEventWeatherDelivery(db, { ...input, meteorologicalText: 'Changed', mentions: {} });
    assert.equal(retry.meteorologicalText, original.meteorologicalText); assert.deepEqual(retry.mentions, input.mentions);
  } finally { db.close(); closeDirectory(directory); }
});
