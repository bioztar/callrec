'use strict';

// Parakeet through sherpa-onnx in a child process, behind the same surface as
// WhisperServer (start / transcribe(wav) → verbose_json-like reply / stop), so
// the live engine and the final pass treat both runtimes alike.

const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readWav } = require('./lib/wav');

const unpacked = (p) => p.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');

/// Folder of the sherpa-onnx native addon for this platform, or null.
function addonDir() {
  const plat = process.platform === 'win32' ? 'win' : process.platform;
  try {
    return unpacked(path.dirname(require.resolve(`sherpa-onnx-${plat}-${os.arch()}/package.json`)));
  } catch { return null; }
}

function isAvailable() { return addonDir() !== null; }

/// A Parakeet model is a folder holding tokens.txt + the ONNX files.
function isParakeetModel(p) {
  try { return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'tokens.txt')); } catch { return false; }
}

function defaultThreads() { return Math.max(1, Math.min(4, os.cpus().length - 1)); }

/// Below-normal priority for a background engine process (best effort).
function lowerPriority(pid, log = () => {}) {
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { log(`could not lower priority: ${e.message}`); }
}

class ParakeetServer {
  constructor({ model, threads = defaultThreads(), lowPriority = false, log = () => {} }) {
    this.model = model; this.threads = threads; this.lowPriority = lowPriority; this.log = log;
    this.child = null; this.exited = null; this.pending = new Map(); this.nextId = 1;
  }

  async start() {
    const lib = addonDir();
    if (!lib) throw new Error('Parakeet runtime (sherpa-onnx) is not bundled in this build');
    const sep = path.delimiter;
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PATH: `${lib}${sep}${process.env.PATH || ''}`,
      LD_LIBRARY_PATH: `${lib}${sep}${process.env.LD_LIBRARY_PATH || ''}`,
      DYLD_LIBRARY_PATH: `${lib}${sep}${process.env.DYLD_LIBRARY_PATH || ''}`,
    };
    this.child = fork(path.join(__dirname, 'parakeet-worker.js'), [], { env, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    if (this.lowPriority) lowerPriority(this.child.pid, this.log);
    let stderr = '';
    this.child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    this.child.on('message', ({ id, ...msg }) => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (msg.error) p.reject(new Error(`Parakeet: ${msg.error}`)); else p.resolve(msg.result);
    });
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      const err = new Error(`Parakeet worker exited (${signal || code})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
    });
    const t0 = Date.now();
    await this.call({ op: 'load', model: this.model, threads: this.threads });
    this.log(`Parakeet loaded in ${Date.now() - t0} ms`);
  }

  call(msg) {
    if (!this.child || this.exited) return Promise.reject(new Error('Parakeet worker is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, ...msg });
    });
  }

  /// PCM16 samples (Int16Array) → { text, tokens, timestamps }.
  decode(samples) {
    return this.call({ op: 'decode', samples: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength) });
  }

  /// WAV clip → reply shaped like whisper-server's verbose_json. Parakeet picks
  /// the language itself (no per-language retry).
  async transcribe(wav) {
    const { samples } = readWav(Buffer.from(wav));
    const r = await this.decode(samples);
    return { text: r.text.trim(), language: '', autoLanguage: true, segments: [] };
  }

  stop() {
    if (this.child && !this.exited) { try { this.child.kill(); } catch { /* gone */ } }
  }
}

module.exports = { ParakeetServer, isAvailable, isParakeetModel, addonDir, lowerPriority };
