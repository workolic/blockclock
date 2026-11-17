// SPDX-FileCopyrightText: 2026 1932819331hy-debug
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSchedule, checkSchedule } from '../src/index.js';

const startTimestamp = 1_700_000_000;
const startBlock = 1_000_000;
const schedule = {
  startBlock, startTimestamp, periodBlocks: 1003, periods: 10,
  designSecondsPerBlock: 0.2, observedSecondsPerBlock: 0.2,
  currentBlock: startBlock + 5015, currentTimestamp: startTimestamp + 1003,
};

// The immediately preceding representable timestamp, not an arbitrary epsilon.
function previousNumber(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) - 1n);
  return view.getFloat64(0);
}

for (const { rate, blocks, seconds } of [
  { rate: 0.2, blocks: 1003, seconds: 1003 }, // 5015 blocks at 200 ms
  { rate: 0.45, blocks: 2628, seconds: 5913 }, // 13140 blocks at 450 ms
  { rate: 1.1, blocks: 100, seconds: 550 }, // 500 blocks at 1100 ms
]) {
  test(`counts five periods exactly on the ${rate}s design-clock boundary`, () => {
    const r = projectSchedule({ ...schedule, periodBlocks: blocks,
      designSecondsPerBlock: rate, observedSecondsPerBlock: rate,
      currentBlock: startBlock + blocks * 5, currentTimestamp: startTimestamp + seconds });
    assert.equal(r.periodsExpectedByNow, 5);
    assert.equal(r.periodsExpectedUncapped, 5);
    assert.equal(r.periodsElapsed, 5);
    assert.equal(r.periodsAhead, 0);
    assert.equal(r.pace, 'on plan');
    assert.equal(r.driftPercent, 0);
  });

  test(`does not count the ${rate}s boundary before its timestamp`, () => {
    const deadline = startTimestamp + seconds;
    for (const currentTimestamp of [deadline - 1, previousNumber(deadline)]) {
      const r = projectSchedule({ ...schedule, periodBlocks: blocks,
        designSecondsPerBlock: rate, currentTimestamp });
      assert.equal(r.periodsExpectedUncapped, 4);
      assert.equal(r.periodsExpectedByNow, 4);
    }
  });
}

test('fractional UNIX timestamps obey the same deadline without early rounding', () => {
  const start = startTimestamp + 0.25;
  const deadline = start + 1003;
  for (const [currentTimestamp, expected] of [[previousNumber(deadline), 4], [deadline, 5]]) {
    const r = projectSchedule({ ...schedule, startTimestamp: start, currentTimestamp });
    assert.equal(r.periodsExpectedUncapped, expected);
  }
});

test('a genesis-origin clock uses total blocks at the five-period deadline', () => {
  for (const [currentTimestamp, expected] of [[previousNumber(1003), 4], [1003, 5]]) {
    const r = projectSchedule({ ...schedule, startBlock: 0, currentBlock: 5015,
      startTimestamp: 0, currentTimestamp });
    assert.equal(r.periodsExpectedUncapped, expected);
  }
});

test('uncapped design counts survive completion and remain independent of actual pace', () => {
  const complete = projectSchedule({ ...schedule, periods: 3 });
  assert.equal(complete.periodsExpectedByNow, 3);
  assert.equal(complete.periodsExpectedUncapped, 5);
  assert.equal(complete.periodsAhead, 0);
  assert.equal(complete.complete, true);

  const slower = projectSchedule({ ...schedule, currentTimestamp: startTimestamp + 2006,
    observedSecondsPerBlock: 0.4 });
  assert.equal(slower.periodsExpectedByNow, 10);
  assert.equal(slower.periodsElapsed, 5);
  assert.equal(slower.periodsAhead, -5);
  assert.equal(slower.driftPercent, -100);
  assert.equal(slower.pace, 'slower');
});

test('checkSchedule preserves expected counts through actual block-header parsing', async () => {
  const url = 'https://schedule-fixture.invalid';
  const headers = new Map([
    ['latest', { number: startBlock + 5015, timestamp: startTimestamp + 1003 }],
    ['0xf4240', { number: startBlock, timestamp: startTimestamp }],
  ]);
  const requested = [];
  const rpc = { retries: 0, fetchImpl: async (requestUrl, init) => {
    assert.equal(requestUrl, url);
    const { method, params: [tag, full] } = JSON.parse(init.body);
    assert.equal(method, 'eth_getBlockByNumber');
    assert.equal(full, false);
    requested.push(tag);
    const header = headers.get(tag);
    assert.ok(header, `unknown fixture tag ${tag}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
      number: '0x' + header.number.toString(16), timestamp: '0x' + header.timestamp.toString(16),
    } }));
  } };
  const r = await checkSchedule({ rpcUrl: url, rpc, startBlock, periodBlocks: 1003,
    periods: 10, designSecondsPerBlock: 0.2, sampleBlocks: 5015 });
  assert.deepEqual(requested, ['latest', '0xf4240', '0xf4240']);
  assert.equal(r.observedSecondsPerBlock, 0.2);
  assert.equal(r.driftPercent, 0);
  assert.equal(r.pace, 'on plan');
  assert.equal(r.periodsExpectedByNow, 5);
  assert.equal(r.periodsElapsed, 5);
  assert.equal(r.periodsAhead, 0);
});
