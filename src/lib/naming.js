'use strict';

const fs = require('fs');
const path = require('path');

const MAX_TITLE = 60;

/// Title -> a safe single path segment. Strips path separators, control chars
/// and characters macOS/Windows dislike, collapses whitespace, trims dots.
function sanitizeTitle(title) {
  const clean = String(title || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_TITLE)
    .trim();
  return clean;
}

const pad = (n) => String(n).padStart(2, '0');

/// "YYYY-MM-DD HHmm <title>" in local time; title optional.
function folderName(date, title) {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
  const t = sanitizeTitle(title);
  return t ? `${stamp} ${t}` : stamp;
}

/// Windows-safe "YYYY-MM-DD HH.MM — <name>" for an auto-recorded call.
function callFolderName(date, name) {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
  const t = sanitizeTitle(name).replace(/[. ]+$/, '');
  return `${stamp} — ${t || 'Teams call'}`;
}

/// Picks a directory under `root` that does not exist yet, appending " (2)",
/// " (3)"... on collision. Does not create it.
function uniqueDir(root, name, exists = fs.existsSync) {
  let candidate = path.join(root, name);
  for (let n = 2; exists(candidate); n += 1) candidate = path.join(root, `${name} (${n})`);
  return candidate;
}

module.exports = { sanitizeTitle, folderName, callFolderName, uniqueDir };
