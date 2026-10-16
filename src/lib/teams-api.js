'use strict';

// Optional Teams third-party app API (new Teams: Settings → Privacy → Manage API).
// A local WebSocket on 127.0.0.1:8124 that reports whether you are in a meeting
// (no names). Used silently when available; any failure just means "not connected"
// and the detector falls back to local signals. Nothing leaves the PC.

const URL_BASE = 'ws://127.0.0.1:8124';
const RETRY_MS = 30000;

function apiUrl(token, version) {
  const q = new URLSearchParams({
    'protocol-version': '2.0.0', manufacturer: 'callrec', device: 'PC', app: 'callrec', 'app-version': version || '0',
  });
  if (token) q.set('token', token);
  return `${URL_BASE}?${q}`;
}

/// state(): true (in a meeting) / false (connected, not in a meeting) / null (no API).
function createTeamsApi({ getToken = () => '', saveToken = () => {}, version, WebSocket = null, log = () => {}, retryMs = RETRY_MS, setTimer = setTimeout } = {}) {
  let ws = null;
  let inMeeting = null;
  let stopped = false;
  let pairAsked = false;
  let reqId = 0;
  let runToken = ''; // kept for this run even when safeStorage cannot store it
  const token = () => getToken() || runToken;

  function handle(msg) {
    if (msg && typeof msg.tokenRefresh === 'string' && msg.tokenRefresh) { runToken = msg.tokenRefresh; saveToken(runToken); log('teams api: paired'); }
    const upd = msg && msg.meetingUpdate;
    if (!upd || !upd.meetingState) return;
    inMeeting = Boolean(upd.meetingState.isInMeeting);
    // First meeting without a token: ask Teams once for pairing (a prompt inside Teams).
    const canPair = upd.meetingPermissions ? upd.meetingPermissions.canPair !== false : true;
    if (inMeeting && !token() && canPair && !pairAsked && ws) {
      pairAsked = true;
      reqId += 1;
      try { ws.send(JSON.stringify({ action: 'pair', parameters: {}, requestId: reqId })); } catch { /* ignore */ }
    }
  }

  function connect() {
    if (stopped) return;
    const WS = WebSocket || require('ws');
    let sock;
    try { sock = new WS(apiUrl(token(), version)); } catch { return retry(); }
    ws = sock;
    const onMessage = (data) => { try { handle(JSON.parse(String(data && data.data !== undefined ? data.data : data))); } catch { /* not JSON */ } };
    const onClose = () => { if (ws === sock) { ws = null; inMeeting = null; retry(); } };
    if (sock.on) {
      sock.on('message', onMessage);
      sock.on('close', onClose);
      sock.on('error', () => {});
    } else {
      sock.onmessage = onMessage; sock.onclose = onClose; sock.onerror = () => {};
    }
  }

  function retry() {
    if (stopped) return;
    const t = setTimer(connect, retryMs);
    if (t && t.unref) t.unref();
  }

  return {
    start() { stopped = false; connect(); },
    stop() { stopped = true; if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; } inMeeting = null; },
    state() { return ws ? inMeeting : null; },
    _handle: handle,
  };
}

module.exports = { createTeamsApi, apiUrl };
