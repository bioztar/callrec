'use strict';

// Per-channel recording for the final pass: 16 kHz mono PCM16 WAV per speaker
// (audio-me.wav = mic, audio-them.wav = system audio), appended as it arrives.
// The header is patched on close; a file cut short by a crash is still read
// (the data runs to the end of the file).

const fs = require('fs');
const path = require('path');
const { pcm16ToWav } = require('./wav');

const FILES = { ME: 'audio-me.wav', THEM: 'audio-them.wav' };
const HEADER = 44;

class ChannelWriter {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'w');
    fs.writeSync(this.fd, pcm16ToWav(new Int16Array(0)));
    this.bytes = 0;
  }

  write(buf) {
    if (this.fd === null) return;
    const b = Buffer.from(buf.buffer ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : buf);
    fs.writeSync(this.fd, b);
    this.bytes += b.length;
  }

  close() {
    if (this.fd === null) return;
    const h = Buffer.alloc(8);
    h.writeUInt32LE(36 + this.bytes, 0);
    fs.writeSync(this.fd, h, 0, 4, 4);
    h.writeUInt32LE(this.bytes, 4);
    fs.writeSync(this.fd, h, 4, 4, 40);
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

/// Both channels of one meeting plus where each starts on the meeting clock.
class ChannelRecorder {
  constructor(dir) {
    this.dir = dir;
    this.writers = {};
    this.offsets = {};
  }

  /// `offsetSec`: meeting second of this channel's first sample (sent once).
  add(speaker, buf, offsetSec) {
    if (!FILES[speaker]) return;
    if (!this.writers[speaker]) {
      this.writers[speaker] = new ChannelWriter(path.join(this.dir, FILES[speaker]));
      this.offsets[speaker] = Math.max(0, Number(offsetSec) || 0);
    }
    this.writers[speaker].write(buf);
  }

  close() {
    Object.values(this.writers).forEach((w) => w.close());
    return { ...this.offsets };
  }
}

/// PCM16 samples of a channel file written above (or any 44-byte-header WAV).
function readChannel(file) {
  const buf = fs.readFileSync(file);
  const data = buf.subarray(HEADER, HEADER + Math.floor((buf.length - HEADER) / 2) * 2);
  const copy = Buffer.from(data);
  return new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2);
}

function channelFiles(dir) {
  return Object.entries(FILES).map(([speaker, f]) => ({ speaker, file: path.join(dir, f) })).filter((c) => fs.existsSync(c.file));
}

module.exports = { ChannelRecorder, ChannelWriter, readChannel, channelFiles, FILES };
