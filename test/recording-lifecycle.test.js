'use strict';

// Every end path of a recording calls the dial's recordingStopped() exactly once.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecordingLifecycle } = require('../src/lib/recording-lifecycle');
const { createCpuDial } = require('../src/lib/cpu-dial');
const tray = require('../src/lib/tray');

function setup() {
  const calls = { started: 0, stopped: 0 };
  const real = createCpuDial({ level: 100 });
  const dial = {
    recordingStarted() { calls.started += 1; real.recordingStarted(); },
    recordingStopped() { calls.stopped += 1; real.recordingStopped(); },
  };
  const life = createRecordingLifecycle({ dial });
  const closed = [];
  // main.js's finishSession(): end() around closing the files + queueing the pass.
  const finishSession = (fail = false) => life.end((w) => { if (fail) throw new Error('disk gone'); closed.push(w); return w; });
  return { calls, real, life, closed, finishSession };
}

test('manual Stop: one recordingStopped, dial back to the idle level', () => {
  const s = setup();
  s.life.start('m1');
  assert.equal(s.real.level, 20);
  assert.equal(s.finishSession(), 'm1');
  assert.equal(s.finishSession(), null); // renderer stop + before-quit both call it
  assert.deepEqual(s.calls, { started: 1, stopped: 1 });
  assert.equal(s.real.level, 100);
});

test('Quit: renderer stops it (or forceFinish after the timeout), then before-quit finishes again', async () => {
  for (const rendererAnswers of [true, false]) {
    const s = setup();
    s.life.start('m1');
    await tray.quitCleanly({
      isRecording: () => Boolean(s.life.active),
      stopRecording: () => { if (rendererAnswers) s.finishSession(); },
      forceFinish: () => s.finishSession(),
      quit: () => s.finishSession(), // 'before-quit'
      timeoutMs: 30, pollMs: 5,
    });
    assert.deepEqual(s.calls, { started: 1, stopped: 1 }, `renderer answers: ${rendererAnswers}`);
    assert.deepEqual(s.closed, ['m1']);
  }
});

test('Windows session end: once, even when closing the files throws', () => {
  const s = setup();
  s.life.start('m1');
  let stopped = 0;
  assert.throws(() => tray.endSessionNow({ policy: { setQuitting() {} }, finishSession: () => s.finishSession(true), stopEngines: () => { stopped += 1; } }));
  assert.equal(stopped, 1);
  assert.deepEqual(s.calls, { started: 1, stopped: 1 });
  assert.equal(s.real.level, 100);
  assert.equal(s.finishSession(), null); // the 'before-quit' that may follow
  assert.equal(s.calls.stopped, 1);
});

test('a second start while recording does not double-count; nothing recording → end is a no-op', () => {
  const s = setup();
  assert.equal(s.finishSession(), null);
  assert.equal(s.life.start('m1'), true);
  assert.equal(s.life.start('m2'), false);
  s.finishSession();
  s.life.start('m3');
  s.finishSession();
  assert.deepEqual(s.calls, { started: 2, stopped: 2 });
});
