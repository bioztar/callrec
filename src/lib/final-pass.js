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
const { pack, split, timedWords } = require('./whisper-pack');
const { preEcho } = require('./echo-pcm');
const { etaSec } = require('./eta');

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

/// A WhisperServer / ParakeetServer as a final-pass transcriber. `stats.requests`
/// counts every engine call (a `mixed` retry is a second one).
function serverTranscriber(server, stats = { requests: 0 }) {
  async function decode(samples, language) {
    const wav = pcm16ToWav(samples, SR);
    const m = protocol.mode(language);
    stats.requests += 1;
    let reply = await server.transcribe(wav, { language: m.request });
    if (protocol.needsRetry(reply, language)) {
      stats.requests += 1;
      reply = await server.transcribe(wav, { language: m.fallback });
    }
    return reply;
  }
  const api = {
    stats,
    async transcribe(seg, { language }) {
      const fin = protocol.toFinal(await decode(seg.samples, language), seg);
      return fin ? fin.text : null;
    },
    /// One request for a packed window (Whisper) → `[{ index, text | null }]` per utterance.
    /// Utterances that come back empty (Whisper merged, skipped or stopped early,
    /// or the reply had no word times to split by) are decoded again: re-packed
    /// once if there are several, then on their own, so packing never loses
    /// speech a solo request would have kept. `stats.redecodes` counts the extra requests.
    async transcribeWindow(win, { language }, depth = 0) {
      const reply = await decode(win.samples, language);
      const many = win.parts.length > 1;
      const parts = many && !timedWords(reply, { keep: protocol.isSpeech })
        ? win.parts.map((p) => ({ index: p.index, text: '' })) : splitReply(win, reply);
      const out = parts.map((p, i) => ({ index: p.index, text: protocol.usableText(p.text, win.parts[i].len) }));
      const missing = many ? win.parts.filter((p, i) => out[i].text == null && p.samples) : [];
      const fill = (index, text) => { out.find((o) => o.index === index).text = text; };
      if (missing.length > 1 && depth === 0) {
        for (const w of pack(missing.map((p) => ({ samples: p.samples, start: p.start, end: p.end })))) {
          stats.redecodes = (stats.redecodes || 0) + 1;
          const again = await api.transcribeWindow(w, { language }, depth + 1);
          again.forEach((r) => fill(missing[r.index].index, r.text));
        }
      } else {
        for (const p of missing) {
          stats.redecodes = (stats.redecodes || 0) + 1;
          fill(p.index, await api.transcribe({ samples: p.samples, start: p.start, end: p.end }, { language }));
        }
      }
      return out;
    },
  };
  return api;
}

function splitReply(win, reply) { return split(win, reply, { keep: protocol.isSpeech }); }

/// Transcriber that follows a CPU level while it runs: before each request it
/// re-spawns the engine if `threads()` changed (the pass decodes request by
/// request, so nothing is lost or decoded twice). `stats.threads` is the history.
function adaptiveTranscriber({ create, threads, level = () => null, log = () => {}, now = Date.now }) {
  let server = null;
  let at = 0;
  let stopped = false;
  const t0 = now();
  const stats = { requests: 0, threads: [] };
  async function ensure() {
    if (stopped) throw new Error('final pass stopped');
    const want = threads();
    if (server && at === want) return server;
    if (server) { log(`final pass: ${at} → ${want} threads`); server.stop(); }
    server = create(want);
    at = want;
    stats.threads.push({ atSec: round((now() - t0) / 1000), threads: want, level: level() });
    await server.start();
    return server;
  }
  return {
    get threads() { return at; },
    stats,
    async transcribe(seg, opts) { return serverTranscriber(await ensure(), stats).transcribe(seg, opts); },
    async transcribeWindow(win, opts) { return serverTranscriber(await ensure(), stats).transcribeWindow(win, opts); },
    stop() { stopped = true; if (server) server.stop(); server = null; },
  };
}

/// Runs the pass for one meeting folder. `transcriber.transcribe(seg, { language })`
/// → text | null; with `whisper: true` it is fed packed windows instead
/// (`transcribeWindow`) and mic clips that only re-hear THEM are skipped before
/// decoding. `label` names the final model in the transcript header.
/// `onProgress(fraction, { etaSec })`.
async function runFinalPass({ dir, transcriber, label, whisper = false, onProgress = () => {}, log = () => {}, now = Date.now }) {
  const job = readJob(dir);
  if (!job) throw new Error(`no ${JOB} in ${dir}`);
  if (job.status === 'done') return job;
  writeJob(dir, { ...job, status: 'running' });
  const t0 = now();
  // THEM first: its speech is what the mic's echo is checked against.
  const channels = channelFiles(dir).map((c) => {
    const samples = readChannel(c.file);
    return { ...c, samples, off: Number(job.offsets && job.offsets[c.speaker]) || 0, segs: utterances(samples) };
  }).sort((a, b) => (b.speaker === 'THEM') - (a.speaker === 'THEM'));
  const total = channels.reduce((n, c) => n + c.segs.reduce((m, s) => m + (s.end - s.start), 0), 0) || 1;
  const audioSec = channels.reduce((n, c) => Math.max(n, c.off + c.samples.length / SR), 0);
  let done = 0;
  const stats = { requests: 0, utterances: 0, packedWindows: 0, echoSkipped: 0, echoSkippedSeconds: 0 };
  const segments = [];
  const progress = () => onProgress(Math.min(0.99, done / total), { etaSec: etaSec({ done, total, elapsedSec: (now() - t0) / 1000 }) });
  onProgress(0, { etaSec: null });
  const them = channels.find((c) => c.speaker === 'THEM');
  let themSpans = [];
  for (const c of channels) {
    let segs = c.segs.map((s) => ({ ...s, start: c.off + s.start, end: c.off + s.end }));
    stats.utterances += segs.length;
    if (whisper && c.speaker === 'ME' && them && themSpans.length) {
      const ref = { samples: them.samples, offset: them.off };
      segs = segs.filter((s) => {
        if (!preEcho(s, ref, themSpans).echo) return true;
        stats.echoSkipped += 1;
        stats.echoSkippedSeconds += s.end - s.start;
        done += s.end - s.start;
        return false;
      });
      progress();
    }
    const add = (s, text) => { if (text) segments.push({ speaker: c.speaker, start: round(s.start), end: round(s.end), text }); };
    if (whisper) {
      for (const w of pack(segs)) {
        stats.packedWindows += 1;
        const parts = await transcriber.transcribeWindow(w, { language: job.language });
        parts.forEach((p) => add(segs[p.index], p.text));
        done += w.parts.reduce((n, p) => n + (segs[p.index].end - segs[p.index].start), 0);
        progress();
      }
    } else {
      for (const s of segs) {
        add(s, await transcriber.transcribe(s, { language: job.language }));
        done += s.end - s.start;
        progress();
      }
    }
    if (c.speaker === 'THEM') themSpans = segments.filter((s) => s.speaker === 'THEM');
  }
  // Mic lines that re-heard the other side through the speakers (text check).
  const thems = segments.filter((s) => s.speaker === 'THEM');
  const kept = segments.filter((s) => s.speaker === 'THEM' || !isEcho(s, thems)).sort((a, b) => a.start - b.start);
  keepDraft(dir);
  const meta = { ...job.meta, startedAt: new Date(job.meta.startedAt), engine: `${label} (final pass; live draft: ${job.meta.engine})` };
  writeAtomic(path.join(dir, 'transcript.json'), renderJson(meta, kept));
  writeAtomic(path.join(dir, 'transcript.md'), renderMarkdown(meta, kept));
  const wallSec = (now() - t0) / 1000;
  const ts = transcriber.stats || {};
  const summary = {
    model: label,
    threads: ts.threads || [],
    audioSeconds: round(audioSec),
    speechSeconds: round(total),
    wallSeconds: round(wallSec),
    rtf: audioSec ? Math.round((wallSec / audioSec) * 1000) / 1000 : null,
    requests: ts.requests != null ? ts.requests : null,
    utterances: stats.utterances,
    packedWindows: whisper ? stats.packedWindows : null,
    redecodes: whisper ? (ts.redecodes || 0) : null,
    echoSkipped: stats.echoSkipped,
    echoSkippedSeconds: round(stats.echoSkippedSeconds),
  };
  const finished = { ...readJob(dir), status: 'done', model: label, segments: kept.length, stats: summary };
  writeJob(dir, finished);
  log(passLine(summary));
  // The per-channel audio was only kept for this pass (audio.webm stays).
  channels.forEach((c) => fs.rmSync(c.file, { force: true }));
  onProgress(1, { etaSec: 0 });
  return finished;
}

/// The one log line per pass: enough to tell later why it was slow.
function passLine(s) {
  const th = s.threads.length ? s.threads.map((t) => `${t.threads}${t.level != null ? ` (${t.level}%)` : ''}`).join(' → ') : '?';
  return `final pass done: ${s.model} · ${s.audioSeconds} s audio (${s.speechSeconds} s speech) in ${s.wallSeconds} s · RTF ${s.rtf}`
    + ` · ${s.requests} requests${s.packedWindows != null ? ` / ${s.packedWindows} windows${s.redecodes ? ` (+${s.redecodes} re-decodes)` : ''}` : ''} for ${s.utterances} utterances`
    + ` · threads ${th} · echo skipped ${s.echoSkippedSeconds} s`;
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
          const res = await run(dir, (fraction, info = {}) => onState({ dir, fraction, ...info }));
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

module.exports = { prepareJob, runFinalPass, serverTranscriber, createFinalQueue, readJob, utterances, keepDraft, JOB, adaptiveTranscriber, passLine };
