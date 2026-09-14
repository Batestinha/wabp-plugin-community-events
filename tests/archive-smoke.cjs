const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'wa-plugin.json')));
const plugin = require(path.join(root, metadata.entrypoint)).default;
assert.equal(plugin.manifest.pluginId, 'official.community-events');
assert.equal(plugin.manifest.version, metadata.version);
assert.equal(plugin.manifest.coreApiRange, '^0.3.7');
for (const method of ['registerCommands', 'registerCancellations', 'registerHooks', 'registerServices', 'resolveGroupTimezone']) assert.equal(typeof plugin[method], 'function');
assert.deepEqual(Object.keys(plugin.lifecycle), ['migrateData']);
const pt = JSON.parse(fs.readFileSync(path.join(root, 'locales/pt-PT/official.community-events.json')));
for (const key of Object.keys(plugin.manifest.defaultMessages)) assert.ok(pt[key]?.trim(), key);
for (const file of ['node_modules/@wabs/plugin-sdk/dist/managed-group-plugin.js', 'node_modules/@wabs/plugin-sdk/LICENSE', 'node_modules/zod/LICENSE', 'contracts/provenance.json', 'contracts/LICENSE.wabp']) assert.ok(fs.statSync(path.join(root, file)).isFile());
assert.equal(fs.existsSync(path.join(root, 'node_modules/geo-tz')), false);
assert.equal(plugin.manifest.configSchema.parse({ timezone: 'Atlantic/Azores' }).timezone, 'Atlantic/Azores');
assert.equal(metadata.dataVersion, '20');
assert.equal(fs.readdirSync(path.join(root, 'migrations/events')).length, 44);
assert.equal(require(path.join(root, 'node_modules/chrono-node/package.json')).version, '2.9.1');
console.log(JSON.stringify({ pluginId: metadata.pluginId, version: metadata.version, standaloneLoad: true, translations: Object.keys(pt).length, controls: metadata.operatorConsole.controls.length }));

const compiledConsoleOperations = metadata.consoleOperations ?? [];
assert.deepEqual(plugin.manifest.consoleOperations ?? [], compiledConsoleOperations);
assert.deepEqual(plugin.manifest.configuration ?? null, metadata.configuration ?? null);
if (compiledConsoleOperations.length) {
  const handlers = plugin.registerConsoleOperations({
    pluginId: metadata.pluginId, runtimeBindingId: 'fixture-runtime', whatsAppAccountId: 'fixture-account', archive: {}
  });
  assert.deepEqual(handlers.map(operation => operation.operationId).sort(), compiledConsoleOperations.map(operation => operation.operationId).sort());
  for (const operation of handlers) assert.equal(typeof operation.handler, 'function');
}
if ((metadata.externalActions ?? []).length) assert.equal(typeof plugin.registerExternalActions, 'function');
