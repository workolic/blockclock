// SPDX-FileCopyrightText: 2026 Cripteracia Unipessoal Lda
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  scanSource, evaluateConstant, blankCommentsAndStrings, fetchVerifiedSources,
  BLOCK_TIME_HISTORY, plateauAt, secondsPerBlockAt, latestSecondsPerBlock, secondsBetweenBlocks,
} from '../src/index.js';
import { scanSources, renderScan } from '../src/scan-cli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'blockclock.js');
const DAY = 86400;

/** The shape of the schedule that started this project, rewritten from scratch. */
const RELEASE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Release {
    uint256[] private releasePeriods;
    uint256 private intervalBlocksYear;
    uint256 private intervalBlocksQuarter;

    constructor() {
        uint256 daysUntilFirstRelease = 58;
        uint256 hoursUntilMidnight = 6;
        uint256 startBlock = block.number + ((daysUntilFirstRelease * 24 + hoursUntilMidnight) * 60 * 60 / 3);

        intervalBlocksYear = 365 * 24 * 60 * 60 / 3;  // one block every 3 seconds
        intervalBlocksQuarter = intervalBlocksYear / 4;

        releasePeriods = new uint256[](81);
        for (uint i = 0; i < 81; i++) {
            releasePeriods[i] = startBlock + i * intervalBlocksQuarter;
        }
    }

    function release() external {
        require(releasePeriods[0] <= block.number, "before release period");
        require(block.number < releasePeriods[80], "after release period");
    }
}
`;

const scan = (source, extra = {}) => scanSource(source, {
  file: 'T.sol', designSecondsPerBlock: 3, currentSecondsPerBlock: 0.45, ...extra,
}).findings;
const kinds = (findings) => findings.map((f) => f.kind);

// --- text handling ---------------------------------------------------------

test('blanking comments and strings keeps every offset and newline', () => {
  const src = 'a = 1; // block.number\n/* block.number\n */ b = "block.number"; c = \'x\';\n';
  const clean = blankCommentsAndStrings(src);
  assert.equal(clean.length, src.length);
  assert.equal(clean.split('\n').length, src.split('\n').length);
  assert.ok(!clean.includes('block.number'));
  assert.ok(clean.includes('a = 1;'));
  assert.ok(clean.includes('b = "'));
});

test('an escaped quote does not end a string early', () => {
  const clean = blankCommentsAndStrings('s = "a \\" block.number"; t = block.number;');
  assert.equal(clean.match(/block\.number/g).length, 1);
});

test('block.number in comments and strings is not reported', () => {
  const src = `contract A {
    // if (block.number > end) revert();
    string constant NOTE = "block.number + 28800";
    /* uint blocksPerDay = 28800; */
  }`;
  assert.deepEqual(scan(src), []);
});

// --- constant evaluation ---------------------------------------------------

test('constant expressions evaluate as Solidity uints would', () => {
  const v = (e, s) => evaluateConstant(e, s)?.value;
  assert.equal(v('365 * 24 * 60 * 60 / 3'), 10_512_000n);
  assert.equal(v('(58 * 24 + 6) * 60 * 60 / 3'), 1_677_600n);
  assert.equal(v('7 / 2'), 3n, 'integer division truncates');
  assert.equal(v('2_628_000'), 2_628_000n);
  assert.equal(v('1e6'), 1_000_000n);
  assert.equal(v('2.5e3'), 2500n);
  assert.equal(v('0x10'), 16n);
  assert.equal(v('10 ** 9'), 1_000_000_000n);
  assert.equal(v('uint256(28800)'), 28_800n);
});

test('time units are understood and mark the value as a duration', () => {
  assert.equal(evaluateConstant('1 days').value, 86_400n);
  assert.equal(evaluateConstant('2 weeks').value, 1_209_600n);
  assert.equal(evaluateConstant('365 days / 3').value, 10_512_000n);
  assert.equal(evaluateConstant('1 days').time, true);
});

test('known names resolve; unknown names make the whole expression unknown', () => {
  const symbols = new Map([['YEAR', { value: 10_512_000n }]]);
  assert.equal(evaluateConstant('YEAR / 4', symbols).value, 2_628_000n);
  assert.equal(evaluateConstant('somethingElse / 4', symbols), null);
  assert.equal(evaluateConstant('block.number + 5', symbols), null);
  assert.equal(evaluateConstant('', symbols), null);
  assert.equal(evaluateConstant('1 / 0'), null);
  assert.equal(evaluateConstant('1 - 2'), null, 'a negative uint is not a constant we can use');
  assert.equal(evaluateConstant('1.5'), null);
});

// --- findings ---------------------------------------------------------------

test('a block time written into the arithmetic is found, with the number it implies', () => {
  const f = scan(RELEASE).find((x) => x.name === 'intervalBlocksYear');
  assert.equal(f.kind, 'hardcoded-block-time');
  assert.equal(f.blocks, 10_512_000);
  assert.equal(f.designSecondsPerBlock, 3);
  assert.equal(f.designSeconds, 365 * DAY);
  assert.ok(Math.abs(f.currentSeconds - 54.75 * DAY) < 1);
  assert.equal(f.line, 15);
});

test('the block time is taken from the contract, not from the default', () => {
  const src = 'contract A { uint256 constant BLOCKS_PER_DAY = 1 days / 5; }';
  const [f] = scan(src, { designSecondsPerBlock: 3 });
  assert.equal(f.kind, 'hardcoded-block-time');
  assert.equal(f.designSecondsPerBlock, 5);
  assert.equal(f.blocks, 17_280);
  assert.equal(f.designSeconds, DAY);
});

test('a count derived from another inherits its block time and is not mistaken for one', () => {
  const f = scan(RELEASE).find((x) => x.name === 'intervalBlocksQuarter');
  assert.equal(f.kind, 'block-count-constant', 'dividing blocks by 4 is not "4 seconds per block"');
  assert.equal(f.blocks, 2_628_000);
  assert.equal(f.designSecondsPerBlock, 3);
  assert.equal(f.designSeconds, 91.25 * DAY);
  assert.ok(Math.abs(f.currentSeconds - 13.6875 * DAY) < 1);
});

test('a literal named as a block count is priced at the default block time', () => {
  const [f] = scan('contract A { uint256 public constant BLOCKS_PER_DAY = 28800; }');
  assert.equal(f.kind, 'block-count-constant');
  assert.equal(f.name, 'BLOCKS_PER_DAY');
  assert.equal(f.blocks, 28_800);
  assert.equal(f.designSeconds, DAY);
  assert.ok(Math.abs(f.currentSeconds - 0.15 * DAY) < 1);
  assert.ok(Math.abs(f.speedup - 3 / 0.45) < 1e-9);
});

test('an amount per block is a rate, not a count of blocks', () => {
  const [f] = scan('contract A { uint256 public constant CAKE_PER_BLOCK = 40 * 1e18; }');
  assert.equal(f.kind, 'per-block-rate');
  assert.equal(f.value, '40000000000000000000');
  assert.equal(f.blocks, undefined);
  assert.equal(f.designSeconds, undefined);
});

test('small counts, non-block names and ordinary divisions are left alone', () => {
  const src = `contract A {
    uint256 constant CONFIRM_BLOCKS = 12;
    uint256 constant FEE = 3;
    uint256 constant SHARE = 1000000 / 10;
    uint256 constant HALF = 100 / 2;
    bytes32 lastBlockHash = 0x00;
    function f(uint256 amount) external pure returns (uint256) { return amount * 3 / 100; }
  }`;
  assert.deepEqual(scan(src), []);
});

test('block.number plus a constant is priced', () => {
  const src = 'contract A { uint256 unlockAt; function lock() external { unlockAt = block.number + 201600; } }';
  const [f] = scan(src);
  assert.equal(f.kind, 'block-number-schedule');
  assert.equal(f.blocks, 201_600);
  assert.equal(f.designSeconds, 7 * DAY);
  assert.ok(Math.abs(f.currentSeconds - 1.05 * DAY) < 1);
});

test('comparisons against block.number are schedule uses', () => {
  const found = scan(RELEASE).filter((f) => f.kind === 'block-number-schedule');
  assert.deepEqual(found.map((f) => f.line), [13, 25, 26]);
  assert.equal(found[0].blocks, 1_677_600, 'the start offset is priced from its own arithmetic');
  assert.equal(found[0].designSecondsPerBlock, 3);
});

test('storing block.number is an anchor, not a schedule', () => {
  const src = 'contract A { uint256 last; function touch() external { last = block.number; } }';
  assert.deepEqual(kinds(scan(src)), ['block-number-anchor']);
});

test('blockhash(block.number - 1) is not a clock', () => {
  const src = 'contract A { function r() external view returns (bytes32) { return blockhash(block.number - 1); } }';
  assert.deepEqual(scan(src), []);
});

test('a snapshot guard is listed as a lookup, not counted as a clock', () => {
  const src = `contract A {
    function getPriorVotes(address a, uint256 blockNumber) external view returns (uint256) {
      require(blockNumber < block.number, "not yet determined");
      return 0;
    }
  }`;
  assert.deepEqual(kinds(scan(src)), ['block-number-lookup']);
});

test('a guard on a deadline is still a clock', () => {
  const src = `contract A { uint256 endBlock;
    function claim() external view { require(endBlock < block.number, "too early"); } }`;
  assert.deepEqual(kinds(scan(src)), ['block-number-schedule']);
});

test('line and column point at the original text', () => {
  const src = 'contract A {\n  // comment\n  function f() external view returns (bool) {\n    return block.number > 100;\n  }\n}\n';
  const [f] = scan(src);
  assert.equal(f.line, 4);
  assert.equal(f.column, 12);
  assert.equal(f.snippet, 'return block.number > 100;');
});

test('without block times the scan still lists, it just does not price', () => {
  const [f] = scanSource('contract A { uint256 constant BLOCKS_PER_DAY = 28800; }').findings;
  assert.equal(f.blocks, 28_800);
  assert.equal(f.designSeconds, undefined);
  assert.equal(f.currentSeconds, undefined);
});

test('mappings, for loops and compound assignments do not confuse the parser', () => {
  const src = `contract A {
    mapping(address => uint256) public balances;
    uint256 total;
    function f() external { for (uint256 i = 0; i < 10; i++) { total += i; } total -= 1; }
  }`;
  assert.deepEqual(scan(src), []);
});

// --- report -----------------------------------------------------------------

test('the report says how many places count time in blocks', () => {
  const settings = { chain: 'bsc', designSecondsPerBlock: 3, currentSecondsPerBlock: 0.45, measured: false };
  const report = scanSources({ 'Release.sol': RELEASE }, settings, 'Release.sol');
  assert.equal(report.files, 1);
  assert.equal(report.countsTimeInBlocks, true);
  const text = renderScan(report);
  assert.match(text, /intervalBlocksQuarter = 2,628,000 blocks/);
  assert.match(text, /written as {2}3 months {2}\(at 3s per block\)/);
  assert.match(text, /today {7}14 days {2}\(at 0\.45s per block\)/);
  assert.match(text, /5 places where this contract counts time in blocks/);
});

test('a clean contract reports nothing and does not count', () => {
  const settings = { chain: 'bsc', designSecondsPerBlock: 3, currentSecondsPerBlock: 0.45, measured: false };
  const report = scanSources({ 'A.sol': 'contract A { uint256 x = 1; }' }, settings, 'A.sol');
  assert.equal(report.countsTimeInBlocks, false);
  assert.match(renderScan(report), /No block\.number arithmetic/);
});

// --- history ----------------------------------------------------------------

test('the published JSON is the same data the library uses', () => {
  const file = path.join(here, '..', 'data', 'block-time-history.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), BLOCK_TIME_HISTORY);
});

test('plateaus are ordered and start at genesis', () => {
  for (const [chain, { plateaus }] of Object.entries(BLOCK_TIME_HISTORY)) {
    assert.equal(plateaus[0].fromBlock, 0, chain);
    for (let i = 1; i < plateaus.length; i++) {
      assert.ok(plateaus[i].fromBlock > plateaus[i - 1].fromBlock, chain);
      assert.ok(plateaus[i].secondsPerBlock > 0, chain);
    }
  }
});

test('the rate at a block is the plateau it falls in', () => {
  assert.equal(secondsPerBlockAt('bsc', 0), 3);
  assert.equal(secondsPerBlockAt('bsc', 48_773_999), 3);
  assert.equal(secondsPerBlockAt('bsc', 48_774_000), 1.5);
  assert.equal(secondsPerBlockAt('bsc', 60_000_000), 0.75);
  assert.equal(secondsPerBlockAt('bsc', 999_999_999), 0.45);
  assert.equal(plateauAt('bsc', 50_000_000).note, 'Lorentz');
  assert.equal(latestSecondsPerBlock('bsc'), 0.45);
});

test('seconds between blocks walk the plateaus', () => {
  assert.equal(secondsBetweenBlocks('bsc', 1000, 1000), 0);
  assert.equal(secondsBetweenBlocks('bsc', 1000, 2000), 3000);
  // 1000 blocks at 3s, then 1000 at 1.5s
  assert.equal(secondsBetweenBlocks('bsc', 48_773_000, 48_775_000), 3000 + 1500);
  // across every boundary
  const all = secondsBetweenBlocks('bsc', 0, 80_000_000);
  const expected = 48_774_000 * 3 + (52_340_000 - 48_774_000) * 1.5
    + (75_142_000 - 52_340_000) * 0.75 + (80_000_000 - 75_142_000) * 0.45;
  assert.ok(Math.abs(all - expected) < 1e-6);
});

test('the Lucrar schedule, priced from the plateaus alone, ends in March 2028', () => {
  const start = 16_579_822;
  const startTimestamp = 1648857600; // 2022-04-02T00:00:00Z
  const seconds = secondsBetweenBlocks('bsc', start, start + 80 * 2_628_000);
  const end = new Date((startTimestamp + seconds) * 1000).toISOString();
  assert.equal(end.slice(0, 7), '2028-03');
  // Written for 3s blocks it was a twenty-year calendar.
  assert.equal(80 * 2_628_000 * 3, 20 * 365 * DAY);
});

test('history refuses unknown chains and nonsense ranges', () => {
  assert.throws(() => secondsPerBlockAt('nope', 1), RangeError);
  assert.throws(() => secondsPerBlockAt('bsc', -1), RangeError);
  assert.throws(() => secondsBetweenBlocks('bsc', 10, 5), RangeError);
  assert.throws(() => secondsBetweenBlocks('bsc', 1.5, 5), RangeError);
});

// --- fetching ---------------------------------------------------------------

const fakeFetch = (status, body, seen = []) => async (url) => {
  seen.push(url);
  return { status, ok: status >= 200 && status < 300, json: async () => body };
};

test('verified sources come back as path -> content, with a lower-cased address', async () => {
  const seen = [];
  const body = { sources: { 'A.sol': { content: 'contract A {}' }, 'bad.sol': {} } };
  const sources = await fetchVerifiedSources(56, '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01', {
    fetchImpl: fakeFetch(200, body, seen),
  });
  assert.deepEqual(sources, { 'A.sol': 'contract A {}' });
  assert.equal(seen[0], 'https://sourcify.dev/server/v2/contract/56/0xabcdef0123456789abcdef0123456789abcdef01?fields=sources');
});

test('an unverified contract is a usage problem, with what to do next', async () => {
  await assert.rejects(
    fetchVerifiedSources(56, `0x${'1'.repeat(40)}`, { fetchImpl: fakeFetch(404, {}) }),
    (err) => err instanceof RangeError && /scan the file instead/.test(err.message),
  );
});

test('a bad address never reaches the network; a server error is not a usage problem', async () => {
  const seen = [];
  await assert.rejects(fetchVerifiedSources(56, '0x123', { fetchImpl: fakeFetch(200, {}, seen) }), RangeError);
  assert.equal(seen.length, 0);
  await assert.rejects(
    fetchVerifiedSources(56, `0x${'1'.repeat(40)}`, { fetchImpl: fakeFetch(500, {}) }),
    (err) => !(err instanceof RangeError) && /500/.test(err.message),
  );
  await assert.rejects(
    fetchVerifiedSources(56, `0x${'1'.repeat(40)}`, { fetchImpl: fakeFetch(200, { sources: {} }) }),
    /no source files/,
  );
});

// --- command line -----------------------------------------------------------

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

test('scan exits 1 on a contract that counts time in blocks, 0 on one that does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockclock-'));
  try {
    fs.writeFileSync(path.join(dir, 'Release.sol'), RELEASE);
    fs.mkdirSync(path.join(dir, 'clean'));
    fs.writeFileSync(path.join(dir, 'clean', 'A.sol'), 'contract A { uint256 x = 1; }');

    const dirty = run(['scan', dir]);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stdout, /Release\.sol:15 {2}intervalBlocksYear = 10,512,000 blocks/);
    assert.match(dirty.stdout, /files read {11}2/);

    const clean = run(['scan', path.join(dir, 'clean', 'A.sol')]);
    assert.equal(clean.status, 0);

    const json = run(['scan', path.join(dir, 'Release.sol'), '--json', '--current-block-time', '0.75']);
    assert.equal(json.status, 1);
    const report = JSON.parse(json.stdout);
    assert.equal(report.countsTimeInBlocks, true);
    assert.equal(report.settings.currentSecondsPerBlock, 0.75);
    assert.equal(report.findings.find((f) => f.name === 'intervalBlocksQuarter').currentSeconds, 2_628_000 * 0.75);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scan rejects bad arguments with exit 2', () => {
  assert.equal(run(['scan', '--nope']).status, 2);
  assert.equal(run(['scan', '/no/such/file.sol']).status, 2);
  assert.equal(run(['scan', 'a.sol', 'b.sol']).status, 2);
  assert.equal(run(['scan', 'a.sol', '--chain', 'nope']).status, 2);
  assert.equal(run(['scan', 'a.sol', '--current-block-time', '0']).status, 2);
  const help = run(['scan', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /blockclock scan/);
});

test('the original command still works alongside scan', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--period-blocks/);
  assert.match(help.stdout, /blockclock scan/);
});
