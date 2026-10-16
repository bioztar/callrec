'use strict';

// Whisper pads every request to a 30 s window, so one short utterance costs as
// much encoder time as 30 s of speech. The final pass therefore packs a
// channel's consecutive utterances into one request (≤ 28 s, silence between
// them cut to ≤ 0.4 s) and maps the reply's word times back to each utterance.

const SR = 16000;

/// Utterances (`{ samples, start, end }`, seconds on the channel clock) →
/// windows `{ samples, start, end, parts: [{ index, at, len, start, end }] }`,
/// where `at`/`len` place utterance `index` inside the window (seconds).
function pack(segs, { maxSec = 28, gapSec = 0.4, sampleRate = SR } = {}) {
  const windows = [];
  let cur = null;
  const close = () => {
    if (!cur) return;
    const n = cur.chunks.reduce((m, c) => m + c.length, 0);
    const samples = new Int16Array(n);
    let o = 0;
    for (const c of cur.chunks) { samples.set(c, o); o += c.length; }
    windows.push({ samples, start: cur.parts[0].start, end: cur.parts[cur.parts.length - 1].end, parts: cur.parts });
    cur = null;
  };
  segs.forEach((s, index) => {
    const len = s.samples.length / sampleRate;
    const prev = cur && cur.parts[cur.parts.length - 1];
    const gap = prev ? Math.round(Math.min(gapSec, Math.max(0, s.start - prev.end)) * sampleRate) : 0;
    if (cur && cur.sec + gap / sampleRate + len > maxSec) close();
    if (!cur) cur = { chunks: [], parts: [], sec: 0 };
    const pad = cur.parts.length ? gap : 0;
    if (pad) cur.chunks.push(new Int16Array(pad));
    const at = cur.sec + pad / sampleRate;
    cur.chunks.push(s.samples);
    cur.parts.push({ index, at, len, start: s.start, end: s.end });
    cur.sec = at + len;
  });
  close();
  return windows;
}

/// Window time → channel time (seconds). Times in a trimmed gap belong to the
/// nearer utterance.
function toOriginal(win, t) {
  const p = win.parts[partAt(win, t)];
  return p.start + Math.min(Math.max(0, t - p.at), p.len);
}

function partAt(win, t) {
  const p = win.parts;
  for (let i = 0; i < p.length; i += 1) {
    const next = p[i + 1];
    if (!next || t < (p[i].at + p[i].len + next.at) / 2) return i;
  }
  return p.length - 1;
}

/// verbose_json reply for a window → text per utterance: `[{ index, text }]`.
/// Every word goes to exactly one utterance (by its midpoint), so nothing is
/// lost or repeated; segments without word times fall back to their midpoint.
/// `keep(segment)` drops segments Whisper marks as silence.
function split(win, reply, { keep = () => true } = {}) {
  const texts = win.parts.map(() => []);
  const segs = Array.isArray(reply && reply.segments) ? reply.segments.filter(keep) : [];
  if (!segs.length && reply && reply.text && !Array.isArray(reply.segments)) texts[0].push(reply.text);
  for (const s of segs) {
    const words = Array.isArray(s.words) && s.words.length ? s.words : [{ word: s.text, start: s.start, end: s.end }];
    for (const w of words) {
      const mid = (Number(w.start) + Number(w.end)) / 2;
      texts[partAt(win, Number.isFinite(mid) ? mid : 0)].push(w.word);
    }
  }
  return win.parts.map((p, i) => ({ index: p.index, text: texts[i].join('').replace(/\s+/g, ' ').trim() }));
}

module.exports = { pack, split, toOriginal, partAt };
