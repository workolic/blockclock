# BlockClock

[![ci](https://github.com/workolic/blockclock/actions/workflows/ci.yml/badge.svg)](https://github.com/workolic/blockclock/actions/workflows/ci.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

**Does your block-count schedule still mean what you think it means?**

A contract that says *"one unlock every 2,628,000 blocks"* is really saying *"one unlock every 91.25 days"* — but only while a block takes 3 seconds. Chains speed up. The contract does not notice. Your documentation does not notice. Your holders notice.

BlockClock measures the gap: it reads the chain's current block time, compares it to the one your schedule assumed, and tells you where your schedule now actually lands.

```
$ npx github:workolic/blockclock --chain bsc --start-block 16579822 --period-blocks 2628000 --periods 80

  Block time   design 3s  ·  now 0.450s  ·  since start 1.295s
  Measured     blocks 126779697–126879697
  Drift        +566.4%  (periods run 6.66x faster than designed)

  One period   meant to take 3 months  ·  actually takes 14 days
  Periods      41 of 80 elapsed  ·  18 expected by now  ·  +23 ahead of plan

  Ends         block 226819822
               intended  2042-03-28
               projected 2028-03-14
               early by 14 years

  FAIL  drift of 566.4% exceeds the 5% you allowed.
```

That is a real schedule on a real chain. It was written for 2042. It ends in 2028.

## Why this exists

BNB Chain's block time went from 3 seconds to roughly 0.45 seconds, in three steps: Lorentz (April 2025) took it to 1.5s, Maxwell (June 2025) to 0.75s, and a third step in January 2026 to ~0.45s. Every contract that counts periods in blocks — unlocks, vesting cliffs, claim windows, epoch rewards, timelocks, fee schedules — is now running about six and a half times faster than its authors wrote down. Most of those authors have not checked, and the changes were announced, which is the part that should worry you: a dated, public event is apparently still easy to miss.

We found this in our own contract, which is how the tool came to exist. We reported the general problem to BNB Chain as [issue #133](https://github.com/bnb-chain/community-contributions/issues/133) and then wrote the checker we had asked for. We would rather other teams find this with a command than with a support ticket.

The same thing happens in the other direction, and more quietly: a chain that slows down stretches a cliff you promised would be over.

## Install

Node 18 or newer. No dependencies.

```bash
npx github:workolic/blockclock --help    # straight from this repo
git clone https://github.com/workolic/blockclock && cd blockclock && node bin/blockclock.js --help
```

Not on npm yet. The examples below write `blockclock` for readability; until it is published, that is `node bin/blockclock.js` or `npx github:workolic/blockclock`.

## Use

```bash
blockclock \
  --chain bsc \
  --start-block 16579822 \
  --period-blocks 2628000 \
  --periods 80
```

| Option | |
|---|---|
| `--chain <name>` | `bsc`, `ethereum`, `polygon`, `base` — sets a public RPC and the chain's *historical* design block time, which is the number your contract was reasoned against |
| `--rpc <url>` | any EVM JSON-RPC endpoint; overrides `--chain`. An old `--start-block` needs an archive node — public endpoints prune, and BlockClock will tell you when yours has |
| `--start-block <n>` | the block your schedule counts from |
| `--period-blocks <n>` | blocks in one period |
| `--periods <n>` | how many periods the schedule has |
| `--design-block-time <s>` | the block time your schedule assumed, if it differs from the preset |
| `--sample-blocks <n>` | how far back to measure the current block time (default 100000). On a chain shorter than that the sample is clamped to the start of the chain and the output says so |
| `--max-drift <pct>` | exit non-zero past this (default 5). Drift is symmetric: `+100` means a period now takes half as long as designed, `-100` means twice as long, so one threshold catches both directions |
| `--json` | machine-readable output |

A *period* is whatever your contract repeats. You give this command the three numbers, it tells you where they now point. That keeps it useful whatever your contract looks like. To find the numbers in a contract you did not write, see [Scan a contract](#scan-a-contract).

### In CI

Exit code 1 means the drift passed your tolerance, so a scheduled job can tell you before a holder does. (2 is a bad argument, 3 is an unreachable endpoint, so a CI failure tells you which went wrong.)

There is a GitHub Action, so a weekly check is six lines:

```yaml
# .github/workflows/schedule-drift.yml
on:
  schedule: [{ cron: '0 7 * * 1' }]
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - id: drift
        uses: workolic/blockclock@v0.1.0
        with:
          chain: bsc
          start-block: 16579822
          period-blocks: 2628000
          periods: 80
          max-drift: 10
```

The step writes a table into the job summary and fails the job past `max-drift`. Set `fail-on-drift: false` to record the numbers without failing — which is what you want when, like us, the schedule is in a contract you cannot change.

Outputs: `drift-percent`, `within-tolerance`, `periods-elapsed`, `periods-expected`, `intended-end`, `projected-end`, and `report` (the full JSON).

Or call the CLI directly, if you would rather not depend on the Action:

```yaml
      - uses: actions/setup-node@v7
        with: { node-version: 20 }
      - run: npx github:workolic/blockclock --chain bsc --start-block 16579822
               --period-blocks 2628000 --periods 80 --max-drift 10
```

### As a library

```js
// until it is on npm: import … from './blockclock/src/index.js'
import { checkSchedule, measureBlockTime, projectSchedule } from 'blockclock';

const report = await checkSchedule({
  rpcUrl: 'https://bsc-dataseed.bnbchain.org',
  startBlock: 16579822,
  periodBlocks: 2628000,
  periods: 80,
  designSecondsPerBlock: 3,
});

console.log(report.paceFactor);    // 6.66  (always >= 1; read with report.pace)
console.log(report.driftPercent);  // 566.4
console.log(report.periodsAhead);  // 23
```

`projectSchedule()` is pure arithmetic and touches no network, so you can run it against your own historical data or in a test.

## Scan a contract

New in 0.2. `blockclock scan` reads Solidity source and lists every place the contract tells time in blocks, with what each block count meant when it was written and what it means today.

```
$ npx github:workolic/blockclock scan 0x1510211E6DC81F5724A1BecA33C5AC70Dcca6CE0 --chain bsc

blockclock scan: 0x1510211E6DC81F5724A1BecA33C5AC70Dcca6CE0

  block time now       0.45s  (newest known rate)
  assumed when written 3s  (unless the contract says otherwise)
  files read           1

  BLOCK TIME WRITTEN INTO THE CONTRACT
    LCRtoken.sol:549  intervalBlocksYear = 10,512,000 blocks
        written as  1 year  (at 3s per block)
        today       55 days  (at 0.45s per block)
        > intervalBlocksYear = 365 * 24 * 60 * 60 / 3;  // 1 year of blocks (1 each 3 seconds)

  BLOCK COUNTS
    LCRtoken.sol:550  intervalBlocksQuarter = 2,628,000 blocks
        written as  3 months  (at 3s per block)
        today       14 days  (at 0.45s per block)
        > intervalBlocksQuarter = intervalBlocksYear / 4;  // 1 quarter of blocks

  block.number USED AS A CLOCK
    LCRtoken.sol:547  1,677,600 blocks
        written as  58 days  (at 3s per block)
        today       9 days  (at 0.45s per block)
        > uint256 startBlock = block.number + ((daysUntilFirstRelease * 24 + hoursUntilMidnight) * 60 * 60 / 3); // April 1, 2022 aprox.
    LCRtoken.sol:610
        > require  (releasePeriods[0] <= block.number, "before release period");
    LCRtoken.sol:611
        > require  (block.number < releasePeriods[80] , "after release period");
    LCRtoken.sol:619
        > if (block.number >= releasePeriods[i] && block.number < releasePeriods[i+1])

  6 places where this contract counts time in blocks.
  Each one moves when the chain changes its block time. Check them against
  what the contract was meant to do, then run `blockclock` on the schedule.
```

That is our own token, read from its verified source. Line 549 is the whole story: the author (us) divided a year of seconds by 3 and stored the result as a number of blocks.

```bash
blockclock scan contracts/              # a file or a directory of .sol files
blockclock scan 0xAddress --chain bsc   # verified source, fetched from Sourcify (no API key)
blockclock scan contracts/ --measure    # measure the block time now instead of using the table
blockclock scan contracts/ --json
```

| Finding | What it is |
|---|---|
| block time written into the contract | seconds divided by a small literal, such as `365 days / 3`. The divisor is the block time the author assumed, so the scan uses it instead of the default |
| block counts | a value whose name says it counts blocks (`BLOCKS_PER_DAY`, `intervalBlocksQuarter`) and that resolves to a number |
| amounts per block | a constant named as an amount per block (`REWARD_PER_BLOCK`). The number is unchanged; the amount per day is not |
| `block.number` used as a clock | `block.number` compared with, or added to, something. When it is added to a constant, the constant is priced |
| `block.number` stored | `x = block.number`. Harmless alone; it is where schedules start |
| past-block lookups | `require(blockNumber < block.number)`, as vote checkpoints do. Listed, never counted |

Exit code 1 means the contract counts time in blocks, 0 means it does not, 2 is a bad argument and 3 is a source that could not be fetched. So `blockclock scan contracts/` in CI fails the day someone adds a block-count schedule.

**This is a text scan.** It does not compile or execute anything. It resolves constants it can follow within one file and gives up on the rest, it will flag reward-per-block maths that is working as designed, and it cannot see a schedule passed in through a constructor argument. Read it as a list of places to look, made by something that does not get bored.

An address only works when the source is verified on Sourcify. Otherwise download the source from the block explorer and scan the file.

### Block-time history as data

[`data/block-time-history.json`](data/block-time-history.json) is the table the scan uses: for each chain, the block at which the measured rate changed and the rate from then on. For BNB Smart Chain that is 3s from launch, 1.5s from about block 48,774,000, 0.75s from about 52,340,000 and 0.45s from about 75,142,000. Boundaries are measurements rounded to the nearest thousand blocks, good to a few minutes of wall-clock time.

```js
import { secondsBetweenBlocks, secondsPerBlockAt } from 'blockclock';

secondsPerBlockAt('bsc', 50_000_000);                      // 1.5
secondsBetweenBlocks('bsc', 16_579_822, 226_819_822);      // the whole schedule above, in seconds
```

Priced from that table alone, with no network, the schedule at the top of this page ends in March 2028. The live measurement says the same.

## What the numbers mean

| | |
|---|---|
| **design** block time | what your schedule assumed |
| **now** | measured across the last `--sample-blocks` blocks |
| **since start** | the time-weighted average across your whole schedule so far. It is history, not a diagnosis: one step change, three, or a genuine slide all produce the same number, so use it to see how much of the schedule ran at the old rate, not to infer what happened |
| **periods elapsed** | how many periods the block counter has actually passed |
| **expected by now** | how many should have passed, on the design clock |
| **intended end** | start time + total blocks × design block time |
| **projected end** | now + remaining blocks × current block time. Once the end block is already past, this becomes **actual**: the real timestamp of that block, read from the chain |

The projected end assumes the chain holds its current pace. It will not, exactly. Treat it as the answer to "if nothing else changes", which is the question most schedules were silently answering anyway.

## What it does not do

- The drift check does not read your contract: give it the three numbers. `blockclock scan` will find the lines they come from, but it reads text and does not execute anything.
- It does not know about pauses, admin overrides, or periods that need a transaction to claim. If a period is a *window* that expires rather than a balance that accrues, a fast chain does not just move your dates — it can close windows nobody reached in time. BlockClock will show you the count; what that means is yours to work out.
- It does not predict future block times. Nobody can.
- It reads one average over `--sample-blocks`. If the chain changed pace inside that window, you get the mixture. Shorten the window when you need "now" rather than "lately" — but not too far: block timestamps are whole seconds, so a window spanning only a few of them is mostly rounding. BlockClock says so when the reading has gone coarse, and refuses outright when the window spans no time at all.

## Contributing

Issues and pull requests welcome, particularly:

- more chain presets, with a source for the design block time
- a reader that pulls the start block and period count out of deployed storage, so the scan can hand its findings straight to the drift check
- block-time history for more chains, with the measurement that backs each boundary
- contracts the scan gets wrong, in either direction, as test fixtures

## Licence

MIT. Use it, fork it, vendor it into your audit tooling.

---

Built by [Lucrar](https://lucrar.pt) (Cripteracia Unipessoal Lda, Setúbal, Portugal) after finding the bug in our own schedule. The worked example in [`examples/lucrar.md`](examples/lucrar.md) is that schedule, with nothing left out.
