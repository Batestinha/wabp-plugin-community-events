'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sameEventProfileContent } = require('../dist/consoleOperations.js');

test('a stored profile with saved-text marker matches the planned rename', () => {
  const planned = { id: 'climbing', questions: [{ key: 'location' }], poll: { titleTemplate: '{style} at {location}' } };
  const stored = { ...planned, textVersion: 1 };
  assert.equal(sameEventProfileContent(stored, planned), true);
  assert.equal(sameEventProfileContent(planned, stored), true);
});

test('any other difference still counts as a different profile', () => {
  const planned = { id: 'climbing', questions: [{ key: 'location' }], textVersion: 1 };
  assert.equal(sameEventProfileContent(planned, { ...planned, questions: [{ key: 'place' }] }), false);
  assert.equal(sameEventProfileContent(planned, undefined), false);
});
