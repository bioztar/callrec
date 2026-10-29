'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  outputRoot: '',
  engine: 'native',
  language: 'es',
  shortcut: 'CommandOrControl+Shift+R',
  screenshotShortcut: 'Control+Shift+F8',
  autoRecordTeams: true,
  launchAtLogin: true, // Windows only; ignored elsewhere
};

/// JSON settings file; the Deepgram key is stored only as `deepgramKeyEnc`
/// (base64 of the encrypt() output, Electron safeStorage in the app).
/// `crypto` = { available(): bool, encrypt(str): Buffer, decrypt(Buffer): str }.
function createSettings({ file, crypto, defaults = {} }) {
  const base = { ...DEFAULTS, ...defaults };

  function readRaw() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`settings unreadable (${err.message}), using defaults`);
      return {};
    }
  }

  function write(obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  }

  return {
    /// Settings safe to send to the renderer: never includes the key.
    get() {
      const { deepgramKeyEnc, teamsTokenEnc, ...rest } = readRaw();
      return { ...base, ...rest, hasDeepgramKey: Boolean(deepgramKeyEnc), teamsApiPaired: Boolean(teamsTokenEnc) };
    },
    set(patch) {
      const { deepgramKeyEnc, hasDeepgramKey, teamsTokenEnc, teamsApiPaired, ...clean } = patch || {};
      write({ ...readRaw(), ...clean });
    },
    setDeepgramKey(key) {
      const raw = readRaw();
      if (!key) { const { deepgramKeyEnc, ...rest } = raw; write(rest); return; }
      if (!crypto.available()) throw new Error('Secure storage is unavailable; cannot save the Deepgram key');
      write({ ...raw, deepgramKeyEnc: crypto.encrypt(key).toString('base64') });
    },
    getDeepgramKey() {
      const { deepgramKeyEnc } = readRaw();
      if (!deepgramKeyEnc) return '';
      try { return crypto.decrypt(Buffer.from(deepgramKeyEnc, 'base64')); } catch { return ''; }
    },
    /// Teams API pairing token, safeStorage-encrypted like the Deepgram key.
    setTeamsToken(token) {
      const raw = readRaw();
      if (!token || !crypto.available()) { const { teamsTokenEnc, ...rest } = raw; write(rest); return; }
      write({ ...raw, teamsTokenEnc: crypto.encrypt(token).toString('base64') });
    },
    getTeamsToken() {
      const { teamsTokenEnc } = readRaw();
      if (!teamsTokenEnc) return '';
      try { return crypto.decrypt(Buffer.from(teamsTokenEnc, 'base64')); } catch { return ''; }
    },
  };
}

module.exports = { createSettings, DEFAULTS };
