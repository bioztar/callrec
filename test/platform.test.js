'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/lib/platform');

test('platform: engines and defaults per OS', () => {
  assert.deepEqual(p.engines('win32').map((e) => e.id), ['whisper', 'deepgram']);
  assert.deepEqual(p.engines('darwin').map((e) => e.id), ['native', 'deepgram']);
  assert.deepEqual(p.engines('darwin', { whisperAvailable: true }).map((e) => e.id), ['native', 'deepgram', 'whisper']);
  assert.equal(p.defaultEngine('win32'), 'whisper');
  assert.equal(p.defaultEngine('darwin'), 'native');
});

test('platform: saved engine the OS does not offer falls back to the default', () => {
  assert.equal(p.effectiveEngine('native', 'win32'), 'whisper');
  assert.equal(p.effectiveEngine('deepgram', 'win32'), 'deepgram');
  assert.equal(p.effectiveEngine('whisper', 'darwin'), 'native');
  assert.equal(p.effectiveEngine('whisper', 'darwin', { whisperAvailable: true }), 'whisper');
});

test('platform: shortcut avoids Outlook Reply-all on Windows; macOS unchanged', () => {
  assert.equal(p.defaultShortcut('darwin'), 'CommandOrControl+Shift+R');
  assert.equal(p.defaultShortcut('win32'), 'Control+Alt+Shift+R');
  assert.deepEqual(p.settingsDefaults('win32'), { engine: 'whisper', shortcut: 'Control+Alt+Shift+R' });
});

test('platform: settings links', () => {
  assert.equal(p.settingsUrl('win32', 'microphone'), 'ms-settings:privacy-microphone');
  assert.equal(p.settingsUrl('darwin', 'screen'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  assert.equal(p.settingsUrl('darwin', 'keyboard'), 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension');
  assert.equal(p.settingsUrl('win32', 'screen'), null);
  assert.equal(p.settingsUrl('linux', 'microphone'), null);
});
