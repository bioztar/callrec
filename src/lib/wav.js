'use strict';

/// PCM16 mono samples → a complete RIFF/WAVE file (what whisper-server accepts).
function pcm16ToWav(samples, sampleRate = 16000) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/// Reads a PCM16 mono WAV file buffer → { sampleRate, samples: Int16Array }.
function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12; let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) throw new Error('expected PCM16 mono WAV');
      const bytes = buf.subarray(body, Math.min(buf.length, body + size));
      const samples = new Int16Array(bytes.length >> 1);
      for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readInt16LE(i * 2);
      return { sampleRate: fmt.sampleRate, samples };
    }
    off = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

module.exports = { pcm16ToWav, readWav };
