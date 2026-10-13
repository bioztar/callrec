'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDisplayMediaHandler } = require('../src/lib/display-media');

/// Calls the handler like Electron does and resolves with every callback argument.
function request(getSources) {
  return new Promise((resolve) => {
    const calls = [];
    createDisplayMediaHandler(getSources)({ frame: null, audioRequested: true, videoRequested: true }, (grant) => {
      calls.push(grant);
      setTimeout(() => resolve(calls), 20); // catch any second call
    });
  });
}

test('display media: grants the first screen with loopback audio (WASAPI / CoreAudio tap)', async () => {
  const asked = [];
  const screen = { id: 'screen:0:0', name: 'Entire screen' };
  const calls = await request(async (opts) => { asked.push(opts); return [screen, { id: 'screen:1:0' }]; });
  assert.deepEqual(asked, [{ types: ['screen'] }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].video, screen);
  assert.equal(calls[0].audio, 'loopback');
});

test('display media: no source (no permission / locked display) → empty grant, once', async () => {
  assert.deepEqual(await request(async () => []), [{}]);
});

test('display media: getSources rejecting or throwing → empty grant, once', async () => {
  assert.deepEqual(await request(async () => { throw new Error('denied'); }), [{}]);
  assert.deepEqual(await request(() => { throw new Error('sync'); }), [{}]);
});
