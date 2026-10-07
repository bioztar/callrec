'use strict';

// Echo dedupe: with speakers, the mic ("Me") re-hears the system audio ("Them").
// A Me segment is an echo when a Them segment overlapping it in time (±windowSec)
// has high text similarity. Pure functions, shared by the renderer (script tag)
// and the node tests (require).

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

/// Shared-token ratio over the shorter side, 0..1 (a clipped echo still matches).
function similarity(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => { if (B.has(w)) inter += 1; });
  return inter / Math.min(A.size, B.size);
}

/// seg = { start, end, text } in seconds. True when `me` echoes any of `thems`.
function isEcho(me, thems, { windowSec = 2, threshold = 0.6 } = {}) {
  return thems.some((t) => me.start - windowSec <= t.end && t.start <= me.end + windowSec
    && similarity(me.text, t.text) >= threshold);
}

// Wrapped: this is also a classic <script>, where top-level consts are shared
// with app.js (a bare `const api` here broke the whole renderer).
(function exportEcho() {
  const exported = { norm, similarity, isEcho };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else globalThis.Echo = exported;
}());
