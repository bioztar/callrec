'use strict';

const fs = require('fs');
const path = require('path');
const { folderName, callFolderName, uniqueDir } = require('./naming');
const { renderMarkdown, renderJson } = require('./transcript');

/// Writes one meeting folder incrementally so a crash keeps everything so far:
/// audio chunks are appended as they arrive; transcript.md/json are rewritten
/// on every final (they are small).
class SessionWriter {
  constructor({ root, title, engine, language, languageNote, call = null, now = () => new Date() }) {
    this.now = now;
    this.meta = { title: title || '', startedAt: now(), durationSec: 0, engine, language, languageNote, markers: [] };
    if (call) this.meta.call = { ...call, startedAt: new Date(call.startedAt || this.meta.startedAt).toISOString() };
    fs.mkdirSync(root, { recursive: true });
    const name = call ? callFolderName(this.meta.startedAt, title) : folderName(this.meta.startedAt, title);
    this.dir = uniqueDir(root, name);
    fs.mkdirSync(this.dir);
    this.audioPath = path.join(this.dir, 'audio.webm');
    fs.writeFileSync(this.audioPath, '');
    this.segments = [];
    this._flush();
  }

  addAudio(bytes) {
    fs.appendFileSync(this.audioPath, Buffer.from(bytes));
  }

  /// seg: { start, end, speaker: 'ME'|'THEM', text } — seconds since start.
  addSegment(seg) {
    if (!seg || !seg.text || !seg.text.trim()) return;
    // Stable sort by start: held Me finals (echo check) can arrive late.
    this.segments = [...this.segments, { ...seg, text: seg.text.trim() }].sort((a, b) => a.start - b.start);
    this.meta = { ...this.meta, durationSec: Math.max(this.meta.durationSec, seg.end) };
    this._flush();
  }

  /// A note at `atSec` since start, e.g. { text: 'screenshot 001', clock: '10:02:03' }.
  addMarker(atSec, text, clock) {
    this.meta = { ...this.meta, markers: [...this.meta.markers, { at: Math.round(atSec * 10) / 10, clock, text }] };
    this._flush();
  }

  finish(durationSec) {
    this.meta = { ...this.meta, durationSec: Math.max(durationSec, this.meta.durationSec) };
    if (this.meta.call && !this.meta.call.endedAt) this.meta.call = { ...this.meta.call, endedAt: this.now().toISOString() };
    this._flush();
    return this.dir;
  }

  _flush() {
    fs.writeFileSync(path.join(this.dir, 'transcript.md'), renderMarkdown(this.meta, this.segments));
    fs.writeFileSync(path.join(this.dir, 'transcript.json'), renderJson(this.meta, this.segments));
  }
}

module.exports = { SessionWriter };
