'use strict';

// Per-OS choices: engines on offer, defaults, shortcut and settings panes.

const ENGINE_LABELS = {
  native: 'Native Mac (on-device, free)',
  whisper: 'Whisper (on-device, free)',
  deepgram: 'Deepgram (cloud, needs key)',
};

/// Engines offered on `platform`, default first. Whisper is offered on macOS
/// only when its binary is bundled; it is the only on-device engine elsewhere.
function engines(platform, { whisperAvailable = false } = {}) {
  const ids = platform === 'darwin'
    ? ['native', 'deepgram', ...(whisperAvailable ? ['whisper'] : [])]
    : ['whisper', 'deepgram'];
  return ids.map((id) => ({ id, label: ENGINE_LABELS[id] }));
}

function defaultEngine(platform) { return platform === 'darwin' ? 'native' : 'whisper'; }

/// Ctrl+Shift+R is Outlook's "Reply all" on Windows, so non-Mac adds Alt.
function defaultShortcut(platform) {
  return platform === 'darwin' ? 'CommandOrControl+Shift+R' : 'Control+Alt+Shift+R';
}

/// Settings deep links for permission panes, or null when the OS has none.
function settingsUrl(platform, pane) {
  if (platform === 'darwin') {
    if (pane === 'keyboard') return 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension';
    const mac = { microphone: 'Privacy_Microphone', screen: 'Privacy_ScreenCapture', speech: 'Privacy_SpeechRecognition' }[pane];
    return mac ? `x-apple.systempreferences:com.apple.preference.security?${mac}` : null;
  }
  if (platform === 'win32') {
    return { microphone: 'ms-settings:privacy-microphone', sound: 'ms-settings:sound' }[pane] || null;
  }
  return null;
}

/// Settings defaults for createSettings().
function settingsDefaults(platform) {
  return { engine: defaultEngine(platform), shortcut: defaultShortcut(platform) };
}

/// Engine to use: the saved one when this OS offers it, else the OS default.
function effectiveEngine(saved, platform, opts) {
  return engines(platform, opts).some((e) => e.id === saved) ? saved : defaultEngine(platform);
}

module.exports = { engines, defaultEngine, defaultShortcut, settingsUrl, settingsDefaults, effectiveEngine, ENGINE_LABELS };
