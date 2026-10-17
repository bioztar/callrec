'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toastXml, parseActionArgv, needsShortCallPrompt, shortCallText, createActionRegistry, discardDialog, confirmDiscard } = require('../src/lib/toast');
const { screenshotTarget, pickCallSource, pickScreenSource, fullSize, windowThumbSize } = require('../src/lib/screenshot');
const { createTeamsApi, apiUrl } = require('../src/lib/teams-api');
const { menuTemplate } = require('../src/lib/tray');
const { createSettings } = require('../src/lib/settings');
const { SessionWriter } = require('../src/lib/session-writer');
const { isTeamsMicEntry } = require('../src/teams-signals-win');

test('toast: Windows buttons are protocol actions; argv parsing', () => {
  const xml = toastXml({ title: 'Recording: A & B <x>', actions: [{ label: 'Stop', action: 'stop', id: '7' }, { label: 'Discard', action: 'discard', id: '7' }] });
  assert.match(xml, /<text>Recording: A &amp; B &lt;x&gt;<\/text>/);
  assert.match(xml, /<action content="Stop" activationType="protocol" arguments="callrec:\/\/stop\?id=7"\/>/);
  assert.match(xml, /arguments="callrec:\/\/discard\?id=7"/);
  assert.deepEqual(parseActionArgv(['C:\\callrec.exe', '--flag', 'callrec://discard?id=7']), { action: 'discard', id: '7' });
  assert.deepEqual(parseActionArgv(['callrec://stop/?id=12']), { action: 'stop', id: '12' });
  assert.equal(parseActionArgv(['C:\\callrec.exe']), null);
});

test('short-call prompt: auto under 1 min only, manual never', () => {
  assert.equal(needsShortCallPrompt({ auto: true, durationSec: 40 }), true);
  assert.equal(needsShortCallPrompt({ auto: true, durationSec: 60 }), false);
  assert.equal(needsShortCallPrompt({ auto: false, durationSec: 5 }), false);
  assert.equal(shortCallText(39.6), 'Keep this 40 s recording?');
});

test('screenshot paths: numbered in the call folder, dated otherwise', () => {
  const date = new Date(2026, 9, 16, 9, 5, 7);
  const t1 = screenshotTarget({ recordingDir: '/rec/call', root: '/rec', date, list: () => [] });
  assert.equal(t1.file.replace(/\\/g, '/'), '/rec/call/screenshots/001 09.05.07.png');
  assert.equal(t1.marker, 'screenshot 001');
  assert.equal(t1.clock, '09:05:07');
  const t2 = screenshotTarget({ recordingDir: '/rec/call', root: '/rec', date, list: () => ['001 09.05.07.png', '002 09.06.00.png'] });
  assert.equal(path.basename(t2.file), '003 09.05.07.png');
  const t3 = screenshotTarget({ recordingDir: null, root: '/rec', date, list: () => [] });
  assert.equal(t3.file.replace(/\\/g, '/'), '/rec/Screenshots/2026-10-16 09.05.07.png');
  assert.equal(t3.marker, undefined);
  const t4 = screenshotTarget({ recordingDir: null, root: '/rec', date, list: () => ['2026-10-16 09.05.07.png'] });
  assert.equal(path.basename(t4.file), '2026-10-16 09.05.07 (2).png');
});

test('screenshot source: Teams call window, else the screen under the cursor', () => {
  const sources = [
    { id: 'window:1:0', name: 'Chat | Ana | Microsoft Teams' },
    { id: 'window:2:0', name: 'Weekly sync | Microsoft Teams' },
    { id: 'screen:0:0', name: 'Screen 1', display_id: '10' },
    { id: 'screen:1:0', name: 'Screen 2', display_id: '11' },
  ];
  const wins = [{ title: 'Chat | Ana | Microsoft Teams', minimized: false }, { title: 'Weekly sync | Microsoft Teams', minimized: false }];
  assert.equal(pickCallSource(sources, wins).id, 'window:2:0');
  assert.equal(pickCallSource(sources, [{ ...wins[1], minimized: true }]), null, 'minimised → fallback');
  assert.equal(pickCallSource(sources, []), null);
  assert.equal(pickScreenSource(sources, 11).id, 'screen:1:0');
  assert.equal(pickScreenSource(sources, 99).id, 'screen:0:0');
  assert.deepEqual(fullSize([{ size: { width: 1920, height: 1080 }, scaleFactor: 1.5 }, { size: { width: 2560, height: 1440 }, scaleFactor: 1 }]), { width: 2880, height: 1620 });
});

test('screenshot marker lands in the transcript at its time; call header', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'callrec-shot-'));
  let now = new Date(2026, 9, 16, 9, 5, 0);
  const w = new SessionWriter({ root, title: 'Weekly sync', engine: 'x', language: 'es', now: () => now, call: { name: 'Weekly sync', kind: 'meeting', source: 'local', startedAt: now } });
  assert.equal(path.basename(w.dir), '2026-10-16 09.05 — Weekly sync');
  w.addSegment({ start: 1, end: 3, speaker: 'ME', text: 'hola' });
  w.addSegment({ start: 20, end: 22, speaker: 'THEM', text: 'adiós' });
  w.addMarker(10, 'screenshot 001', '09:05:10');
  now = new Date(2026, 9, 16, 9, 6, 0);
  w.finish(60);
  const md = fs.readFileSync(path.join(w.dir, 'transcript.md'), 'utf8');
  assert.match(md, /- Call: Weekly sync \(meeting, Teams\)/);
  assert.match(md, /- Detected by: local signals/);
  assert.match(md, /- End: /);
  const body = md.split('\n').filter((l) => l.startsWith('['));
  assert.deepEqual(body.map((l) => l.slice(0, 12)), ['[00:01] Me: ', '[09:05:10 sc', '[00:20] Them']);
  const json = JSON.parse(fs.readFileSync(path.join(w.dir, 'transcript.json'), 'utf8'));
  assert.equal(json.markers[0].text, 'screenshot 001');
  assert.equal(json.call.source, 'local');
  fs.rmSync(root, { recursive: true, force: true });
});

test('tray: Screenshot item with hotkey; Teams toggle on Windows only', () => {
  const actions = { toggle() {}, show() {}, openFolder() {}, quit() {}, screenshot() {}, autoRecord() {} };
  const win = menuTemplate({ shortcut: 'CommandOrControl+Shift+R', screenshotShortcut: 'Control+Shift+F8', autoRecordTeams: true, platform: 'win32', actions });
  assert.ok(win.some((i) => i.label === 'Screenshot\tCtrl+Shift+F8'));
  const toggle = win.find((i) => i.label === 'Auto-record Teams calls');
  assert.equal(toggle.type, 'checkbox');
  assert.equal(toggle.checked, true);
  const mac = menuTemplate({ shortcut: '', screenshotShortcut: 'Control+Shift+F8', platform: 'darwin', actions });
  assert.ok(!mac.some((i) => i.label === 'Auto-record Teams calls'));
});

test('settings: defaults, Teams token encrypted and never exposed', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'callrec-set-')), 'settings.json');
  const crypto = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`), decrypt: (b) => String(b).slice(4) };
  const s = createSettings({ file, crypto });
  assert.equal(s.get().autoRecordTeams, true);
  assert.equal(s.get().screenshotShortcut, 'Control+Shift+F8');
  s.setTeamsToken('tok-123');
  assert.equal(s.getTeamsToken(), 'tok-123');
  assert.equal(s.get().teamsApiPaired, true);
  assert.ok(!JSON.stringify(s.get()).includes('tok-123'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('tok-123'));
});

test('Teams API: in-meeting state, pairing once, token saved, silent when closed', () => {
  const sent = [];
  let token = '';
  class FakeWs {
    constructor(url) { this.url = url; FakeWs.last = this; this.handlers = {}; }
    on(ev, fn) { this.handlers[ev] = fn; }
    send(m) { sent.push(JSON.parse(m)); }
    close() {}
  }
  const timers = [];
  const api = createTeamsApi({ WebSocket: FakeWs, getToken: () => token, saveToken: (t) => { token = t; }, setTimer: (fn) => timers.push(fn) });
  api.start();
  assert.match(FakeWs.last.url, /^ws:\/\/127\.0\.0\.1:8124\?protocol-version=2\.0\.0/);
  assert.equal(api.state(), null);
  FakeWs.last.handlers.message(JSON.stringify({ meetingUpdate: { meetingState: { isInMeeting: true } } }));
  FakeWs.last.handlers.message(JSON.stringify({ meetingUpdate: { meetingState: { isInMeeting: true } } }));
  assert.equal(api.state(), true);
  assert.equal(sent.filter((m) => m.action === 'pair').length, 1);
  FakeWs.last.handlers.message(JSON.stringify({ tokenRefresh: 'abc' }));
  assert.equal(token, 'abc');
  FakeWs.last.handlers.close();
  assert.equal(api.state(), null, 'closed → local signals');
  assert.equal(timers.length, 1, 'retries quietly');
  assert.match(apiUrl('abc', '0.4.0'), /token=abc/);
});

test('mic consent entries: Teams packaged/non-packaged, never callrec', () => {
  assert.equal(isTeamsMicEntry('MSTeams_8wekyb3d8bbwe'), true);
  assert.equal(isTeamsMicEntry('C:#Users#a#AppData#Local#Microsoft#Teams#current#Teams.exe'), false, 'classic Teams / anything named *teams* is not new Teams');
  assert.equal(isTeamsMicEntry('C:#Tools#steams-helper.exe'), false);
  assert.equal(isTeamsMicEntry('C:#Program Files#WindowsApps#MSTeams_x#ms-teams.exe'), true);
  assert.equal(isTeamsMicEntry('C:#Users#a#Desktop#callrec.exe'), false);
  assert.equal(isTeamsMicEntry('C:#Program Files#Zoom#bin#Zoom.exe'), false);
});

test('toast actions: random nonce, live only, single use, expiring', () => {
  let t = 0;
  let n = 0;
  const reg = createActionRegistry({ now: () => t, randomId: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}` });
  const ran = [];
  let recording = true;
  const a = reg.issue([
    { action: 'stop', valid: () => recording, ttlMs: 86400000, run: () => ran.push('stop') },
    { action: 'discard', valid: () => recording, ttlMs: 86400000, run: () => ran.push('discard') },
  ]);
  const b = reg.issue([{ action: 'delete', run: () => ran.push('delete') }]);
  assert.notEqual(a, b);
  assert.equal(reg.run({ action: 'discard', id: '1' }), false, 'sequential id guess');
  assert.equal(reg.run({ action: 'discard', id: '00000000-0000-4000-8000-000000000099' }), false, 'unknown nonce');
  assert.equal(reg.run({ action: 'delete', id: a }), false, 'action not on that toast');
  assert.equal(reg.run({ action: 'constructor', id: a }), false);
  assert.equal(reg.run({ action: 'discard', id: a }), true);
  assert.equal(reg.run({ action: 'discard', id: a }), false, 'reused');
  assert.equal(reg.run({ action: 'stop', id: a }), false, 'one button per toast');
  t = 10 * 60 * 1000 + 1;
  assert.equal(reg.run({ action: 'delete', id: b }), false, 'Delete expires after 10 min');
  const c = reg.issue([{ action: 'discard', valid: () => recording, ttlMs: 86400000, run: () => ran.push('late discard') }]);
  recording = false;
  assert.equal(reg.run({ action: 'discard', id: c }), false, 'Discard only while that recording runs');
  assert.deepEqual(ran, ['discard']);
  const real = createActionRegistry().issue([{ action: 'stop', run() {} }]);
  assert.match(real, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(parseActionArgv(['callrec://discard?id=1&x=2']), null);
});

test('tray: Stop + Discard for an auto-recording', () => {
  const actions = { toggle() {}, show() {}, openFolder() {}, quit() {}, discard() {} };
  const labels = (st) => menuTemplate({ shortcut: '', platform: 'win32', actions, ...st }).map((i) => i.label);
  assert.deepEqual(labels({ recording: true, autoRecording: true }).slice(0, 2), ['Stop recording', 'Discard this recording']);
  assert.ok(!labels({ recording: true, autoRecording: false }).includes('Discard this recording'), 'manual: no Discard');
});

test('screenshot thumbnail: the window\'s own size', () => {
  assert.deepEqual(windowThumbSize({ title: 'x', width: 1280, height: 720 }, []), { width: 1280, height: 720 });
  assert.deepEqual(windowThumbSize({ title: 'x' }, [{ size: { width: 1920, height: 1080 }, scaleFactor: 1 }]), { width: 1920, height: 1080 });
});

test('tray Discard asks first: Delete / Keep, default Keep', async () => {
  const o = discardDialog(12 * 60 + 10);
  assert.equal(o.message, 'Delete this recording (12 min) and its transcript? This cannot be undone.');
  assert.deepEqual(o.buttons, ['Delete', 'Keep']);
  assert.equal(o.buttons[o.defaultId], 'Keep');
  assert.equal(o.buttons[o.cancelId], 'Keep', 'Esc / closing the dialog keeps it');
  assert.match(discardDialog(40).message, /\(40 s\)/);
  assert.equal(await confirmDiscard(async () => ({ response: 0 }), 60), true);
  assert.equal(await confirmDiscard(async () => ({ response: 1 }), 60), false);
});
