/**
 * @fileoverview Shared Language Server read cache. Every Context Monitor iframe polls
 * /api/telemetry from this one Node process, so their reads merge into one request each
 * and slow-changing RPCs are served from a short TTL. Steps and generator metadata are not
 * cached here: context-telemetry.mjs re-fetches them only when the trajectory changes.
 */

import { createLsRpcCache } from 'antigravity-sidecar-kit/rpc';

export const CONVERSATION_RPC_TTL_MS = 2_000;
export const MCP_STATES_TTL_MS = 15_000;
export const SLOW_RPC_TTL_MS = 30_000;

export const lsRpcCache = createLsRpcCache({
  ttlMs: {
    GetAllCascadeTrajectories: CONVERSATION_RPC_TTL_MS,
    GetMcpServerStates: MCP_STATES_TTL_MS,
    GetCascadeModelConfigData: SLOW_RPC_TTL_MS,
    GetCustomizationStates: SLOW_RPC_TTL_MS,
    GetUserStatus: SLOW_RPC_TTL_MS,
    RetrieveUserQuotaSummary: SLOW_RPC_TTL_MS,
  },
});

export function callLsRpcCached(method, body = {}, options = {}) {
  return lsRpcCache.call(method, body, options);
}

// After a write (MCP toggle/refresh, AI credits toggle) the next poll must see fresh state
export function clearRpcCache() {
  lsRpcCache.invalidate();
}
