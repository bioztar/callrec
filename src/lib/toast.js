'use strict';

// Windows toasts with buttons. Electron's Notification `actions` are macOS-only,
// so buttons are toastXml <action>s with protocol activation (callrec://…);
// Windows launches callrec with the URL and the single-instance lock hands it
// to the running app ('second-instance' argv).

const SCHEME = 'callrec';
const SHORT_CALL_SEC = 60;

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/// actions: [{ label, action, id }] → callrec://<action>?id=<id>
function toastXml({ title, body = '', actions = [], scenario = '' }) {
  const buttons = actions.map((a) => `<action content="${esc(a.label)}" activationType="protocol" arguments="${esc(actionUrl(a.action, a.id))}"/>`).join('');
  return `<toast${scenario ? ` scenario="${esc(scenario)}"` : ''}><visual><binding template="ToastGeneric"><text>${esc(title)}</text>${body ? `<text>${esc(body)}</text>` : ''}</binding></visual>${buttons ? `<actions>${buttons}</actions>` : ''}</toast>`;
}

function actionUrl(action, id) { return `${SCHEME}://${action}?id=${encodeURIComponent(id)}`; }

/// argv (second-instance) → { action, id } or null.
function parseActionArgv(argv = []) {
  for (const arg of argv) {
    const m = /^callrec:\/\/([a-z-]+)\/?\?id=([0-9a-f-]{1,64})$/i.exec(String(arg));
    if (m) return { action: m[1].toLowerCase(), id: decodeURIComponent(m[2]) };
  }
  return null;
}

const ACTION_TTL_MS = 10 * 60 * 1000;

/// Toast buttons are callrec:// links, and any web page or chat message can open
/// one. So every toast gets a random nonce; only a nonce issued by a live toast
/// runs, once, before it expires and while its `valid()` still holds.
///   issue([{ action, run, ttlMs?, valid? }]) → nonce;  run({ action, id }) → bool
function createActionRegistry({ now = () => Date.now(), randomId = () => require('crypto').randomUUID(), max = 50 } = {}) {
  const live = new Map();
  function prune() {
    const t = now();
    for (const [k, v] of live) if (Object.values(v).every((a) => a.expiresAt <= t)) live.delete(k);
    while (live.size > max) live.delete(live.keys().next().value);
  }
  return {
    issue(actions) {
      prune();
      const nonce = randomId();
      const t = now();
      live.set(nonce, Object.fromEntries(actions.map((a) => [a.action, {
        run: a.run, valid: a.valid || (() => true), expiresAt: t + (a.ttlMs == null ? ACTION_TTL_MS : a.ttlMs),
      }])));
      return nonce;
    },
    run({ action, id } = {}) {
      const entry = live.get(id);
      const a = entry && Object.prototype.hasOwnProperty.call(entry, action) ? entry[action] : null;
      if (!a) return false;
      live.delete(id); // single use: one button per toast
      if (a.expiresAt <= now() || !a.valid()) return false;
      a.run();
      return true;
    },
    get size() { return live.size; },
  };
}

/// Only auto-recordings shorter than a minute are asked about; manual ones never.
function needsShortCallPrompt({ auto, durationSec }) {
  return Boolean(auto) && durationSec < SHORT_CALL_SEC;
}

function shortCallText(durationSec) {
  const s = Math.max(1, Math.round(durationSec));
  return `Keep this ${s} s recording?`;
}

function durationText(sec) {
  const s = Math.max(1, Math.round(sec));
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/// Native dialog options for the tray's "Discard this recording": Keep is the default.
function discardDialog(durationSec) {
  return {
    type: 'warning',
    buttons: ['Delete', 'Keep'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: `Delete this recording (${durationText(durationSec)}) and its transcript? This cannot be undone.`,
  };
}

/// Resolves true only if the user explicitly picked Delete.
async function confirmDiscard(showMessageBox, durationSec) {
  const { response } = await showMessageBox(discardDialog(durationSec));
  return response === 0;
}

module.exports = { toastXml, actionUrl, parseActionArgv, createActionRegistry, ACTION_TTL_MS, needsShortCallPrompt, shortCallText, discardDialog, confirmDiscard, SCHEME, SHORT_CALL_SEC };
