'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const models = require('../src/lib/whisper-models');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'callrec-models-'));
const fakeModel = (n = 300000) => Buffer.concat([Buffer.from('lmgg'), crypto.randomBytes(n)]);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function serve(body) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (!req.url.endsWith('.bin')) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-length': body.length });
      let o = 0;
      (function pump() { if (o >= body.length) { res.end(); return; } res.write(body.subarray(o, o + 65536)); o += 65536; setImmediate(pump); }());
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

test('models: catalogue default is the multilingual small model with a pinned sha256', () => {
  const m = models.MODELS[models.DEFAULT_MODEL];
  assert.equal(m.file, 'ggml-small-q5_1.bin');
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  Object.values(models.MODELS).forEach((e) => assert.ok(!/\.en\./.test(e.file), 'English-only models cannot do Spanish'));
});

test('models: download → progress, verified, renamed; status becomes ready', async () => {
  const body = fakeModel();
  const { srv, base } = await serve(body);
  const dir = tmp();
  const entry = { file: 'ggml-test.bin', bytes: body.length, sha256: sha(body) };
  const ticks = [];
  const res = await models.download({ dir, fetchImpl: fetch, baseUrl: base, entry, onProgress: (f) => ticks.push(f) });
  srv.close();
  assert.ok(res.ok, res.error);
  assert.equal(ticks[ticks.length - 1], 1);
  assert.ok(ticks.every((f, i) => i === 0 || f >= ticks[i - 1]));
  assert.ok(fs.existsSync(path.join(dir, 'ggml-test.bin')) && !fs.existsSync(path.join(dir, 'ggml-test.bin.part')));
  const st = models.status({ dir });
  assert.equal(st.ready, true); // found by scanning the folder
  assert.equal(st.source, 'found');
});

test('models: checksum mismatch and HTTP errors leave nothing behind', async () => {
  const body = fakeModel();
  const { srv, base } = await serve(body);
  const dir = tmp();
  const bad = await models.download({ dir, fetchImpl: fetch, baseUrl: base, entry: { file: 'ggml-x.bin', bytes: body.length, sha256: '0'.repeat(64) } });
  assert.match(bad.error, /verification/);
  const missing = await models.download({ dir, fetchImpl: fetch, baseUrl: `${base}nope/`, entry: { file: 'x.txt', bytes: 1, sha256: '' } });
  assert.match(missing.error, /HTTP 404/);
  const offline = await models.download({ dir, fetchImpl: () => Promise.reject(new Error('proxy says no')), baseUrl: base, entry: { file: 'ggml-y.bin', bytes: 1, sha256: '' } });
  assert.match(offline.error, /Choose model file/);
  srv.close();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('models: resolve order — chosen file, catalogue file, any ggml file; non-models ignored', () => {
  const dir = tmp();
  assert.equal(models.resolveModel({ dir }), null);
  fs.writeFileSync(path.join(dir, 'ggml-zzz.bin'), fakeModel(10));
  fs.writeFileSync(path.join(dir, 'ggml-aaa.bin'), 'not a model');
  assert.equal(models.resolveModel({ dir }).name, 'ggml-zzz.bin');
  fs.writeFileSync(path.join(dir, 'ggml-small-q5_1.bin'), fakeModel(10));
  assert.equal(models.resolveModel({ dir }).source, 'catalogue');
  const chosen = path.join(tmp(), 'my-model.bin');
  fs.writeFileSync(chosen, fakeModel(10));
  assert.equal(models.resolveModel({ dir, chosenPath: chosen }).source, 'chosen');
  assert.equal(models.resolveModel({ dir, chosenPath: path.join(dir, 'ggml-aaa.bin') }).source, 'catalogue');
});

test('models: import copies a ggml file, rejects other files and corrupt catalogue files', async () => {
  const dir = tmp();
  const src = path.join(tmp(), 'ggml-custom.bin');
  fs.writeFileSync(src, fakeModel(10));
  const ok = await models.importFile(src, dir);
  assert.ok(ok.ok);
  assert.ok(fs.existsSync(path.join(dir, 'ggml-custom.bin')));
  const txt = path.join(tmp(), 'notes.txt');
  fs.writeFileSync(txt, 'hello');
  assert.match((await models.importFile(txt, dir)).error, /not a whisper\.cpp/);
  const fakeSmall = path.join(tmp(), 'ggml-small-q5_1.bin');
  fs.writeFileSync(fakeSmall, fakeModel(10));
  assert.match((await models.importFile(fakeSmall, dir)).error, /checksum/);
});
