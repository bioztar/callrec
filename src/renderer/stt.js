'use strict';

// STT sockets. All engines expose the same surface to app.js:
//   { readyState, send(), addEventListener('open'), close(), drain(): Promise, _ctx }
// Each takes onPartial(text) / onFinal(text, span) callbacks and reports problems
// through onStatus(message). `span` = { start, end } in seconds of the stream
// when the engine knows them (Whisper), else undefined.

const STT = (() => {
  // Wires a raw-PCM16/16kHz audio graph to a socket, buffering chunks captured
  // before it finishes opening and flushing them on open.
  function wireAudioGraph(stream, ws) {
    const pending = [];
    (async () => {
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule('pcm-worklet.js');
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-downsampler');
      node.port.onmessage = (e) => {
        // Wall-clock second of the first audio sample, so engine stream offsets map onto it.
        if (ws._audioT0 === undefined) ws._audioT0 = performance.now() / 1000 - e.data.byteLength / 32000;
        if (ws.readyState === 1) ws.send(e.data);
        else if (ws.readyState === 0) {
          pending.push(e.data);
          if (pending.length > 250) ws._audioT0 += pending.shift().byteLength / 32000; // dropped audio
        }
      };
      src.connect(node);
      ws._ctx = ctx;
    })().catch((err) => console.error('audio graph failed:', err.message));
    ws.addEventListener('open', () => { while (pending.length && ws.readyState === 1) ws.send(pending.shift()); });
  }

  const DRAIN_MS = 2000;
  const WHISPER_DRAIN_MS = 60000; // the last utterances may still be queued for transcription

  // ---- Deepgram (Nova-3 websocket) ----
  function connectDeepgram({ stream, key, language, onFinal, onPartial, onStatus, label }) {
    const url =
      'wss://api.deepgram.com/v1/listen' +
      '?model=nova-3&encoding=linear16&sample_rate=16000&channels=1' +
      '&punctuate=true&smart_format=true&interim_results=true&endpointing=300' +
      `&language=${encodeURIComponent(language)}`;
    const ws = new WebSocket(url, ['token', key]);
    ws.binaryType = 'arraybuffer';
    wireAudioGraph(stream, ws);
    // Deepgram splits one utterance into several is_final segments; only the
    // last carries speech_final. Accumulate and emit the whole utterance then.
    let seg = [];
    ws.onmessage = (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
      if (!alt) return;
      if (msg.is_final && alt.transcript) seg.push(alt.transcript);
      const interim = msg.is_final ? '' : (alt.transcript || '');
      onPartial((seg.join(' ') + ' ' + interim).replace(/\s+/g, ' ').trim());
      if (msg.speech_final) {
        const full = seg.join(' ').replace(/\s+/g, ' ').trim();
        seg = [];
        onPartial('');
        if (full) onFinal(full);
      }
    };
    ws.onerror = () => onStatus(`Deepgram error (${label}) — check the key in Settings`);
    ws.onclose = (e) => {
      if (e.code === 1008 || e.code === 4001) onStatus(`Deepgram rejected the key (${label})`);
      if (ws._ctx) ws._ctx.close();
    };
    ws.drain = () => new Promise((resolve) => {
      // Flush: server finalises remaining audio, then we flush any open utterance.
      const finish = () => {
        const full = seg.join(' ').replace(/\s+/g, ' ').trim();
        seg = [];
        if (full) onFinal(full);
        try { ws.close(); } catch { /* ignore */ }
        resolve();
      };
      if (ws.readyState !== 1) { finish(); return; }
      try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* ignore */ }
      ws.addEventListener('close', finish, { once: true });
      setTimeout(finish, DRAIN_MS);
    });
    return ws;
  }

  // ---- Native helper / Whisper (on-device, via the main process) ----
  const nativeSockets = new Map();
  let nativeSeq = 0;
  window.callrec.on('stt:event', (msg) => {
    const sock = msg && nativeSockets.get(msg.id);
    if (sock) sock._handle(msg);
  });

  class NativeSocket {
    constructor({ speaker, locale, language, engine = 'native', onFinal, onPartial, onStatus, label }) {
      this.id = `${speaker}-${(nativeSeq += 1)}`;
      this.engine = engine;
      this.name = engine === 'whisper' ? 'Whisper' : 'native STT';
      this.readyState = 0;
      this.onFinal = onFinal; this.onPartial = onPartial; this.onStatus = onStatus; this.label = label;
      this._openHandlers = [];
      this._ctx = null;
      this._deafTimer = null;
      this._warnedDeaf = false;
      this._drainResolve = null;
      nativeSockets.set(this.id, this);
      window.callrec.sttStart({ id: this.id, speaker, locale, language })
        .then((res) => { if (res && res.error) this._fail(res.error); })
        .catch((err) => this._fail(err.message));
    }

    addEventListener(type, fn) { if (type === 'open') this._openHandlers.push(fn); }

    send(buf) {
      if (this.readyState !== 1) return;
      window.callrec.sttChunk(this.id, buf);
      this._armDeafWatchdog();
    }

    // Closing stdin makes the helper emit a final for whatever is open, so keep
    // the handler registered until that final (or the helper exit) arrives.
    drain() {
      return new Promise((resolve) => {
        if (this.readyState === 3) { resolve(); return; }
        this._drainResolve = resolve;
        this.readyState = 3;
        clearTimeout(this._deafTimer);
        try { window.callrec.sttStop(this.id); } catch { /* ignore */ }
        setTimeout(() => this._dispose(), this.engine === 'whisper' ? WHISPER_DRAIN_MS : DRAIN_MS);
      });
    }

    close() { this.drain(); }

    _dispose() {
      nativeSockets.delete(this.id);
      if (this._ctx) { try { this._ctx.close(); } catch { /* ignore */ } }
      if (this._drainResolve) { this._drainResolve(); this._drainResolve = null; }
    }

    _armDeafWatchdog() {
      // Whisper only reports speech, so silence on one side is normal there (meters show levels).
      if (this._warnedDeaf || this.engine === 'whisper') return;
      clearTimeout(this._deafTimer);
      this._deafTimer = setTimeout(() => {
        this._warnedDeaf = true;
        this.onStatus(`native STT (${this.label}) has heard nothing for 15s — check System Settings › Privacy & Security › Speech Recognition`);
      }, 15000);
    }

    _fail(message) {
      this.onStatus(`${this.name} (${this.label}) failed: ${message}`);
      this.readyState = 3;
      this._dispose();
    }

    _handle(msg) {
      switch (msg.type) {
        case 'ready':
          this.readyState = 1;
          this._openHandlers.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
          break;
        case 'partial':
          clearTimeout(this._deafTimer); this._warnedDeaf = false;
          this.onPartial(msg.text || '');
          break;
        case 'final':
          clearTimeout(this._deafTimer); this._warnedDeaf = false;
          this.onPartial('');
          // Drop punctuation-only finals (e.g. ", .." when the locale can't hear the language).
          if (msg.text && /[\p{L}\p{N}]/u.test(msg.text)) {
            const span = typeof msg.start === 'number' && this._audioT0 !== undefined
              ? { start: this._audioT0 + msg.start, end: this._audioT0 + msg.end, lang: msg.lang } : undefined;
            this.onFinal(msg.text.trim(), span);
          }
          // The native helper's last final ends a drain; Whisper sends `done` after its queue.
          if (this.readyState === 3 && this.engine !== 'whisper') this._dispose();
          break;
        case 'done':
          if (this.readyState === 3) this._dispose();
          break;
        case 'error':
          if (msg.fatal) this._fail(msg.message);
          else this.onStatus(`${this.name} (${this.label}): ${msg.message}`);
          break;
        default:
          break;
      }
    }
  }

  function connectNative({ stream, locale, language, engine, speaker, onFinal, onPartial, onStatus, label }) {
    const sock = new NativeSocket({ speaker, locale, language, engine, onFinal, onPartial, onStatus, label });
    wireAudioGraph(stream, sock);
    return sock;
  }

  return { connectDeepgram, connectNative };
})();
