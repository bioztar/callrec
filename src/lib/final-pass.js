'use strict';

// Quality pass after Stop: re-transcribes each channel's recording with the
// Final model, then replaces transcript.md/json and keeps the live draft as
// transcript.draft.md/json. A persisted queue (userData/final-queue.json)
// survives quitting mid-pass; the draft is copied before anything is replaced
// and is never overwritten, so it cannot be lost.

const fs = require('fs');
const path = require('path');
const { Segmenter } = require('./vad');
const { renderMarkdown, renderJson } = require('./transcript');
const { isEcho } = require('./echo');
const protocol = require('./whisper-protocol');
const { pcm16ToWav } = require('./wav');
const { readChannel, channelFiles } = require('./channel-audio');

const JOB = 'final-pass.json';
const SR = 16000;

const jobFile = (dir) => path.join(dir, JOB);
function readJob(dir) { try { return JSON.parse(fs.readFileSync(jobFile(dir), 'utf8')); } catch { return null; } }
function writeJob(dir, job) { writeAtomic(jobFile(dir), JSON.stringify(job, null, 2)); }
function writeAtomic(file, text) { fs.writeFileSync(`${file}.tmp`, text); fs.renameSync(`${file}.tmp`, file); }

/// Written at Stop, next to the draft: what the final pass needs.
function prepareJob(dir, { meta, offsets = {}, language }) {
  writeJob(dir, { status: 'pending', meta, offsets, language, attempts: 0 });
}

/// Utterances of one channel: long clips (≤ 28 s) give the model context.
function utterances(samples) {
  const out = [];
  const seg = new Segmenter({ sampleRate: SR, maxMs: 28000, endSilenceMs: 600, onSegment: (s) => out.push(s) });
  for (let i = 0; i < samples.length; i += SR) seg.push(samples.subarray(i, i + SR));
  seg.flush();
  return out;
}

/// A WhisperServer / ParakeetServer as a final-pass transcriber.
function serverTranscriber(server) {
  return {
    async transcribe(seg, { language }) {
      const wav = pcm16ToWav(seg.samples, SR);
      const m = protocol.mode(language);
      let reply = await server.transcribe(wav, { language: m.request });
      if (protocol.needsRetry(reply, language)) reply = await server.transcribe(wav, { language: m.fallback });
      const fin = protocol.toFinal(reply, seg);
      return fin ? fin.text : null;
    },
  };
}

/// Runs the pass for one meeting folder. `transcriber.transcribe(seg, { language })`
/// → text | null. `label` names the final model in the transcript header.
/// Transcriber that follows a CPU level while it runs: before each segment it
/// re-spawns the engine if `threads()` changed (the pass decodes segment by
/// segment, so nothing is lost or decoded twice).
function adaptiveTranscriber({ create, threads, log = () => {} }) {
  let server = null;
  let at = 0;
  let stopped = false;
  async function ensure() {
    if (stopped) throw new Error('final pass stopped');
    const want = threads();
    if (server && at === want) return server;
    if (server) { log(`final pass: ${at} → ${want} threads`); server.stop(); }
    server = create(want);
    at = want;
    await server.start();
    return server;
  }
  return {
    get threads() { return at; },
    async transcribe(seg, opts) { return serverTranscriber(await ensure()).transcribe(seg, opts); },
    stop() { stopped = true; if (server) server.stop(); server = null; },
  };
}

async function runFinalPass({ dir, transcriber, label, onProgress = () => {} }) {
  const job = readJob(dir);
  if (!job) throw new Error(`no ${JOB} in ${dir}`);
  if (job.status === 'done') return job;
  writeJob(dir, { ...job, status: 'running' });
  const channels = channelFiles(dir).map((c) => ({ ...c, segs: utterances(readChannel(c.file)) }));
  const total = channels.reduce((n, c) => n + c.segs.reduce((m, s) => m + (s.end - s.start), 0), 0) || 1;
  let done = 0;
  const segments = [];
  onProgress(0);
  for (const c of channels) {
    const off = Number(job.offsets && job.offsets[c.speaker]) || 0;
    for (const s of c.segs) {
      const text = await transcriber.transcribe(s, { language: job.language });
      if (text) segments.push({ speaker: c.speaker, start: round(off + s.start), end: round(off + s.end), text });
      done += s.end - s.start;
      onProgress(Math.min(0.99, done / total));
    }
  }
  // Mic lines that re-heard the other side through the speakers.
  const thems = segments.filter((s) => s.speaker === 'THEM');
  const kept = segments.filter((s) => s.speaker === 'THEM' || !isEcho(s, thems)).sort((a, b) => a.start - b.start);
  keepDraft(dir);
  const meta = { ...job.meta, startedAt: new Date(job.meta.startedAt), engine: `${label} (final pass; live draft: ${job.meta.engine})` };
  writeAtomic(path.join(dir, 'transcript.json'), renderJson(meta, kept));
  writeAtomic(path.join(dir, 'transcript.md'), renderMarkdown(meta, kept));
  const finished = { ...readJob(dir), status: 'done', model: label, segments: kept.length };
  writeJob(dir, finished);
  // The per-channel audio was only kept for this pass (audio.webm stays).
  channels.forEach((c) => fs.rmSync(c.file, { force: true }));
  onProgress(1);
  return finished;
}

/// Copies the live transcript to transcript.draft.* once; never overwrites it.
function keepDraft(dir) {
  for (const ext of ['md', 'json']) {
    const draft = path.join(dir, `transcript.draft.${ext}`);
    const live = path.join(dir, `transcript.${ext}`);
    if (!fs.existsSync(draft) && fs.existsSync(live)) {
      fs.copyFileSync(live, `${draft}.tmp`);
      fs.renameSync(`${draft}.tmp`, draft);
    }
  }
}

function round(x) { return Math.round(x * 100) / 100; }

/// Persisted FIFO of meeting folders. `run(dir, onProgress)` does one pass;
/// `onState({ dir, fraction } | null)` drives the tray / window; `onDone(dir, job)`.
/// A pass that fails is retried on the next launch (up to `maxAttempts`).
function createFinalQueue({ file, run, onState = () => {}, onDone = () => {}, onError = () => {}, maxAttempts = 3 }) {
  let dirs = [];
  try { dirs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { dirs = []; }
  let busy = null;
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); writeAtomic(file, JSON.stringify(dirs, null, 2)); };
  const drop = (dir) => { dirs = dirs.filter((d) => d !== dir); save(); };

  async function pump() {
    if (busy) return busy;
    busy = (async () => {
      const failed = new Set();
      for (;;) {
        const dir = dirs.find((d) => !failed.has(d));
        if (!dir) break;
        const job = readJob(dir);
        if (!job || job.status === 'done' || !fs.existsSync(dir)) { drop(dir); continue; }
        if ((job.attempts || 0) >= maxAttempts) { writeJob(dir, { ...job, status: 'failed' }); drop(dir); continue; }
        writeJob(dir, { ...job, attempts: (job.attempts || 0) + 1 });
        try {
          onState({ dir, fraction: 0 });
          const res = await run(dir, (fraction) => onState({ dir, fraction }));
          drop(dir);
          onDone(dir, res);
        } catch (err) {
          failed.add(dir); // stays queued: retried on the next launch or kick()
          const now = readJob(dir);
          // A missing Final model is not the meeting's fault: it does not use up an attempt.
          if (now) writeJob(dir, { ...now, status: 'pending', error: err.message, attempts: err.code === 'model-missing' ? job.attempts || 0 : now.attempts });
          onError(dir, err);
        }
      }
      onState(null);
    })().finally(() => { busy = null; });
    return busy;
  }

  return {
    /// `run: false` only persists it (while quitting).
    add(dir, { run = true } = {}) { if (!dirs.includes(dir)) { dirs.push(dir); save(); } return run ? pump() : Promise.resolve(); },
    /// Resume after launch / retry after the final model got installed.
    kick: pump,
    /// Forget a meeting (deleted by the user).
    remove(dir) { if (dirs.includes(dir)) drop(dir); },
    pending: () => [...dirs],
    idle: () => busy || Promise.resolve(),
  };
}

module.exports = { prepareJob, runFinalPass, serverTranscriber, createFinalQueue, readJob, utterances, keepDraft, JOB, adaptiveTranscriber };
