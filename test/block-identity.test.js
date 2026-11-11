// SPDX-FileCopyrightText: 2026 1932819331hy-debug
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import { getBlock, measureBlockTime, checkSchedule, RpcShapeError, BlockNotFoundError } from '../src/index.js';

const url = 'https://block-identity.invalid';
const header = (number, timestamp) => ({
  number: '0x' + number.toString(16), timestamp: '0x' + timestamp.toString(16),
});

// Only the HTTP transport is synthetic; the real RPC client decodes the JSON
// and the public functions parse and use the returned header.
function nodeFor(resultFor) {
  let calls = 0;
  return {
    get calls() { return calls; },
    rpc: { retries: 1, fetchImpl: async (requestUrl, init) => {
      assert.equal(requestUrl, url);
      assert.equal(init.method, 'POST');
      const request = JSON.parse(init.body);
      assert.equal(request.method, 'eth_getBlockByNumber');
      assert.equal(request.params[1], false);
      calls++;
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: resultFor(request.params[0]),
      }));
    } },
  };
}

function isShapeError(error) {
  assert.ok(error instanceof RpcShapeError, `${error.name}: ${error.message}`);
  assert.equal(error.url, url);
  assert.equal(error.method, 'eth_getBlockByNumber');
  return true;
}

for (const [requested, returned] of [[100, 101], ['0x64', 101], [0, 1]]) {
  test(`getBlock rejects block ${returned} when ${requested} was requested`, async () => {
    const node = nodeFor(() => header(returned, 10000));
    await assert.rejects(() => getBlock(url, requested, node.rpc), isShapeError);
    assert.equal(node.calls, 1, 'a mismatched header must not be retried');
  });
}

for (const [requested, returned] of [
  [0, 0], ['0x0', 0], [100, 100], ['0xAB', 171],
  ['earliest', 0], ['latest', 171], ['safe', 171], ['finalized', 171],
  [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
]) {
  test(`getBlock preserves a valid ${requested} response`, async () => {
    const node = nodeFor(() => header(returned, 10000));
    assert.deepEqual(await getBlock(url, requested, node.rpc), { number: returned, timestamp: 10000 });
    assert.equal(node.calls, 1);
  });
}

test('a missing numbered block remains BlockNotFoundError', async () => {
  const node = nodeFor(() => null);
  await assert.rejects(() => getBlock(url, 100, node.rpc), BlockNotFoundError);
  assert.equal(node.calls, 1);
});

// A correct fixture has one-second blocks and head 1000. Wrong replies remain
// monotonic, so monotonicity alone cannot catch selecting the wrong header.
function chain(wrongTag) {
  return nodeFor((tag) => {
    const n = tag === 'latest' ? 1000 : Number(BigInt(tag));
    const returned = tag === wrongTag ? n + 1 : n;
    return header(returned, 10000 + returned);
  });
}

test('measureBlockTime rejects a different block at the sample boundary', async () => {
  const node = chain('0x384'); // asked for 900, received 901
  await assert.rejects(() => measureBlockTime(url, {
    sampleBlocks: 100, rpc: node.rpc,
  }), isShapeError);
});

const schedule = {
  rpcUrl: url, startBlock: 100, periodBlocks: 100, periods: 2,
  designSecondsPerBlock: 1, sampleBlocks: 100,
};

for (const [role, tag] of [['start', '0x64'], ['end', '0x12c']]) {
  test(`checkSchedule rejects a different ${role} block instead of reporting its timestamp`, async () => {
    const node = chain(tag);
    await assert.rejects(() => checkSchedule({ ...schedule, rpc: node.rpc }), isShapeError);
  });
}

test('checkSchedule still reports the actual finish for matching headers', async () => {
  const node = chain();
  const report = await checkSchedule({ ...schedule, rpc: node.rpc });
  assert.equal(report.startTimestamp, 10100);
  assert.equal(report.currentBlock, 1000);
  assert.equal(report.observedSecondsPerBlock, 1);
  assert.equal(report.sample.fromBlock, 900);
  assert.equal(report.sample.toBlock, 1000);
  assert.equal(report.projectedEnd, 10300);
  assert.equal(report.complete, true);
  assert.equal(report.projectedEndIsEstimate, false);
  assert.equal(report.driftPercent, 0);
});
