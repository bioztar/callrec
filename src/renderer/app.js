'use strict';

// callrec renderer: capture (system audio = Them, mic = Me), live transcript,
// meters, mixed-audio recorder. All persistence goes through window.callrec.

const api = window.callrec;
const $ = (id) => document.getElementById(id);
const els = {
  title: $('title'), engine: $('engine'), language: $('language'), langNote: $('langNote'),
  toggle: $('toggleBtn'), timer: $('timer'), openBtn: $('openBtn'), status: $('status'),
  meterMe: $('meterMe'), meterThem: $('meterThem'), transcript: $('transcript'),
  permCard: $('permCard'), settings: $('settings'),
};

let settings = null;
let session = null; // set while recording
let lastDir = null;

const LABEL = { ME: 'Me', THEM: 'Them' };

function setStatus(msg, kind = 'idle') { els.status.textContent = msg; els.status.dataset.kind = kind; }
function mmss(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---- echo suppression: drop ME lines that re-heard THEM through the speakers ----
// Me finals are held ECHO_HOLD_MS before commit: the mic usually hears the line
// before the system-audio recognizer finishes it, so Them may not be known yet.
const ECHO_HOLD_MS = 3500;
const echoState = { thems: [], held: [] };
function releaseMe(item) {
  if (!echoState.held.includes(item)) return;
  echoState.held = echoState.held.filter((h) => h !== item);
  clearTimeout(item.timer);
  if (!Echo.isEcho(item.seg, echoState.thems)) item.commit();
}
function releaseAllMe() { [...echoState.held].forEach(releaseMe); }

// ---- transcript pane ----
const partialEls = {};
function renderPartial(speaker, text) {
  let el = partialEls[speaker];
  if (!text) { if (el) { el.remove(); delete partialEls[speaker]; } return; }
  if (!el) {
    el = document.createElement('div');
    el.className = 'partial';
    partialEls[speaker] = el;
    els.transcript.appendChild(el);
  }
  el.textContent = `${LABEL[speaker]}: ${text}`;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}
function renderFinal(speaker, text, startSec) {
  renderPartial(speaker, '');
  const div = document.createElement('div');
  div.className = speaker === 'ME' ? 'me' : 'them';
  const t = document.createElement('span'); t.className = 't'; t.textContent = `[${mmss(startSec)}]`;
  const b = document.createElement('b'); b.textContent = `${LABEL[speaker]}: `;
  div.append(t, b, document.createTextNode(text));
  els.transcript.insertBefore(div, els.transcript.querySelector('.partial'));
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

// ---- audio acquisition + meters ----
async function acquireStreams() {
  const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  sys.getVideoTracks().forEach((t) => t.stop());
  if (!sys.getAudioTracks().length) {
    sys.getTracks().forEach((t) => t.stop());
    throw new Error(settings.platform === 'darwin'
      ? 'no system audio track (Screen & System Audio Recording permission?)'
      : 'no system audio track (is an output device enabled?)');
  }
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return { sys, mic };
}

function makeMeter(ctx, stream, el) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const meter = { peak: 0, stopped: false };
  (function tick() {
    if (meter.stopped) { el.style.width = '0'; return; }
    analyser.getFloatTimeDomainData(buf);
    let sum = 0; for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    meter.peak = Math.max(meter.peak, rms);
    el.style.width = `${Math.min(100, Math.round(Math.sqrt(rms) * 140))}%`;
    requestAnimationFrame(tick);
  }());
  return meter;
}

// ---- on-device model card (download with progress / Dictation instructions) ----
const model = { language: null, engine: null, busy: false, downloadingId: null, fraction: 0, role: 'live' };
const modelEls = {
  card: $('modelCard'), title: $('modelTitle'), text: $('modelText'), btn: $('modelDownload'),
  dict: $('modelDictation'), barWrap: $('modelBarWrap'), bar: $('modelBar'), pct: $('modelPct'),
  choose: $('modelChoose'), openDir: $('modelOpenDir'), path: $('modelPath'),
};
const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;

/// Whisper flavour of the model card: download on first use, or a file placed by hand.
async function checkWhisper() {
  const st = await api.whisperStatus('live');
  if (!model.busy) {
    $('whisperState').textContent = st.installed
      ? `${st.message} — ${st.path}`
      : `${st.message}. Download it, or copy ${st.expected} into ${st.dir}`;
  }
  $('setWhisperModel').value = st.id;
  if (st.ready) { if (model.engine === 'whisper') modelEls.card.hidden = true; return true; }
  model.engine = 'whisper';
  if (!model.busy) model.role = 'live';
  modelEls.title.textContent = `Speech model ${st.wanted} is not installed`;
  modelEls.text.textContent = `One-time download of ${st.expected} (${mb(st.bytes)}) from huggingface.co. `
    + 'Audio never leaves this computer. If the download is blocked (company proxy), fetch the file on another '
    + 'network and use "Choose model file…", or copy it into the models folder.';
  modelEls.path.textContent = `Models folder: ${st.dir}  ·  file: ${st.url}`;
  modelEls.btn.textContent = `Download ${st.expected}`;
  modelEls.btn.hidden = false;
  modelEls.dict.hidden = true;
  modelEls.choose.hidden = false;
  modelEls.openDir.hidden = false;
  modelEls.path.hidden = false;
  modelEls.card.hidden = false;
  return false;
}

async function chooseWhisperFile() {
  const res = await api.whisperChoose('live');
  if (res.canceled) return;
  if (res.error) { modelEls.text.textContent = res.error; $('whisperState').textContent = res.error; return; }
  setStatus(`Whisper model ${res.name} installed. Ready.`, 'idle');
  modelEls.card.hidden = true;
  checkWhisper();
}

/// Model check for whichever on-device engine is picked; true when ready.
function checkEngineModel(engine, language) {
  if (engine === 'whisper') return checkWhisper();
  if (engine === 'native') { model.engine = 'native'; return checkModel(language); }
  modelEls.card.hidden = true;
  return Promise.resolve(true);
}

/// Shows the card when the native engine has no usable on-device model for the
/// selected language. Returns true when the model is ready.
async function checkModel(language) {
  const st = await api.modelStatus(language);
  if (st.error) { setStatus(st.error, 'error'); return false; }
  $('modelState').textContent = `On-device model ${st.locale}: ${st.ready ? 'ready' : 'missing'} (engine: ${st.analyzer}, dictation: ${st.sf ? 'yes' : 'no'})`;
  if (st.ready) { modelEls.card.hidden = true; return true; }
  model.language = language;
  [modelEls.choose, modelEls.openDir, modelEls.path].forEach((e) => { e.hidden = true; });
  modelEls.btn.textContent = 'Download speech model';
  const canDownload = st.analyzer === 'supported' || st.analyzer === 'downloading';
  modelEls.title.textContent = `On-device speech model for ${st.locale} is not installed`;
  modelEls.text.textContent = canDownload
    ? 'One-time download of Apple\'s on-device model (a few hundred MB). Audio never leaves this Mac — callrec will not fall back to server recognition.'
    : 'This Mac cannot fetch the model from here. Add the language in System Settings › Keyboard › Dictation › Languages (wait for the download), then press Start again. callrec will not fall back to server recognition.';
  modelEls.btn.hidden = !canDownload;
  modelEls.dict.hidden = canDownload;
  modelEls.card.hidden = false;
  return false;
}

function showDownloading() {
  const p = Math.round(model.fraction * 100);
  modelEls.card.hidden = false;
  modelEls.btn.hidden = false;
  modelEls.btn.textContent = 'Cancel download';
  modelEls.barWrap.hidden = false;
  modelEls.bar.style.width = `${p}%`;
  modelEls.pct.textContent = `${p}%`;
  $(model.role === 'final' ? 'setFinalDownload' : 'setWhisperDownload').textContent = 'Cancel download';
}

/// Downloads the picked model. While one runs, the same model shows its progress
/// (never a silent no-op), a different Whisper model replaces it.
async function downloadModel() {
  const whisper = model.engine === 'whisper';
  const id = whisper ? $(model.role === 'final' ? 'setFinalModel' : 'setWhisperModel').value : null;
  if (model.busy && (!whisper || id === model.downloadingId)) {
    showDownloading();
    modelEls.text.textContent = 'Download in progress — the bar shows how far it is. "Cancel download" stops it.';
    modelEls.card.scrollIntoView({ block: 'start' });
    return;
  }
  const token = Symbol('download');
  model.busy = token;
  model.downloadingId = id;
  model.fraction = 0;
  showDownloading();
  const res = whisper ? await api.whisperDownload(id, model.role) : await api.modelDownload(model.language || els.language.value);
  if (model.busy !== token) return; // replaced by a download of another model
  model.busy = false;
  model.downloadingId = null;
  modelEls.btn.disabled = false;
  modelEls.barWrap.hidden = true;
  modelEls.pct.textContent = '';
  $('setWhisperDownload').textContent = 'Download'; $('setFinalDownload').textContent = 'Download';
  if (res.error) {
    modelEls.text.textContent = res.canceled ? 'Download canceled.' : `Download failed: ${res.error}`;
    if (whisper) { modelEls.btn.textContent = 'Download again'; $('whisperState').textContent = res.canceled ? 'Download canceled.' : res.error; }
    return;
  }
  setStatus('Speech model installed. Ready.', 'idle');
  if (whisper) { modelEls.card.hidden = true; checkWhisper(); checkFinal(); } else checkModel(els.language.value);
}

/// Final model line in Settings (the quality pass after Stop).
async function checkFinal() {
  const st = await api.whisperStatus('final');
  $('setFinalModel').value = st.id;
  if (!(model.busy && model.role === 'final')) $('finalState').textContent = st.installed ? `${st.message} — ${st.path}` : `${st.message} — the recording is kept until it is installed.`;
  return st;
}

function cancelDownload() {
  if (model.engine === 'whisper') api.whisperCancel();
}

// ---- recording ----
async function start(auto = null) {
  const engine = els.engine.value;
  const language = els.language.value;
  if (engine === 'deepgram' && !settings.hasDeepgramKey) { setStatus('Add your Deepgram key in Settings', 'error'); return; }
  if (engine === 'native' && !settings.nativeAvailable) { setStatus('Native helper not built — run native/stt/build.sh, or pick Deepgram', 'error'); return; }
  if (engine === 'native' && !(await checkModel(language))) { setStatus('Speech model missing — see the card above', 'error'); return; }
  if (engine === 'whisper' && !settings.whisperAvailable) { setStatus('Whisper is not bundled in this build — run npm run build:whisper, or pick Deepgram', 'error'); return; }
  if (engine === 'whisper' && !(await checkWhisper())) { setStatus('Whisper model missing — see the card above', 'error'); return; }

  els.toggle.disabled = true;
  setStatus('Requesting audio…', 'live');
  let streams;
  try { streams = await acquireStreams(); } catch (err) {
    setStatus(`Audio permission problem: ${err.message}. See the permissions card above.`, 'error');
    els.permCard.hidden = false; els.toggle.disabled = false;
    return;
  }
  const res = await api.sessionStart({ title: auto ? auto.title : els.title.value, engine, language, autoCallId: auto ? auto.autoCallId : null });
  if (res.error) {
    streams.sys.getTracks().forEach((t) => t.stop()); streams.mic.getTracks().forEach((t) => t.stop());
    setStatus(res.error, 'error'); els.toggle.disabled = false;
    if (res.code === 'model-missing') checkEngineModel(engine, language);
    return;
  }

  els.transcript.textContent = '';
  els.openBtn.hidden = true;
  echoState.thems = []; echoState.held = [];
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  const ctx = new AudioContext();
  const meters = [makeMeter(ctx, streams.mic, els.meterMe), makeMeter(ctx, streams.sys, els.meterThem)];

  const utt = {}; // per speaker: start second of the in-progress utterance
  const handlers = (speaker) => ({
    label: LABEL[speaker],
    onPcm: (buf) => api.channelPcm(speaker, buf, Math.max(0, now() - buf.byteLength / 32000)),
    onStatus: (m) => { console.error(`[stt] ${m}`); setStatus(m, 'error'); },
    onPartial: (text) => {
      if (text && utt[speaker] === undefined) utt[speaker] = now();
      renderPartial(speaker, text);
    },
    onFinal: (text, span) => {
      // Whisper knows where the utterance sits in the stream; others are timed on arrival.
      const t0s = t0 / 1000;
      const end = span ? Math.max(0, span.end - t0s) : now();
      const startSec = span ? Math.min(Math.max(0, span.start - t0s), end) : Math.min(utt[speaker] ?? Math.max(0, end - 1), end);
      delete utt[speaker];
      const commit = () => { api.segment({ speaker, start: startSec, end, text }); renderFinal(speaker, text, startSec); };
      if (speaker === 'THEM') { echoState.thems.push({ start: startSec, end, text }); commit(); return; }
      const item = { seg: { start: startSec, end, text }, commit };
      item.timer = setTimeout(() => releaseMe(item), ECHO_HOLD_MS);
      echoState.held.push(item);
    },
  });
  const connect = (stream, speaker) => (engine === 'deepgram'
    ? STT.connectDeepgram({ stream, key: res.deepgramKey, language: res.deepgramLanguage, speaker, ...handlers(speaker) })
    : STT.connectNative({ stream, locale: res.locale, language, engine, speaker, ...handlers(speaker) }));
  const sockets = [connect(streams.mic, 'ME'), connect(streams.sys, 'THEM')];

  // Mixed recording, chunks flushed to disk every 3s.
  const dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(streams.sys).connect(dest);
  ctx.createMediaStreamSource(streams.mic).connect(dest);
  const writes = [];
  const recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 48000 });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) writes.push(e.data.arrayBuffer().then((b) => api.recChunk(b)));
  };
  recorder.start(3000);

  const timer = setInterval(() => { els.timer.textContent = mmss(now()); }, 500);
  session = { streams, sockets, ctx, meters, recorder, writes, timer, now, dir: res.dir };
  lastDir = res.dir;
  els.toggle.textContent = 'Stop'; els.toggle.classList.add('recording'); els.toggle.disabled = false;
  [els.engine, els.language, els.title].forEach((e) => { e.disabled = true; });
  setStatus(`Recording → ${res.dir}${res.note ? ` — ⚠ ${res.note}` : ''}`, 'live');
}

async function stop() {
  const s = session;
  if (!s) return;
  session = null;
  els.toggle.disabled = true;
  setStatus('Finishing…', 'live');
  clearInterval(s.timer);
  const duration = s.now();
  await new Promise((resolve) => { s.recorder.onstop = resolve; try { s.recorder.stop(); } catch { resolve(); } });
  await Promise.all(s.writes);
  await Promise.all(s.sockets.map((k) => k.drain()));
  releaseAllMe(); // commit/drop held Me finals before the session closes
  s.meters.forEach((m) => { m.stopped = true; });
  s.streams.sys.getTracks().forEach((t) => t.stop());
  s.streams.mic.getTracks().forEach((t) => t.stop());
  try { await s.ctx.close(); } catch { /* ignore */ }
  const dir = await api.sessionStop();
  lastDir = dir || s.dir;
  els.toggle.textContent = 'Start'; els.toggle.classList.remove('recording'); els.toggle.disabled = false;
  [els.engine, els.language, els.title].forEach((e) => { e.disabled = false; });
  els.timer.textContent = mmss(duration);
  els.openBtn.hidden = false;
  setStatus(`Saved ${mmss(duration)} → ${lastDir}`, 'idle');
}

let starting = false;
async function toggle() {
  if (starting) return; // a start is already in flight (double hotkey / autorun race)
  try {
    if (session) { await stop(); return; }
    starting = true;
    console.error('[callrec] start requested');
    await start();
    console.error(`[callrec] start ${session ? 'ok' : 'did not begin'}`);
  } catch (err) {
    console.error(`[callrec] toggle failed: ${err && err.stack}`);
    setStatus(`Failed: ${err && err.message}`, 'error');
    els.toggle.disabled = false;
  } finally {
    starting = false;
  }
}

// ---- settings panel ----
function refreshLangNote() {
  const mixed = els.language.value === 'mixed';
  const notes = {
    native: 'Native engine hears Spanish (es-ES) only — English words may be garbled. For true Spanish/English code-switching pick Deepgram (multi).',
    whisper: 'Whisper detects Spanish or English for each utterance (a sentence that switches mid-way stays in one language).',
  };
  const note = mixed ? notes[els.engine.value] || '' : '';
  els.langNote.hidden = !note;
  els.langNote.textContent = note;
}

function fillSelect(sel, options) {
  const want = options.map((o) => `${o.id}=${o.label}`).join('|');
  if (sel.dataset.options === want) return;
  sel.dataset.options = want;
  sel.replaceChildren(...options.map((o) => { const el = document.createElement('option'); el.value = o.id; el.textContent = o.label; return el; }));
}

function applySettings(s) {
  settings = s;
  document.body.classList.add(`platform-${s.platform}`);
  fillSelect(els.engine, s.engines);
  fillSelect($('setEngine'), s.engines);
  fillSelect($('setWhisperModel'), s.liveModels);
  fillSelect($('setFinalModel'), s.finalModels);
  $('setFinalModel').value = s.finalModel;
  const hasWhisper = s.engines.some((e) => e.id === 'whisper');
  $('whisperSettings').hidden = !hasWhisper;
  $('nativeModelRow').hidden = !s.engines.some((e) => e.id === 'native');
  $('setRoot').value = s.outputRoot;
  $('setEngine').value = s.engine;
  $('setLanguage').value = s.language;
  $('setShortcut').value = s.shortcut;
  $('setShotShortcut').value = s.screenshotShortcut || '';
  $('teamsApiNote').hidden = s.platform !== 'win32';
  $('keyState').textContent = s.hasDeepgramKey ? '(saved)' : '(not set)';
  if (!session) { els.engine.value = s.engine; els.language.value = s.language; }
  refreshLangNote();
}

async function saveSetting(patch) { applySettings((await api.setSettings(patch)).settings); }

async function testAudio() {
  const out = $('testResult');
  out.textContent = 'Listening for 3 seconds — speak and play some audio…';
  let streams;
  try { streams = await acquireStreams(); } catch (err) { out.textContent = `Cannot open audio: ${err.message}`; return; }
  const ctx = new AudioContext();
  const me = makeMeter(ctx, streams.mic, els.meterMe);
  const them = makeMeter(ctx, streams.sys, els.meterThem);
  await new Promise((r) => setTimeout(r, 3000));
  me.stopped = them.stopped = true;
  Object.values(streams).forEach((st) => st.getTracks().forEach((t) => t.stop()));
  ctx.close();
  const verdict = (m, name) => `${name}: ${m.peak > 0.005 ? `OK (level ${m.peak.toFixed(3)})` : 'silent — nothing heard'}`;
  out.textContent = `${verdict(me, 'Microphone')} · ${verdict(them, 'System audio')}`;
}

async function refreshPermissions() {
  const p = await api.permStatus();
  // 'not-determined' on Windows just means never asked; only an explicit denial needs the card.
  const micOk = p.microphone === 'granted' || (settings.platform !== 'darwin' && p.microphone === 'not-determined');
  els.permCard.hidden = micOk && p.screen === 'granted';
}

// ---- boot ----
(async function boot() {
  applySettings(await api.getSettings());
  refreshPermissions();
  window.addEventListener('focus', refreshPermissions);

  els.toggle.addEventListener('click', toggle);
  els.openBtn.addEventListener('click', () => lastDir && api.openFolder(lastDir));
  const onPick = () => { refreshLangNote(); checkEngineModel(els.engine.value, els.language.value); };
  els.engine.addEventListener('change', onPick);
  els.language.addEventListener('change', onPick);
  api.on('model:progress', ({ fraction, engine }) => {
    model.fraction = fraction || 0;
    const p = Math.round(model.fraction * 100);
    modelEls.bar.style.width = `${p}%`;
    modelEls.pct.textContent = `${p}%`;
    if (engine === 'whisper') $('whisperState').textContent = `Downloading Whisper model… ${p}%`;
    else $('modelState').textContent = `Downloading Spanish model… ${p}%`;
  });
  modelEls.btn.addEventListener('click', () => {
    if (model.busy && model.engine === 'whisper' && modelEls.btn.textContent === 'Cancel download') cancelDownload();
    else downloadModel();
  });
  modelEls.dict.addEventListener('click', () => api.openPane('keyboard'));
  modelEls.choose.addEventListener('click', chooseWhisperFile);
  modelEls.openDir.addEventListener('click', () => api.whisperOpenDir());
  $('setWhisperChoose').addEventListener('click', chooseWhisperFile);
  $('setWhisperOpenDir').addEventListener('click', () => api.whisperOpenDir());
  $('setWhisperModel').addEventListener('change', async (e) => { await saveSetting({ liveModel: e.target.value, whisperModelPath: '' }); checkWhisper(); });
  $('setFinalModel').addEventListener('change', async (e) => { await saveSetting({ finalModel: e.target.value }); checkFinal(); });
  $('setFinalChoose').addEventListener('click', async () => {
    const res = await api.whisperChoose('final');
    if (res.error) $('finalState').textContent = res.error; else if (!res.canceled) checkFinal();
  });
  $('setFinalDownload').addEventListener('click', async () => {
    model.engine = 'whisper';
    const id = $('setFinalModel').value;
    if (model.busy && id === model.downloadingId) { cancelDownload(); return; }
    await saveSetting({ finalModel: id });
    const st = await checkFinal();
    if (st.installed) { $('finalState').textContent = `${st.message} — already installed.`; return; }
    model.role = 'final';
    modelEls.card.scrollIntoView({ block: 'start' });
    downloadModel();
  });
  $('setWhisperDownload').addEventListener('click', async () => {
    model.engine = 'whisper';
    const id = $('setWhisperModel').value;
    if (model.busy && id === model.downloadingId) { cancelDownload(); return; }
    await saveSetting({ liveModel: id, whisperModelPath: '' });
    model.role = 'live';
    const st = await api.whisperStatus('live');
    await checkWhisper();
    if (st.installed) { $('whisperState').textContent = `${st.message} — already installed.`; return; }
    modelEls.card.scrollIntoView({ block: 'start' });
    downloadModel();
  });
  $('setModelBtn').addEventListener('click', async () => {
    model.language = 'es';
    model.engine = 'native';
    if (!(await checkModel('es')) && !modelEls.btn.hidden) {
      modelEls.card.scrollIntoView({ block: 'start' }); // progress bar lives in the card
      downloadModel();
    }
  });
  checkEngineModel(els.engine.value, els.language.value);
  api.on('toggle-recording', toggle);
  api.on('stop-recording', () => { if (session) stop(); });
  // Teams call detected (main process): same path as a manual start, named after the call.
  api.on('start-recording', (auto) => { if (!session && !els.toggle.disabled) start(auto); });
// Quality pass after Stop (main process): progress, then the final transcript.
api.on('final:state', (st) => {
  if (session) return;
  if (st.fraction != null) setStatus(`Finalising transcript… ${Math.round(st.fraction * 100)}%`, 'live');
  else if (st.done) setStatus(`Final transcript ready → ${st.dir}`, 'idle');
  else if (st.error) setStatus(`Final pass failed (${st.error}); the live draft is kept in ${st.dir}`, 'error');
});
  const showSettings = (open) => {
    els.settings.hidden = !open;
    if (!open) return;
    els.settings.scrollIntoView({ block: 'start' });
    if (settings.engines.some((e) => e.id === 'native')) checkModel('es');
    if (settings.engines.some((e) => e.id === 'whisper')) { checkWhisper(); checkFinal(); }
  };
  api.on('open-settings', () => showSettings(true));
  $('settingsBtn').addEventListener('click', () => showSettings(els.settings.hidden));

  $('permMic').addEventListener('click', async () => { await api.askMic(); refreshPermissions(); });
  $('permMicPane').addEventListener('click', () => api.openPane('microphone'));
  $('permScreenPane').addEventListener('click', () => api.openPane('screen'));
  $('permSpeechPane').addEventListener('click', () => api.openPane('speech'));

  $('setRootPick').addEventListener('click', async () => {
    const dir = await api.pickFolder();
    if (dir) saveSetting({ outputRoot: dir });
  });
  $('setEngine').addEventListener('change', (e) => saveSetting({ engine: e.target.value }));
  $('setLanguage').addEventListener('change', (e) => saveSetting({ language: e.target.value }));
  $('setKeySave').addEventListener('click', async () => {
    const input = $('setKey');
    const res = await api.setDeepgramKey(input.value);
    if (res.error) { $('keyState').textContent = res.error; return; }
    input.value = '';
    applySettings(await api.getSettings());
  });
  $('setKeyClear').addEventListener('click', async () => {
    await api.setDeepgramKey('');
    applySettings(await api.getSettings());
  });
  $('setShortcutSave').addEventListener('click', async () => {
    const res = await api.setSettings({ shortcut: $('setShortcut').value.trim() });
    applySettings(res.settings);
    $('shortcutState').textContent = res.shortcutOk ? '(applied)' : '(invalid or already taken — not registered)';
  });
  $('setShotShortcutSave').addEventListener('click', async () => {
    const res = await api.setSettings({ screenshotShortcut: $('setShotShortcut').value.trim() });
    applySettings(res.settings);
    $('shotShortcutState').textContent = res.screenshotShortcutOk ? '(applied)' : '(invalid or already taken — not registered)';
  });
  $('testBtn').addEventListener('click', testAudio);
}());
