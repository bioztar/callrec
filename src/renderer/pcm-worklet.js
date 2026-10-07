// AudioWorklet: takes Float32 input at the context sample rate and emits
// downsampled 16 kHz signed 16-bit PCM chunks (what Deepgram linear16 wants).

class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = 16000;
    this.inputRate = sampleRate; // global in AudioWorklet scope
    this.ratio = this.inputRate / this.targetRate;
    this._pos = 0;
    this._buf = [];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0]; // mono (first channel)

    for (let i = 0; i < ch.length; i++) {
      this._pos += 1;
      if (this._pos >= this.ratio) {
        this._pos -= this.ratio;
        let s = ch[i];
        s = Math.max(-1, Math.min(1, s));
        this._buf.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      }
    }

    // Flush ~every 100ms worth of 16k samples (1600) to keep latency low.
    if (this._buf.length >= 1600) {
      const out = new Int16Array(this._buf);
      this._buf = [];
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
