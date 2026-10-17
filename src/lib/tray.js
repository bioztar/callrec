'use strict';

const { LEVELS, DEFAULT_LEVEL } = require('./cpu-dial');
const { etaText } = require('./eta');

// Tray / menu-bar icon: pure helpers plus a controller that takes Electron's
// Tray / Menu / nativeImage as arguments (unit-tested with mocks).

const IDLE_TIP = 'callrec — idle';

function clock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/// "callrec — idle" / "callrec — recording 12:34" / "callrec — Finalising transcript… 43%".
function tooltip({ recording = false, elapsedSec = 0, finalising = null, etaSec = null, cpu = null } = {}) {
  if (recording) return `callrec — recording ${clock(elapsedSec)}`;
  if (finalising != null) {
    const left = etaText(etaSec);
    return `callrec — finalising ${Math.round(finalising * 100)}%${left ? ` · ${left}` : ''}${cpu ? ` · CPU ${cpu}%` : ''}`;
  }
  return IDLE_TIP;
}

/// Electron accelerator → what the user presses ("Ctrl+Alt+Shift+R", "⌘⇧R" stays as "Cmd+Shift+R").
function shortcutLabel(accelerator, platform) {
  if (!accelerator) return '';
  return accelerator.split('+').map((k) => {
    if (/^(CommandOrControl|CmdOrCtrl)$/i.test(k)) return platform === 'darwin' ? 'Cmd' : 'Ctrl';
    if (/^Control$/i.test(k)) return 'Ctrl';
    if (/^Command$/i.test(k)) return 'Cmd';
    if (/^Option$/i.test(k)) return 'Alt';
    return k;
  }).join('+');
}

/// "Finalising speed" submenu: how much CPU the final pass may use.
function speedMenu(cpu, pick) {
  return LEVELS.map((p) => ({ label: p === 100 ? '100% (max)' : `${p}%`, type: 'radio', checked: p === cpu, click: () => pick(p) }));
}

function menuTemplate({ recording = false, autoRecording = false, shortcut = '', screenshotShortcut = '', autoRecordTeams = true, platform = 'win32', cpu = DEFAULT_LEVEL, actions }) {
  const keys = shortcutLabel(shortcut, platform);
  const shotKeys = shortcutLabel(screenshotShortcut, platform);
  return [
    { label: `${recording ? 'Stop recording' : 'Start recording'}${keys ? `\t${keys}` : ''}`, click: actions.toggle },
    ...(recording && autoRecording && actions.discard ? [{ label: 'Discard this recording', click: actions.discard }] : []),
    ...(actions.screenshot ? [{ label: `Screenshot${shotKeys ? `\t${shotKeys}` : ''}`, click: actions.screenshot }] : []),
    ...(platform === 'win32' && actions.autoRecord
      ? [{ label: 'Auto-record Teams calls', type: 'checkbox', checked: Boolean(autoRecordTeams), click: (item) => actions.autoRecord(item ? item.checked : !autoRecordTeams) }]
      : []),
    { label: 'Show callrec', click: actions.show },
    { label: 'Open recordings folder', click: actions.openFolder },
    ...(actions.speed ? [{ label: 'Finalising speed', submenu: speedMenu(cpu, actions.speed) }] : []),
    { type: 'separator' },
    { label: 'Quit', click: actions.quit },
  ];
}

/// BGRA bitmap of a record button: a ring with a dot. Idle = light grey dot,
/// recording = red dot (clearly different at 16 px).
function iconBitmap(size, { recording = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const rOuter = size * 0.47;
  const rRing = size * 0.36;
  const rDot = size * (recording ? 0.30 : 0.22);
  const ring = [235, 235, 235]; // RGB
  const dot = recording ? [235, 40, 40] : [235, 235, 235];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - c, y - c);
      const cov = (r) => Math.max(0, Math.min(1, r - d + 0.5)); // 1 px anti-alias
      let rgb = null; let a = 0;
      if (cov(rDot) > 0) { rgb = dot; a = cov(rDot); } else if (cov(rOuter) > 0 && d > rRing - 0.5) {
        rgb = ring; a = cov(rOuter) * Math.max(0, Math.min(1, d - rRing + 0.5));
      }
      if (!rgb) continue;
      const i = (y * size + x) * 4;
      buf[i] = rgb[2]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[0]; buf[i + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

function makeIcon(nativeImage, recording) {
  const img = nativeImage.createEmpty();
  for (const [size, scaleFactor] of [[16, 1], [32, 2]]) {
    img.addRepresentation({ scaleFactor, width: size, height: size, buffer: iconBitmap(size, { recording }) });
  }
  return img;
}

/// The tray icon. `getState()` → { recording, elapsedSec, finalising, shortcut }.
/// Left click shows the window; right click (Windows) / click (macOS) opens the menu.
function createTrayController({ Tray, Menu, nativeImage, platform, getState, actions }) {
  const icons = { idle: makeIcon(nativeImage, false), recording: makeIcon(nativeImage, true) };
  if (platform === 'darwin' && icons.idle.setTemplateImage) icons.idle.setTemplateImage(true);
  const tray = new Tray(icons.idle);
  let last = {};
  function refresh() {
    const st = getState();
    const tip = tooltip(st);
    if (tip !== last.tip) tray.setToolTip(tip);
    if (st.recording !== last.recording || st.autoRecording !== last.autoRecording || st.shortcut !== last.shortcut || st.cpu !== last.cpu
      || st.screenshotShortcut !== last.screenshotShortcut || st.autoRecordTeams !== last.autoRecordTeams) {
      tray.setImage(st.recording ? icons.recording : icons.idle);
      tray.setContextMenu(Menu.buildFromTemplate(menuTemplate({ ...st, platform, actions })));
    }
    last = { tip, recording: st.recording, autoRecording: st.autoRecording, shortcut: st.shortcut, cpu: st.cpu, screenshotShortcut: st.screenshotShortcut, autoRecordTeams: st.autoRecordTeams };
  }
  // macOS opens the context menu on click by itself; Windows/Linux: left click = window.
  if (platform !== 'darwin') tray.on('click', () => actions.show());
  refresh();
  return {
    tray,
    refresh,
    /// Windows balloon (works for a portable exe without a Start-menu shortcut).
    balloon(title, content) {
      if (tray.displayBalloon) tray.displayBalloon({ title, content, iconType: 'info' });
    },
    destroy() { tray.destroy(); },
  };
}

/// Window ✕ policy. Windows/Linux: hide to tray (first time: say so). macOS keeps
/// close = quit. Quitting for real (tray Quit, File › Quit) sets `quitting`.
function createCloseToTray({ platform, hintShown, markHintShown, notify }) {
  let quitting = false;
  let shown = Boolean(hintShown);
  return {
    get quitting() { return quitting; },
    setQuitting() { quitting = true; },
    hidesToTray: platform !== 'darwin',
    /// Window 'close' handler. Returns 'hide' | 'quit'.
    onClose(event, win) {
      if (quitting || platform === 'darwin') return 'quit';
      event.preventDefault();
      win.hide();
      if (!shown) {
        shown = true;
        markHintShown();
        notify('callrec is still running in the tray — right-click the icon to quit');
      }
      return 'hide';
    },
  };
}

/// Quit that never loses a recording: stop it via the renderer (it drains the
/// live transcript and closes the files), wait until the session is closed
/// (or `timeoutMs`), then force-close it and quit.
async function quitCleanly({ isRecording, stopRecording, forceFinish, quit, timeoutMs = 20000, pollMs = 200 }) {
  if (isRecording()) {
    stopRecording();
    const deadline = Date.now() + timeoutMs;
    while (isRecording() && Date.now() < deadline) await new Promise((r) => setTimeout(r, pollMs));
    if (isRecording()) forceFinish();
  }
  quit();
}

/// Windows shutdown / sign-out ('session-end'): no time for the renderer round
/// trip and no reliable 'before-quit'. Mark quitting so ✕ really closes (never
/// block shutdown), close the meeting files synchronously (the final pass is
/// queued, not run, so it resumes on the next launch), stop the engines.
function endSessionNow({ policy, finishSession, stopEngines }) {
  policy.setQuitting();
  try {
    finishSession();
  } finally {
    stopEngines();
  }
}

module.exports = { tooltip, shortcutLabel, menuTemplate, iconBitmap, createTrayController, createCloseToTray, quitCleanly, endSessionNow, clock, IDLE_TIP };
