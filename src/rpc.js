/**
 * Minimal JSON-RPC client. No dependencies: Node 18+ has global fetch.
 */

export class RpcError extends Error {
  constructor(message, { url, method, cause } = {}) {
    super(message);
    this.name = 'RpcError';
    this.url = url;
    this.method = method;
    if (cause) this.cause = cause;
  }
}

/** Thrown when the chain answers and says that block does not exist. */
export class BlockNotFoundError extends RpcError {
  constructor(message, context) {
    super(message, context);
    this.name = 'BlockNotFoundError';
  }
}

/** Thrown when the endpoint answers, but with something we cannot read. */
export class RpcShapeError extends RpcError {
  constructor(message, context) {
    super(message, context);
    this.name = 'RpcShapeError';
  }
}

/**
 * @param {string} url      JSON-RPC endpoint
 * @param {string} method   e.g. 'eth_blockNumber'
 * @param {unknown[]} params
 * @param {{timeoutMs?: number, retries?: number, fetchImpl?: typeof fetch}} [opts]
 */
export async function rpcCall(url, method, params = [], opts = {}) {
  const { timeoutMs = 15000, retries = 2, fetchImpl = fetch } = opts;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // 4xx other than 429 is the endpoint refusing us, not a blip.
        const deterministic = res.status >= 400 && res.status < 500 && res.status !== 429;
        const Err = deterministic ? RpcShapeError : RpcError;
        throw new Err(`HTTP ${res.status} from ${url}`, { url, method });
      }
      const body = await res.json();
      if (body && body.error) {
        // The node understood us and said no. Retrying will not change that.
        throw new RpcShapeError(
          `${method}: ${body.error.message || 'RPC error'}`,
          { url, method },
        );
      }
      if (!body || !('result' in body)) {
        throw new RpcShapeError(`${method}: response had no result field`, { url, method });
      }
      return body.result;
    } catch (err) {
      if (err instanceof RpcShapeError) throw err; // deterministic: do not retry
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new RpcError(`${method} failed after ${retries + 1} attempts: ${lastError?.message}`, {
    url,
    method,
    cause: lastError,
  });
}

/** Parse a 0x-quantity, refusing anything that is not one. */
function quantity(value, { url, method, what }) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new RpcShapeError(
      `${what} was not a hex quantity (got ${JSON.stringify(value)})`,
      { url, method },
    );
  }
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n)) {
    throw new RpcShapeError(`${what} exceeds safe integer range (${value})`, { url, method });
  }
  return n;
}

/** Current head block number. */
export async function getBlockNumber(url, opts) {
  const result = await rpcCall(url, 'eth_blockNumber', [], opts);
  return quantity(result, { url, method: 'eth_blockNumber', what: 'block number' });
}

/**
 * Block header, reduced to what we need. Accepts a number or a tag such as 'latest'.
 * @returns {Promise<{number: number, timestamp: number}>}
 */
export async function getBlock(url, blockNumber, opts) {
  const method = 'eth_getBlockByNumber';
  if (typeof blockNumber === 'number' && (!Number.isInteger(blockNumber) || blockNumber < 0)) {
    throw new RangeError(`block number must be a non-negative integer (got ${blockNumber})`);
  }
  const tag = typeof blockNumber === 'number' ? '0x' + blockNumber.toString(16) : blockNumber;
  const block = await rpcCall(url, method, [tag, false], opts);
  if (block === null || block === undefined) {
    throw new BlockNotFoundError(`block ${blockNumber} not found`, { url, method });
  }
  return {
    number: quantity(block.number, { url, method, what: `block ${blockNumber} number` }),
    timestamp: quantity(block.timestamp, { url, method, what: `block ${blockNumber} timestamp` }),
  };
}
