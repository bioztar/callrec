'use strict';

// Feeds overlapping / back-dated buffers through the helper's MonotonicClip and
// asserts nothing it would submit to SpeechAnalyzer overlaps or goes backwards
// (the SFSpeechErrorDomain 2 "timestamp overlaps or precedes" bug).

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { helperPath } = require('../src/native-stt');

const bin = helperPath();

test('helper clips overlapping audio timestamps to a monotonic sequence', { skip: !bin && 'helper not built' }, () => {
  const out = execFileSync(bin, ['--check-monotonic'], { encoding: 'utf8', timeout: 20000 });
  const { accepted } = JSON.parse(out.split('\n').find((l) => l.startsWith('{')));
  assert.ok(accepted.length >= 4);
  let prevEnd = 0;
  for (const r of accepted) {
    assert.ok(r.start >= prevEnd - 1e-9, `start ${r.start} precedes previous end ${prevEnd}`);
    assert.ok(r.end > r.start);
    prevEnd = r.end;
  }
  // 0.0-0.1, 0.1-0.2, (0.05-0.15 and 0.0-0.05 dropped), 0.5-0.6, 0.6-0.65 trimmed, 0.7-0.8
  assert.equal(accepted.length, 5);
  assert.ok(Math.abs(accepted[3].start - 0.6) < 1e-6);
});
