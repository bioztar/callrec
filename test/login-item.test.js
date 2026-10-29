'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loginItemSettings, isHiddenLaunch } = require('../src/lib/login-item');
const { menuTemplate } = require('../src/lib/tray');
const { createSettings } = require('../src/lib/settings');

const base = { platform: 'win32', isPackaged: true, enabled: true, env: {}, execPath: 'C:\\App\\callrec.exe' };

test('login item: installed exe, hidden arg, on/off', () => {
  assert.deepEqual(loginItemSettings(base), { openAtLogin: true, path: 'C:\\App\\callrec.exe', args: ['--hidden'] });
  assert.equal(loginItemSettings({ ...base, enabled: false }).openAtLogin, false);
});

test('login item: portable build registers the real exe, not the temp unpack', () => {
  const s = loginItemSettings({ ...base, execPath: 'C:\\Temp\\x\\callrec.exe', env: { PORTABLE_EXECUTABLE_FILE: 'D:\\tools\\callrec-portable.exe' } });
  assert.equal(s.path, 'D:\\tools\\callrec-portable.exe');
});

test('login item: untouched on macOS and in dev', () => {
  assert.equal(loginItemSettings({ ...base, platform: 'darwin' }), null);
  assert.equal(loginItemSettings({ ...base, isPackaged: false }), null);
});

test('login item: --hidden detection', () => {
  assert.equal(isHiddenLaunch(['callrec.exe', '--hidden']), true);
  assert.equal(isHiddenLaunch(['callrec.exe']), false);
});

test('tray: Start with Windows checkbox on Windows only', () => {
  const actions = { toggle() {}, show() {}, openFolder() {}, quit() {}, launchAtLogin() {} };
  const win = menuTemplate({ launchAtLogin: true, platform: 'win32', actions }).find((i) => i.label === 'Start with Windows');
  assert.equal(win.type, 'checkbox');
  assert.equal(win.checked, true);
  assert.ok(!menuTemplate({ platform: 'darwin', actions }).some((i) => i.label === 'Start with Windows'));
});

test('settings: launchAtLogin defaults on, also for files that never set it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'callrec-login-')), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ language: 'en' }));
  const s = createSettings({ file, crypto: {} });
  assert.equal(s.get().launchAtLogin, true);
  s.set({ launchAtLogin: false });
  assert.equal(s.get().launchAtLogin, false);
});
