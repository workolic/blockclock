// SPDX-FileCopyrightText: 2026 Cripteracia Unipessoal Lda
// SPDX-License-Identifier: MIT

/**
 * BlockClock — tell whether a schedule written in block counts still lands
 * where its authors thought it would.
 *
 * A contract that says "one period every 2,628,000 blocks" is really saying
 * "one period every 91.25 days" — but only while a block takes 3 seconds.
 * Chains change their block time. The contract does not. This library measures
 * the gap.
 */

import { getBlock } from './rpc.js';

export { RpcError, RpcShapeError, BlockNotFoundError, getBlock, getBlockNumber } from './rpc.js';

const SECONDS_PER_DAY = 86400;
const DAYS_PER_YEAR = 365.25;
const DAYS_PER_MONTH = 30.44;
/**
 * Years past 9999 make toISOString() emit the expanded form (+027005-08-27),
 * which slices into nonsense. Stop before that rather than print a fragment.
 */
const MAX_UNIX_SECONDS = 253402300799; // 9999-12-31T23:59:59Z

/**
 * Average seconds per block, measured between two real blocks on the chain.
 *
 * The sample is clamped to genesis on a young chain, so always read
 * `fromBlock`/`toBlock` back rather than assuming you got the span you asked
 * for.
 *
 * @param {string} rpcUrl
 * @param {object} [options]
 * @param {number} [options.sampleBlocks=100000] How far back to sample from the head.
 * @param {{number: number, timestamp: number}} [options.headBlock] Reuse a header you already have.
 * @param {object} [options.rpc]  Passed through to the JSON-RPC client.
 * @returns {Promise<{secondsPerBlock: number, fromBlock: number, toBlock: number,
 *                    spanBlocks: number, spanSeconds: number, clamped: boolean}>}
 */
export async function measureBlockTime(rpcUrl, options = {}) {
  const { sampleBlocks = 100_000, rpc } = options;
  if (!Number.isInteger(sampleBlocks) || sampleBlocks <= 0) {
    throw new RangeError('sampleBlocks must be a positive integer');
  }

  const newer = options.headBlock ?? (await getBlock(rpcUrl, 'latest', rpc));
  // Floor at block 1, not 0: many chains (BNB Chain among them) give genesis a
  // placeholder timestamp months before the first real block, which would
  // poison a clamped average.
  const wantedFrom = newer.number - sampleBlocks;
  const fromBlock = Math.max(1, wantedFrom);
  const clamped = wantedFrom < 1;

  if (fromBlock >= newer.number) {
    throw new RangeError(
      `cannot measure block time: head is block ${newer.number}, nothing to sample against`,
    );
  }

  const older = await getBlock(rpcUrl, fromBlock, rpc);

  const spanSeconds = newer.timestamp - older.timestamp;
  const spanBlocks = newer.number - older.number;

  if (spanBlocks <= 0 || spanSeconds < 0) {
    throw new Error('non-monotonic block data returned by the node; try another RPC endpoint');
  }
  if (spanSeconds === 0) {
    // Block timestamps have one-second resolution. On a sub-second chain a
    // short window can span zero seconds; that is the window's fault, not the
    // node's.
    throw new RangeError(
      `the last ${spanBlocks} blocks span 0 seconds, so no rate can be measured. ` +
      'Block timestamps have one-second resolution; use a larger sample.',
    );
  }

  const secondsPerBlock = spanSeconds / spanBlocks;
  // ±1s of rounding at each end over `spanBlocks` blocks.
  const precision = 2 / spanBlocks;

  return {
    secondsPerBlock,
    precision,
    coarse: precision > secondsPerBlock * 0.01,
    fromBlock: older.number,
    toBlock: newer.number,
    spanBlocks,
    spanSeconds,
    clamped,
  };
}

/** The input checks that do not need a current block; shared with checkSchedule. */
function assertScheduleShape({ startBlock, periodBlocks, periods, designSecondsPerBlock }) {
  if (!Number.isSafeInteger(startBlock) || startBlock < 0) {
    throw new RangeError(`startBlock must be a non-negative integer (got ${startBlock})`);
  }
  for (const [name, value] of Object.entries({ periodBlocks, periods })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer (got ${value})`);
    }
  }
  const totalBlocks = periodBlocks * periods;
  if (!Number.isSafeInteger(totalBlocks) || !Number.isSafeInteger(startBlock + totalBlocks)) {
    throw new RangeError('schedule block counts and end block must stay within the safe integer range');
  }
  if (!Number.isFinite(designSecondsPerBlock) || designSecondsPerBlock <= 0) {
    throw new RangeError(
      `designSecondsPerBlock must be a positive finite number (got ${designSecondsPerBlock})`,
    );
  }
}

/**
 * Project a block-denominated schedule, in pure arithmetic. No network.
 *
 * @param {object} schedule
 * @param {number} schedule.startBlock          Block the schedule counts from.
 * @param {number} schedule.startTimestamp      UNIX seconds of that block.
 * @param {number} schedule.periodBlocks        Blocks in one period.
 * @param {number} schedule.periods             How many periods the schedule has.
 * @param {number} schedule.designSecondsPerBlock  Block time the authors assumed.
 * @param {number} schedule.currentBlock
 * @param {number} schedule.currentTimestamp
 * @param {number} schedule.observedSecondsPerBlock Block time measured now.
 * @param {number} [schedule.endBlockTimestamp] Real timestamp of endBlock, when it is already past.
 * @returns {ScheduleReport}
 */
export function projectSchedule(schedule) {
  const {
    startBlock,
    startTimestamp,
    periodBlocks,
    periods,
    designSecondsPerBlock,
    currentBlock,
    currentTimestamp,
    observedSecondsPerBlock,
    endBlockTimestamp,
  } = schedule;

  assertScheduleShape({ startBlock, periodBlocks, periods, designSecondsPerBlock });

  // Block numbers and timestamps may be zero (genesis). Rates and counts may not.
  for (const [name, value] of Object.entries({ startBlock, currentBlock })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer (got ${value})`);
    }
  }
  for (const [name, value] of Object.entries({ startTimestamp, currentTimestamp })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative number (got ${value})`);
    }
  }
  for (const [name, value] of Object.entries({ periodBlocks, periods })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer (got ${value})`);
    }
  }
  for (const [name, value] of Object.entries({
    designSecondsPerBlock,
    observedSecondsPerBlock,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive finite number (got ${value})`);
    }
  }
  if (currentBlock < startBlock) {
    throw new RangeError('currentBlock is before startBlock: the schedule has not started');
  }
  if (currentTimestamp < startTimestamp) {
    throw new RangeError('currentTimestamp is before startTimestamp');
  }

  const totalBlocks = periodBlocks * periods;
  const endBlock = startBlock + totalBlocks;

  // What the authors meant.
  const intendedPeriodSeconds = periodBlocks * designSecondsPerBlock;
  const intendedDurationSeconds = totalBlocks * designSecondsPerBlock;
  const intendedEnd = startTimestamp + intendedDurationSeconds;

  // What actually happened between the start block and now.
  const blocksSoFar = currentBlock - startBlock;
  const secondsSoFar = currentTimestamp - startTimestamp;
  const realisedSecondsPerBlock = blocksSoFar > 0 ? secondsSoFar / blocksSoFar : null;

  // Periods. The uncapped counts keep the drift signal alive after the
  // schedule ends; the capped ones are what you would print next to "of N".
  const periodsElapsedUncapped = Math.floor(blocksSoFar / periodBlocks);
  const periodsExpectedUncapped = Math.floor(secondsSoFar / intendedPeriodSeconds);
  const periodsElapsed = Math.min(periods, periodsElapsedUncapped);
  const periodsExpectedByNow = Math.min(periods, periodsExpectedUncapped);

  // Where it ends.
  const complete = currentBlock >= endBlock;
  const blocksRemaining = Math.max(0, endBlock - currentBlock);
  let projectedEnd;
  if (!complete) {
    projectedEnd = currentTimestamp + blocksRemaining * observedSecondsPerBlock;
  } else if (Number.isFinite(endBlockTimestamp)) {
    projectedEnd = endBlockTimestamp;      // measured: the block really happened
  } else {
    // Walk back from now at the current pace. An estimate, and flagged as one.
    projectedEnd = currentTimestamp - (currentBlock - endBlock) * observedSecondsPerBlock;
  }

  // Drift, symmetric in both directions so that |drift| is a usable threshold.
  // +100% means periods take half as long as designed; -100% means twice as long.
  const ratio = designSecondsPerBlock / observedSecondsPerBlock;
  const paceFactor = ratio >= 1 ? ratio : 1 / ratio;
  // Three states, not two: a chain exactly on plan is neither faster nor slower.
  const pace = ratio === 1 ? 'on plan' : ratio > 1 ? 'faster' : 'slower';
  const driftPercent = (ratio >= 1 ? ratio - 1 : -(1 / ratio - 1)) * 100;

  return {
    periods,
    endBlock,
    blocksRemaining,
    complete,
    projectedEndIsEstimate: complete && !Number.isFinite(endBlockTimestamp),

    intendedEnd,
    projectedEnd,
    earlyBySeconds: Math.round(intendedEnd - projectedEnd),

    intendedPeriodSeconds,
    effectivePeriodSeconds: periodBlocks * observedSecondsPerBlock,

    periodsElapsed,
    periodsExpectedByNow,
    periodsElapsedUncapped,
    periodsExpectedUncapped,
    periodsAhead: periodsElapsedUncapped - periodsExpectedUncapped,

    designSecondsPerBlock,
    observedSecondsPerBlock,
    realisedSecondsPerBlock,
    paceFactor,
    pace,
    faster: ratio > 1,
    driftPercent,
  };
}

/**
 * Fetch what is needed and project, in one call.
 *
 * @param {object} input
 * @param {string} input.rpcUrl
 * @param {number} input.startBlock
 * @param {number} input.periodBlocks
 * @param {number} input.periods
 * @param {number} input.designSecondsPerBlock
 * @param {number} [input.sampleBlocks]
 * @param {object} [input.rpc]
 */
export async function checkSchedule(input) {
  const { rpcUrl, startBlock, periodBlocks, periods, designSecondsPerBlock, sampleBlocks, rpc } = input;

  // Validate before touching the network, so a library caller gets a RangeError
  // rather than a malformed JSON-RPC request.
  assertScheduleShape({ startBlock, periodBlocks, periods, designSecondsPerBlock });

  // One call for the head: asking for 'latest' avoids the race where a
  // load-balanced endpoint has not yet seen the number it just gave us.
  const headBlock = await getBlock(rpcUrl, 'latest', rpc);
  if (startBlock > headBlock.number) {
    throw new RangeError(
      `startBlock ${startBlock} is ahead of the chain head (${headBlock.number}): check the number`,
    );
  }

  const [startHeader, sample] = await Promise.all([
    getBlock(rpcUrl, startBlock, rpc),
    measureBlockTime(rpcUrl, { sampleBlocks, headBlock, rpc }),
  ]);

  const endBlock = startBlock + periodBlocks * periods;
  let endBlockTimestamp;
  if (headBlock.number >= endBlock) {
    endBlockTimestamp = (await getBlock(rpcUrl, endBlock, rpc)).timestamp;
  }

  const report = projectSchedule({
    startBlock,
    startTimestamp: startHeader.timestamp,
    periodBlocks,
    periods,
    designSecondsPerBlock,
    currentBlock: headBlock.number,
    currentTimestamp: headBlock.timestamp,
    observedSecondsPerBlock: sample.secondsPerBlock,
    endBlockTimestamp,
  });

  return {
    ...report,
    currentBlock: headBlock.number,
    currentTimestamp: headBlock.timestamp,
    startTimestamp: startHeader.timestamp,
    sample,
  };
}

/** Seconds as "3 years, 2 months" — rough on purpose; nobody needs the hours. */
export function humanDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.abs(seconds);
  const days = abs / SECONDS_PER_DAY;
  if (days < 1) return `${sign}${Math.round(abs / 3600)} hours`;
  if (days < 60) return `${sign}${Math.round(days)} days`;

  let years = Math.floor(days / DAYS_PER_YEAR);
  let months = Math.round((days - years * DAYS_PER_YEAR) / DAYS_PER_MONTH);
  if (months >= 12) {           // 730 days must not print "1 year, 12 months"
    years += Math.floor(months / 12);
    months = months % 12;
  }
  const parts = [];
  if (years) parts.push(`${years} year${years === 1 ? '' : 's'}`);
  if (months) parts.push(`${months} month${months === 1 ? '' : 's'}`);
  return sign + parts.join(', ');
}

/** UNIX seconds as YYYY-MM-DD, or null when the value is off the calendar. */
export function isoDate(unixSeconds) {
  if (!Number.isFinite(unixSeconds) || Math.abs(unixSeconds) > MAX_UNIX_SECONDS) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** UNIX seconds as a full ISO string, or null when off the calendar. */
export function isoDateTime(unixSeconds) {
  if (!Number.isFinite(unixSeconds) || Math.abs(unixSeconds) > MAX_UNIX_SECONDS) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * @typedef {object} ScheduleReport
 * @property {number} periods
 * @property {number} endBlock              first block after the final period
 * @property {number} blocksRemaining
 * @property {boolean} complete
 * @property {boolean} projectedEndIsEstimate
 * @property {number} intendedEnd           UNIX seconds, per the design block time
 * @property {number} projectedEnd          UNIX seconds, at the current pace
 * @property {number} earlyBySeconds        positive = ends earlier than intended
 * @property {number} intendedPeriodSeconds
 * @property {number} effectivePeriodSeconds
 * @property {number} periodsElapsed        capped at `periods`
 * @property {number} periodsExpectedByNow  capped at `periods`
 * @property {number} periodsElapsedUncapped
 * @property {number} periodsExpectedUncapped
 * @property {number} periodsAhead          from the uncapped counts
 * @property {number} designSecondsPerBlock
 * @property {number} observedSecondsPerBlock
 * @property {number|null} realisedSecondsPerBlock  null before the first block elapses
 * @property {number} paceFactor            always >= 1; read with `pace`
 * @property {'faster'|'slower'|'on plan'} pace
 * @property {boolean} faster                convenience; false when exactly on plan
 * @property {number} driftPercent          symmetric: +100 = twice as fast, -100 = twice as slow
 */
