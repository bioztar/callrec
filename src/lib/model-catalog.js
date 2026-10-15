'use strict';

// Every on-device model callrec can use, across runtimes (whisper.cpp ggml
// files, Parakeet via sherpa-onnx), behind one API for the Live / Final pickers.

const whisperModels = require('./whisper-models');
const parakeetModels = require('./parakeet-models');

const LIVE_DEFAULT = 'parakeet-tdt-0.6b-v3';
const FINAL_DEFAULT = 'parakeet-tdt-0.6b-v3';

function runtimeOf(id) {
  if (parakeetModels.MODELS[id]) return 'parakeet';
  if (whisperModels.MODELS[id]) return 'whisper';
  return null;
}

function list({ role } = {}) {
  const rec = role === 'final' ? FINAL_DEFAULT : LIVE_DEFAULT;
  const all = [
    ...Object.entries(parakeetModels.MODELS).map(([id, m]) => ({ id, runtime: 'parakeet', label: m.label, short: m.short, bytes: m.bytes })),
    ...Object.entries(whisperModels.MODELS).map(([id, m]) => ({ id, runtime: 'whisper', label: m.label.replace(/ — recommended$/, ''), short: m.short, bytes: m.bytes })),
  ];
  return all.map((m) => ({ ...m, recommended: m.id === rec, label: m.id === rec ? `${m.label} (recommended)` : m.label }));
}

/// `installed` = exactly this model is present; `ready`/`path` = what will be loaded
/// (Whisper may fall back to another installed ggml file; Parakeet never falls back).
function status({ dir, id, chosenPath = '' }) {
  if (runtimeOf(id) === 'parakeet') return { ...parakeetModels.status({ dir, id }), id };
  const st = whisperModels.status({ dir, id, chosenPath });
  return { ...st, runtime: 'whisper' };
}

function download(opts) {
  return runtimeOf(opts.id) === 'parakeet' ? parakeetModels.download(opts) : whisperModels.download(opts);
}

/// "Choose model file…" for the runtime of `id`.
function importFile(src, dir, id) {
  return runtimeOf(id) === 'parakeet' ? parakeetModels.importFile(src, dir, id) : whisperModels.importFile(src, dir);
}

/// Settings from older versions only had `whisperModel` (the live model).
function migrate(s) {
  return {
    liveModel: s.liveModel || s.whisperModel || LIVE_DEFAULT,
    finalModel: s.finalModel || FINAL_DEFAULT,
  };
}

module.exports = { LIVE_DEFAULT, FINAL_DEFAULT, runtimeOf, list, status, download, importFile, migrate };
