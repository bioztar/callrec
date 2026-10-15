'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tray = require('../src/lib/tray');

function electronMocks() {
  const made = [];
  class Tray {
    constructor(image) { this.image = image; this.handlers = {}; this.tips = []; made.push(this); }
    setToolTip(t) { this.tip = t; this.tips.push(t); }
    setImage(i) { this.image = i; }
    setContextMenu(m) { this.menu = m; }
    on(ev, fn) { this.handlers[ev] = fn; }
    displayBalloon(o) { this.balloonShown = o; }
    destroy() { this.destroyed = true; }
  }
  const Menu = { buildFromTemplate: (t) => ({ items: t }) };
  const nativeImage = { createEmpty: () => ({ reps: [], addRepresentation(r) { this.reps.push(r); }, setTemplateImage(v) { this.template = v; } }) };
  return { Tray, Menu, nativeImage, made };
}

function fakeWindow() {
  return { visible: true, focused: false, hide() { this.visible = false; }, show() { this.visible = true; }, focus() { this.focused = true; } };
}

test('tooltip: idle, recording mm:ss / h:mm:ss, finalising %', () => {
  assert.equal(tray.tooltip({}), 'callrec — idle');
  assert.equal(tray.tooltip({ recording: true, elapsedSec: 754 }), 'callrec — recording 12:34');
  assert.equal(tray.tooltip({ recording: true, elapsedSec: 3725 }), 'callrec — recording 1:02:05');
  assert.equal(tray.tooltip({ finalising: 0.432 }), 'callrec — Finalising transcript… 43%');
});

test('menu: one start/stop item with the shortcut, show, folder, quit', () => {
  const actions = { toggle() {}, show() {}, openFolder() {}, quit() {} };
  const idle = tray.menuTemplate({ shortcut: 'Control+Alt+Shift+R', platform: 'win32', actions });
  assert.deepEqual(idle.map((i) => i.label || i.type), ['Start recording\tCtrl+Alt+Shift+R', 'Show callrec', 'Open recordings folder', 'separator', 'Quit']);
  const rec = tray.menuTemplate({ recording: true, shortcut: 'CommandOrControl+Shift+R', platform: 'darwin', actions });
  assert.equal(rec[0].label, 'Stop recording\tCmd+Shift+R');
  assert.equal(rec[0].click, actions.toggle);
});

test('icons: recording icon has a red dot, idle has none', () => {
  const red = (buf) => { let n = 0; for (let i = 0; i < buf.length; i += 4) if (buf[i + 3] > 128 && buf[i + 2] > 200 && buf[i + 1] < 80) n += 1; return n; };
  assert.equal(red(tray.iconBitmap(16)), 0);
  assert.ok(red(tray.iconBitmap(16, { recording: true })) > 20);
  assert.equal(tray.iconBitmap(32).length, 32 * 32 * 4);
});

test('tray: hidden window → left click shows it; menu toggles recording with the window hidden; state switches icon + label', () => {
  const { Tray, Menu, nativeImage, made } = electronMocks();
  const win = fakeWindow();
  let state = { recording: false, elapsedSec: 0, finalising: null, shortcut: 'Control+Alt+Shift+R' };
  const toggled = [];
  const ctl = tray.createTrayController({
    Tray, Menu, nativeImage, platform: 'win32',
    getState: () => state,
    actions: { show: () => { win.show(); win.focus(); }, toggle: () => toggled.push(win.visible), openFolder() {}, quit() {} },
  });
  const t = made[0];
  assert.equal(t.tip, 'callrec — idle');
  const idleIcon = t.image;
  win.hide();
  t.handlers.click();
  assert.equal(win.visible, true);
  assert.equal(win.focused, true);
  win.hide();
  t.menu.items[0].click(); // Start recording from the tray, window hidden
  assert.deepEqual(toggled, [false]);
  state = { ...state, recording: true, elapsedSec: 5 };
  ctl.refresh();
  assert.equal(t.tip, 'callrec — recording 0:05');
  assert.notEqual(t.image, idleIcon);
  assert.equal(t.menu.items[0].label, 'Stop recording\tCtrl+Alt+Shift+R');
  state = { ...state, recording: false, finalising: 0.5 };
  ctl.refresh();
  assert.equal(t.tip, 'callrec — Finalising transcript… 50%');
  assert.equal(t.image, idleIcon);
  ctl.balloon('callrec', 'done');
  assert.equal(t.balloonShown.content, 'done');
});

test('close-to-tray: ✕ hides (Windows), hint only the first time, Quit really closes; macOS keeps close = quit', () => {
  const notes = []; let marked = 0;
  const win = fakeWindow();
  const ev = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const c = tray.createCloseToTray({ platform: 'win32', hintShown: false, markHintShown: () => { marked += 1; }, notify: (m) => notes.push(m) });
  const e1 = ev();
  assert.equal(c.onClose(e1, win), 'hide');
  assert.equal(e1.prevented, true);
  assert.equal(win.visible, false);
  win.show();
  assert.equal(c.onClose(ev(), win), 'hide');
  assert.deepEqual(notes, ['callrec is still running in the tray — right-click the icon to quit']);
  assert.equal(marked, 1);
  c.setQuitting();
  const e3 = ev();
  assert.equal(c.onClose(e3, win), 'quit');
  assert.equal(e3.prevented, false);
  const again = tray.createCloseToTray({ platform: 'win32', hintShown: true, markHintShown() {}, notify: (m) => notes.push(m) });
  again.onClose(ev(), win);
  assert.equal(notes.length, 1); // remembered across launches
  const mac = tray.createCloseToTray({ platform: 'darwin', hintShown: false, markHintShown() {}, notify() {} });
  assert.equal(mac.onClose(ev(), win), 'quit');
});

test('session-end (Windows shutdown/sign-out): quits instead of hiding, files closed synchronously, engines stopped', () => {
  const win = fakeWindow();
  const ev = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const c = tray.createCloseToTray({ platform: 'win32', hintShown: true, markHintShown() {}, notify() {} });
  const calls = [];
  tray.endSessionNow({ policy: c, finishSession: () => calls.push(c.quitting ? 'finish(quitting)' : 'finish'), stopEngines: () => calls.push('stop') });
  assert.deepEqual(calls, ['finish(quitting)', 'stop']); // quitting first: the final pass is only queued
  const e = ev();
  assert.equal(c.onClose(e, win), 'quit');
  assert.equal(e.prevented, false); // never blocks shutdown
  assert.equal(win.visible, true);

  // A failing flush still lets Windows end the session.
  const c2 = tray.createCloseToTray({ platform: 'win32', hintShown: true, markHintShown() {}, notify() {} });
  const stopped = [];
  assert.throws(() => tray.endSessionNow({ policy: c2, finishSession: () => { throw new Error('disk'); }, stopEngines: () => stopped.push('stop') }), /disk/);
  assert.deepEqual(stopped, ['stop']);
  assert.equal(c2.onClose(ev(), win), 'quit');
});

test('quit: stops an active recording through the renderer, waits for the files, then quits', async () => {
  const log = [];
  let recording = true;
  await tray.quitCleanly({
    isRecording: () => recording,
    stopRecording: () => { log.push('stop'); setTimeout(() => { recording = false; log.push('closed'); }, 30); },
    forceFinish: () => log.push('force'),
    quit: () => log.push('quit'),
    pollMs: 5,
  });
  assert.deepEqual(log, ['stop', 'closed', 'quit']);
  const stuck = [];
  await tray.quitCleanly({ isRecording: () => true, stopRecording: () => stuck.push('stop'), forceFinish: () => stuck.push('force'), quit: () => stuck.push('quit'), timeoutMs: 20, pollMs: 5 });
  assert.deepEqual(stuck, ['stop', 'force', 'quit']);
  const idle = [];
  await tray.quitCleanly({ isRecording: () => false, stopRecording: () => idle.push('stop'), forceFinish() {}, quit: () => idle.push('quit') });
  assert.deepEqual(idle, ['quit']);
});
