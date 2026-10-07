'use strict';

const fs = require('fs');
const path = require('path');
const { folderName, uniqueDir } = require('./naming');
const { renderMarkdown, renderJson } = require('./transcript');

/// Writes one meeting folder incrementally so a crash keeps everything so far:
/// audio chunks are appended as they arrive; transcript.md/json are rewritten
/// on every final (they are small).
class SessionWriter {
  constructor({ root, title, engine, language, languageNote, now = () => new Date() }) {
    this.now = now;
    this.meta = { title: title || '', startedAt: now(), durationSec: 0, engine, language, languageNote };
    fs.mkdirSync(root, { recursive: true });
    this.dir = uniqueDir(root, folderName(this.meta.startedAt, title));
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

  finish(durationSec) {
    this.meta = { ...this.meta, durationSec: Math.max(durationSec, this.meta.durationSec) };
    this._flush();
    return this.dir;
  }

  _flush() {
    fs.writeFileSync(path.join(this.dir, 'transcript.md'), renderMarkdown(this.meta, this.segments));
    fs.writeFileSync(path.join(this.dir, 'transcript.json'), renderJson(this.meta, this.segments));
  }
}

module.exports = { SessionWriter };
