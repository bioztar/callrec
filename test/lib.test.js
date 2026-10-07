'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sanitizeTitle, folderName, uniqueDir } = require('../src/lib/naming');
const { coalesce, renderMarkdown, renderJson } = require('../src/lib/transcript');
const { SessionWriter } = require('../src/lib/session-writer');
const { createSettings } = require('../src/lib/settings');
const { deepgramLanguage, nativeLocale } = require('../src/lib/engines');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'callrec-test-'));

test('sanitizeTitle strips path chars and trims', () => {
  assert.equal(sanitizeTitle('  ../a/b:c*?  '), 'a b c');
  assert.equal(sanitizeTitle(undefined), '');
  assert.equal(sanitizeTitle('x'.repeat(100)).length, 60);
});

test('folderName uses local date + HHmm + title', () => {
  const d = new Date(2026, 9, 7, 9, 5);
  assert.equal(folderName(d, 'Standup'), '2026-10-07 0905 Standup');
  assert.equal(folderName(d, ''), '2026-10-07 0905');
});

test('uniqueDir appends (2), (3) on collision', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'm'));
  fs.mkdirSync(path.join(root, 'm (2)'));
  assert.equal(uniqueDir(root, 'm'), path.join(root, 'm (3)'));
  assert.equal(uniqueDir(root, 'fresh'), path.join(root, 'fresh'));
});

test('coalesce merges same speaker within gap only, without mutating', () => {
  const input = [
    { speaker: 'ME', start: 0, end: 2, text: 'hello' },
    { speaker: 'ME', start: 3, end: 4, text: 'there' },
    { speaker: 'THEM', start: 4.5, end: 6, text: 'hi' },
    { speaker: 'ME', start: 20, end: 21, text: 'later' },
  ];
  const copy = JSON.parse(JSON.stringify(input));
  const out = coalesce(input);
  assert.deepEqual(input, copy);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { speaker: 'ME', start: 0, end: 4, text: 'hello there' });
});

test('markdown + json render header and labelled lines', () => {
  const meta = { title: 'T', startedAt: new Date(Date.UTC(2026, 0, 1)), durationSec: 125, engine: 'native', language: 'English' };
  const segs = [{ speaker: 'ME', start: 1, end: 2, text: 'a' }, { speaker: 'THEM', start: 65, end: 70, text: 'b' }];
  const md = renderMarkdown(meta, segs);
  assert.match(md, /^# T/);
  assert.match(md, /Duration: 2m 5s/);
  assert.match(md, /\[00:01\] Me: a/);
  assert.match(md, /\[01:05\] Them: b/);
  const json = JSON.parse(renderJson(meta, segs));
  assert.equal(json.segments[1].speaker, 'THEM');
  assert.equal(json.segments[1].engine, 'native');
});

test('SessionWriter writes incrementally and handles folder collisions', () => {
  const root = tmp();
  const fixed = () => new Date(2026, 9, 7, 10, 0);
  const a = new SessionWriter({ root, title: 'Call', engine: 'native', language: 'English', now: fixed });
  const b = new SessionWriter({ root, title: 'Call', engine: 'native', language: 'English', now: fixed });
  assert.notEqual(a.dir, b.dir);
  assert.equal(path.basename(b.dir), '2026-10-07 1000 Call (2)');

  a.addAudio(new Uint8Array([1, 2, 3]));
  a.addAudio(new Uint8Array([4]));
  a.addSegment({ speaker: 'ME', start: 0, end: 1, text: ' hi ' });
  a.addSegment({ speaker: 'THEM', start: 2, end: 3, text: '   ' }); // ignored
  // Read before finish(): simulates a crash.
  assert.deepEqual([...fs.readFileSync(a.audioPath)], [1, 2, 3, 4]);
  assert.match(fs.readFileSync(path.join(a.dir, 'transcript.md'), 'utf8'), /Me: hi/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.dir, 'transcript.json'), 'utf8')).segments.length, 1);
  a.finish(30);
  assert.match(fs.readFileSync(path.join(a.dir, 'transcript.md'), 'utf8'), /Duration: 0m 30s/);
});

test('settings persist, key encrypted at rest and never returned by get()', () => {
  const file = path.join(tmp(), 's.json');
  const crypto = {
    available: () => true,
    encrypt: (s) => Buffer.from([...s].reverse().join('')),
    decrypt: (b) => [...b.toString()].reverse().join(''),
  };
  const s = createSettings({ file, crypto });
  assert.equal(s.get().engine, 'native');
  assert.equal(s.get().language, 'es');
  s.set({ engine: 'deepgram', outputRoot: '/x', hasDeepgramKey: true, deepgramKeyEnc: 'evil' });
  s.setDeepgramKey('FAKE-TEST-KEY');
  const again = createSettings({ file, crypto });
  assert.equal(again.get().engine, 'deepgram');
  assert.equal(again.get().hasDeepgramKey, true);
  assert.equal(JSON.stringify(again.get()).includes('FAKE'), false);
  assert.equal(fs.readFileSync(file, 'utf8').includes('FAKE-TEST-KEY'), false);
  assert.equal(again.getDeepgramKey(), 'FAKE-TEST-KEY');
  again.setDeepgramKey('');
  assert.equal(again.get().hasDeepgramKey, false);
});

test('settings refuse to store a key without secure storage', () => {
  const s = createSettings({ file: path.join(tmp(), 's.json'), crypto: { available: () => false } });
  assert.throws(() => s.setDeepgramKey('k'), /Secure storage/);
});

test('language mapping', () => {
  assert.equal(deepgramLanguage('mixed'), 'multi');
  assert.equal(deepgramLanguage('es'), 'es');
  assert.equal(nativeLocale('en').locale, 'en-US');
  assert.equal(nativeLocale('es').locale, 'es-ES');
  assert.equal(nativeLocale('mixed', 'en-GB').locale, 'en-GB');
  assert.match(nativeLocale('mixed', 'en-GB').note, /en-GB only/);
  assert.equal(nativeLocale('mixed', 'garbage!').locale, 'en-US');
});
