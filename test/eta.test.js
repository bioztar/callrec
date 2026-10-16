'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { etaSec, etaText } = require('../src/lib/eta');
const tray = require('../src/lib/tray');

test('eta: from measured throughput, none before there is enough to go on', () => {
  assert.equal(etaSec({ done: 600, total: 3600, elapsedSec: 300 }), 1500); // 2 s of speech per wall second
  assert.equal(etaSec({ done: 3600, total: 3600, elapsedSec: 900 }), 0);
  assert.equal(etaSec({ done: 60, total: 3600, elapsedSec: 5 }), null); // too early
  assert.equal(etaSec({ done: 10, total: 3600, elapsedSec: 60 }), null); // < 3 % done
  assert.equal(etaSec({ done: 0, total: 0, elapsedSec: 60 }), null);
});

test('eta text and tray tooltip', () => {
  assert.equal(etaText(null), '');
  assert.equal(etaText(20), '<1 min left');
  assert.equal(etaText(25 * 60), '~25 min left');
  assert.equal(etaText(70 * 60), '~1 h 10 min left');
  assert.equal(etaText(120 * 60), '~2 h left');
  assert.equal(tray.tooltip({ finalising: 0.432, etaSec: 1500, cpu: 100 }), 'callrec — finalising 43% · ~25 min left · CPU 100%');
  assert.equal(tray.tooltip({ finalising: 0.05, etaSec: null, cpu: 60 }), 'callrec — finalising 5% · CPU 60%');
});
