// SPDX-FileCopyrightText: 2026 1932819331hy-debug
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/blockclock.js', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/block-identity-rpc.cjs', import.meta.url));

function run({ wrongEnd, json }) {
  const result = spawnSync(process.execPath, ['--require', fixture, cli,
    '--rpc', 'https://block-identity.invalid', '--start-block', '100',
    '--period-blocks', '100', '--periods', '2', '--design-block-time', '1',
    '--sample-blocks', '100', ...(json ? ['--json'] : [])], {
    encoding: 'utf8', timeout: 10000,
    // Keep the subprocess's only preload deterministic. The fixture itself
    // supplies all responses and never delegates to the network.
    env: { ...process.env, NODE_OPTIONS: '', BLOCKCLOCK_WRONG_END: wrongEnd ? '1' : '0' },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

for (const json of [true, false]) {
  const mode = json ? 'JSON' : 'text';
  test(`${mode} CLI rejects the wrong end header without printing a success report`, () => {
    const result = run({ wrongEnd: true, json });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /block 300: node returned block 301/);
  });

  test(`${mode} CLI still reports success for matching block headers`, () => {
    const result = run({ wrongEnd: false, json });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    if (json) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.endBlock, 300);
      assert.equal(report.projectedEnd, 10300);
      assert.equal(report.projectedEndIsEstimate, false);
      assert.equal(report.withinTolerance, true);
    } else {
      assert.match(result.stdout, /Ends\s+block 300\s+\(already passed\)/);
      assert.match(result.stdout, /actual\s+1970-01-01/);
      assert.match(result.stdout, /OK\s+drift of 0\.0%/);
      assert.doesNotMatch(result.stdout, /estimated/);
    }
  });
}
