#!/usr/bin/env node
/**
 * blockclock — check whether a block-denominated schedule still lands where
 * its authors thought it would.
 *
 * Exit codes:
 *   0  drift within tolerance
 *   1  drift beyond --max-drift (use this in CI)
 *   2  bad arguments
 *   3  could not reach or read the RPC endpoint
 */

import {
  checkSchedule, humanDuration, isoDate, isoDateTime,
  RpcShapeError, BlockNotFoundError,
} from '../src/index.js';

/**
 * Design block times are the value a schedule's author would have assumed when
 * writing a block count on that chain, with a source. They are deliberately
 * historical: that is the number your contract was reasoned against.
 */
const PRESETS = {
  // BNB Chain shipped 3s blocks from launch. Measured on mainnet, the rate
  // stepped 3s -> 1.5s around block 48.77M (Apr 2025, Lorentz), -> 0.75s around
  // block 52.34M (Jun 2025, Maxwell), and -> ~0.45s around block 75.14M
  // (Jan 2026). 3s is what a pre-2025 schedule was reasoned against.
  bsc: { rpcUrl: 'https://bsc-dataseed.bnbchain.org', designSecondsPerBlock: 3 },
  // Post-Merge Ethereum slots are 12s and have not changed.
  ethereum: { rpcUrl: 'https://ethereum-rpc.publicnode.com', designSecondsPerBlock: 12 },
  // Polygon PoS targeted ~2s before the Bhilai/Heimdall-v2 reductions.
  polygon: { rpcUrl: 'https://polygon-bor-rpc.publicnode.com', designSecondsPerBlock: 2 },
  // Base and other OP-stack chains target 2s.
  base: { rpcUrl: 'https://mainnet.base.org', designSecondsPerBlock: 2 },
};

const FLAGS = new Set([
  'chain', 'rpc', 'start-block', 'period-blocks', 'periods',
  'design-block-time', 'sample-blocks', 'max-drift', 'json', 'help',
]);

const USAGE = `
blockclock — does your block-count schedule still mean what you think?

Usage:
  blockclock --chain bsc --start-block 16579822 --period-blocks 2628000 --periods 80

Options:
  --chain <name>           ${Object.keys(PRESETS).join(', ')}
  --rpc <url>              JSON-RPC endpoint (overrides --chain)
  --start-block <n>        block the schedule counts from            (required)
  --period-blocks <n>      blocks in one period                      (required)
  --periods <n>            how many periods the schedule has         (required)
  --design-block-time <s>  block time the schedule assumed, seconds
                           (defaults to the chain preset)
  --sample-blocks <n>      how far back to measure the current block
                           time, default 100000
  --max-drift <pct>        exit 1 when |drift| exceeds this, default 5
  --json                   machine-readable output
  --help

A period is whatever your contract repeats: an unlock, a halving, an epoch,
a claim window, a fee change. blockclock does not read your contract; you
tell it the three numbers and it tells you where they now point.

Drift is symmetric: +100% means a period now takes half as long as designed,
-100% means twice as long.
`.trimStart();

class UsageError extends Error {}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!FLAGS.has(key)) {
      throw new UsageError(`unknown option --${key}. See --help.`);
    }
    if (key === 'json' || key === 'help') {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`--${key} needs a value`);
    out[key] = value;
  }
  return out;
}

function num(args, key, { required = false, fallback, integer = false, min = 0, allowZero = false }) {
  const raw = args[key];
  if (raw === undefined) {
    if (required) throw new UsageError(`--${key} is required`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${key} must be a number (got "${raw}")`);
  if (integer && !Number.isInteger(n)) {
    throw new UsageError(`--${key} must be a whole number of blocks (got "${raw}")`);
  }
  if (n < min || (!allowZero && n === 0 && min === 0)) {
    throw new UsageError(`--${key} must be ${allowZero ? `at least ${min}` : 'greater than 0'} (got "${raw}")`);
  }
  return n;
}

function date(unix, fallback = 'off the calendar') {
  return isoDate(unix) ?? fallback;
}

function render(report, maxDrift) {
  const d = report.driftPercent;
  const L = [];

  const realised = report.realisedSecondsPerBlock === null
    ? 'not yet'
    : report.realisedSecondsPerBlock.toFixed(3) + 's';

  L.push('');
  L.push(`  Block time   design ${report.designSecondsPerBlock}s  ·  now ${report.observedSecondsPerBlock.toFixed(3)}s  ·  since start ${realised}`);
  const notes = [];
  if (report.sample.clamped) notes.push('sample clamped to the start of the chain');
  if (report.sample.coarse) {
    notes.push(`only ${report.sample.spanSeconds}s of one-second timestamps: ±${report.sample.precision.toFixed(3)}s, use a larger --sample-blocks`);
  }
  L.push(`  Measured     blocks ${report.sample.fromBlock}–${report.sample.toBlock}${notes.length ? '  (' + notes.join('; ') + ')' : ''}`);
  const pace = report.pace === 'on plan'
    ? '(periods run exactly as designed)'
    : report.paceFactor < 1.005
      // 1.00x reads as a bug; say it in words instead.
      ? `(periods run marginally ${report.pace} than designed)`
      : `(periods run ${report.paceFactor.toFixed(2)}x ${report.pace} than designed)`;
  L.push(`  Drift        ${d >= 0 ? '+' : ''}${d.toFixed(1)}%  ${pace}`);
  L.push('');
  L.push(`  One period   meant to take ${humanDuration(report.intendedPeriodSeconds)}  ·  actually takes ${humanDuration(report.effectivePeriodSeconds)}`);
  const capped = report.periodsElapsedUncapped > report.periods
    || report.periodsExpectedUncapped > report.periods;
  const counts = capped
    ? `${report.periodsElapsed} of ${report.periods} elapsed  ·  the block counter has passed ${report.periodsElapsedUncapped}, the design clock ${report.periodsExpectedUncapped}`
    : `${report.periodsElapsed} of ${report.periods} elapsed  ·  ${report.periodsExpectedByNow} expected by now`;
  L.push(`  Periods      ${counts}  ·  ${report.periodsAhead >= 0 ? '+' : ''}${report.periodsAhead} ahead of plan`);
  L.push('');
  L.push(`  Ends         block ${report.endBlock}${report.complete ? '  (already passed)' : ''}`);
  L.push(`               intended  ${date(report.intendedEnd)}`);
  L.push(`               ${report.complete ? 'actual   ' : 'projected'} ${date(report.projectedEnd)}${report.projectedEndIsEstimate ? ' (estimated)' : ''}`);
  const early = report.earlyBySeconds;
  L.push(`               ${early >= 0 ? 'early by' : 'late by '} ${humanDuration(Math.abs(early))}`);
  L.push('');

  if (Math.abs(d) > maxDrift) {
    L.push(`  FAIL  drift of ${d.toFixed(1)}% exceeds the ${maxDrift}% you allowed.`);
    L.push('        Anything your contract times in blocks is now on a different calendar');
    L.push('        than your documentation. Check both before someone else does.');
  } else {
    L.push(`  OK    drift of ${d.toFixed(1)}% is within the ${maxDrift}% you allowed.`);
  }
  L.push('');
  return L.join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`blockclock: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (args.help || process.argv.length === 2) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  let settings;
  try {
    const preset = args.chain ? PRESETS[args.chain] : undefined;
    if (args.chain && !preset) {
      throw new UsageError(`unknown chain "${args.chain}". Known: ${Object.keys(PRESETS).join(', ')}`);
    }
    const rpcUrl = args.rpc || preset?.rpcUrl;
    if (!rpcUrl) throw new UsageError('give me --rpc <url> or --chain <name>');

    const designSecondsPerBlock = num(args, 'design-block-time', { fallback: preset?.designSecondsPerBlock });
    if (!designSecondsPerBlock) {
      throw new UsageError('--design-block-time is required when --chain is not used');
    }

    settings = {
      rpcUrl,
      designSecondsPerBlock,
      maxDrift: num(args, 'max-drift', { fallback: 5, min: 0, allowZero: true }),
      startBlock: num(args, 'start-block', { required: true, integer: true, min: 0, allowZero: true }),
      periodBlocks: num(args, 'period-blocks', { required: true, integer: true }),
      periods: num(args, 'periods', { required: true, integer: true }),
      sampleBlocks: num(args, 'sample-blocks', { fallback: 100_000, integer: true }),
    };
  } catch (err) {
    process.stderr.write(`blockclock: ${err.message}\n`);
    process.exit(2);
  }

  const { maxDrift, ...scheduleInput } = settings;

  let report;
  try {
    report = await checkSchedule(scheduleInput);
  } catch (err) {
    // A block that does not exist, or a refused endpoint, is a bad argument:
    // the chain answered us. Exit 3 is reserved for "could not reach it".
    const badInput = err instanceof RangeError
      || err instanceof BlockNotFoundError
      || err instanceof RpcShapeError;
    process.stderr.write(`blockclock: ${err.message}\n`);
    if (/prune|history unavailable|missing trie/i.test(err.message)) {
      process.stderr.write(
        '  This endpoint does not keep history that far back. Point --rpc at an\n' +
        '  archive node, or ask for a start block it still holds.\n',
      );
    }
    process.exit(badInput ? 2 : 3);
  }

  const withinTolerance = Math.abs(report.driftPercent) <= maxDrift;

  if (args.json) {
    process.stdout.write(JSON.stringify({
      ...report,
      intendedEndIso: isoDateTime(report.intendedEnd),
      projectedEndIso: isoDateTime(report.projectedEnd),
      maxDriftPercent: maxDrift,
      withinTolerance,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(render(report, maxDrift));
  }

  process.exit(withinTolerance ? 0 : 1);
}

main();
