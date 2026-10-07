'use strict';

// Main-process supervisor for the native (on-device) STT helper.
//
// A Chromium renderer cannot link Speech.framework, so the native engine needs
// a real process boundary.
//
//   renderer --stt:start--> here --spawn--> native/stt/.build/release/callrec-stt
//   renderer --stt:chunk--> here --stdin--> (PCM16LE @ 16 kHz mono)
//   renderer <--stt:event-- here <-stdout-- (one JSON object per line)
//
// Framing: 4-byte LE length + JSON config on stdin, then raw PCM until EOF.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN_NAME = 'callrec-stt';

/// Candidate locations, most-specific first. Packaged builds get the helper
/// from extraResources; a dev checkout gets it straight out of SwiftPM's
/// release directory, which is exactly where native/stt/build.sh leaves it.
function candidates() {
  const out = [];
  if (process.env.CALLREC_NATIVE_STT) out.push(process.env.CALLREC_NATIVE_STT);
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'native', 'stt', BIN_NAME));
  const repo = path.join(__dirname, '..');
  out.push(path.join(repo, 'native', 'stt', '.build', 'release', BIN_NAME));
  out.push(path.join(repo, 'native', 'stt', BIN_NAME));
  return out;
}

function helperPath() {
  for (const p of candidates()) {
    try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return null;
}

const NOT_BUILT =
  'The native speech helper has not been built yet. Run:  cd native/stt && ./build.sh  ' +
  'Native STT is unavailable until then.';

/// One entry per live audio stream. callrec runs two at a time (THEM and ME),
/// because separate streams are how it gets speaker identity without a
/// diarization model — so it also runs two helpers.
const sessions = new Map();

function encodeHeader(config) {
  const json = Buffer.from(JSON.stringify(config), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length, 0);
  return Buffer.concat([length, json]);
}

/// Spawns a helper for `id`. `onEvent(payload)` receives every parsed stdout
/// line, plus synthesised `error` events for spawn/exit failures, so the
/// renderer only ever has to understand one shape.
function start(options, onEvent) {
  const { id } = options;
  if (!id) return { error: 'native STT: missing session id' };
  if (sessions.has(id)) stop(id);

  const bin = helperPath();
  if (!bin) return { error: NOT_BUILT };

  let child;
  try {
    child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return { error: `native STT: could not start the helper (${e.message})` };
  }

  const session = { child, id, closed: false, buffer: '' };
  sessions.set(id, session);

  // The helper reads its whole config before the first audio byte, so this has
  // to be the very first thing on the pipe.
  try {
    child.stdin.write(encodeHeader({
      speaker: options.speaker || 'THEM',
      locale: options.locale || 'en-US',
      keyterms: [],
      endpointSilenceMs: options.endpointSilenceMs || 300,
      maxUtteranceMs: options.maxUtteranceMs || 45000,
      engine: options.engine || 'auto',
    }));
  } catch (e) {
    sessions.delete(id);
    return { error: `native STT: could not send the config header (${e.message})` };
  }

  child.stdout.on('data', (data) => {
    session.buffer += data.toString('utf8');
    // stdout is newline-framed; a chunk boundary can land mid-line.
    let index = session.buffer.indexOf('\n');
    while (index !== -1) {
      const line = session.buffer.slice(0, index).trim();
      session.buffer = session.buffer.slice(index + 1);
      if (line) {
        let msg = null;
        try { msg = JSON.parse(line); } catch { msg = null; }
        if (msg) onEvent({ ...msg, id });
      }
      index = session.buffer.indexOf('\n');
    }
  });

  // stderr is diagnostics only and is never parsed — see the design doc §3.4.
  child.stderr.on('data', (data) => {
    const text = data.toString('utf8').trim();
    if (text) console.error(`[native-stt ${id}] ${text}`);
  });

  child.on('error', (e) => {
    onEvent({ type: 'error', code: 'spawn-failed', message: e.message, fatal: true, id });
    sessions.delete(id);
  });

  child.on('exit', (code, signal) => {
    sessions.delete(id);
    if (session.closed) return; // we asked for this
    onEvent({
      type: 'error',
      code: 'helper-exited',
      message: `the native speech helper exited unexpectedly (${signal || `code ${code}`})`,
      fatal: true,
      id,
    });
  });

  // A pipe that closes under us (helper gone) would otherwise throw EPIPE out
  // of the audio path on every chunk.
  child.stdin.on('error', () => { /* surfaced by the exit handler instead */ });

  return { ok: true };
}

// `Buffer.from` is overloaded in a way that silently mangles audio: given an
// ArrayBuffer it wraps the bytes, but given a typed array it copies *element
// values* — so a stray Int16Array would arrive as half-length garbage that
// still looks like valid PCM. The renderer transfers `out.buffer` (an
// ArrayBuffer) from pcm-worklet.js, and what Electron's structured clone hands
// the main process is a Buffer/Uint8Array/ArrayBuffer depending on version, so
// spell out every case rather than trust the overload.
function toBytes(buf) {
  if (Buffer.isBuffer(buf)) return buf;
  if (buf instanceof ArrayBuffer) return Buffer.from(buf);
  if (ArrayBuffer.isView(buf)) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return Buffer.from(buf);
}

function chunk(id, buf) {
  const session = sessions.get(id);
  if (!session || session.closed || !buf) return;
  try { session.child.stdin.write(toBytes(buf)); } catch { /* exit handler reports it */ }
}

/// Closing stdin is the normal shutdown: the helper drains, emits the final for
/// whatever was still open, and exits on its own.
function stop(id) {
  const session = sessions.get(id);
  if (!session) return;
  session.closed = true;
  sessions.delete(id);
  try { session.child.stdin.end(); } catch { /* already gone */ }
  setTimeout(() => { try { session.child.kill('SIGKILL'); } catch { /* already gone */ } }, 3000).unref?.();
}

function stopAll() { Array.from(sessions.keys()).forEach(stop); }

/// Which locales this Mac can actually transcribe on-device. Used by Settings
/// to offer a real picker instead of a free-text field.
function locales() {
  return new Promise((resolve) => {
    const bin = helperPath();
    if (!bin) { resolve({ error: NOT_BUILT }); return; }
    execFile(bin, ['--locales'], { timeout: 20000 }, (err, stdout) => {
      if (err) { resolve({ error: `native STT: ${err.message}` }); return; }
      const line = String(stdout).split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) { resolve({ error: 'native STT: the helper returned no locale list' }); return; }
      try {
        const parsed = JSON.parse(line);
        resolve({ supported: parsed.supported || [], installed: parsed.installed || [] });
      } catch (e) { resolve({ error: `native STT: unreadable locale list (${e.message})` }); }
    });
  });
}

/// True when the helper binary is present. Cheap enough to call from a UI path.
function isAvailable() { return helperPath() !== null; }

module.exports = { start, chunk, stop, stopAll, locales, isAvailable, helperPath, NOT_BUILT };
