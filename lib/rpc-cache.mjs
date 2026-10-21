/**
 * @fileoverview Short-TTL cache for slow-changing Language Server RPCs so the 1.5s
 * telemetry poll does not refetch quota, user status, model config, and customizations.
 */

import { callLsRpc, getLsConfig } from 'antigravity-sidecar-kit/rpc';

export const SLOW_RPC_TTL_MS = 30_000;

const cache = new Map();

export function callLsRpcCached(method, options = {}, ttlMs = SLOW_RPC_TTL_MS) {
  const key = `${getLsConfig(options).lsAddress}|${method}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;

  const promise = callLsRpc(method, {}, options);
  cache.set(key, { at: Date.now(), promise });
  // Never cache failures: drop the entry so the next poll retries
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

export function clearRpcCache() {
  cache.clear();
}
