// SPDX-FileCopyrightText: 2026 1932819331hy-debug
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSchedule, checkSchedule } from '../src/index.js';

const base = { startBlock: 0, currentBlock: 100, startTimestamp: 0,
  currentTimestamp: 100, periodBlocks: 10, periods: 20,
  designSecondsPerBlock: 1, observedSecondsPerBlock: 1 };

for (const field of ['startBlock', 'currentBlock', 'periodBlocks', 'periods']) {
  test(`rejects unsafe integer ${field} instead of a rounded schedule`, () => {
    const input = { ...base, [field]: 9007199254740992 };
    if (field === 'startBlock') input.currentBlock = input.startBlock;
    assert.throws(() => projectSchedule(input), RangeError);
  });
}
test('rejects unsafe product of individually safe block counts', () => {
  assert.throws(() => projectSchedule({ ...base, periodBlocks: 9007199254740991, periods: 3 }), RangeError);
});
test('rejects unsafe end block even when total blocks is safe', () => {
  assert.throws(() => projectSchedule({ ...base, startBlock: 9007199254740990,
    currentBlock: 9007199254740990, periodBlocks: 1, periods: 3 }), RangeError);
});
test('preserves the largest exactly supported end block', () => {
  const r = projectSchedule({ ...base, startBlock: 9007199254740990,
    currentBlock: 9007199254740990, periodBlocks: 1, periods: 1 });
  assert.equal(r.endBlock, 9007199254740991);
  assert.equal(r.blocksRemaining, 1);
  assert.equal(r.complete, false);
});
test('checkSchedule rejects unrepresentable schedules before sending an RPC', async () => {
  for (const change of [{ startBlock: 9007199254740992 },
    { periodBlocks: 9007199254740992 }, { periods: 9007199254740992 },
    { periodBlocks: 9007199254740991, periods: 3 },
    { startBlock: 9007199254740990, periodBlocks: 1, periods: 3 }]) {
    let requests = 0;
    const rpc = { retries: 0, fetchImpl: async () => { requests++; throw new Error('network forbidden'); } };
    await assert.rejects(() => checkSchedule({ ...base, ...change,
      rpcUrl: 'https://example.invalid', rpc }), RangeError);
    assert.equal(requests, 0);
  }
});
