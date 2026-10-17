'use strict';

// One recording's start and end, as seen by the "Finalising speed" dial: every
// way a recording ends (Stop, Quit, Windows session end, a quit with the
// renderer gone) goes through end(), which tells the dial exactly once, even
// when closing the files throws. Otherwise the final pass could stay at the
// recording-time 20 % forever.

function createRecordingLifecycle({ dial }) {
  let active = null;
  return {
    get active() { return active; },
    /// `rec` is whatever the caller keeps for the open recording (the writer).
    start(rec) {
      if (active) return false;
      active = rec;
      dial.recordingStarted();
      return true;
    },
    /// Runs `close(rec)` for the open recording (if any) and returns its result;
    /// null when nothing was recording (a second end is a no-op).
    end(close) {
      if (!active) return null;
      const rec = active;
      active = null;
      try {
        return close(rec);
      } finally {
        dial.recordingStopped();
      }
    },
  };
}

module.exports = { createRecordingLifecycle };
