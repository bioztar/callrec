'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { wer } = require('../src/lib/wer');

test('wer: folding, substitutions, deletions, insertions', () => {
  assert.equal(wer('Hola equipo, ¿qué tal?', 'hola Equipo que tal'), 0);
  assert.equal(wer("Let's schedule the follow-up", 'lets schedule the follow up'), 0); // hyphens fold to spaces
  assert.equal(wer('a b c d', 'a x c'), 0.5);
  assert.equal(wer('a b', 'a b c d'), 1);
  assert.equal(wer('', ''), 0);
});
