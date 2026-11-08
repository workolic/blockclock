// SPDX-FileCopyrightText: 2026 1932819331hy-debug
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import { getBlock, getBlockNumber, RpcError, RpcShapeError, BlockNotFoundError } from '../src/index.js';
import { rpcCall } from '../src/rpc.js';

const url = 'https://example.invalid';

// The transport is injected, but real Response.json() decodes every fixture.
function responseSequence(responses) {
  let calls = 0;
  return {
    get calls() { return calls; },
    rpc: {
      retries: 1,
      fetchImpl: async (requestUrl, init) => {
        assert.equal(requestUrl, url);
        assert.equal(init.method, 'POST');
        const response = responses[Math.min(calls++, responses.length - 1)];
        if (response instanceof Error) throw response;
        return new Response(response.body, { status: response.status ?? 200 });
      },
    },
  };
}

for (const body of ['true', '1', '"unavailable"', 'null', 'false', '0', '""', '[]', '[1]', '{}']) {
  test(`rejects malformed response ${body} without retrying`, async () => {
    const node = responseSequence([{ body }]);
    const error = await getBlockNumber(url, node.rpc).then(
      () => assert.fail('malformed response must not succeed'),
      (err) => err,
    );
    assert.equal(node.calls, 1, `deterministic response was retried (${error.name}: ${error.message})`);
    assert.ok(error instanceof RpcShapeError, `${error.name}: ${error.message}`);
    assert.equal(error.url, url);
    assert.equal(error.method, 'eth_blockNumber');
  });
}

test('a valid result envelope still returns the parsed block number', async () => {
  const node = responseSequence([{ body: '{"jsonrpc":"2.0","id":1,"result":"0x2a"}' }]);
  assert.equal(await getBlockNumber(url, node.rpc), 42);
  assert.equal(node.calls, 1);
});

test('a null result remains a result, and a missing block stays BlockNotFoundError', async () => {
  const node = responseSequence([{ body: '{"jsonrpc":"2.0","id":1,"result":null}' }]);
  assert.equal(await rpcCall(url, 'eth_getBlockByNumber', ['latest', false], node.rpc), null);
  await assert.rejects(() => getBlock(url, 'latest', node.rpc), BlockNotFoundError);
  assert.equal(node.calls, 2, 'each call should make exactly one request');
});

test('an RPC error remains deterministic and preserves its diagnostic', async () => {
  const node = responseSequence([{
    body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"missing trie node"}}',
  }]);
  await assert.rejects(() => getBlockNumber(url, node.rpc), (err) => {
    assert.ok(err instanceof RpcShapeError);
    assert.match(err.message, /missing trie node/);
    return true;
  });
  assert.equal(node.calls, 1);
});

test('an HTTP refusal is not retried', async () => {
  const node = responseSequence([{ status: 403, body: 'Forbidden' }]);
  await assert.rejects(() => getBlockNumber(url, node.rpc), RpcShapeError);
  assert.equal(node.calls, 1);
});

for (const [name, first] of [
  ['temporary HTTP failure', { status: 503, body: 'Unavailable' }],
  ['transport failure', new TypeError('synthetic connection failure')],
]) {
  test(`${name} can still retry successfully`, async () => {
    const node = responseSequence([first, { body: '{"jsonrpc":"2.0","id":1,"result":"0x2a"}' }]);
    assert.equal(await getBlockNumber(url, node.rpc), 42);
    assert.equal(node.calls, 2);
  });
}

test('an exhausted transport failure keeps its RpcError and cause', async () => {
  const cause = new TypeError('synthetic connection failure');
  const node = responseSequence([cause]);
  await assert.rejects(() => getBlockNumber(url, node.rpc), (err) => {
    assert.ok(err instanceof RpcError);
    assert.ok(!(err instanceof RpcShapeError));
    assert.equal(err.cause, cause);
    return true;
  });
  assert.equal(node.calls, 2);
});
