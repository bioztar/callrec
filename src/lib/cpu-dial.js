'use strict';

// "Finalising speed": how much of the CPU the final pass may use. The tray
// picks a level; starting a recording drops it to BUSY_LEVEL so the live draft
// keeps up, and Stop returns to the level chosen while idle.

const os = require('os');

const LEVELS = [20, 40, 60, 80, 100];
const DEFAULT_LEVEL = 100;
const BUSY_LEVEL = 20;

function cores() { return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length; }

function validLevel(pct) { return LEVELS.includes(Number(pct)) ? Number(pct) : DEFAULT_LEVEL; }

/// Level (%) → final-pass threads on an n-core machine.
function threadsFor(pct, n = cores()) { return Math.max(1, Math.round((validLevel(pct) / 100) * n)); }

/// Idle choice is persisted; a pick during a recording applies now but is not
/// kept (Stop restores the idle choice).
function createCpuDial({ level = DEFAULT_LEVEL, persist = () => {}, onChange = () => {} } = {}) {
  let idle = validLevel(level);
  let recording = false;
  let during = null; // level for the running recording
  const effective = () => (recording ? during : idle);
  const update = (fn) => {
    const before = effective();
    fn();
    if (effective() !== before) onChange(effective());
  };
  return {
    get level() { return effective(); },
    get idleLevel() { return idle; },
    get recording() { return recording; },
    threads(n) { return threadsFor(effective(), n); },
    pick(pct) {
      const p = validLevel(pct);
      update(() => {
        if (recording) during = p;
        else { idle = p; persist(p); }
      });
    },
    recordingStarted() { update(() => { if (!recording) { recording = true; during = Math.min(BUSY_LEVEL, idle); } }); },
    recordingStopped() { update(() => { recording = false; during = null; }); },
  };
}

module.exports = { LEVELS, DEFAULT_LEVEL, BUSY_LEVEL, cores, threadsFor, validLevel, createCpuDial };
