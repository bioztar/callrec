'use strict';

const fs = require('fs');
const path = require('path');
const { findCallWindow } = require('./teams-detector');

const pad = (n, w = 2) => String(n).padStart(w, '0');
const hms = (d, sep) => `${pad(d.getHours())}${sep}${pad(d.getMinutes())}${sep}${pad(d.getSeconds())}`;
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/// Where a screenshot goes. While recording: <call>/screenshots/NNN HH.MM.SS.png
/// (NNN counts up per call); otherwise <recordings>/Screenshots/YYYY-MM-DD HH.MM.SS.png.
function screenshotTarget({ recordingDir, root, date = new Date(), list = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []) }) {
  if (recordingDir) {
    const dir = path.join(recordingDir, 'screenshots');
    const n = list(dir).map((f) => parseInt(f, 10)).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0) + 1;
    const number = pad(n, 3);
    return { dir, file: path.join(dir, `${number} ${hms(date, '.')}.png`), number, marker: `screenshot ${number}`, clock: hms(date, ':') };
  }
  const dir = path.join(root, 'Screenshots');
  const taken = new Set(list(dir));
  let name = `${ymd(date)} ${hms(date, '.')}`;
  for (let i = 2; taken.has(`${name}.png`); i += 1) name = `${ymd(date)} ${hms(date, '.')} (${i})`;
  return { dir, file: path.join(dir, `${name}.png`) };
}

/// The desktopCapturer window source for the Teams call window, or null when
/// there is none or it is minimised (→ caller captures the screen under the cursor).
/// The Teams call window to capture (not minimised), or null.
function pickCallWindow(teamsWindows) {
  const open = (teamsWindows || []).filter((w) => !w.minimized);
  const call = findCallWindow(open.map((w) => w.title));
  return call ? open.find((w) => w.title === call.title) : null;
}

function pickCallSource(sources, teamsWindows) {
  const w = pickCallWindow(teamsWindows);
  return w ? sources.find((s) => s.name === w.title) || null : null;
}

/// Thumbnail size for one window source: the window's own pixel size.
function windowThumbSize(win, displays) {
  if (win && win.width > 0 && win.height > 0) return { width: win.width, height: win.height };
  return fullSize(displays);
}

/// The screen source of the display under the cursor (falls back to the first screen).
function pickScreenSource(sources, displayId) {
  const screens = sources.filter((s) => String(s.id).startsWith('screen:'));
  return screens.find((s) => String(s.display_id) === String(displayId)) || screens[0] || null;
}

/// Thumbnail size large enough for any display at full resolution.
function fullSize(displays) {
  let width = 0; let height = 0;
  for (const d of displays) {
    const f = d.scaleFactor || 1;
    width = Math.max(width, Math.round(d.size.width * f));
    height = Math.max(height, Math.round(d.size.height * f));
  }
  return { width: width || 1920, height: height || 1080 };
}

module.exports = { screenshotTarget, pickCallWindow, windowThumbSize, pickCallSource, pickScreenSource, fullSize };
