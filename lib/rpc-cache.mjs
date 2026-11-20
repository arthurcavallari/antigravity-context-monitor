/**
 * @fileoverview Shared Language Server read cache. Every Context Monitor iframe polls
 * /api/telemetry from this one Node process, so their reads merge into one request each
 * and slow-changing RPCs are served from a short TTL. Steps and generator metadata are not
 * cached here: context-telemetry.mjs re-fetches them only when the trajectory changes.
 */

import { callLsRpc, createLsRpcCache, getLsConfig } from 'antigravity-sidecar-kit/rpc';
import { recordLiveCatalogFetch } from './model-catalog.mjs';

export const CONVERSATION_RPC_TTL_MS = 2_000;
export const MCP_STATES_TTL_MS = 15_000;
export const SLOW_RPC_TTL_MS = 30_000;

export const lsRpcCache = createLsRpcCache({
  ttlMs: {
    GetAllCascadeTrajectories: CONVERSATION_RPC_TTL_MS,
    GetMcpServerStates: MCP_STATES_TTL_MS,
    GetAvailableModels: SLOW_RPC_TTL_MS,
    GetCascadeModelConfigData: SLOW_RPC_TTL_MS,
    GetCustomizationStates: SLOW_RPC_TTL_MS,
    GetUserStatus: SLOW_RPC_TTL_MS,
    RetrieveUserQuotaSummary: SLOW_RPC_TTL_MS,
  },
  rpcFn: async (method, body, options) => {
    const res = await callLsRpc(method, body, options);
    if (method === 'GetAvailableModels') {
      recordLiveCatalogFetch(getLsConfig(options).lsAddress, options?.nowMs ?? Date.now());
    }
    return res;
  },
});

export function callLsRpcCached(method, body = {}, options = {}) {
  return lsRpcCache.call(method, body, options);
}

export function invalidateModelCatalogRpcs() {
  lsRpcCache.invalidate('GetAvailableModels', 'GetCascadeModelConfigData', 'GetUserStatus');
}

const extraClearHooks = new Set();

export function registerRpcCacheClearHook(fn) {
  if (typeof fn === 'function') extraClearHooks.add(fn);
}

// After a write (MCP toggle/refresh, AI credits toggle) the next poll must see fresh state
export function clearRpcCache() {
  lsRpcCache.invalidate();
  for (const fn of extraClearHooks) fn();
}
