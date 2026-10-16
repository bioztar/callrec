'use strict';

// Teams call-window title → { call, name, kind }. Table-driven so real titles
// from the laptop (test/fixtures/teams-titles.json) only need new rows.

const SUFFIX = /\s*[|\-–—]\s*Microsoft Teams(?:\s*\((?:work or school|free)\))?\s*$/i;

/// Non-call windows of ms-teams.exe: main window views and helper windows.
const NOT_CALL = [
  /^$/,
  /^Microsoft Teams(?:\s*\(.*\))?$/i,
  /^(?:Activity|Chat|Teams|Calendar|Calls|Files|Apps|OneDrive|Communities|Copilot|Settings|Notifications?|Search|Help)(?:\s*\|.*)?$/i,
  /^(?:Meeting compact view|Sharing control bar|Screen sharing toolbar|Microsoft Teams Notification|Teams Notification)$/i,
];

/// First match wins: [pattern, kind, name(m)].
const RULES = [
  [/^Meeting in ["“](.+)["”]$/i, 'meeting', (m) => m[1]],
  [/^Meeting with (.+)$/i, 'meeting', (m) => m[1]],
  [/^Call with (.+)$/i, 'one-to-one', (m) => m[1]],
  [/^(.+?),\s*(.+?)(?:,\s*.+)?$/, 'group', (m) => m[0]],
  [/^(.+) and (?:\d+ others?|.+)$/i, 'group', (m) => m[0]],
  [/^(?:\p{Lu}[\p{L}'’.-]+)(?:\s+(?:\p{Lu}[\p{L}'’.-]+|de|del|der|den|da|di|du|dos|van|von|la|le|y))*\s+\p{Lu}[\p{L}'’.-]+(?:\s*\(.*\))?$/u, 'one-to-one', (m) => m[0].replace(/\s*\(.*\)$/, '')],
  [/^(.+)$/, 'meeting', (m) => m[1]],
];

function stripSuffix(title) {
  let t = String(title || '').trim();
  for (let i = 0; i < 2 && SUFFIX.test(t); i += 1) t = t.replace(SUFFIX, '').trim();
  return t;
}

function parseTitle(title) {
  const t = stripSuffix(title);
  if (NOT_CALL.some((re) => re.test(t))) return { call: false, name: '', kind: 'none' };
  for (const [re, kind, name] of RULES) {
    const m = t.match(re);
    if (m) return { call: true, name: name(m).trim(), kind };
  }
  return { call: true, name: '', kind: 'unknown' };
}

/// Recording name for a call: meeting → subject; 1:1 → "Call with X"; group → its name.
function callName({ name, kind } = {}) {
  if (!name) return 'Teams call';
  if (kind === 'one-to-one') return `Call with ${name}`;
  return name;
}

const KIND_LABEL = { meeting: 'meeting', 'one-to-one': '1:1', group: 'group', unknown: 'unknown' };

module.exports = { parseTitle, stripSuffix, callName, KIND_LABEL, RULES, NOT_CALL };
