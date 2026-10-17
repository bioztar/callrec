'use strict';

const test = require('node:test');
const path = require('path');
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
  for (const k of ['meeting', 'one-to-one', 'group', 'unknown']) assert.ok(kinds.has(k), k);
  assert.equal(parseTitle('Budget, Q4 review').kind, 'unknown', 'a bare comma is not a group');
  assert.equal(parseTitle('Viva Engage | Microsoft Teams').call, false);
  assert.equal(parseTitle('Ana Pérez | Microsoft Teams').positive, false, 'a bare name only names the call');
  assert.equal(parseTitle('Meeting in "General" | Microsoft Teams').positive, true);
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
  const taken = new Set([path.join('/r', 'n'), path.join('/r', 'n (2)')]);
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

const CALL = { mic: true, windows: ['Chat | Ana | Microsoft Teams', 'Meeting in "Weekly sync" | Microsoft Teams'] };
const NONE = { mic: false, windows: ['Chat | Ana | Microsoft Teams'] };

test('detector: start needs mic and a call window', () => {
  const h = harness();
  h.step({ mic: true, windows: ['Chat | Ana | Microsoft Teams'] });
  h.step({ mic: false, windows: ['Meeting in "Weekly sync" | Microsoft Teams'] });
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
  assert.equal(findCallWindow(['Viva Engage | Microsoft Teams', 'Ana Pérez | Microsoft Teams']).kind, 'one-to-one', 'recognised title wins');
});

test('detector: unrecognised window starts a call with the mic, named "Teams call"', () => {
  const h = harness();
  h.step({ mic: false, windows: ['Weekly sync | Microsoft Teams'] });
  assert.deepEqual(h.events, [], 'no mic, no call');
  h.step({ mic: true, windows: ['Weekly sync | Microsoft Teams'] });
  assert.deepEqual(h.events, [['start', 'Teams call', 'local']]);
});

test('detector: unrecognised window never holds a call open', () => {
  const h = harness();
  h.step({ mic: true, windows: ['Some pop-out | Microsoft Teams'] });
  for (let i = 0; i < 9; i += 1) h.step({ mic: false, windows: ['Some pop-out | Microsoft Teams'] });
  assert.deepEqual(h.events.map((e) => e[0]), ['start', 'end']);
  // A recognised window does hold it (and upgrades the name).
  const k = harness();
  k.step({ mic: true, windows: ['Some pop-out | Microsoft Teams'] });
  k.step({ mic: true, windows: ['Call with Ana Pérez | Microsoft Teams'] });
  assert.equal(k.d.call.name, 'Call with Ana Pérez');
  for (let i = 0; i < 20; i += 1) k.step({ mic: false, windows: ['Some pop-out | Microsoft Teams', 'Call with Ana Pérez | Microsoft Teams'] });
  assert.equal(k.events.length, 1);
  // API out of meeting + mic released + only unrecognised windows → ends.
  const a = harness();
  a.step({ api: true, mic: false, windows: ['Weekly sync | Microsoft Teams'] });
  for (let i = 0; i < 9; i += 1) a.step({ api: false, mic: false, windows: ['Weekly sync | Microsoft Teams', 'Ana Pérez | Microsoft Teams'] });
  assert.deepEqual(a.events.map((e) => e[0]), ['start', 'end']);
});

test('detector: turning auto-record off mid-call keeps recording until the call ends', () => {
  let on = true;
  const h = harness({ enabled: undefined });
  const d = createTeamsDetector({ enabled: () => on, now: () => 0 });
  assert.ok(d); // enabled is only consulted when a call starts
  const events = [];
  let t = 0;
  const det = createTeamsDetector({ now: () => t, enabled: () => on, onStart: () => events.push('start'), onEnd: () => events.push('end') });
  det.tick(CALL); t += 2000;
  on = false;
  for (let i = 0; i < 20; i += 1) { det.tick(CALL); t += 2000; }
  assert.deepEqual(events, ['start'], 'still recording');
  for (let i = 0; i < 9; i += 1) { det.tick(NONE); t += 2000; }
  assert.deepEqual(events, ['start', 'end']);
  det.tick(CALL);
  assert.deepEqual(events, ['start', 'end'], 'next call not recorded while off');
  assert.ok(h);
});
