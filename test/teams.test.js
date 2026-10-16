'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/teams-titles.json');
const { parseTitle, callName, stripSuffix } = require('../src/lib/teams-titles');
const { createTeamsDetector, findCallWindow } = require('../src/lib/teams-detector');
const { callFolderName, uniqueDir } = require('../src/lib/naming');

test('title parser: every fixture row', () => {
  assert.ok(fixtures.titles.length >= 10);
  for (const row of fixtures.titles) {
    assert.ok(['assumed', 'real'].includes(row.source), row.title);
    const r = parseTitle(row.title);
    assert.equal(r.call, row.call, row.title);
    if (row.call) {
      assert.equal(r.kind, row.kind, row.title);
      assert.equal(r.name, row.name, row.title);
    }
  }
});

test('title parser: suffix stripping and kinds covered', () => {
  assert.equal(stripSuffix('Weekly sync | Microsoft Teams'), 'Weekly sync');
  assert.equal(stripSuffix('Weekly sync - Microsoft Teams (work or school)'), 'Weekly sync');
  const kinds = new Set(fixtures.titles.filter((r) => r.call).map((r) => r.kind));
  for (const k of ['meeting', 'one-to-one', 'group']) assert.ok(kinds.has(k), k);
});

test('call names: meeting, 1:1, group, unknown', () => {
  assert.equal(callName({ kind: 'meeting', name: 'Weekly sync' }), 'Weekly sync');
  assert.equal(callName({ kind: 'one-to-one', name: 'Ana Pérez' }), 'Call with Ana Pérez');
  assert.equal(callName({ kind: 'group', name: 'Launch crew' }), 'Launch crew');
  assert.equal(callName({ kind: 'unknown', name: '' }), 'Teams call');
});

test('folder name is Windows-safe, capped, collision-suffixed', () => {
  const d = new Date(2026, 9, 16, 9, 5);
  assert.equal(callFolderName(d, 'Weekly sync'), '2026-10-16 09.05 — Weekly sync');
  assert.equal(callFolderName(d, 'a<b>c:d"e/f\\g|h?i*j. . '), '2026-10-16 09.05 — a b c d e f g h i j');
  assert.equal(callFolderName(d, '...'), '2026-10-16 09.05 — Teams call');
  assert.ok(callFolderName(d, 'x'.repeat(300)).length <= 16 + 3 + 60);
  const taken = new Set(['/r/n', '/r/n (2)']);
  assert.equal(uniqueDir('/r', 'n', (p) => taken.has(p)).replace(/\\/g, '/'), '/r/n (3)');
});

function harness(opts = {}) {
  let t = 0;
  const events = [];
  let recording = opts.recording || false;
  const d = createTeamsDetector({
    now: () => t,
    isRecording: () => recording,
    enabled: () => (opts.enabled === undefined ? true : opts.enabled),
    onStart: (c) => { events.push(['start', c.name, c.source]); recording = true; },
    onEnd: (c) => { events.push(['end', c.name, c.endedAt - c.startedAt]); recording = false; },
  });
  const step = (sig, ms = 2000) => { d.tick(sig); t += ms; };
  return { d, events, step, setRecording: (v) => { recording = v; } };
}

const CALL = { mic: true, windows: ['Chat | Ana | Microsoft Teams', 'Weekly sync | Microsoft Teams'] };
const NONE = { mic: false, windows: ['Chat | Ana | Microsoft Teams'] };

test('detector: start needs mic and a call window', () => {
  const h = harness();
  h.step({ mic: true, windows: ['Chat | Ana | Microsoft Teams'] });
  h.step({ mic: false, windows: ['Weekly sync | Microsoft Teams'] });
  assert.deepEqual(h.events, []);
  h.step(CALL);
  assert.deepEqual(h.events, [['start', 'Weekly sync', 'local']]);
});

test('detector: 15 s end debounce, reconnect within 15 s is one recording', () => {
  const h = harness();
  h.step(CALL);
  for (let i = 0; i < 6; i += 1) h.step(NONE); // 12 s gone
  h.step(CALL);
  for (let i = 0; i < 7; i += 1) h.step(NONE); // 14 s gone
  assert.equal(h.events.length, 1);
  h.step(NONE);
  h.step(NONE);
  assert.deepEqual(h.events.map((e) => e[0]), ['start', 'end']);
});

test('detector: mic released but window still open keeps the call', () => {
  const h = harness();
  h.step(CALL);
  for (let i = 0; i < 20; i += 1) h.step({ mic: false, windows: CALL.windows });
  assert.equal(h.events.length, 1);
});

test('detector: manual recording has precedence, no second start', () => {
  const h = harness({ recording: true });
  h.step(CALL);
  for (let i = 0; i < 10; i += 1) h.step(NONE);
  assert.deepEqual(h.events, []);
});

test('detector: Stop sticks for the call; next call records again', () => {
  const h = harness();
  h.step(CALL);
  h.d.userStopped();
  h.setRecording(false);
  for (let i = 0; i < 5; i += 1) h.step(CALL);
  assert.equal(h.events.length, 1);
  for (let i = 0; i < 9; i += 1) h.step(NONE);
  assert.equal(h.events.length, 1, 'no end event for a stopped call');
  h.step(CALL);
  assert.equal(h.events.length, 2);
});

test('detector: toggle off records nothing', () => {
  const h = harness({ enabled: false });
  h.step(CALL);
  assert.deepEqual(h.events, []);
});

test('detector: API path vs local path', () => {
  const api = harness();
  api.step({ api: true, mic: false, windows: CALL.windows });
  assert.deepEqual(api.events, [['start', 'Weekly sync', 'api']]);
  const local = harness();
  local.step({ api: null, mic: true, windows: CALL.windows });
  assert.deepEqual(local.events, [['start', 'Weekly sync', 'local']]);
});

test('findCallWindow skips main-window views', () => {
  assert.equal(findCallWindow(['Activity | Microsoft Teams', 'Microsoft Teams']), null);
  assert.equal(findCallWindow(CALL.windows).name, 'Weekly sync');
});
