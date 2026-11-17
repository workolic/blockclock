// SPDX-FileCopyrightText: 2026 Cripteracia Unipessoal Lda
// SPDX-License-Identifier: MIT

/**
 * Source scanner: find the places where a Solidity contract uses block
 * numbers as a clock.
 *
 * This reads text. It does not compile, execute or prove anything, and it will
 * both miss things and flag things that are fine. What it does well is the
 * boring part a reviewer skips: list every line where time is being counted in
 * blocks, work out the block counts that can be worked out, and say what each
 * one meant when it was written and what it means now.
 *
 * The kinds of finding, strongest first:
 *
 *   hardcoded-block-time   seconds divided by a literal, e.g. `365 days / 3`.
 *                          The author wrote the block time into the contract.
 *   block-count-constant   a value named like a block count (`blocksPerDay`,
 *                          `intervalBlocksQuarter`) that resolves to a number.
 *   per-block-rate         a constant named as an amount per block
 *                          (`REWARD_PER_BLOCK`). More blocks per day, more per day.
 *   block-number-schedule  `block.number` compared with, or added to, something.
 *   block-number-anchor    `x = block.number`: harmless alone, but it is where
 *                          schedules start.
 *   block-number-lookup    `require(blockNumber < block.number)`: a snapshot
 *                          read, as vote checkpoints do. Listed, not counted.
 */

const TIME_UNITS = {
  seconds: 1n, minutes: 60n, hours: 3600n, days: 86400n, weeks: 604800n,
};

/** A divisor is read as "seconds per block" only in this range. */
const MAX_BLOCK_TIME_DIVISOR = 30n;

/** Names that say "this is a count of blocks". */
const BLOCK_COUNT_NAME = /blocks?(?![a-z]*hash)/i;

/** Names that say "this much for every block": a rate, which a faster chain pays out faster. */
const PER_BLOCK_NAME = /per_?block/i;

/** Smaller counts than this are loop bounds and confirmations, not schedules. */
const MIN_INTERESTING_BLOCKS = 20n;

/**
 * Blank out comments and string literals, keeping every newline and every
 * offset, so line and column numbers still refer to the original text.
 */
export function blankCommentsAndStrings(source) {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      let j = source.indexOf('\n', i);
      if (j === -1) j = n;
      blank(i, j);
      i = j;
    } else if (two === '/*') {
      let j = source.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      let j = i + 1;
      while (j < n && source[j] !== quote && source[j] !== '\n') {
        if (source[j] === '\\') j++;
        j++;
      }
      j = Math.min(n, j + 1);
      blank(i + 1, j - 1);
      i = j;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Split blanked source into statements, each with its starting offset. */
function statements(clean) {
  const found = [];
  let start = 0;
  let depth = 0; // parentheses: a `;` inside for(...) does not end the statement
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if ((c === ';' && depth === 0) || c === '{' || c === '}') {
      found.push({ text: clean.slice(start, i), offset: start });
      start = i + 1;
      depth = 0;
    }
  }
  if (start < clean.length) found.push({ text: clean.slice(start), offset: start });
  return found;
}

function tokenize(expr) {
  const tokens = [];
  const re = /\s*(0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE]\d+)?|\*\*|[A-Za-z_$][\w$.]*|[()+\-*/%])/y;
  let pos = 0;
  while (pos < expr.length) {
    if (/^\s*$/.test(expr.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(expr);
    if (!m) return null;
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  return tokens;
}

function parseLiteral(tok) {
  const t = tok.replace(/_/g, '');
  if (/^0x/i.test(t)) return BigInt(t);
  const m = /^(\d+)(?:\.(\d+))?(?:[eE](\d+))?$/.exec(t);
  if (!m) return null;
  const [, whole, frac = '', exp = '0'] = m;
  const shift = Number(exp) - frac.length;
  if (shift < 0 || shift > 80) return null; // not an integer, or absurd
  return BigInt(whole + frac) * 10n ** BigInt(shift);
}

/**
 * Evaluate an integer constant expression the way Solidity would for uints:
 * + - * / % ** and parentheses, time units, and names already known.
 *
 * Returns null when the expression depends on anything it cannot resolve.
 * `divisions` collects every `/ literal` it performs, with the dividend, so
 * the caller can see a block time written into the arithmetic.
 */
export function evaluateConstant(expr, symbols = new Map(), divisions = []) {
  const tokens = tokenize(expr);
  if (!tokens || tokens.length === 0) return null;
  let i = 0;
  const peek = () => tokens[i];
  const fail = Symbol('unresolved');

  const primary = () => {
    const tok = tokens[i++];
    if (tok === undefined) throw fail;
    if (tok === '(') {
      const v = additive();
      if (tokens[i++] !== ')') throw fail;
      return withUnit(v);
    }
    if (/^[\d]|^0x/i.test(tok)) {
      const v = parseLiteral(tok);
      if (v === null) throw fail;
      return withUnit({ value: v, literal: true });
    }
    // uint256(x) style casts are transparent.
    if (/^u?int\d*$/.test(tok) && peek() === '(') return primary();
    if (symbols.has(tok)) {
      const known = symbols.get(tok);
      return withUnit({ value: known.value, time: known.time, blocks: known.blocks });
    }
    throw fail;
  };
  const withUnit = (v) => {
    if (peek() in TIME_UNITS) {
      const unit = TIME_UNITS[tokens[i++]];
      return { value: v.value * unit, time: true };
    }
    return v;
  };
  const power = () => {
    const base = primary();
    if (peek() === '**') {
      i++;
      const exp = power();
      if (exp.value > 80n) throw fail;
      return { value: base.value ** exp.value, time: base.time, blocks: base.blocks };
    }
    return base;
  };
  const multiplicative = () => {
    let left = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = tokens[i++];
      const right = power();
      if (op === '*') {
        left = { value: left.value * right.value, time: left.time || right.time, blocks: left.blocks || right.blocks };
      } else {
        if (right.value === 0n) throw fail;
        if (op === '/') {
          divisions.push({
            dividend: left.value,
            divisor: right.value,
            divisorIsLiteral: !!right.literal,
            dividendIsTime: !!left.time,
            dividendIsBlocks: !!left.blocks,
          });
          left = { value: left.value / right.value, time: left.time, blocks: left.blocks };
        } else {
          left = { value: left.value % right.value, time: left.time, blocks: left.blocks };
        }
      }
    }
    return left;
  };
  const additive = () => {
    let left = multiplicative();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[i++];
      const right = multiplicative();
      const value = op === '+' ? left.value + right.value : left.value - right.value;
      if (value < 0n) throw fail;
      left = { value, time: left.time || right.time, blocks: left.blocks || right.blocks };
    }
    return left;
  };

  try {
    const result = additive();
    if (i !== tokens.length) return null;
    return result;
  } catch (err) {
    if (err === fail) return null;
    throw err;
  }
}

/**
 * Does this many seconds look like a duration a person would choose?
 * Whole minutes up to a day, whole hours beyond.
 */
function looksLikeWallClock(seconds) {
  if (seconds < 60n) return false;
  if (seconds % 3600n === 0n) return true;
  return seconds < 86400n && seconds % 60n === 0n;
}

/**
 * Seconds-per-block the arithmetic was written for, if it shows one.
 *
 * `secondsExpression / 3` is the tell: a duration in seconds divided by a
 * small literal. A dividend counts as seconds when it uses a time unit, or
 * when it is itself a round wall-clock duration (`365 * 24 * 60 * 60`).
 */
function impliedBlockTime(divisions) {
  for (const d of divisions) {
    if (!d.divisorIsLiteral || d.dividendIsBlocks) continue;
    if (d.divisor < 1n || d.divisor > MAX_BLOCK_TIME_DIVISOR) continue;
    if (d.dividendIsTime || (d.dividend >= 3600n && looksLikeWallClock(d.dividend))) {
      return Number(d.divisor);
    }
  }
  return null;
}

/**
 * `require(blockNumber < block.number)` guards a snapshot read: "the block you
 * are asking about must already be over". Vote checkpoints do this. It is an
 * ordering check on a caller-supplied block, not a schedule.
 */
function isPastBlockLookup(statement) {
  const m = /^(?:require|if)\s*\(\s*(?:([A-Za-z_$][\w$]*)\s*<\s*block\s*\.\s*number|block\s*\.\s*number\s*>\s*([A-Za-z_$][\w$]*))\s*[,)]/.exec(statement);
  if (!m) return false;
  const name = m[1] ?? m[2];
  return /block|timepoint/i.test(name) && !/start|end|deadline|(?<!b)lock|release|until|expir|cliff/i.test(name);
}

function position(source, offset) {
  let line = 1;
  let last = -1;
  for (let k = 0; k < offset; k++) {
    if (source[k] === '\n') { line++; last = k; }
  }
  return { line, column: offset - last };
}

function snippetAt(source, offset) {
  const start = source.lastIndexOf('\n', offset - 1) + 1;
  let end = source.indexOf('\n', offset);
  if (end === -1) end = source.length;
  const text = source.slice(start, end).trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/**
 * Scan one Solidity source file.
 *
 * @param {string} source
 * @param {object} [options]
 * @param {string} [options.file]                     Name to report.
 * @param {number} [options.designSecondsPerBlock]    Block time to assume when the contract does not say.
 * @param {number} [options.currentSecondsPerBlock]   Block time now.
 * @returns {{file: string|undefined, findings: object[]}}
 */
export function scanSource(source, options = {}) {
  const { file, designSecondsPerBlock, currentSecondsPerBlock } = options;
  const clean = blankCommentsAndStrings(source);
  const symbols = new Map();
  const findings = [];

  const add = (kind, offset, extra = {}) => {
    findings.push({ kind, file, ...position(source, offset), snippet: snippetAt(source, offset), ...extra });
  };

  const meaning = (blocks, design) => {
    const out = { blocks: blocks <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(blocks) : blocks.toString() };
    const d = design ?? designSecondsPerBlock;
    if (typeof out.blocks !== 'number') return out;
    if (d) {
      out.designSecondsPerBlock = d;
      out.designSeconds = out.blocks * d;
    }
    if (currentSecondsPerBlock) {
      out.currentSecondsPerBlock = currentSecondsPerBlock;
      out.currentSeconds = out.blocks * currentSecondsPerBlock;
      if (d) out.speedup = d / currentSecondsPerBlock;
    }
    return out;
  };

  for (const { text, offset } of statements(clean)) {
    const lead = text.length - text.trimStart().length;
    const at = offset + lead;
    const body = text.trim();
    if (!body) continue;

    // --- assignments and declarations: `<type and modifiers> name = expr` ---
    const assign = /^(?:[\w\s[\]().]*?[\s)])?([A-Za-z_$][\w$]*)\s*(?<![=!<>+\-*/%])=(?![=>])\s*([\s\S]+)$/.exec(body);
    let handledAsConstant = false;
    if (assign) {
      const [, name, rhs] = assign;
      const divisions = [];
      const value = evaluateConstant(rhs, symbols, divisions);
      if (value) {
        symbols.set(name, value);
        const blockTime = impliedBlockTime(divisions);
        const named = BLOCK_COUNT_NAME.test(name);
        if (blockTime !== null) {
          add('hardcoded-block-time', at, { name, ...meaning(value.value, blockTime) });
          // What comes out of seconds/blockTime is a block count, not a duration.
          symbols.set(name, { value: value.value, blocks: true, design: blockTime });
          handledAsConstant = true;
        } else if (PER_BLOCK_NAME.test(name)) {
          // An amount paid per block is a rate, not a count of blocks.
          add('per-block-rate', at, { name, value: value.value.toString() });
          handledAsConstant = true;
        } else if (named && value.value >= MIN_INTERESTING_BLOCKS) {
          // Inherit the block time from whatever this was derived from.
          const parent = [...rhs.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => symbols.get(m[0])).find((s) => s?.design);
          add('block-count-constant', at, { name, ...meaning(value.value, parent?.design) });
          symbols.set(name, { value: value.value, blocks: true, design: parent?.design });
          handledAsConstant = true;
        }
      }
    }

    // --- uses of block.number ---
    const re = /\bblock\s*\.\s*number\b/g;
    let m;
    let reported = false;
    while ((m = re.exec(text)) && !reported) {
      // blockhash(block.number - 1) is ordering/randomness, not a clock.
      const before = text.slice(0, m.index);
      if (/\bblockhash\s*\(\s*$/.test(before)) continue;
      const after = text.slice(m.index + m[0].length);
      const plainStore = /=\s*$/.test(before.replace(/[<>!=]=\s*$/, '')) && /^\s*$/.test(after) && !/[<>]|==|!=/.test(text);
      const divisions = [];
      // `block.number + <constant>`: price the constant.
      const added = /^\s*\+\s*([\s\S]+)$/.exec(after);
      let extra = {};
      if (added) {
        const v = evaluateConstant(added[1], symbols, divisions);
        if (v) extra = meaning(v.value, impliedBlockTime(divisions) ?? undefined);
      }
      if (plainStore) {
        add('block-number-anchor', offset + m.index);
      } else if (isPastBlockLookup(body)) {
        add('block-number-lookup', offset + m.index);
      } else if (/[<>]=?|[+\-*/%]|==/.test(text.replace(/\bblock\s*\.\s*number\b/g, ''))) {
        if (handledAsConstant && !Object.keys(extra).length) { reported = true; break; }
        add('block-number-schedule', offset + m.index, extra);
      }
      reported = true;
    }
  }

  return { file, findings };
}

/** Kinds that mean "this contract tells time in blocks". */
export const SCHEDULE_KINDS = new Set([
  'hardcoded-block-time', 'block-count-constant', 'per-block-rate', 'block-number-schedule',
]);

/** Sourcify chain ids for the chains this tool knows by name. */
export const CHAIN_IDS = { bsc: 56, ethereum: 1, polygon: 137, base: 8453, opbnb: 204 };

/**
 * Fetch the verified sources of a contract from Sourcify. No API key.
 *
 * @returns {Promise<{[path: string]: string}>}
 */
export async function fetchVerifiedSources(chainId, address, options = {}) {
  const { fetchImpl = globalThis.fetch, baseUrl = 'https://sourcify.dev/server' } = options;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new RangeError(`not a contract address: ${address}`);
  }
  // Sourcify rejects a mixed-case address whose checksum is wrong; lower case always works.
  const url = `${baseUrl}/v2/contract/${chainId}/${address.toLowerCase()}?fields=sources`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) {
    throw new RangeError(
      `no verified source for ${address} on chain ${chainId} at Sourcify. ` +
      'Download the source from the block explorer and scan the file instead.',
    );
  }
  if (!res.ok) throw new Error(`Sourcify answered ${res.status} for ${address}`);
  const body = await res.json();
  const sources = {};
  for (const [path, entry] of Object.entries(body?.sources ?? {})) {
    if (typeof entry?.content === 'string') sources[path] = entry.content;
  }
  if (Object.keys(sources).length === 0) {
    throw new Error(`Sourcify returned no source files for ${address}`);
  }
  return sources;
}
