'use strict';

// Start-with-Windows: pure choices for app.setLoginItemSettings (unit-tested).

const HIDDEN_FLAG = '--hidden';

/// Argument object for app.setLoginItemSettings, or null when nothing should be touched:
/// not Windows, or a dev run (would register electron.exe). The portable exe unpacks
/// to a temp dir, so process.execPath is wrong there; PORTABLE_EXECUTABLE_FILE is the real exe.
function loginItemSettings({ platform, isPackaged, enabled, env = {}, execPath }) {
  if (platform !== 'win32' || !isPackaged) return null;
  return { openAtLogin: Boolean(enabled), path: env.PORTABLE_EXECUTABLE_FILE || execPath, args: [HIDDEN_FLAG] };
}

/// True when the app was started by the login item (tray only, no window).
function isHiddenLaunch(argv = []) { return argv.includes(HIDDEN_FLAG); }

module.exports = { loginItemSettings, isHiddenLaunch, HIDDEN_FLAG };
