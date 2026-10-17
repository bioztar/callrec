'use strict';

// Time left in the final pass, from the throughput measured so far in this pass
// (speech seconds decoded per wall second). Null until there is enough to go on.

function etaSec({ done, total, elapsedSec, minElapsedSec = 10, minDone = 0.03 }) {
  if (!(total > 0) || !(elapsedSec >= minElapsedSec) || !(done / total >= minDone)) return null;
  return Math.max(0, ((total - done) * elapsedSec) / done);
}

/// "~25 min left", "~1 h 10 min left", "<1 min left".
function etaText(sec) {
  if (sec == null) return '';
  const min = Math.round(sec / 60);
  if (min < 1) return '<1 min left';
  if (min < 60) return `~${min} min left`;
  const h = Math.floor(min / 60); const m = min % 60;
  return `~${h} h${m ? ` ${m} min` : ''} left`;
}

module.exports = { etaSec, etaText };
