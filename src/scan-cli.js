// SPDX-FileCopyrightText: 2026 Cripteracia Unipessoal Lda
// SPDX-License-Identifier: MIT

/**
 * `blockclock scan` — list where a contract tells time in blocks.
 *
 * Exit codes:
 *   0  nothing schedule-shaped found
 *   1  the contract counts time in blocks (use this in CI)
 *   2  bad arguments, or nothing to scan
 *   3  could not fetch the source or reach the RPC endpoint
 */

import fs from 'node:fs';
import path from 'node:path';

import { humanDuration, measureBlockTime } from './index.js';
import { BLOCK_TIME_HISTORY, latestSecondsPerBlock } from './history.js';
import { scanSource, fetchVerifiedSources, SCHEDULE_KINDS, CHAIN_IDS } from './scan.js';

const RPC = {
  bsc: 'https://bsc-dataseed.bnbchain.org',
  opbnb: 'https://opbnb-mainnet-rpc.bnbchain.org',
  ethereum: 'https://ethereum-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  base: 'https://mainnet.base.org',
};

const FLAGS = new Set([
  'chain', 'design-block-time', 'current-block-time', 'measure', 'rpc', 'json', 'help',
]);
const BOOLEAN_FLAGS = new Set(['measure', 'json', 'help']);

export const SCAN_USAGE = `
blockclock scan — where does this contract tell time in blocks?

Usage:
  blockclock scan <file.sol | directory | 0xAddress> [options]

  blockclock scan contracts/
  blockclock scan 0x1510211E6DC81F5724A1BecA33C5AC70Dcca6CE0 --chain bsc

Options:
  --chain <name>             ${Object.keys(CHAIN_IDS).join(', ')} (default bsc)
  --design-block-time <s>    block time to assume where the contract does not
                             say (default: the chain's first known rate)
  --current-block-time <s>   block time now (default: the newest known rate)
  --measure                  measure the current block time from the chain
  --rpc <url>                JSON-RPC endpoint for --measure
  --json                     machine-readable output
  --help

An address is looked up on Sourcify, so it only works for contracts whose
source is verified there. Anything else: download the source, scan the file.

This reads source text. It does not compile or execute the contract. It lists
every place time is counted in blocks so a person can decide what matters.
`.trimStart();

class UsageError extends Error {}

function parseArgs(argv) {
  const out = { targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out.targets.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (!FLAGS.has(key)) throw new UsageError(`unknown option --${key}. See blockclock scan --help.`);
    if (BOOLEAN_FLAGS.has(key)) {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`--${key} needs a value`);
    out[key] = value;
  }
  return out;
}

function positive(args, key) {
  if (args[key] === undefined) return undefined;
  const n = Number(args[key]);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`--${key} must be a number greater than 0 (got "${args[key]}")`);
  }
  return n;
}

function solidityFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.sol')) found.push(full);
    }
  };
  walk(target);
  return found.sort();
}

const TITLES = {
  'hardcoded-block-time': 'BLOCK TIME WRITTEN INTO THE CONTRACT',
  'block-count-constant': 'BLOCK COUNTS',
  'per-block-rate': 'AMOUNTS PER BLOCK (a faster chain pays these out faster)',
  'block-number-schedule': 'block.number USED AS A CLOCK',
  'block-number-anchor': 'block.number STORED',
  'block-number-lookup': 'PAST-BLOCK LOOKUPS (snapshot reads, not a clock)',
};

const n = (x) => x.toLocaleString('en-US');

export function renderScan(report) {
  const L = [];
  const { settings, files, findings } = report;
  L.push('');
  L.push(`blockclock scan: ${report.target}`);
  L.push('');
  if (settings.currentSecondsPerBlock) {
    const src = settings.measured ? 'measured just now' : 'newest known rate';
    L.push(`  block time now       ${settings.currentSecondsPerBlock}s  (${src})`);
  }
  if (settings.designSecondsPerBlock) {
    L.push(`  assumed when written ${settings.designSecondsPerBlock}s  (unless the contract says otherwise)`);
  }
  L.push(`  files read           ${files}`);
  L.push('');

  if (findings.length === 0) {
    L.push('  No block.number arithmetic and no block-count constants found.');
    L.push('');
    return L.join('\n');
  }

  for (const kind of Object.keys(TITLES)) {
    const group = findings.filter((f) => f.kind === kind);
    if (group.length === 0) continue;
    L.push(`  ${TITLES[kind]}`);
    for (const f of group) {
      const where = `${f.file ?? 'source'}:${f.line}`;
      const label = f.name ? `${f.name} = ` : '';
      const count = typeof f.blocks === 'number' ? `${label}${n(f.blocks)} blocks` : '';
      L.push(`    ${where}${count ? `  ${count}` : ''}`);
      if (f.designSeconds !== undefined) {
        L.push(`        written as  ${humanDuration(f.designSeconds)}  (at ${f.designSecondsPerBlock}s per block)`);
      }
      if (f.currentSeconds !== undefined) {
        L.push(`        today       ${humanDuration(f.currentSeconds)}  (at ${f.currentSecondsPerBlock}s per block)`);
      }
      L.push(`        > ${f.snippet}`);
    }
    L.push('');
  }

  const clock = findings.filter((f) => SCHEDULE_KINDS.has(f.kind)).length;
  if (clock > 0) {
    L.push(`  ${clock} place${clock === 1 ? '' : 's'} where this contract counts time in blocks.`);
    L.push('  Each one moves when the chain changes its block time. Check them against');
    L.push('  what the contract was meant to do, then run `blockclock` on the schedule.');
  } else {
    L.push('  block.number appears, but never as a clock, in this source.');
  }
  L.push('');
  return L.join('\n');
}

/**
 * Scan a set of named sources and assemble one report. Pure: no I/O.
 */
export function scanSources(sources, settings, target) {
  const findings = [];
  for (const [file, content] of Object.entries(sources)) {
    findings.push(...scanSource(content, { file, ...settings }).findings);
  }
  return {
    target,
    settings,
    files: Object.keys(sources).length,
    findings,
    countsTimeInBlocks: findings.some((f) => SCHEDULE_KINDS.has(f.kind)),
  };
}

export async function scanMain(argv) {
  let args;
  let settings;
  try {
    args = parseArgs(argv);
    if (args.help || argv.length === 0) {
      process.stdout.write(SCAN_USAGE);
      process.exit(0);
    }
    if (args.targets.length !== 1) {
      throw new UsageError('give me one thing to scan: a .sol file, a directory or a contract address');
    }
    const chain = args.chain ?? 'bsc';
    if (!(chain in CHAIN_IDS)) {
      throw new UsageError(`unknown chain "${chain}". Known: ${Object.keys(CHAIN_IDS).join(', ')}`);
    }
    const history = BLOCK_TIME_HISTORY[chain];
    settings = {
      chain,
      designSecondsPerBlock: positive(args, 'design-block-time') ?? history?.plateaus[0].secondsPerBlock,
      currentSecondsPerBlock: positive(args, 'current-block-time') ?? (history ? latestSecondsPerBlock(chain) : undefined),
      measured: false,
    };
  } catch (err) {
    process.stderr.write(`blockclock: ${err.message}\n`);
    process.exit(2);
  }

  const target = args.targets[0];
  let sources;
  try {
    if (args.measure) {
      const rpcUrl = args.rpc ?? RPC[settings.chain];
      const measured = await measureBlockTime(rpcUrl);
      settings.currentSecondsPerBlock = Number(measured.secondsPerBlock.toFixed(3));
      settings.measured = true;
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(target)) {
      sources = await fetchVerifiedSources(CHAIN_IDS[settings.chain], target);
    } else {
      if (!fs.existsSync(target)) throw new UsageError(`no such file or directory: ${target}`);
      sources = {};
      for (const file of solidityFiles(target)) sources[file] = fs.readFileSync(file, 'utf8');
      if (Object.keys(sources).length === 0) throw new UsageError(`no .sol files under ${target}`);
    }
  } catch (err) {
    process.stderr.write(`blockclock: ${err.message}\n`);
    process.exit(err instanceof UsageError || err instanceof RangeError ? 2 : 3);
  }

  const report = scanSources(sources, settings, target);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderScan(report));
  process.exit(report.countsTimeInBlocks ? 1 : 0);
}
