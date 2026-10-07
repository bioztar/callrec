'use strict';

// callrec main process: window, system-audio loopback grant, settings, per-meeting
// folder writing, native STT supervision, global shortcut and menu.

const {
  app, BrowserWindow, ipcMain, Menu, dialog, shell, session, desktopCapturer,
  globalShortcut, safeStorage, systemPreferences,
} = require('electron');
const path = require('path');
const os = require('os');

const nativeStt = require('./src/native-stt');
const { createSettings } = require('./src/lib/settings');
const { SessionWriter } = require('./src/lib/session-writer');
const { nativeLocale, deepgramLanguage, LANGUAGES } = require('./src/lib/engines');

const PANES = {
  microphone: 'Privacy_Microphone',
  screen: 'Privacy_ScreenCapture',
  speech: 'Privacy_SpeechRecognition',
};

let win = null;
let settings = null;
let writer = null;
let startedAtMs = 0;

function defaultRoot() { return path.join(os.homedir(), 'Documents', 'callrec'); }

function currentSettings() {
  const s = settings.get();
  return { ...s, outputRoot: s.outputRoot || defaultRoot(), nativeAvailable: nativeStt.isAvailable() };
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
    titleBarStyle: 'hiddenInset', // native traffic lights, top-left
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  // Test hook: CALLREC_AUTORUN_SEC=N records for N seconds then quits (no UI clicks needed).
  const autoSec = Number(process.env.CALLREC_AUTORUN_SEC);
  if (autoSec > 0) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(toggleRecording, 1500);
      setTimeout(toggleRecording, 1500 + autoSec * 1000);
      setTimeout(() => app.quit(), 1500 + autoSec * 1000 + 6000);
    });
  }
  // Red traffic light quits (desktop-app-ux rule 4).
  win.on('close', () => app.quit());
}

// Grant getDisplayMedia({ audio: 'loopback' }) → system audio, no virtual driver.
function wireDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] })
        // No screen source = no Screen Recording permission (or locked display): deny cleanly.
        .then((sources) => (sources[0] ? { video: sources[0], audio: 'loopback' } : {}), () => ({}))
        .then((grant) => callback(grant)); // exactly one callback call (a second throws)
    },
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

function installMenu() {
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

  ipcMain.handle('perm:status', () => ({
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    screen: systemPreferences.getMediaAccessStatus('screen'),
  }));
  ipcMain.handle('perm:askMic', () => systemPreferences.askForMediaAccess('microphone'));
  ipcMain.handle('perm:open', (_e, pane) => {
    if (pane === 'keyboard') shell.openExternal('x-apple.systempreferences:com.apple.Keyboard-Settings.extension');
    else if (PANES[pane]) shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PANES[pane]}`);
  });

  // Dev-only UI test: pretend the model is missing until a simulated download finishes.
  const fakeMissing = !app.isPackaged && process.env.CALLREC_FAKE_MODEL_MISSING === '1';
  let fakeInstalled = false;
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
    return nativeStt.downloadModel(locale, (fraction) => {
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { locale, fraction });
    });
  });

  ipcMain.handle('session:start', async (_e, { title, engine, language }) => {
    if (writer) return { error: 'A recording is already running' };
    if (!LANGUAGES[language]) return { error: `Unknown language "${language}"` };
    const s = currentSettings();
    let deepgramKey = '';
    let locale = '';
    let note = '';
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
    } else {
      return { error: `Unknown engine "${engine}"` };
    }
    try {
      const label = engine === 'deepgram' ? 'Deepgram Nova-3' : 'Native Mac (on-device)';
      const langLabel = LANGUAGES[language].label;
      writer = new SessionWriter({
        root: s.outputRoot,
        title,
        engine: label,
        language: engine === 'native' ? `${langLabel} → ${locale}` : `${langLabel} → ${deepgramLanguage(language)}`,
        languageNote: note,
      });
    } catch (err) {
      return { error: `Cannot create the meeting folder in ${s.outputRoot}: ${err.message}` };
    }
    startedAtMs = Date.now();
    return { dir: writer.dir, deepgramKey, deepgramLanguage: deepgramLanguage(language), locale, note };
  });

  ipcMain.on('session:audio', (_e, bytes) => { if (writer) writer.addAudio(bytes); });
  ipcMain.on('session:segment', (_e, seg) => { if (writer) writer.addSegment(seg); });
  ipcMain.handle('session:stop', () => finishSession());

  ipcMain.handle('shell:openFolder', (_e, dir) => shell.openPath(dir));

  const send = (payload) => { if (win && !win.isDestroyed()) win.webContents.send('stt:event', payload); };
  ipcMain.handle('stt:start', (_e, opts) => nativeStt.start(opts, send));
  ipcMain.on('stt:chunk', (_e, id, buf) => nativeStt.chunk(id, buf));
  ipcMain.on('stt:stop', (_e, id) => nativeStt.stop(id));
}

function finishSession() {
  if (!writer) return null;
  const dir = writer.finish((Date.now() - startedAtMs) / 1000);
  writer = null;
  return dir;
}

// ---- lifecycle ------------------------------------------------------------

app.whenReady().then(() => {
  settings = createSettings({
    file: path.join(app.getPath('userData'), 'settings.json'),
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
  // Dock click restores from any state (desktop-app-ux rule 2).
  app.on('activate', showWindow);
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  // Audio + finals are already on disk; just stamp the final duration.
  finishSession();
  nativeStt.stopAll();
  globalShortcut.unregisterAll();
});
