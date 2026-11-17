// SPDX-FileCopyrightText: 2026 1932819331hy-debug
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSchedule } from '../src/index.js';

function adjacentPositiveNumber(value, direction) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + BigInt(direction));
  return view.getFloat64(0);
}

const schedule = {
  startBlock: 1_000_000, currentBlock: 1_000_300,
  periodBlocks: 3, periods: 100,
  designSecondsPerBlock: 0.15, observedSecondsPerBlock: 0.15,
};

// 300 blocks at 150 ms take exactly 45 seconds. Each literal deadline below
// also equals the public report's intendedEnd; no new rounding rule is used.
for (const [startTimestamp, deadline] of [[0, 45], [0.25, 45.25], [1, 46]]) {
  for (const [label, currentTimestamp, expected] of [
    ['before', adjacentPositiveNumber(deadline, -1), 99],
    ['at', deadline, 100],
    ['after', adjacentPositiveNumber(deadline, 1), 100],
  ]) {
    test(`${label} the ${deadline}s deadline from a ${startTimestamp}s origin`, () => {
      const r = projectSchedule({ ...schedule, startTimestamp, currentTimestamp });
      assert.equal(r.intendedEnd, deadline);
      assert.equal(r.periodsElapsedUncapped, 100);
      assert.equal(r.periodsExpectedUncapped, expected);
      assert.equal(r.periodsExpectedByNow, expected);
      assert.equal(r.periodsAhead, 100 - expected);
      assert.equal(r.pace, 'on plan');
      assert.equal(r.driftPercent, 0);
      assert.equal(r.complete, true);
    });
  }
}

test('an unfinished design period remains excluded after the block schedule completes', () => {
  const r = projectSchedule({ ...schedule, periods: 50, startTimestamp: 1,
    currentTimestamp: adjacentPositiveNumber(46, -1) });
  assert.equal(r.periodsExpectedUncapped, 99);
  assert.equal(r.periodsExpectedByNow, 50);
  assert.equal(r.periodsElapsed, 50);
  assert.equal(r.periodsAhead, 1);
  assert.equal(r.complete, true);
});

test('zero elapsed time never produces a negative design count', () => {
  for (const startTimestamp of [0, 0.25, 1, 1_700_000_000]) {
    const r = projectSchedule({ ...schedule, startTimestamp,
      currentTimestamp: startTimestamp, currentBlock: schedule.startBlock });
    assert.equal(r.periodsExpectedUncapped, 0);
    assert.equal(r.periodsExpectedByNow, 0);
    assert.equal(r.periodsAhead, 0);
    assert.equal(r.realisedSecondsPerBlock, null);
    assert.equal(r.complete, false);
  }
});

test('the timestamp before the start is still rejected', () => {
  assert.throws(() => projectSchedule({ ...schedule, startTimestamp: 1,
    currentTimestamp: adjacentPositiveNumber(1, -1) }), /before startTimestamp/);
});
