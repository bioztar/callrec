'use strict';

// Main-process Whisper engine. Same surface and event protocol as native-stt.js
// (ready / partial / final / error, plus `done` after a drain), so the renderer
// handles it with the same socket.
//
//   renderer --stt:chunk--> Segmenter (energy VAD, per stream)
//            utterance ---> queue ---> whisper-server on 127.0.0.1 (one process,
//                                      model loaded once, shared by Me and Them)
//   renderer <--stt:event-- final { text, start, end, lang }
//
// whisper-server is whisper.cpp's HTTP server, bundled as an extraResource.
// It listens on loopback only and gets clips over HTTP; nothing leaves the machine.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { Segmenter } = require('./lib/vad');
const { pcm16ToWav } = require('./lib/wav');
const protocol = require('./lib/whisper-protocol');
const parakeet = require('./parakeet-stt');

const EXE = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
const SAMPLE_RATE = 16000;
const BACKLOG_WARN_SEC = 30;

function candidates() {
  const out = [];
  if (process.env.CALLREC_WHISPER_BIN) out.push(process.env.CALLREC_WHISPER_BIN);
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'whisper', EXE));
  out.push(path.join(__dirname, '..', 'vendor', 'whisper', EXE));
  return out;
}

function binaryPath() {
  for (const p of candidates()) {
    try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return null;
}

function isAvailable() { return binaryPath() !== null; }

const NOT_BUILT = 'The Whisper engine is not bundled in this build. Run:  npm run build:whisper';

function defaultThreads() {
  const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, n > 4 ? n - 1 : n));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/// One whisper-server child bound to 127.0.0.1.
class WhisperServer {
  constructor({ bin, model, threads = defaultThreads(), lowPriority = false, log = () => {} }) {
    this.bin = bin; this.model = model; this.threads = threads; this.lowPriority = lowPriority; this.log = log;
    this.child = null; this.port = 0; this.exited = null; this.stderr = '';
  }

  async start({ timeoutMs = 120000 } = {}) {
    this.port = await freePort();
    const args = ['-m', this.model, '--host', '127.0.0.1', '--port', String(this.port),
      '-t', String(this.threads), '-l', 'auto', '-nlp'];
    this.child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (this.lowPriority && this.child.pid) parakeet.lowerPriority(this.child.pid, this.log);
    const keep = (d) => { this.stderr = (this.stderr + d.toString()).slice(-4000); };
    this.child.stdout.on('data', keep);
    this.child.stderr.on('data', keep);
    this.exitPromise = new Promise((resolve) => {
      this.child.on('error', (err) => { this.exited = { error: err.message }; resolve(); });
      this.child.on('exit', (code, signal) => { this.exited = { code, signal }; resolve(); });
    });
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.exited) throw new Error(`whisper-server exited during start-up (${this.exitReason()})`);
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (res.ok) { this.log(`whisper-server ready on 127.0.0.1:${this.port} in ${Date.now() - t0} ms`); return; }
      } catch { /* not listening yet */ }
      await delay(150);
    }
    this.stop();
    throw new Error('whisper-server did not become ready in time');
  }

  exitReason() {
    const e = this.exited || {};
    const tail = this.stderr.trim().split('\n').slice(-2).join(' | ');
    return `${e.error || (e.signal ? `signal ${e.signal}` : `code ${e.code}`)}${tail ? `: ${tail}` : ''}`;
  }

  /// POSTs one WAV clip to /inference → verbose_json object.
  async transcribe(wav, { language }) {
    if (this.exited) throw new Error(`whisper-server is not running (${this.exitReason()})`);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
    form.append('response_format', 'verbose_json');
    form.append('language', language);
    form.append('temperature', '0.0');
    form.append('no_language_probabilities', 'true');
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form });
    const body = await res.text();
    if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}: ${body.slice(0, 200)}`);
    const json = JSON.parse(body);
    if (json.error) throw new Error(`whisper-server: ${json.error}`);
    return json;
  }

  stop() {
    if (this.child && !this.exited) { try { this.child.kill(); } catch { /* gone */ } }
  }
}

/// The engine: sessions (one per audio stream), the shared server, the queue.
/// `transcribe(wav, { language })` can be injected (tests); otherwise a
/// WhisperServer is started lazily for `modelPath`.
/// A model path is a whisper.cpp ggml file or a Parakeet (sherpa-onnx) folder.
function defaultServerFactory(o) {
  return parakeet.isParakeetModel(o.model) ? new parakeet.ParakeetServer(o) : new WhisperServer(o);
}

function createEngine({ transcribe: injected = null, serverFactory = defaultServerFactory, log = () => {}, idleStopMs = 60000 } = {}) {
  const sessions = new Map();
  let server = null; // { model, instance, ready: Promise }
  let queue = Promise.resolve();
  let queuedSec = 0;
  let idleTimer = null;

  function ensureServer(model) {
    if (injected) return Promise.resolve();
    clearTimeout(idleTimer);
    if (server && server.model === model && !server.instance.exited) return server.ready;
    if (server) server.instance.stop();
    const bin = binaryPath();
    if (!bin && !parakeet.isParakeetModel(model)) return Promise.reject(new Error(NOT_BUILT));
    const instance = serverFactory({ bin, model, log });
    server = { model, instance, ready: instance.start() };
    server.ready.catch(() => { if (server && server.instance === instance) server = null; });
    return server.ready;
  }

  function run(wav, language) {
    if (injected) return injected(wav, { language });
    return server ? server.instance.transcribe(wav, { language }) : Promise.reject(new Error('whisper-server is not running'));
  }

  function maybeIdleStop() {
    if (sessions.size || !server || injected) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!sessions.size && server) { server.instance.stop(); server = null; } }, idleStopMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  async function transcribeSegment(s, seg) {
    const wav = pcm16ToWav(seg.samples, SAMPLE_RATE);
    const m = protocol.mode(s.language);
    let reply = await run(wav, m.request);
    if (protocol.needsRetry(reply, s.language)) reply = await run(wav, m.fallback);
    return protocol.toFinal(reply, seg);
  }

  function enqueue(s, seg) {
    const dur = seg.end - seg.start;
    queuedSec += dur;
    s.pending += 1;
    if (queuedSec > BACKLOG_WARN_SEC && !s.warnedBacklog) {
      s.warnedBacklog = true;
      s.emit({ type: 'error', code: 'backlog', fatal: false, message: `Whisper is ${Math.round(queuedSec)} s behind — this CPU is too slow for the model; pick a smaller one in Settings` });
    }
    queue = queue.then(async () => {
      try {
        const final = await transcribeSegment(s, seg);
        if (final) s.emit(final);
      } catch (err) {
        s.emit({ type: 'error', code: 'transcribe', fatal: false, message: err.message });
      } finally {
        queuedSec -= dur;
        s.pending -= 1;
        if (s.stopping && s.pending === 0) finish(s);
      }
    });
  }

  function finish(s) {
    if (s.done) return;
    s.done = true;
    sessions.delete(s.id);
    s.emit({ type: 'done' });
    maybeIdleStop();
  }

  /// options: { id, language: es|en|mixed, modelPath }. Emits `ready` once the
  /// server is up; audio pushed before that is segmented and queued anyway.
  function start(options, onEvent) {
    const { id, language = 'es', modelPath } = options || {};
    if (!id) return { error: 'Whisper: missing session id' };
    if (!injected && !modelPath) return { error: 'Whisper: no model file', code: 'model-missing' };
    if (sessions.has(id)) stop(id);
    const s = { id, language, pending: 0, stopping: false, done: false, warnedBacklog: false };
    s.emit = (msg) => { try { onEvent({ id, ...msg }); } catch { /* window gone */ } };
    s.seg = new Segmenter({
      sampleRate: SAMPLE_RATE,
      onSpeechStart: () => s.emit({ type: 'partial', text: '…' }),
      onSegment: (seg) => enqueue(s, seg),
    });
    sessions.set(id, s);
    ensureServer(modelPath).then(
      () => { if (!s.done) s.emit({ type: 'ready', engine: 'whisper', locale: protocol.mode(language).request, onDevice: true }); },
      (err) => {
        if (s.done) return;
        s.emit({ type: 'error', code: 'server', fatal: true, message: err.message });
        s.done = true; sessions.delete(id);
      },
    );
    return { ok: true };
  }

  function chunk(id, buf) {
    const s = sessions.get(id);
    if (s && !s.stopping) s.seg.push(toBytes(buf));
  }

  /// Ends the stream: the open utterance is transcribed, then `done` is emitted.
  function stop(id) {
    const s = sessions.get(id);
    if (!s || s.stopping) return;
    s.stopping = true;
    s.seg.flush();
    if (s.pending === 0) finish(s);
  }

  function stopAll({ killServer = true } = {}) {
    Array.from(sessions.keys()).forEach(stop);
    if (killServer && server) { server.instance.stop(); server = null; }
  }

  /// Resolves when every queued clip has been transcribed (tests, shutdown).
  function idle() { return queue; }

  return { start, chunk, stop, stopAll, idle, sessions };
}

function toBytes(buf) {
  if (Buffer.isBuffer(buf)) return buf;
  if (buf instanceof ArrayBuffer) return Buffer.from(buf);
  if (ArrayBuffer.isView(buf)) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return Buffer.alloc(0);
}

const engine = createEngine({ log: (m) => console.log(`[whisper] ${m}`) });

module.exports = {
  defaultServerFactory,
  ...engine, createEngine, WhisperServer, binaryPath, isAvailable, defaultThreads, NOT_BUILT,
};
