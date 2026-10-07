'use strict';

// STT sockets. Both engines expose the same surface to app.js:
//   { readyState, send(), addEventListener('open'), close(), drain(): Promise, _ctx }
// Each takes onPartial(text) / onFinal(text) callbacks and reports problems
// through onStatus(message).

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
        if (ws.readyState === 1) ws.send(e.data);
        else if (ws.readyState === 0) { pending.push(e.data); if (pending.length > 250) pending.shift(); }
      };
      src.connect(node);
      ws._ctx = ctx;
    })().catch((err) => console.error('audio graph failed:', err.message));
    ws.addEventListener('open', () => { while (pending.length && ws.readyState === 1) ws.send(pending.shift()); });
  }

  const DRAIN_MS = 2000;

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

  // ---- Native (on-device helper via main process) ----
  const nativeSockets = new Map();
  let nativeSeq = 0;
  window.callrec.on('stt:event', (msg) => {
    const sock = msg && nativeSockets.get(msg.id);
    if (sock) sock._handle(msg);
  });

  class NativeSocket {
    constructor({ speaker, locale, onFinal, onPartial, onStatus, label }) {
      this.id = `${speaker}-${(nativeSeq += 1)}`;
      this.readyState = 0;
      this.onFinal = onFinal; this.onPartial = onPartial; this.onStatus = onStatus; this.label = label;
      this._openHandlers = [];
      this._ctx = null;
      this._deafTimer = null;
      this._warnedDeaf = false;
      this._drainResolve = null;
      nativeSockets.set(this.id, this);
      window.callrec.sttStart({ id: this.id, speaker, locale })
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
        setTimeout(() => this._dispose(), DRAIN_MS);
      });
    }

    close() { this.drain(); }

    _dispose() {
      nativeSockets.delete(this.id);
      if (this._ctx) { try { this._ctx.close(); } catch { /* ignore */ } }
      if (this._drainResolve) { this._drainResolve(); this._drainResolve = null; }
    }

    _armDeafWatchdog() {
      if (this._warnedDeaf) return;
      clearTimeout(this._deafTimer);
      this._deafTimer = setTimeout(() => {
        this._warnedDeaf = true;
        this.onStatus(`native STT (${this.label}) has heard nothing for 15s — check System Settings › Privacy & Security › Speech Recognition`);
      }, 15000);
    }

    _fail(message) {
      this.onStatus(`Native STT (${this.label}) failed: ${message}`);
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
          if (msg.text && /[\p{L}\p{N}]/u.test(msg.text)) this.onFinal(msg.text.trim());
          if (this.readyState === 3) this._dispose();
          break;
        case 'error':
          if (msg.fatal) this._fail(msg.message);
          else this.onStatus(`native STT (${this.label}): ${msg.message}`);
          break;
        default:
          break;
      }
    }
  }

  function connectNative({ stream, locale, speaker, onFinal, onPartial, onStatus, label }) {
    const sock = new NativeSocket({ speaker, locale, onFinal, onPartial, onStatus, label });
    wireAudioGraph(stream, sock);
    return sock;
  }

  return { connectDeepgram, connectNative };
})();
