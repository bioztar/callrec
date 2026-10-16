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
    const m = /^callrec:\/\/([a-z-]+)\/?\?id=([^&]+)/i.exec(String(arg));
    if (m) return { action: m[1].toLowerCase(), id: decodeURIComponent(m[2]) };
  }
  return null;
}

/// Only auto-recordings shorter than a minute are asked about; manual ones never.
function needsShortCallPrompt({ auto, durationSec }) {
  return Boolean(auto) && durationSec < SHORT_CALL_SEC;
}

function shortCallText(durationSec) {
  const s = Math.max(1, Math.round(durationSec));
  return `Keep this ${s} s recording?`;
}

module.exports = { toastXml, actionUrl, parseActionArgv, needsShortCallPrompt, shortCallText, SCHEME, SHORT_CALL_SEC };
