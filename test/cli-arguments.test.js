// SPDX-FileCopyrightText: 2026 1932819331hy-debug
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/blockclock.js', import.meta.url));
function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

// An option token is not the missing value of the preceding option.
// In particular, treating --json as an RPC URL misclassifies usage as exit 3.
const schedule = ['--start-block', '0', '--period-blocks', '100', '--periods', '20',
  '--design-block-time', '2'];
for (const next of ['--json', '--help', '--unknown']) {
  test(`a missing --rpc value before ${next} is a usage error`, () => {
    const r = run([...schedule, '--rpc', next]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /--rpc needs a value/);
    assert.doesNotMatch(r.stderr, /attempts|Failed to parse URL/);
  });
}

test('a missing value at the end is still a usage error', () => {
  const r = run([...schedule, '--rpc']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--rpc needs a value/);
});

test('a negative numeric value is still diagnosed as a numeric argument', () => {
  const r = run(['--chain', 'bsc', ...schedule, '--periods', '-1']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--periods must be greater than 0/);
  assert.doesNotMatch(r.stderr, /needs a value/);
});

test('--help still succeeds without schedule arguments', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.equal(r.stderr, '');
});
