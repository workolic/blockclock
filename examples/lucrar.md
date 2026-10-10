# Worked example: the schedule that produced this tool

This is our own contract. We publish it in full because a tool that warns about a class of bug is worth more when it shows the bug being found than when it describes one.

## The schedule as written

LCR, a BEP-20 token on BNB Chain, contract [`0x1510211E6DC81F5724A1BecA33C5AC70Dcca6CE0`](https://bscscan.com/token/0x1510211E6DC81F5724A1BecA33C5AC70Dcca6CE0). The contract was created in February 2022 and audited by Fairyproof the same month; the project launched publicly on 15 April 2022.

The release schedule counts from **2 April 2022** and runs for **80 periods of 2,628,000 blocks**.

Why 2,628,000? Because 2,628,000 × 3 seconds = 7,884,000 seconds = exactly 91.25 days, one quarter. BNB Chain blocks took 3 seconds when this was written, so 80 quarters was twenty years, and the documentation said the schedule ran to 2042.

## What the chain did instead

Not a slide. Three step changes, each halving or nearly halving the block time. Each row below is the average over the **20,000 blocks ending at** the stated block, read from `bsc-dataseed.bnbchain.org`:

| Date | Block | s/block over the preceding 20,000 |
|---|---|---|
| 2022-07-30 | 20,000,000 | 3.011 |
| 2024-11-14 | 44,000,000 | 3.000 |
| 2025-03-15 | 47,500,000 | 3.000 |
| 2025-05-03 | 49,000,000 | 1.500 |
| 2025-06-24 | 52,000,000 | 1.500 |
| 2025-09-04 | 60,000,000 | 0.750 |
| 2026-02-08 | 80,000,000 | 0.450 |
| 2026-09-04 | 120,000,000 | 0.450 |

Flat plateaus with clean ratios between them: 3 → 1.5 → 0.75 → 0.45. Bisecting for the transitions puts them at roughly block 48,774,000 (late April 2025, the Lorentz upgrade), block 52,340,000 (end of June 2025, Maxwell) and block 75,142,000 (mid-January 2026).

The schedule ran at **exactly** its design rate for its first three years. Then, on three specific and publicly announced days, it did not.

That is the uncomfortable part. This was not a slow drift nobody could have spotted. It was three dated events, and we still did not re-check what they did to a number compiled into a contract in 2022. If it can be missed when it is announced, it can be missed by anyone.

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

A quarter is now a fortnight. The twenty-year schedule is a six-year schedule.

The 1.295s "since start" figure is not a rate the chain ever ran at. It is the time-weighted mixture of those four plateaus, which is why BlockClock reports it as history rather than as a diagnosis.

## The part that was worse than the dates

Each period in our contract is a **claim window**, not a balance that accrues. Tokens can be claimed during the window; after it closes they stay in the contract.

So the drift did not only move dates. It closed windows. Of the periods elapsed, 5 were claimed. The rest expired, and those tokens are locked in the contract permanently.

To be exact, because this is where projects usually round in their own favour: **nothing was destroyed.** Total supply is and remains 100,000,000 and the contract has no function capable of destroying tokens. The tokens are out of reach, not gone.

The lesson worth passing on: **check whether your period is a window or a balance before you work out what the drift cost you.** A balance-based schedule that runs 6.6× fast releases early. A window-based one that runs 6.6× fast releases *nothing at all* unless somebody is watching the clock.

## What we did about it

- Nothing on chain. The contract has no upgrade path and no function that can change the schedule — the price of it also having no function that can change anything else. We did not redeploy and quietly reset the clock.
- We corrected the documentation. Every page that said the schedule ran to 2042 now says it was *designed* for 2042 and will in fact end around March 2028.
- We reported the general problem upstream as [issue #133](https://github.com/bnb-chain/community-contributions/issues/133) in `bnb-chain/community-contributions`, because the block-time changes affect every contract on BSC that counts periods in blocks, and most of their authors have not checked.
- We wrote this tool, so that checking takes one command.

## Reproducing the numbers

| Input | Value | Where it comes from |
|---|---|---|
| `--start-block` | 16579822 | the first BSC block at or after 2022-04-02T00:00:00Z (its timestamp is exactly 1648857600; block 16579821 is 23:59:57) |
| `--period-blocks` | 2628000 | the constant in the contract |
| `--periods` | 80 | the constant in the contract |
| `--design-block-time` | 3 | the `bsc` preset; BNB Chain's block time from launch until April 2025 |

The projected end date moves slightly between runs, because it is computed from the block time measured over the last 100,000 blocks. That is intended. A single figure pretending to be exact would be the same mistake the contract made.
