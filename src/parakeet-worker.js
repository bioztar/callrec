'use strict';

// Child process running sherpa-onnx (Parakeet). Decoding is synchronous and
// CPU-bound, so it must not run on Electron's main thread.
// Messages: { id, op: 'load', model, threads } | { id, op: 'decode', samples: Int16 PCM Buffer (16 kHz) }.

let sherpa;
let recognizer = null;

function reply(msg) { if (process.send) process.send(msg); }

function load(model, threads) {
  sherpa = sherpa || require('sherpa-onnx-node');
  const f = (name) => require('path').join(model, name);
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: f('encoder.int8.onnx'), decoder: f('decoder.int8.onnx'), joiner: f('joiner.int8.onnx') },
      tokens: f('tokens.txt'),
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
      modelType: 'nemo_transducer',
    },
    decodingMethod: 'greedy_search',
  });
}

function decode(buf) {
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i] / 32768;
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples });
  recognizer.decode(stream);
  const r = recognizer.getResult(stream);
  return { text: r.text || '', tokens: r.tokens || [], timestamps: r.timestamps || [] };
}

process.on('disconnect', () => process.exit(0)); // the app quit

process.on('message', (msg) => {
  try {
    if (msg.op === 'load') { load(msg.model, msg.threads); reply({ id: msg.id, ok: true }); return; }
    if (msg.op === 'decode') { reply({ id: msg.id, ok: true, result: decode(Buffer.from(msg.samples)) }); return; }
    reply({ id: msg.id, error: `unknown op ${msg.op}` });
  } catch (err) {
    reply({ id: msg.id, error: err.message });
  }
});
