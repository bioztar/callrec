'use strict';

// callrec main process: window, system-audio loopback grant, settings, per-meeting
// folder writing, STT supervision (native helper on macOS, Whisper everywhere),
// global shortcut and menu.

const {
  app, BrowserWindow, ipcMain, Menu, dialog, shell, session, desktopCapturer,
  globalShortcut, safeStorage, systemPreferences, net, Tray, nativeImage, Notification, powerMonitor,
} = require('electron');
const path = require('path');
const os = require('os');

const fs = require('fs');
const nativeStt = require('./src/native-stt');
const whisperStt = require('./src/whisper-stt');
const whisperModels = require('./src/lib/whisper-models');
const catalog = require('./src/lib/model-catalog');
const { ChannelRecorder } = require('./src/lib/channel-audio');
const finalPass = require('./src/lib/final-pass');
const parakeetStt = require('./src/parakeet-stt');
const { createDownloadManager } = require('./src/lib/model-downloads');
const trayLib = require('./src/lib/tray');
const platform = require('./src/lib/platform');
const { createDisplayMediaHandler } = require('./src/lib/display-media');
const { createSettings } = require('./src/lib/settings');
const { SessionWriter } = require('./src/lib/session-writer');
const { nativeLocale, deepgramLanguage, LANGUAGES } = require('./src/lib/engines');

const IS_MAC = process.platform === 'darwin';
const AUTORUN_SEC = Number(process.env.CALLREC_AUTORUN_SEC) || 0;

// Test hook (CI smoke): CALLREC_FAKE_MIC_WAV=file.wav replaces the microphone
// with Chromium's fake capture device playing that file.
if (process.env.CALLREC_FAKE_MIC_WAV) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.CALLREC_FAKE_MIC_WAV);
}

// Test hook (CI smoke): a throw-away profile (settings, models) instead of the user's.
if (process.env.CALLREC_USER_DATA) app.setPath('userData', process.env.CALLREC_USER_DATA);

let win = null;
let settings = null;
let writer = null;
let startedAtMs = 0;
let lastSession = null; // summary of the last finished meeting (autorun report)
let channels = null; // per-channel audio of the running meeting, for the final pass
let sessionLanguage = 'es';
let finalQueue = null;
let finalServer = null;
const autorunLog = [];

function defaultRoot() { return path.join(os.homedir(), 'Documents', 'callrec'); }

function whisperDir() { return whisperModels.modelsDir(app.getPath('userData')); }

/// Status of the Live (default) or Final model. Only a hand-picked Whisper
/// file overrides the live catalogue choice.
function whisperStatus(s = settings.get(), role = 'live') {
  const m = catalog.migrate(s);
  const id = role === 'final' ? m.finalModel : m.liveModel;
  return { ...catalog.status({ dir: whisperDir(), id, chosenPath: role === 'live' ? s.whisperModelPath : '' }), role };
}

/// "Parakeet TDT 0.6B v3" / "Whisper small": the model file actually loaded.
function modelLabel(st) { return st.runtime === 'parakeet' ? 'Parakeet TDT 0.6B v3' : `Whisper ${st.short}`; }

function onDeviceAvailable() { return whisperStt.isAvailable() || parakeetStt.isAvailable(); }

function currentSettings() {
  const s = settings.get();
  const whisperAvailable = onDeviceAvailable();
  return {
    ...s,
    engine: platform.effectiveEngine(s.engine, process.platform, { whisperAvailable }),
    outputRoot: s.outputRoot || defaultRoot(),
    platform: process.platform,
    engines: platform.engines(process.platform, { whisperAvailable }),
    nativeAvailable: IS_MAC && nativeStt.isAvailable(),
    whisperAvailable,
    ...catalog.migrate(s),
    liveModels: catalog.list({ role: 'live' }),
    finalModels: catalog.list({ role: 'final' }),
    whisperModelsDir: whisperDir(),
  };
}

// ---- window ----------------------------------------------------------------

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 780,
    height: 760,
    minWidth: 560,
    minHeight: 520,
    title: 'callrec',
    // macOS: native traffic lights inset top-left. Windows: the standard title bar.
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: true }),
    backgroundColor: '#14161a',
    show: !(AUTORUN_SEC > 0 && process.env.CALLREC_AUTORUN_HIDDEN === '1'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keeps recording at full rate while hidden in the tray
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  // Test hook: CALLREC_AUTORUN_SEC=N records for N seconds then quits (no UI clicks needed).
  if (AUTORUN_SEC > 0) {
    win.webContents.on('console-message', (_e, level, message) => {
      autorunLog.push(message);
      console.log(`[renderer] ${message}`);
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(toggleRecording, 1500);
      setTimeout(toggleRecording, 1500 + AUTORUN_SEC * 1000);
      // Whisper may still be transcribing the last utterance: quit once the stop has finished.
      // Safety net only: normally we quit once the transcript is closed (Whisper may still be draining a backlog).
      const drainSec = Number(process.env.CALLREC_AUTORUN_DRAIN_SEC) || 60;
      const deadline = Date.now() + 1500 + AUTORUN_SEC * 1000 + drainSec * 1000;
      const quitWhenStopped = () => {
        const finalDone = !lastSession || lastSession.final !== 'pending';
        if ((lastSession && !writer && finalDone) || Date.now() > deadline) app.quit();
        else setTimeout(quitWhenStopped, 500);
      };
      setTimeout(quitWhenStopped, 1500 + AUTORUN_SEC * 1000 + 3000);
    });
  }
  // Windows: ✕ hides to the tray (Vitaly's choice for this app); Quit is in the tray menu.
  // macOS: the red traffic light still quits.
  win.on('close', (event) => { if (closePolicy.onClose(event, win) === 'quit' && IS_MAC) app.quit(); });
  if (process.platform === 'win32') win.on('session-end', onSessionEnd);
}

// ---- tray -------------------------------------------------------------------

let trayCtl = null;
let closePolicy = null;
let finalising = null; // 0..1 while the quality pass runs, else null

function notify(message) {
  if (process.platform === 'win32' && trayCtl) { trayCtl.balloon('callrec', message); return; }
  if (Notification.isSupported()) new Notification({ title: 'callrec', body: message }).show();
}

function trayState() {
  return {
    recording: Boolean(writer),
    elapsedSec: writer ? (Date.now() - startedAtMs) / 1000 : 0,
    finalising,
    shortcut: settings.get().shortcut,
  };
}

function openRecordingsFolder() {
  const root = currentSettings().outputRoot;
  fs.mkdirSync(root, { recursive: true });
  shell.openPath(root);
}

/// Quit for real: an active recording is stopped by the renderer first (live
/// transcript drained, files closed), then the app exits.
function requestQuit() {
  if (closePolicy.quitting) return;
  closePolicy.setQuitting();
  trayLib.quitCleanly({
    isRecording: () => Boolean(writer),
    stopRecording: () => { if (win && !win.isDestroyed()) win.webContents.send('stop-recording'); },
    forceFinish: finishSession,
    quit: () => app.quit(),
  });
}

/// Windows shutdown / sign-out: 'before-quit' may not come before the window
/// closes, so close the meeting files now and let the window go (never block
/// shutdown). The final pass is queued and resumes on the next launch.
function onSessionEnd() {
  trayLib.endSessionNow({
    policy: closePolicy,
    finishSession,
    stopEngines: () => {
      nativeStt.stopAll();
      whisperStt.stopAll();
      if (finalServer) finalServer.stop();
    },
  });
  app.quit();
}

function createTray() {
  closePolicy = trayLib.createCloseToTray({
    platform: process.platform,
    hintShown: settings.get().trayHintShown,
    markHintShown: () => settings.set({ trayHintShown: true }),
    notify,
  });
  try {
    trayCtl = trayLib.createTrayController({
      Tray, Menu, nativeImage,
      platform: process.platform,
      getState: trayState,
      actions: { show: showWindow, toggle: toggleRecording, openFolder: openRecordingsFolder, quit: requestQuit },
    });
    setInterval(() => trayCtl.refresh(), 1000).unref();
  } catch (err) {
    console.error(`tray unavailable: ${err.message}`); // never strand a hidden window without a tray
    closePolicy = trayLib.createCloseToTray({ platform: 'darwin', hintShown: true, markHintShown() {}, notify });
  }
}

// Grant getDisplayMedia({ audio: 'loopback' }) → system audio, no virtual driver
// (CoreAudio tap on macOS, WASAPI loopback on Windows).
function wireDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(
    createDisplayMediaHandler((opts) => desktopCapturer.getSources(opts)),
    { useSystemPicker: false },
  );
}

// ---- shortcut + menu ------------------------------------------------------

function toggleRecording() {
  if (win && !win.isDestroyed()) win.webContents.send('toggle-recording');
}

/// Returns true when the accelerator registered.
function registerShortcut(accelerator) {
  globalShortcut.unregisterAll();
  if (!accelerator) return true;
  try { return globalShortcut.register(accelerator, toggleRecording); } catch { return false; }
}

function openSettings() { if (win && !win.isDestroyed()) { showWindow(); win.webContents.send('open-settings'); } }

function installMenu() {
  if (!IS_MAC) {
    // Windows: File / Recording / Edit / Help on the native menu bar (Alt shows it).
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '&File', submenu: [{ label: 'Settings…', accelerator: 'Ctrl+,', click: openSettings }, { type: 'separator' }, { label: 'Quit', accelerator: 'Ctrl+Q', click: () => requestQuit() }] },
      { label: '&Recording', submenu: [{ label: 'Start / Stop Recording', click: toggleRecording }] },
      { role: 'editMenu' },
      { label: '&Help', submenu: [{ label: 'About callrec', click: () => dialog.showMessageBox(win, { message: `callrec ${app.getVersion()}`, detail: 'MIT licence. https://github.com/bioztar/callrec' }) }] },
    ]));
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => win && win.webContents.send('open-settings') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Recording',
      submenu: [{ label: 'Start / Stop Recording', click: toggleRecording }],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

// ---- IPC ------------------------------------------------------------------

function wireIpc() {
  ipcMain.handle('settings:get', () => currentSettings());

  ipcMain.handle('settings:set', (_e, patch) => {
    settings.set(patch);
    const ok = patch && 'shortcut' in patch ? registerShortcut(patch.shortcut) : true;
    return { settings: currentSettings(), shortcutOk: ok };
  });

  ipcMain.handle('settings:setKey', (_e, key) => {
    try { settings.setDeepgramKey(String(key || '').trim()); return { ok: true }; } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('settings:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

  // Windows has no screen-capture permission; loopback needs none either.
  const mediaStatus = (kind) => {
    try { return systemPreferences.getMediaAccessStatus(kind); } catch { return 'granted'; }
  };
  ipcMain.handle('perm:status', () => ({
    microphone: process.platform === 'linux' ? 'granted' : mediaStatus('microphone'),
    screen: IS_MAC ? mediaStatus('screen') : 'granted',
  }));
  ipcMain.handle('perm:askMic', () => (IS_MAC ? systemPreferences.askForMediaAccess('microphone') : mediaStatus('microphone') === 'granted'));
  ipcMain.handle('perm:open', (_e, pane) => {
    const url = platform.settingsUrl(process.platform, pane);
    if (url) shell.openExternal(url);
  });

  // Dev-only UI test: pretend the model is missing until a simulated download finishes.
  const fakeMissing = !app.isPackaged && process.env.CALLREC_FAKE_MODEL_MISSING === '1';
  let fakeInstalled = false;
  const progress = (payload) => { if (win && !win.isDestroyed()) win.webContents.send('model:progress', payload); };

  // ---- Whisper model: status, first-use download, manual file, folder ----
  // Always the selected model unless that exact file is installed; a click on the
  // running download rejoins it; another model replaces it; Cancel aborts it.
  const whisperDownloads = createDownloadManager({
    isInstalled: (id) => catalog.status({ dir: whisperDir(), id }).installed,
    start: ({ id, signal, onProgress }) => catalog.download({
      id,
      dir: whisperDir(),
      signal,
      fetchImpl: (url, init) => net.fetch(url, init), // Chromium network stack: system / corporate proxy applies
      onProgress,
    }),
    onProgress: ({ id, fraction }) => progress({ engine: 'whisper', id, fraction }),
  });
  const roleKey = (role) => (role === 'final' ? 'finalModel' : 'liveModel');
  ipcMain.handle('whisper:status', (_e, role) => ({ ...whisperStatus(settings.get(), role), downloading: whisperDownloads.current() }));
  ipcMain.handle('whisper:download', async (_e, id, role) => {
    const modelId = catalog.runtimeOf(id) ? id : whisperStatus(settings.get(), role).id;
    const job = whisperDownloads.request(modelId);
    const res = await job.promise;
    if (res.ok) settings.set({ [roleKey(role)]: modelId, ...(role === 'final' ? {} : { whisperModelPath: '' }) });
    if (res.ok && finalQueue) finalQueue.kick(); // meetings waiting for the Final model
    return { ...res, id: modelId };
  });
  ipcMain.handle('whisper:cancel', () => whisperDownloads.cancel());
  ipcMain.handle('whisper:choose', async (_e, role) => {
    const { id } = whisperStatus(settings.get(), role);
    const parakeet = catalog.runtimeOf(id) === 'parakeet';
    const pick = await dialog.showOpenDialog(win, {
      title: parakeet ? 'Choose encoder.int8.onnx (decoder, joiner and tokens.txt must be next to it)' : 'Choose a Whisper model file (ggml-*.bin)',
      properties: ['openFile'],
      filters: [parakeet ? { name: 'Parakeet model', extensions: ['onnx', 'txt'] } : { name: 'whisper.cpp model', extensions: ['bin'] }],
    });
    if (pick.canceled || !pick.filePaths[0]) return { canceled: true };
    const res = await catalog.importFile(pick.filePaths[0], whisperDir(), id);
    if (res.ok && !parakeet && role !== 'final') settings.set({ whisperModelPath: res.path });
    return res.ok ? { ...res, status: whisperStatus(settings.get(), role) } : res;
  });
  ipcMain.handle('whisper:openDir', () => {
    fs.mkdirSync(whisperDir(), { recursive: true });
    return shell.openPath(whisperDir());
  });

  ipcMain.handle('model:status', (_e, language) => {
    const { locale } = nativeLocale(language, app.getLocale());
    if (fakeMissing && !fakeInstalled) return { locale, analyzer: 'supported', sf: false, ready: false };
    return nativeStt.modelStatus(locale);
  });
  ipcMain.handle('model:download', async (_e, language) => {
    const { locale } = nativeLocale(language, app.getLocale());
    if (fakeMissing && !fakeInstalled) {
      for (let i = 1; i <= 20; i += 1) {
        await new Promise((r) => setTimeout(r, 400));
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { locale, fraction: i / 20 });
      }
      fakeInstalled = true;
      return { ok: true };
    }
    return nativeStt.downloadModel(locale, (fraction) => progress({ engine: 'native', locale, fraction }));
  });

  ipcMain.handle('session:start', async (_e, { title, engine, language }) => {
    if (writer) return { error: 'A recording is already running' };
    if (!LANGUAGES[language]) return { error: `Unknown language "${language}"` };
    const s = currentSettings();
    let deepgramKey = '';
    let locale = '';
    let note = '';
    let modelPath = '';
    let modelName = '';
    if (!s.engines.some((e) => e.id === engine)) return { error: `The ${engine} engine is not available on this computer` };
    if (engine === 'deepgram') {
      deepgramKey = settings.getDeepgramKey();
      if (!deepgramKey) return { error: 'Add your Deepgram key in Settings' };
    } else if (engine === 'native') {
      if (!s.nativeAvailable) return { error: nativeStt.NOT_BUILT };
      ({ locale, note } = nativeLocale(language, app.getLocale()));
      // Never start without an on-device model: the helper would otherwise fail
      // mid-session, and nothing may fall back to server recognition.
      const model = await nativeStt.modelStatus(locale);
      if (model.error) return { error: model.error };
      if (!model.ready) return { error: `No on-device speech model for ${locale}.`, code: 'model-missing', locale, model };
    } else if (engine === 'whisper') {
      if (!s.whisperAvailable) return { error: whisperStt.NOT_BUILT };
      const model = whisperStatus(s);
      if (!model.ready) return { error: 'No Whisper model yet.', code: 'model-missing', model };
      modelPath = model.path;
      modelName = modelLabel(model); // the file actually loaded, not the setting id (may be a fallback)
      locale = { es: 'es', en: 'en', mixed: 'auto (es/en per utterance)' }[language];
    } else {
      return { error: `Unknown engine "${engine}"` };
    }
    try {
      const label = { deepgram: 'Deepgram Nova-3', native: 'Native Mac (on-device)', whisper: `${modelName} (on-device)` }[engine];
      const langLabel = LANGUAGES[language].label;
      writer = new SessionWriter({
        root: s.outputRoot,
        title,
        engine: label,
        language: engine === 'deepgram' ? `${langLabel} → ${deepgramLanguage(language)}` : `${langLabel} → ${locale}`,
        languageNote: note,
      });
    } catch (err) {
      return { error: `Cannot create the meeting folder in ${s.outputRoot}: ${err.message}` };
    }
    startedAtMs = Date.now();
    channels = new ChannelRecorder(writer.dir);
    sessionLanguage = language;
    sttEngine = engine === 'whisper' ? whisperStt : nativeStt;
    sttModelPath = modelPath;
    return { dir: writer.dir, deepgramKey, deepgramLanguage: deepgramLanguage(language), locale, note };
  });

  ipcMain.on('session:audio', (_e, bytes) => { if (writer) writer.addAudio(bytes); });
  ipcMain.on('session:segment', (_e, seg) => { if (writer) writer.addSegment(seg); });
  ipcMain.on('session:pcm', (_e, speaker, buf, offsetSec) => { if (channels) channels.add(speaker, Buffer.from(buf), offsetSec); });
  ipcMain.handle('session:stop', () => finishSession());

  ipcMain.handle('shell:openFolder', (_e, dir) => shell.openPath(dir));

  const send = (payload) => {
    if (AUTORUN_SEC > 0 && payload && payload.type !== 'partial') console.log(`[stt] ${JSON.stringify(payload)}`);
    if (win && !win.isDestroyed()) win.webContents.send('stt:event', payload);
  };
  // The engine is fixed per meeting by session:start; both speak the same protocol.
  ipcMain.handle('stt:start', (_e, opts) => sttEngine.start({ ...opts, modelPath: sttModelPath }, send));
  ipcMain.on('stt:chunk', (_e, id, buf) => sttEngine.chunk(id, buf));
  ipcMain.on('stt:stop', (_e, id) => sttEngine.stop(id));
}

let sttEngine = nativeStt;
let sttModelPath = '';

function finishSession() {
  if (!writer) return null;
  const w = writer;
  const dir = w.finish((Date.now() - startedAtMs) / 1000);
  writer = null;
  const offsets = channels ? channels.close() : {};
  channels = null;
  lastSession = { dir, segments: w.segments ? w.segments.length : null };
  queueFinalPass(dir, w.meta, offsets);
  return dir;
}

// ---- final pass ---------------------------------------------------------------

function toWindow(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

/// After Stop: the Final model re-transcribes the kept channel audio in the
/// background. While quitting the meeting is only queued (resumes next launch).
function queueFinalPass(dir, meta, offsets) {
  if (!finalQueue || !Object.keys(offsets).length) return;
  try {
    finalPass.prepareJob(dir, { meta, offsets, language: sessionLanguage });
  } catch (err) {
    console.error(`[final] cannot queue ${dir}: ${err.message}`);
    return;
  }
  lastSession.final = 'pending';
  finalQueue.add(dir, { run: !(closePolicy && closePolicy.quitting) });
}

async function runFinal(dir, onProgress) {
  const st = whisperStatus(settings.get(), 'final');
  if (!st.ready) { const err = new Error(st.message); err.code = 'model-missing'; throw err; }
  const server = whisperStt.defaultServerFactory({ bin: whisperStt.binaryPath(), model: st.path, log: (m) => console.error(`[final] ${m}`) });
  finalServer = server;
  try {
    await server.start();
    const label = `${modelLabel(st)} (on-device)`;
    return await finalPass.runFinalPass({ dir, transcriber: finalPass.serverTranscriber(server), label, onProgress });
  } finally {
    server.stop();
    finalServer = null;
  }
}

function createFinalQueue() {
  finalQueue = finalPass.createFinalQueue({
    file: path.join(app.getPath('userData'), 'final-queue.json'),
    run: runFinal,
    onState: (st) => {
      finalising = st ? st.fraction : null;
      if (trayCtl) trayCtl.refresh();
      if (st) toWindow('final:state', { dir: st.dir, fraction: st.fraction });
    },
    onDone: (dir) => {
      if (lastSession && lastSession.dir === dir) lastSession.final = 'done';
      toWindow('final:state', { dir, done: true });
      notify(`Final transcript ready — ${path.basename(dir)}`);
    },
    onError: (dir, err) => {
      console.error(`[final] ${dir}: ${err.message}`);
      if (lastSession && lastSession.dir === dir) lastSession.final = `error: ${err.message}`;
      toWindow('final:state', { dir, error: err.message });
    },
  });
}

/// CALLREC_AUTORUN_REPORT=file.json: what the autorun meeting produced (CI smoke).
function writeAutorunReport() {
  const file = process.env.CALLREC_AUTORUN_REPORT;
  if (!file) return;
  const report = { ...lastSession, settings: (() => { const { engines, ...s } = currentSettings(); return s; })(), log: autorunLog };
  try { fs.writeFileSync(file, JSON.stringify(report, null, 2)); } catch (err) { console.error(`autorun report: ${err.message}`); }
}

// ---- lifecycle ------------------------------------------------------------

// One instance: a second launch (Start menu, taskbar, double-clicked exe) restores this one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  settings = createSettings({
    file: path.join(app.getPath('userData'), 'settings.json'),
    defaults: { ...platform.settingsDefaults(process.platform), whisperModelPath: '' },
    crypto: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    },
  });
  createFinalQueue();
  wireDisplayMedia();
  wireIpc();
  installMenu();
  registerShortcut(settings.get().shortcut);
  if (process.platform === 'win32') app.setAppUserModelId('com.pro7ocol.callrec');
  createTray();
  createWindow();
  if (process.platform === 'win32') powerMonitor.on('shutdown', onSessionEnd);
  // Dock / taskbar click restores from any state (desktop-app-ux rule 2).
  app.on('activate', showWindow);
  // Meetings whose final pass was cut short by a quit (or waited for the model).
  setTimeout(() => finalQueue.kick(), AUTORUN_SEC > 0 ? 0 : 3000).unref();
});

// Windows hides instead of closing, so this only runs when quitting (or on macOS).
app.on('window-all-closed', () => app.quit());

app.on('before-quit', (event) => {
  // File › Quit / Ctrl+Q / OS shutdown with a meeting running: stop it cleanly first.
  if (writer && closePolicy && !closePolicy.quitting) { event.preventDefault(); requestQuit(); return; }
  if (closePolicy) closePolicy.setQuitting();
  // Audio + finals are already on disk; just stamp the final duration.
  finishSession();
  nativeStt.stopAll();
  whisperStt.stopAll();
  if (finalServer) finalServer.stop(); // the queue resumes this meeting on the next launch
  globalShortcut.unregisterAll();
  if (AUTORUN_SEC > 0) writeAutorunReport();
});
