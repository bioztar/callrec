'use strict';

// Teams call-window title → { call, name, kind }. Table-driven so real titles
// from the laptop (test/fixtures/teams-titles.json) only need new rows.

const SUFFIX = /\s*[|\-–—]\s*Microsoft Teams(?:\s*\((?:work or school|free)\))?\s*$/i;

/// Non-call windows of ms-teams.exe: main window views and helper windows.
const NOT_CALL = [
  /^$/,
  /^Microsoft Teams(?:\s*\(.*\))?$/i,
  /^(?:Activity|Chat|Teams|Calendar|Calls|Files|Apps|OneDrive|Communities|Copilot|Settings|Notifications?|Search|Help)(?:\s*\|.*)?$/i,
  /^Viva (?:Engage|Connections|Learning|Insights|Goals|Pulse|Amplify)\b/i,
  /^(?:Planner|Approvals|Shifts|Whiteboard|Wiki|Tasks by Planner and To Do)$/i,
  /^(?:Meeting compact view|Sharing control bar|Screen sharing toolbar|Microsoft Teams Notification|Teams Notification)$/i,
];

// A person as Teams shows them: capitalised words with name particles, maybe "(External)".
const WORD = String.raw`\p{Lu}[\p{L}'’.-]+`;
const PERSON = String.raw`${WORD}(?:\s+(?:${WORD}|de|del|der|den|da|di|du|dos|van|von|la|le|y))*\s+${WORD}(?:\s*\([^)]*\))?`;

/// Call-window patterns, first match wins: [pattern, kind, name(m), { holds }].
/// Explicit shapes are "positive" and keep a call open; a bare person name only
/// names the call (it could be any two capitalised words). Anything else is
/// "unknown": it may start a call with the mic in use, is named "Teams call",
/// and never keeps a call open.
const RULES = [
  [/^Meeting in ["“](.+)["”]$/i, 'meeting', (m) => m[1]],
  [/^Meeting with (.+)$/i, 'meeting', (m) => m[1]],
  [/^Call with (.+)$/i, 'one-to-one', (m) => m[1]],
  [new RegExp(`^${PERSON}(?:,\\s*${PERSON})+(?:,?\\s+and\\s+(?:${PERSON}|\\d+ others?))?$`, 'u'), 'group', (m) => m[0]],
  [new RegExp(`^${PERSON}\\s+and\\s+(?:${PERSON}|\\d+ others?)$`, 'u'), 'group', (m) => m[0]],
  [new RegExp(`^${PERSON}$`, 'u'), 'one-to-one', (m) => m[0].replace(/\s*\([^)]*\)$/, ''), { holds: false }],
];

function stripSuffix(title) {
  let t = String(title || '').trim();
  for (let i = 0; i < 2 && SUFFIX.test(t); i += 1) t = t.replace(SUFFIX, '').trim();
  return t;
}

function parseTitle(title) {
  const t = stripSuffix(title);
  if (NOT_CALL.some((re) => re.test(t))) return { call: false, positive: false, name: '', kind: 'none' };
  for (const [re, kind, name, opts = {}] of RULES) {
    const m = t.match(re);
    if (m) return { call: true, positive: opts.holds !== false, name: name(m).trim(), kind };
  }
  return { call: true, positive: false, name: '', kind: 'unknown' };
}

/// Recording name for a call: meeting → subject; 1:1 → "Call with X"; group → its name.
function callName({ name, kind } = {}) {
  if (!name) return 'Teams call';
  if (kind === 'one-to-one') return `Call with ${name}`;
  return name;
}

const KIND_LABEL = { meeting: 'meeting', 'one-to-one': '1:1', group: 'group', unknown: 'unknown' };

module.exports = { parseTitle, stripSuffix, callName, KIND_LABEL, RULES, NOT_CALL };
