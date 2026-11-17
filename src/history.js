// SPDX-FileCopyrightText: 2026 Cripteracia Unipessoal Lda
// SPDX-License-Identifier: MIT

/**
 * Block-time history, as plateaus.
 *
 * A schedule written in blocks was reasoned against the block time of its day.
 * To say what that schedule means now, you need the rate at each point since.
 * On the chains below the rate did not drift: it stepped, on announced dates,
 * and sat flat in between.
 *
 * Boundaries are the block at which the measured rate changes, rounded to the
 * nearest thousand. They are measurements, not consensus constants: treat
 * them as accurate to a few thousand blocks, which is minutes of wall-clock
 * time. The same data ships as data/block-time-history.json for anyone who
 * wants it without this library.
 */
export const BLOCK_TIME_HISTORY = {
  bsc: {
    chainId: 56,
    name: 'BNB Smart Chain',
    plateaus: [
      { fromBlock: 0, secondsPerBlock: 3, since: '2020-09', note: 'launch' },
      { fromBlock: 48_774_000, secondsPerBlock: 1.5, since: '2025-04', note: 'Lorentz' },
      { fromBlock: 52_340_000, secondsPerBlock: 0.75, since: '2025-06', note: 'Maxwell' },
      { fromBlock: 75_142_000, secondsPerBlock: 0.45, since: '2026-01', note: 'measured average' },
    ],
  },
};

function plateausOf(chain) {
  const entry = BLOCK_TIME_HISTORY[chain];
  if (!entry) {
    throw new RangeError(
      `no block-time history for "${chain}". Known: ${Object.keys(BLOCK_TIME_HISTORY).join(', ')}`,
    );
  }
  return entry.plateaus;
}

/** The plateau a block falls in. */
export function plateauAt(chain, block) {
  if (!Number.isInteger(block) || block < 0) {
    throw new RangeError(`block must be a non-negative integer (got ${block})`);
  }
  const plateaus = plateausOf(chain);
  let found = plateaus[0];
  for (const p of plateaus) {
    if (p.fromBlock <= block) found = p;
    else break;
  }
  return found;
}

/** Seconds per block in force at `block`. */
export function secondsPerBlockAt(chain, block) {
  return plateauAt(chain, block).secondsPerBlock;
}

/** Seconds per block on the newest plateau. */
export function latestSecondsPerBlock(chain) {
  const plateaus = plateausOf(chain);
  return plateaus[plateaus.length - 1].secondsPerBlock;
}

/**
 * Wall-clock seconds between two blocks, walking the plateaus.
 *
 * Blocks past the newest boundary are priced at the newest rate, so a span
 * that ends in the future is a projection that assumes no further change.
 */
export function secondsBetweenBlocks(chain, fromBlock, toBlock) {
  for (const [name, value] of Object.entries({ fromBlock, toBlock })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer (got ${value})`);
    }
  }
  if (toBlock < fromBlock) {
    throw new RangeError(`toBlock (${toBlock}) is before fromBlock (${fromBlock})`);
  }
  const plateaus = plateausOf(chain);
  let seconds = 0;
  for (let i = 0; i < plateaus.length; i++) {
    const start = Math.max(fromBlock, plateaus[i].fromBlock);
    const end = Math.min(toBlock, i + 1 < plateaus.length ? plateaus[i + 1].fromBlock : Infinity);
    if (end > start) seconds += (end - start) * plateaus[i].secondsPerBlock;
  }
  return seconds;
}
