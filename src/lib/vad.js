'use strict';

// Energy VAD that cuts a 16 kHz PCM16 stream into utterances for Whisper.
// Whisper transcribes whole clips, so callrec feeds it one clip per utterance:
// speech starts after `startMs` of frames above the adaptive threshold, ends after
// `endSilenceMs` below it, and is force-cut at `maxMs`.
// Times are seconds of audio consumed, so they map straight onto the stream clock.

const FRAME_MS = 20;

class Segmenter {
  constructor({
    sampleRate = 16000,
    startMs = 60,
    endSilenceMs = 700,
    maxMs = 15000,
    minSpeechMs = 250,
    preRollMs = 300,
    tailMs = 200,
    minRms = 0.006,
    floorRatio = 3,
    onSpeechStart = () => {},
    onSegment = () => {},
  } = {}) {
    this.rate = sampleRate;
    this.frame = Math.round((sampleRate * FRAME_MS) / 1000);
    this.cfg = { startMs, endSilenceMs, maxMs, minSpeechMs, preRollMs, tailMs, minRms, floorRatio };
    this.onSpeechStart = onSpeechStart;
    this.onSegment = onSegment;
    this.floor = minRms / 2; // noise floor estimate (RMS, full scale = 1)
    this.carry = new Int16Array(0); // samples that did not fill a frame yet
    this.consumed = 0; // samples consumed into frames
    this.history = []; // recent frames kept for pre-roll while idle
    this.active = null; // { frames: [], startSample, voiced, silence }
    this.loud = 0; // consecutive loud frames while idle
  }

  /// Feeds PCM16 mono samples (Int16Array, Buffer or ArrayBuffer of PCM16LE).
  push(pcm) {
    const samples = toInt16(pcm);
    let buf = samples;
    if (this.carry.length) {
      buf = new Int16Array(this.carry.length + samples.length);
      buf.set(this.carry, 0);
      buf.set(samples, this.carry.length);
    }
    let off = 0;
    while (off + this.frame <= buf.length) {
      this._frame(buf.subarray(off, off + this.frame));
      off += this.frame;
    }
    this.carry = buf.slice(off);
  }

  /// Ends the stream: emits whatever utterance is still open.
  flush() {
    if (this.carry.length && this.active) this.active.frames.push(this.carry);
    this.carry = new Int16Array(0);
    if (this.active) this._close(true);
  }

  get timeSec() { return this.consumed / this.rate; }

  _frame(frame) {
    const copy = frame.slice();
    const rms = frameRms(copy);
    const { startMs, endSilenceMs, maxMs, preRollMs, minRms, floorRatio } = this.cfg;
    const thr = Math.max(minRms, this.floor * floorRatio);
    const loud = rms > thr;
    this.consumed += copy.length;

    if (!this.active) {
      // Track the noise floor only outside speech: falls fast, rises slowly.
      this.floor = rms < this.floor ? this.floor * 0.8 + rms * 0.2 : this.floor * 0.995 + rms * 0.005;
      this.history.push(copy);
      const keep = Math.ceil(preRollMs / FRAME_MS) + Math.ceil(startMs / FRAME_MS);
      if (this.history.length > keep) this.history.shift();
      this.loud = loud ? this.loud + 1 : 0;
      if (this.loud * FRAME_MS >= startMs) {
        const frames = this.history.splice(0);
        const startSample = this.consumed - frames.reduce((n, f) => n + f.length, 0);
        this.active = { frames, startSample, voiced: this.loud, silence: 0 };
        this.loud = 0;
        this.onSpeechStart(startSample / this.rate);
      }
      return;
    }

    const a = this.active;
    a.frames.push(copy);
    if (loud) { a.voiced += 1; a.silence = 0; } else a.silence += 1;
    const lenMs = a.frames.length * FRAME_MS;
    if (a.silence * FRAME_MS >= endSilenceMs) this._close(false);
    else if (lenMs >= maxMs) this._close(true);
  }

  _close(keepTail) {
    const a = this.active;
    this.active = null;
    const { tailMs, minSpeechMs } = this.cfg;
    // Trim trailing silence down to `tailMs` (all of it is kept on a forced cut).
    const drop = keepTail ? 0 : Math.max(0, a.silence - Math.ceil(tailMs / FRAME_MS));
    const frames = drop ? a.frames.slice(0, a.frames.length - drop) : a.frames;
    if (a.voiced * FRAME_MS < minSpeechMs) return; // a click or a cough, not speech
    const total = frames.reduce((n, f) => n + f.length, 0);
    const samples = new Int16Array(total);
    let o = 0;
    for (const f of frames) { samples.set(f, o); o += f.length; }
    this.onSegment({
      start: a.startSample / this.rate,
      end: (a.startSample + total) / this.rate,
      samples,
    });
  }
}

function frameRms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) { const v = frame[i] / 32768; sum += v * v; }
  return Math.sqrt(sum / (frame.length || 1));
}

function toInt16(pcm) {
  if (pcm instanceof Int16Array) return pcm;
  if (Buffer.isBuffer(pcm) || ArrayBuffer.isView(pcm)) {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
    return new Int16Array(bytes.slice().buffer); // copy: the source may be unaligned
  }
  if (pcm instanceof ArrayBuffer) return new Int16Array(pcm.slice(0, pcm.byteLength - (pcm.byteLength % 2)));
  return new Int16Array(0);
}

module.exports = { Segmenter, frameRms, toInt16, FRAME_MS };
