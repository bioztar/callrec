'use strict';

// getDisplayMedia() grant for system-audio capture: the first screen plus
// `audio: 'loopback'` (CoreAudio tap on macOS, WASAPI loopback on Windows),
// so no virtual audio driver is needed. The renderer stops the video track.

/// Returns a handler for session.setDisplayMediaRequestHandler.
/// `getSources` is desktopCapturer.getSources (injected for tests).
function createDisplayMediaHandler(getSources) {
  return (_request, callback) => {
    let answered = false;
    const answer = (grant) => { if (!answered) { answered = true; callback(grant); } }; // a second call throws
    let pending;
    try { pending = Promise.resolve(getSources({ types: ['screen'] })); } catch { pending = Promise.resolve([]); }
    pending
      // No screen source = no Screen Recording permission (or locked display): deny cleanly.
      .then((sources) => (sources && sources[0] ? { video: sources[0], audio: 'loopback' } : {}), () => ({}))
      .then(answer);
  };
}

module.exports = { createDisplayMediaHandler };
