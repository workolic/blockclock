import test from 'node:test';
import assert from 'node:assert/strict';

import {
  projectSchedule,
  measureBlockTime,
  checkSchedule,
  humanDuration,
  isoDate,
  isoDateTime,
} from '../src/index.js';

const DAY = 86400;
const START_TS = 1648857600; // 2022-04-02T00:00:00Z
const START_BLOCK = 16_579_822; // the first BSC block at or after that instant

/**
 * The Lucrar schedule: 80 periods of 2,628,000 blocks, written for 3s blocks.
 * Defaults put it 42 periods in, with the chain now at 0.45s.
 */
const lucrar = (overrides = {}) => ({
  startBlock: START_BLOCK,
  startTimestamp: START_TS,
  periodBlocks: 2_628_000,
  periods: 80,
  designSecondsPerBlock: 3,
  currentBlock: START_BLOCK + 42 * 2_628_000,
  currentTimestamp: START_TS + 1650 * DAY,
  observedSecondsPerBlock: 0.45,
  ...overrides,
});

test('a chain holding its design block time shows no drift', () => {
  const r = projectSchedule({
    startBlock: 1_000_000,
    startTimestamp: START_TS,
    periodBlocks: 100_000,
    periods: 10,
    designSecondsPerBlock: 3,
    currentBlock: 1_300_000,
    currentTimestamp: START_TS + 300_000 * 3,
    observedSecondsPerBlock: 3,
  });

  assert.equal(r.paceFactor, 1);
  assert.equal(r.driftPercent, 0);
  assert.equal(r.earlyBySeconds, 0);
  assert.equal(r.periodsElapsed, 3);
  assert.equal(r.periodsExpectedByNow, 3);
  assert.equal(r.periodsAhead, 0);
  assert.equal(r.endBlock, 2_000_000);
  assert.equal(r.intendedEnd, START_TS + 1_000_000 * 3);
  assert.equal(r.projectedEnd, r.intendedEnd);
});

test('the Lucrar case: exact numbers, not just "big"', () => {
  const r = projectSchedule(lucrar());

  // 3s designed against 0.45s observed is exactly 6.666... times faster.
  assert.equal(r.pace, 'faster');
  assert.ok(Math.abs(r.paceFactor - 3 / 0.45) < 1e-12);
  assert.ok(Math.abs(r.driftPercent - (3 / 0.45 - 1) * 100) < 1e-9);

  // A "quarter" of 2,628,000 blocks: 91.25 days as designed, 13.6875 as run.
  assert.equal(r.intendedPeriodSeconds, 7_884_000);
  assert.equal(r.intendedPeriodSeconds / DAY, 91.25);
  assert.equal(r.effectivePeriodSeconds / DAY, 13.6875);

  // 80 periods x 2,628,000 blocks x 3s = exactly 7300 days.
  assert.equal(r.intendedEnd, START_TS + 7300 * DAY);
  assert.equal(isoDate(r.intendedEnd), '2042-03-28');

  // The headline: periods have gone by far faster than the design clock.
  assert.equal(r.periodsElapsed, 42);
  assert.equal(r.periodsExpectedByNow, Math.floor((1650 * DAY) / 7_884_000)); // 18
  assert.equal(r.periodsExpectedByNow, 18);
  assert.equal(r.periodsAhead, 24);

  assert.equal(r.blocksRemaining, 38 * 2_628_000);
});

test('projected end is now plus the remaining blocks at the current pace', () => {
  const r = projectSchedule(lucrar());
  const now = START_TS + 1650 * DAY;
  const remaining = (80 - 42) * 2_628_000;

  assert.equal(r.projectedEnd, now + remaining * 0.45);
  assert.equal(r.earlyBySeconds, Math.round(r.intendedEnd - (now + remaining * 0.45)));
  assert.ok(r.earlyBySeconds > 0, 'ends earlier than intended');
  assert.equal(r.projectedEndIsEstimate, false);
});

test('a slower chain pushes the end out, and drift is symmetric', () => {
  const r = projectSchedule({
    startBlock: 1_000_000,
    startTimestamp: START_TS,
    periodBlocks: 100_000,
    periods: 10,
    designSecondsPerBlock: 3,
    currentBlock: 1_100_000,
    currentTimestamp: START_TS + 100_000 * 6,
    observedSecondsPerBlock: 6,
  });

  // Twice as slow must read as -100%, not -50%: |drift| has to be a usable gate.
  assert.equal(r.driftPercent, -100);
  assert.equal(r.paceFactor, 2);
  assert.equal(r.pace, 'slower');
  assert.ok(r.earlyBySeconds < 0, 'ends later than intended');
  assert.equal(r.periodsElapsed, 1);
  assert.equal(r.periodsExpectedByNow, 2);
  assert.equal(r.periodsAhead, -1);
});

test('an extreme slowdown is not flattened towards -100%', () => {
  const base = {
    startBlock: 1_000_000,
    startTimestamp: START_TS,
    periodBlocks: 100_000,
    periods: 10,
    designSecondsPerBlock: 3,
    currentBlock: 1_100_000,
    currentTimestamp: START_TS + 100_000 * 300,
  };
  const mild = projectSchedule({ ...base, observedSecondsPerBlock: 30 });
  const severe = projectSchedule({ ...base, observedSecondsPerBlock: 3000 });

  assert.equal(mild.driftPercent, -900);
  assert.equal(severe.driftPercent, -99900);
  // Both must trip a 100% gate; the old (f-1)*100 form could never exceed -100.
  assert.ok(Math.abs(mild.driftPercent) > 100);
  assert.ok(Math.abs(severe.driftPercent) > 100);
});

test('a finished schedule reports when it actually finished, early', () => {
  // A chain that has run at a steady 1s/block since the schedule started.
  const now = START_TS + (9_000_000 - 1_000_000) * 1;
  const r = projectSchedule({
    startBlock: 1_000_000,
    startTimestamp: START_TS,
    periodBlocks: 100_000,
    periods: 2,            // ends at block 1,200,000
    designSecondsPerBlock: 3,
    currentBlock: 9_000_000,
    currentTimestamp: now,
    observedSecondsPerBlock: 1,
  });

  assert.equal(r.complete, true);
  assert.equal(r.blocksRemaining, 0);
  assert.equal(r.endBlock, 1_200_000);

  // Walked back from now at 1s/block: the end block is long past.
  assert.equal(r.projectedEnd, now - (9_000_000 - 1_200_000) * 1);
  assert.equal(r.projectedEndIsEstimate, true);
  assert.ok(r.earlyBySeconds > 0, 'a 3x-fast chain finished the schedule EARLY');

  // The drift signal must survive the schedule ending.
  assert.equal(r.periodsElapsed, 2);
  assert.equal(r.periodsElapsedUncapped, 80);
  assert.ok(r.periodsAhead > 0);
});

test('a measured end-block timestamp beats the estimate', () => {
  const now = START_TS + 500 * DAY;
  const measured = START_TS + 200_000;
  const r = projectSchedule({
    startBlock: 1_000_000,
    startTimestamp: START_TS,
    periodBlocks: 100_000,
    periods: 2,
    designSecondsPerBlock: 3,
    currentBlock: 9_000_000,
    currentTimestamp: now,
    observedSecondsPerBlock: 1,
    endBlockTimestamp: measured,
  });

  assert.equal(r.projectedEnd, measured);
  assert.equal(r.projectedEndIsEstimate, false);
  assert.equal(r.earlyBySeconds, r.intendedEnd - measured);
});

test('a genesis-anchored schedule is allowed', () => {
  const r = projectSchedule({
    startBlock: 0,
    startTimestamp: 0,
    periodBlocks: 100,
    periods: 10,
    designSecondsPerBlock: 3,
    currentBlock: 500,
    currentTimestamp: 1500,
    observedSecondsPerBlock: 3,
  });
  assert.equal(r.periodsElapsed, 5);
  assert.equal(r.driftPercent, 0);
});

test('realised block time is null before any block has elapsed', () => {
  const r = projectSchedule(lucrar({
    currentBlock: START_BLOCK,
    currentTimestamp: START_TS,
  }));
  assert.equal(r.realisedSecondsPerBlock, null);
  assert.equal(r.periodsElapsed, 0);
});

test('rejects nonsense instead of returning a confident wrong answer', () => {
  assert.throws(() => projectSchedule(lucrar({ periodBlocks: 0 })), RangeError);
  assert.throws(() => projectSchedule(lucrar({ periodBlocks: 2_628_000.5 })), /positive integer/);
  assert.throws(() => projectSchedule(lucrar({ periods: 80.5 })), /positive integer/);
  assert.throws(() => projectSchedule(lucrar({ startBlock: 1.5 })), /non-negative integer/);
  assert.throws(() => projectSchedule(lucrar({ observedSecondsPerBlock: -1 })), RangeError);
  assert.throws(() => projectSchedule(lucrar({ designSecondsPerBlock: NaN })), RangeError);
  assert.throws(() => projectSchedule(lucrar({ currentBlock: 1 })), /has not started/);
  assert.throws(
    () => projectSchedule(lucrar({ currentTimestamp: START_TS - 1 })),
    /before startTimestamp/,
  );
});

// --- RPC-backed paths, against a fake node ------------------------------

/** A node where block N has timestamp N * secondsPerBlock. */
function fakeNode({ head, secondsPerBlock = 2 }) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push(method + (params?.[0] ? ':' + params[0] : ''));
    if (method === 'eth_blockNumber') {
      return { ok: true, json: async () => ({ result: '0x' + head.toString(16) }) };
    }
    const n = params[0] === 'latest' ? head : Number(BigInt(params[0]));
    if (n > head) return { ok: true, json: async () => ({ result: null }) };
    return {
      ok: true,
      json: async () => ({
        result: {
          number: '0x' + n.toString(16),
          timestamp: '0x' + Math.round(n * secondsPerBlock).toString(16),
        },
      }),
    };
  };
  return { fetchImpl, calls, rpc: { fetchImpl, retries: 0 } };
}

test('measureBlockTime averages over the sampled span', async () => {
  const node = fakeNode({ head: 200_000, secondsPerBlock: 2 });
  const s = await measureBlockTime('http://example.invalid', {
    sampleBlocks: 100_000,
    rpc: node.rpc,
  });

  assert.equal(s.secondsPerBlock, 2);
  assert.equal(s.fromBlock, 100_000);
  assert.equal(s.toBlock, 200_000);
  assert.equal(s.spanBlocks, 100_000);
  assert.equal(s.spanSeconds, 200_000);
  assert.equal(s.clamped, false);
});

test('an oversized sample is clamped to block 1, not genesis, and says so', async () => {
  const node = fakeNode({ head: 50, secondsPerBlock: 3 });
  const s = await measureBlockTime('http://example.invalid', {
    sampleBlocks: 100_000,
    rpc: node.rpc,
  });

  // Block 0 often carries a placeholder timestamp months before block 1.
  assert.equal(s.fromBlock, 1);
  assert.equal(s.toBlock, 50);
  assert.equal(s.clamped, true, 'the caller must be able to tell it did not get what it asked for');
});

test('a synthetic genesis timestamp cannot poison a clamped average', async () => {
  // Block 0 at t=0, then real blocks every 2s starting 130 days later.
  const offset = 130 * DAY;
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === 'eth_blockNumber') return { ok: true, json: async () => ({ result: '0x64' }) };
    const n = params[0] === 'latest' ? 100 : Number(BigInt(params[0]));
    const ts = n === 0 ? 0 : offset + n * 2;
    return {
      ok: true,
      json: async () => ({ result: { number: '0x' + n.toString(16), timestamp: '0x' + ts.toString(16) } }),
    };
  };

  const s = await measureBlockTime('http://example.invalid', {
    sampleBlocks: 1_000_000,
    rpc: { fetchImpl, retries: 0 },
  });

  assert.equal(s.fromBlock, 1);
  assert.equal(s.secondsPerBlock, 2, 'genesis must not be averaged in');
});

test('a window too short for one-second timestamps is refused, and blames the window', async () => {
  // A sub-second chain: 3 blocks inside the same second.
  const fetchImpl = async (_url, init) => {
    const { params, method } = JSON.parse(init.body);
    if (method === 'eth_blockNumber') return { ok: true, json: async () => ({ result: '0x3e8' }) };
    const n = params[0] === 'latest' ? 1000 : Number(BigInt(params[0]));
    return {
      ok: true,
      json: async () => ({
        result: { number: '0x' + n.toString(16), timestamp: '0x' + Math.floor(n / 3).toString(16) },
      }),
    };
  };

  await assert.rejects(
    () => measureBlockTime('http://example.invalid', { sampleBlocks: 1, rpc: { fetchImpl, retries: 0 } }),
    (err) => {
      assert.ok(err instanceof RangeError, 'this is the window being wrong, not the node');
      assert.match(err.message, /one-second resolution/);
      assert.doesNotMatch(err.message, /another RPC endpoint/);
      return true;
    },
  );

  // A wide enough window works, and flags that the reading is coarse.
  const s = await measureBlockTime('http://example.invalid', {
    sampleBlocks: 30,
    rpc: { fetchImpl, retries: 0 },
  });
  assert.ok(Math.abs(s.secondsPerBlock - 1 / 3) < 0.05);
  assert.equal(s.coarse, true);
});

test('a chain exactly on plan is neither faster nor slower', () => {
  const r = projectSchedule({
    startBlock: 1_000_000,
    startTimestamp: START_TS,
    periodBlocks: 100_000,
    periods: 10,
    designSecondsPerBlock: 2,
    currentBlock: 1_100_000,
    currentTimestamp: START_TS + 200_000,
    observedSecondsPerBlock: 2,
  });

  assert.equal(r.driftPercent, 0);
  assert.equal(r.paceFactor, 1);
  assert.equal(r.pace, 'on plan', 'never print "1.00x slower" for a healthy chain');
  assert.equal(r.faster, false);
});

test('checkSchedule validates before it reaches the network', async () => {
  let called = false;
  const rpc = { retries: 0, fetchImpl: async () => { called = true; throw new Error('should not happen'); } };

  await assert.rejects(
    () => checkSchedule({
      rpcUrl: 'http://example.invalid',
      startBlock: -1, periodBlocks: 100, periods: 10, designSecondsPerBlock: 3, rpc,
    }),
    RangeError,
  );
  assert.equal(called, false, 'a bad startBlock must not be put on the wire');
});

test('a start block ahead of the head is a RangeError, not a network failure', async () => {
  const node = fakeNode({ head: 1000, secondsPerBlock: 1 });
  await assert.rejects(
    () => checkSchedule({
      rpcUrl: 'http://example.invalid',
      startBlock: 999_999, periodBlocks: 100, periods: 10,
      designSecondsPerBlock: 3, sampleBlocks: 100, rpc: node.rpc,
    }),
    /ahead of the chain head/,
  );
});

test('checkSchedule wires the pieces together', async () => {
  const node = fakeNode({ head: 1_000_000, secondsPerBlock: 1 });
  const r = await checkSchedule({
    rpcUrl: 'http://example.invalid',
    startBlock: 0,
    periodBlocks: 100_000,
    periods: 20,            // ends at block 2,000,000 — not reached
    designSecondsPerBlock: 3,
    sampleBlocks: 100_000,
    rpc: node.rpc,
  });

  assert.equal(r.currentBlock, 1_000_000);
  assert.equal(r.observedSecondsPerBlock, 1);
  assert.equal(r.driftPercent, 200);            // 3s designed, 1s real
  assert.equal(r.periodsElapsed, 10);
  assert.equal(r.periodsExpectedByNow, 3);      // 1,000,000s / 300,000s
  assert.equal(r.complete, false);
  assert.equal(r.projectedEnd, 1_000_000 + 1_000_000 * 1);
  assert.ok(node.calls.includes('eth_getBlockByNumber:latest'), 'head is fetched by tag, not number');
});

test('checkSchedule reads the real end block once the schedule is over', async () => {
  const node = fakeNode({ head: 1_000_000, secondsPerBlock: 1 });
  const r = await checkSchedule({
    rpcUrl: 'http://example.invalid',
    startBlock: 0,
    periodBlocks: 100_000,
    periods: 5,             // ends at block 500,000, which exists
    designSecondsPerBlock: 3,
    rpc: node.rpc,
  });

  assert.equal(r.complete, true);
  assert.equal(r.projectedEndIsEstimate, false);
  assert.equal(r.projectedEnd, 500_000);  // the real timestamp of block 500,000
});

test('a garbage RPC result is an RpcShapeError, not a BigInt crash', async () => {
  const bad = (result) => ({
    fetchImpl: async () => ({ ok: true, json: async () => ({ result }) }),
    retries: 0,
  });

  for (const result of [null, 'latest', {}, 42, { number: '0x1' }]) {
    await assert.rejects(
      () => measureBlockTime('http://example.invalid', { rpc: bad(result) }),
      (err) => {
        assert.ok(
          err.name === 'RpcShapeError' || /not found/.test(err.message),
          `expected a readable error, got ${err.name}: ${err.message}`,
        );
        return true;
      },
    );
  }
});

test('an RPC-level error is reported once, not retried three times', async () => {
  let calls = 0;
  const rpc = {
    retries: 2,
    fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ error: { message: 'missing trie node' } }) };
    },
  };

  await assert.rejects(
    () => measureBlockTime('http://example.invalid', { rpc }),
    /missing trie node/,
  );
  assert.equal(calls, 1, 'a deterministic refusal must not be retried');
});

// --- formatting ---------------------------------------------------------

test('formatting helpers stay readable and never print 12 months', () => {
  assert.equal(isoDate(START_TS), '2022-04-02');
  assert.equal(humanDuration(30 * DAY), '30 days');
  assert.equal(humanDuration(365.25 * DAY), '1 year');
  assert.equal(humanDuration(365 * DAY), '1 year');
  assert.equal(humanDuration(730 * DAY), '2 years');
  assert.equal(humanDuration(1095 * DAY), '3 years');
  assert.equal(humanDuration(400 * DAY), '1 year, 1 month');
  assert.equal(humanDuration(-400 * DAY), '-1 year, 1 month');
  assert.equal(humanDuration(12 * 3600), '12 hours');

  for (let d = 60; d < 4000; d++) {
    assert.doesNotMatch(humanDuration(d * DAY), /12 months/, `${d} days printed 12 months`);
  }
});

test('dates beyond the calendar return null rather than a sliced fragment', () => {
  // toISOString() emits "+027005-08-27T..." past year 9999; slicing that
  // yields "+027005-08", which is not a date.
  assert.equal(isoDate(2.6e11), null);
  assert.equal(isoDate(7.884e11), null);
  assert.equal(isoDate(8.64e12), null);
  assert.equal(isoDate(253402300799), '9999-12-31');
  assert.equal(isoDate(1e15), null);
  assert.equal(isoDateTime(1e15), null);
  assert.equal(isoDate(Infinity), null);
  assert.equal(humanDuration(Infinity), 'unknown');
});
