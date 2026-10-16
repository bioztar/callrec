'use strict';

// Windows-only local Teams signals through koffi (prebuilt FFI, no admin):
// top-level windows of ms-teams.exe, and whether Teams holds the microphone
// (CapabilityAccessManager consent store, LastUsedTimeStop == 0 while in use).
// Reads window titles and two registry timestamps; nothing else.

const path = require('path');

const CONSENT = 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
const TEAMS_PACKAGE = /^MSTeams_8wekyb3d8bbwe$/i;
const TEAMS_EXE = /^ms-teams\.exe$/i;
const HKCU = -2147483647; // (HKEY)(LONG)0x80000001, sign-extended on x64
const KEY_READ = 0x20019;
const RRF_RT_QWORD = 0x48;

let api = null;
function load() {
  if (api) return api;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const advapi32 = koffi.load('advapi32.dll');
  const RECT = koffi.struct('CallrecRECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const EnumProc = koffi.proto('bool __stdcall CallrecEnumProc(void *hwnd, intptr_t lParam)');
  api = {
    koffi,
    EnumProc,
    EnumWindows: user32.func('bool __stdcall EnumWindows(CallrecEnumProc *cb, intptr_t lParam)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *buf, int max)'),
    GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ CallrecRECT *r)'),
    IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
    OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *h)'),
    QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'),
    RegGetValueW: advapi32.func('long __stdcall RegGetValueW(intptr_t hkey, str16 sub, str16 value, uint32_t flags, void *type, _Out_ uint64_t *data, _Inout_ uint32_t *cb)'),
    RegOpenKeyExW: advapi32.func('long __stdcall RegOpenKeyExW(intptr_t hkey, str16 sub, uint32_t opts, uint32_t sam, _Out_ intptr_t *out)'),
    RegEnumKeyExW: advapi32.func('long __stdcall RegEnumKeyExW(intptr_t hkey, uint32_t i, _Out_ uint16_t *name, _Inout_ uint32_t *cch, void *r, void *cls, void *ccls, void *ft)'),
    RegCloseKey: advapi32.func('long __stdcall RegCloseKey(intptr_t hkey)'),
  };
  return api;
}

const exeCache = new Map();
function exeName(pid) {
  if (exeCache.has(pid)) return exeCache.get(pid);
  const a = load();
  let name = '';
  const h = a.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
  if (h) {
    const buf = Buffer.alloc(1040);
    const size = [520];
    if (a.QueryFullProcessImageNameW(h, 0, buf, size)) name = path.win32.basename(buf.toString('utf16le', 0, size[0] * 2));
    a.CloseHandle(h);
  }
  if (exeCache.size > 512) exeCache.clear();
  exeCache.set(pid, name);
  return name;
}

/// Visible top-level windows of ms-teams.exe: [{ title, minimized, width, height }] (pixels).
function teamsWindows() {
  const a = load();
  const out = [];
  const buf = Buffer.alloc(1024);
  const cb = a.koffi.register((hwnd) => {
    try {
      if (!a.IsWindowVisible(hwnd)) return true;
      const pid = [0];
      a.GetWindowThreadProcessId(hwnd, pid);
      if (!TEAMS_EXE.test(exeName(pid[0]))) return true;
      const n = a.GetWindowTextW(hwnd, buf, 512);
      const r = {};
      const size = a.GetWindowRect(hwnd, r) ? { width: r.right - r.left, height: r.bottom - r.top } : {};
      out.push({ title: buf.toString('utf16le', 0, n * 2), minimized: Boolean(a.IsIconic(hwnd)), ...size });
    } catch { /* keep enumerating */ }
    return true;
  }, a.koffi.pointer(a.EnumProc));
  try { a.EnumWindows(cb, 0); } finally { a.koffi.unregister(cb); }
  return out;
}

function qword(sub, value) {
  const a = load();
  const data = [0n];
  const cb = [8];
  const rc = a.RegGetValueW(HKCU, sub, value, RRF_RT_QWORD, null, data, cb);
  return rc === 0 ? BigInt(data[0]) : null;
}

function subkeys(sub) {
  const a = load();
  const h = [0];
  if (a.RegOpenKeyExW(HKCU, sub, 0, KEY_READ, h) !== 0) return [];
  const names = [];
  const buf = Buffer.alloc(1040);
  try {
    for (let i = 0; i < 4096; i += 1) {
      const cch = [520];
      if (a.RegEnumKeyExW(h[0], i, buf, cch, null, null, null, null) !== 0) break;
      names.push(buf.toString('utf16le', 0, cch[0] * 2));
    }
  } finally { a.RegCloseKey(h[0]); }
  return names;
}

/// Pure: which consent-store entries count as "Teams has the mic" (testable).
function isTeamsMicEntry(name, { ownExe = process.execPath } = {}) {
  if (TEAMS_PACKAGE.test(name)) return true;
  const own = String(ownExe || '').replace(/\\/g, '#').toLowerCase();
  const lower = name.toLowerCase();
  if (own && lower === own) return false;
  if (/callrec/.test(lower)) return false;
  return TEAMS_EXE.test(path.win32.basename(name.replace(/#/g, '\\')));
}

const inUse = (sub) => {
  const start = qword(sub, 'LastUsedTimeStart');
  const stop = qword(sub, 'LastUsedTimeStop');
  return start != null && start > 0n && stop === 0n;
};

/// True while Teams (packaged or a non-packaged Teams exe) uses the microphone.
function teamsMicInUse() {
  const keys = [
    ...subkeys(CONSENT).filter((n) => n !== 'NonPackaged' && isTeamsMicEntry(n)).map((n) => `${CONSENT}\\${n}`),
    ...subkeys(`${CONSENT}\\NonPackaged`).filter((n) => isTeamsMicEntry(n)).map((n) => `${CONSENT}\\NonPackaged\\${n}`),
  ];
  return keys.some(inUse);
}

module.exports = { teamsWindows, teamsMicInUse, isTeamsMicEntry };
