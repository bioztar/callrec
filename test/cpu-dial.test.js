'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dial = require('../src/lib/cpu-dial');

test('cpu dial: pct → threads on 1, 4, 8 and 16 cores', () => {
  const table = { 1: [1, 1, 1, 1, 1], 4: [1, 2, 2, 3, 4], 8: [2, 3, 5, 6, 8], 16: [3, 6, 10, 13, 16] };
  for (const [n, want] of Object.entries(table)) {
    assert.deepEqual(dial.LEVELS.map((p) => dial.threadsFor(p, Number(n))), want, `${n} cores`);
  }
  assert.equal(dial.threadsFor(undefined, 8), 8); // unset → default 100%
  assert.equal(dial.threadsFor(55, 8), 8); // not a level → default
});

test('cpu dial: default 100%, idle pick persisted', () => {
  const saved = []; const changes = [];
  const d = dial.createCpuDial({ persist: (p) => saved.push(p), onChange: (p) => changes.push(p) });
  assert.equal(d.level, 100);
  d.pick(60);
  assert.equal(d.level, 60);
  assert.equal(d.threads(8), 5);
  assert.deepEqual(saved, [60]);
  assert.deepEqual(changes, [60]);
  assert.equal(dial.createCpuDial({ level: 40 }).level, 40);
  assert.equal(dial.createCpuDial({ level: 'junk' }).level, 100);
});

test('cpu dial: recording during a pass → 20%, manual pick applies now, Stop restores the idle choice', () => {
  const saved = []; const changes = [];
  const d = dial.createCpuDial({ level: 80, persist: (p) => saved.push(p), onChange: (p) => changes.push(p) });
  d.recordingStarted();
  assert.equal(d.level, 20);
  d.recordingStarted(); // idempotent
  d.pick(60); // during the call
  assert.equal(d.level, 60);
  assert.equal(d.idleLevel, 80);
  d.recordingStopped();
  assert.equal(d.level, 80);
  assert.deepEqual(changes, [20, 60, 80]);
  assert.deepEqual(saved, [], 'a pick during a call is not persisted');

  // Plain call with no change.
  d.recordingStarted();
  d.recordingStopped();
  assert.equal(d.level, 80);
  // Idle choice already at 20%: the call does not raise it.
  d.pick(20);
  d.recordingStarted();
  assert.equal(d.level, 20);
  d.recordingStopped();
  assert.deepEqual(saved, [20]);
});
