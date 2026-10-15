'use strict';

// Word error rate for the model benchmark: (substitutions + deletions +
// insertions) / reference words, after case, accent and punctuation folding.

const words = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\p{L}\p{N}' ]/gu, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean);

function wer(reference, hypothesis) {
  const r = words(reference);
  const h = words(hypothesis);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= h.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[h.length] / r.length;
}

module.exports = { wer, words };
