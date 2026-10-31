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
test('preserves individually safe period counts at the supported limit', () => {
  for (const change of [
    { periodBlocks: Number.MAX_SAFE_INTEGER, periods: 1 },
    { periodBlocks: 1, periods: Number.MAX_SAFE_INTEGER },
  ]) {
    const r = projectSchedule({ ...base, ...change, currentBlock: Number.MAX_SAFE_INTEGER });
    assert.equal(r.endBlock, Number.MAX_SAFE_INTEGER);
    assert.equal(r.blocksRemaining, 0);
    assert.equal(r.complete, true);
    assert.equal(r.periodsElapsed, change.periods);
  }
});
test('checkSchedule accepts the safe end-block boundary and requests exact block tags', async () => {
  const head = Number.MAX_SAFE_INTEGER;
  const requested = [];
  const rpc = { retries: 0, fetchImpl: async (_url, init) => {
    const { params: [tag] } = JSON.parse(init.body);
    requested.push(tag);
    const block = tag === 'latest' ? head : Number(BigInt(tag));
    return { ok: true, json: async () => ({ result: {
      number: '0x' + block.toString(16),
      timestamp: '0x' + (100 + (block - head)).toString(16),
    } }) };
  } };
  const r = await checkSchedule({
    rpcUrl: 'https://example.invalid', rpc, startBlock: head - 1,
    periodBlocks: 1, periods: 1, designSecondsPerBlock: 1, sampleBlocks: 1,
  });
  assert.equal(r.endBlock, head);
  assert.equal(r.complete, true);
  assert.equal(r.projectedEnd, 100);
  assert.deepEqual(requested, ['latest', '0x1ffffffffffffe', '0x1ffffffffffffe', '0x1fffffffffffff']);
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
