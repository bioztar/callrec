'use strict';

const { parseTitle, callName } = require('./teams-titles');

const END_DEBOUNCE_MS = 5000;
const POLL_MS = 2000;

/// Picks the call window from Teams window titles: a positive call title first,
/// then one that at least names the call, then an unrecognised one.
function findCallWindow(titles = []) {
  const rank = (p) => (p.positive ? 3 : p.kind !== 'unknown' ? 2 : 1);
  let best = null;
  for (const title of titles) {
    const parsed = parseTitle(title);
    if (parsed.call && (!best || rank(parsed) > rank(best))) best = { title, ...parsed };
  }
  return best;
}

/// Teams call state machine. Feed it signals with tick(); it decides when a
/// call starts and ends and whether callrec should record it.
///   signals: { mic: bool, api: true|false|null (null = API not connected), windows: [titles] }
///   hooks:   isRecording() → bool, enabled() → bool, onStart(call), onEnd(call)
/// start = (mic or API in-meeting) and a call window (recognised or not);
/// end = mic/API gone for 5 s. Windows only start a call, never hold one open:
/// a meeting chat or pop-out left open after hanging up must not keep recording.
function createTeamsDetector({ isRecording = () => false, enabled = () => true, onStart = () => {}, onEnd = () => {}, endDebounceMs = END_DEBOUNCE_MS, now = () => Date.now() } = {}) {
  let call = null;
  let goneSince = null;
  let seq = 0;

  function tick(signals = {}) {
    const t = now();
    const win = findCallWindow(signals.windows);
    const inCall = signals.api === true || Boolean(signals.mic);
    if (!call) {
      if (!(inCall && win)) return null;
      seq += 1;
      call = {
        id: seq,
        title: win.title,
        kind: win.kind,
        name: callName(win),
        source: signals.api === true ? 'api' : 'local',
        startedAt: t,
        recording: false,
        stopped: false,
        manual: false,
      };
      goneSince = null;
      if (isRecording()) call.manual = true;
      else if (enabled()) { call.recording = true; onStart(call); }
      return call;
    }
    if (inCall) {
      goneSince = null;
      if (win && win.kind !== 'unknown' && call.kind === 'unknown') Object.assign(call, { title: win.title, kind: win.kind, name: callName(win) });
      return call;
    }
    if (goneSince == null) goneSince = t;
    if (t - goneSince < endDebounceMs) return call;
    const ended = { ...call, endedAt: goneSince };
    call = null;
    goneSince = null;
    if (ended.recording) onEnd(ended);
    return null;
  }

  return {
    tick,
    get call() { return call; },
    /// The user pressed Stop (or Discard): stay stopped until this call ends.
    userStopped() { if (call) Object.assign(call, { recording: false, stopped: true }); },
  };
}

/// Polls `read()` (async, returns signals) every 2 s into a detector.
function startPolling(detector, read, { intervalMs = POLL_MS, onError = () => {} } = {}) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { detector.tick(await read()); } catch (e) { onError(e); } finally { busy = false; }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { createTeamsDetector, startPolling, findCallWindow, END_DEBOUNCE_MS, POLL_MS };
