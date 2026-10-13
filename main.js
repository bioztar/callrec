'use strict';

// callrec main process: window, system-audio loopback grant, settings, per-meeting
// folder writing, STT supervision (native helper on macOS, Whisper everywhere),
// global shortcut and menu.

const {
  app, BrowserWindow, ipcMain, Menu, dialog, shell, session, desktopCapturer,
  globalShortcut, safeStorage, systemPreferences, net,
} = require('electron');
const path = require('path');
const os = require('os');

const fs = require('fs');
const nativeStt = require('./src/native-stt');
const whisperStt = require('./src/whisper-stt');
const whisperModels = require('./src/lib/whisper-models');
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
const autorunLog = [];

function defaultRoot() { return path.join(os.homedir(), 'Documents', 'callrec'); }

function whisperDir() { return whisperModels.modelsDir(app.getPath('userData')); }

function whisperStatus(s = settings.get()) {
  return whisperModels.status({ dir: whisperDir(), id: s.whisperModel, chosenPath: s.whisperModelPath });
}

function currentSettings() {
  const s = settings.get();
  const whisperAvailable = whisperStt.isAvailable();
  return {
    ...s,
    engine: platform.effectiveEngine(s.engine, process.platform, { whisperAvailable }),
    outputRoot: s.outputRoot || defaultRoot(),
    platform: process.platform,
    engines: platform.engines(process.platform, { whisperAvailable }),
    nativeAvailable: IS_MAC && nativeStt.isAvailable(),
    whisperAvailable,
    whisperModels: Object.entries(whisperModels.MODELS).map(([id, m]) => ({ id, label: m.label })),
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
        if ((lastSession && !writer) || Date.now() > deadline) app.quit();
        else setTimeout(quitWhenStopped, 500);
      };
      setTimeout(quitWhenStopped, 1500 + AUTORUN_SEC * 1000 + 3000);
    });
  }
  // Close button / red traffic light quits (desktop-app-ux rule 4).
  win.on('close', () => app.quit());
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
      { label: '&File', submenu: [{ label: 'Settings…', accelerator: 'Ctrl+,', click: openSettings }, { type: 'separator' }, { role: 'quit' }] },
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
  let whisperDownload = null;
  ipcMain.handle('whisper:status', () => ({ ...whisperStatus(), downloading: Boolean(whisperDownload) }));
  ipcMain.handle('whisper:download', async (_e, id) => {
    const modelId = whisperModels.MODELS[id] ? id : settings.get().whisperModel;
    if (!whisperDownload) {
      whisperDownload = whisperModels.download({
        id: modelId,
        dir: whisperDir(),
        fetchImpl: (url) => net.fetch(url), // Chromium network stack: system / corporate proxy applies
        onProgress: (fraction) => progress({ engine: 'whisper', fraction }),
      }).finally(() => { whisperDownload = null; });
    }
    const res = await whisperDownload;
    if (res.ok) settings.set({ whisperModel: modelId, whisperModelPath: '' });
    return res;
  });
  ipcMain.handle('whisper:choose', async () => {
    const pick = await dialog.showOpenDialog(win, {
      title: 'Choose a Whisper model file (ggml-*.bin)',
      properties: ['openFile'],
      filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }],
    });
    if (pick.canceled || !pick.filePaths[0]) return { canceled: true };
    const res = await whisperModels.importFile(pick.filePaths[0], whisperDir());
    if (res.ok) settings.set({ whisperModelPath: res.path });
    return res.ok ? { ...res, status: whisperStatus() } : res;
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
      modelName = model.name;
      locale = { es: 'es', en: 'en', mixed: 'auto (es/en per utterance)' }[language];
    } else {
      return { error: `Unknown engine "${engine}"` };
    }
    try {
      const label = { deepgram: 'Deepgram Nova-3', native: 'Native Mac (on-device)', whisper: `Whisper ${modelName} (on-device)` }[engine];
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
    sttEngine = engine === 'whisper' ? whisperStt : nativeStt;
    sttModelPath = modelPath;
    return { dir: writer.dir, deepgramKey, deepgramLanguage: deepgramLanguage(language), locale, note };
  });

  ipcMain.on('session:audio', (_e, bytes) => { if (writer) writer.addAudio(bytes); });
  ipcMain.on('session:segment', (_e, seg) => { if (writer) writer.addSegment(seg); });
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
  lastSession = { dir, segments: w.segments ? w.segments.length : null };
  return dir;
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
    defaults: { ...platform.settingsDefaults(process.platform), whisperModel: whisperModels.recommendedModel(require('os').cpus().length), whisperModelPath: '' },
    crypto: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    },
  });
  wireDisplayMedia();
  wireIpc();
  installMenu();
  registerShortcut(settings.get().shortcut);
  createWindow();
  // Dock / taskbar click restores from any state (desktop-app-ux rule 2).
  app.on('activate', showWindow);
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  // Audio + finals are already on disk; just stamp the final duration.
  finishSession();
  nativeStt.stopAll();
  whisperStt.stopAll();
  globalShortcut.unregisterAll();
  if (AUTORUN_SEC > 0) writeAutorunReport();
});
