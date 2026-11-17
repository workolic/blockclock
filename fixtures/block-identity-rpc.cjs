// SPDX-FileCopyrightText: 2026 1932819331hy-debug
// SPDX-License-Identifier: MIT

const assert = require('node:assert/strict');

// Preloaded only by CLI tests. Replace fetch completely, without opening a
// socket or allowing any request to fall through to a real RPC provider.
globalThis.fetch = async (url, init) => {
  assert.equal(url, 'https://block-identity.invalid');
  assert.equal(init.method, 'POST');
  const request = JSON.parse(init.body);
  assert.equal(request.method, 'eth_getBlockByNumber');
  assert.equal(request.params[1], false);
  const tag = request.params[0];
  let number = tag === 'latest' ? 1000 : Number(BigInt(tag));
  if (process.env.BLOCKCLOCK_WRONG_END === '1' && number === 300) number = 301;
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    number: '0x' + number.toString(16), timestamp: '0x' + (10000 + number).toString(16),
  } }));
};
