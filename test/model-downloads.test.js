'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const models = require('../src/lib/whisper-models');
const { createDownloadManager } = require('../src/lib/model-downloads');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'callrec-dl-'));
const ggml = () => Buffer.concat([Buffer.from('lmgg'), crypto.randomBytes(64)]);

function managerFor(dir, calls, impl) {
  return createDownloadManager({
    isInstalled: (id) => models.status({ dir, id }).installed,
    start: (opts) => { calls.push(opts.id); return impl ? impl(opts) : Promise.resolve({ ok: true }); },
  });
}

test('regression: small present, large selected → status not installed (says so), Download fetches large', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'ggml-small-q5_1.bin'), ggml());
  const st = models.status({ dir, id: 'large-v3-turbo-q5_0' });
  assert.equal(st.installed, false);
  assert.equal(st.ready, true); // can still record…
  assert.equal(st.usingFallback, true);
  assert.equal(st.name, 'ggml-small-q5_1.bin'); // …with the file that will really be loaded
  assert.equal(st.message, 'large-v3-turbo not installed — currently using small');
  const calls = [];
  const r = managerFor(dir, calls).request('large-v3-turbo-q5_0');
  assert.equal(r.started, true);
  assert.deepEqual(await r.promise, { ok: true });
  assert.deepEqual(calls, ['large-v3-turbo-q5_0']);
});

test('downloads: exact catalogue file present → nothing to download', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'ggml-large-v3-turbo-q5_0.bin'), ggml());
  const calls = [];
  const r = managerFor(dir, calls).request('large-v3-turbo-q5_0');
  assert.equal(r.installed, true);
  assert.deepEqual(calls, []);
  assert.equal(models.status({ dir, id: 'large-v3-turbo-q5_0' }).message, 'Using large-v3-turbo (ggml-large-v3-turbo-q5_0.bin)');
});

test('downloads: second click shows the running job; another model replaces it; cancel aborts', async () => {
  const dir = tmp();
  const calls = [];
  const signals = {};
  const m = managerFor(dir, calls, ({ id, signal, onProgress }) => new Promise((resolve) => {
    signals[id] = signal;
    onProgress(0.4);
    signal.addEventListener('abort', () => resolve({ error: 'Download canceled', canceled: true }));
  }));
  const first = m.request('large-v3-turbo-q5_0');
  await new Promise((r) => setImmediate(r));
  const again = m.request('large-v3-turbo-q5_0');
  assert.equal(again.running, true);
  assert.equal(again.fraction, 0.4);
  assert.equal(again.promise, first.promise);
  assert.deepEqual(calls, ['large-v3-turbo-q5_0']);
  const other = m.request('base-q5_1'); // the earlier (stalled) download must not swallow this click
  assert.equal(other.started, true);
  assert.equal((await first.promise).canceled, true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['large-v3-turbo-q5_0', 'base-q5_1']);
  assert.deepEqual(m.current(), { id: 'base-q5_1', fraction: 0.4 });
  assert.equal(m.cancel(), true);
  assert.equal((await other.promise).canceled, true);
  assert.equal(m.current(), null);
  assert.equal(m.cancel(), false);
});

test('download: a stalled connection aborts with a plain message; cancel too; no .part left', async () => {
  const dir = tmp();
  const hang = (url, { signal }) => Promise.resolve({
    ok: true,
    status: 200,
    headers: new Map([['content-length', '10']]),
    body: { getReader: () => ({ read: () => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))), cancel: () => Promise.resolve() }) },
  });
  const entry = { file: 'ggml-x.bin', bytes: 10, sha256: '' };
  const stalled = await models.download({ dir, entry, baseUrl: 'http://x/', fetchImpl: hang, stallMs: 50 });
  assert.equal(stalled.stalled, true);
  assert.match(stalled.error, /stalled/);
  const ctl = new AbortController();
  const p = models.download({ dir, entry, baseUrl: 'http://x/', fetchImpl: hang, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  assert.equal((await p).canceled, true);
  assert.deepEqual(fs.readdirSync(dir), []);
});
