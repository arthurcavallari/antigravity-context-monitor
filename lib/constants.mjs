/**
 * @fileoverview Shared constants, context ceilings, category metadata, and JSON config helpers.
 */

import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG_PATH,
  readJsonFile,
  writeJsonAtomic,
  writeJsonNoBom,
} from 'antigravity-sidecar-kit/config';
import {
  getCurrentRequestContext,
  removeServerInfo,
  writeServerInfo,
} from 'antigravity-sidecar-kit/state-sync';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));

export const writeJsonFile = writeJsonNoBom;

export {
  DEFAULT_CONFIG_PATH,
  readJsonFile,
  writeJsonAtomic,
};

export const SIDECAR_ID = 'context-monitor';

export const REPO_ROOT = process.env.SIDECAR_REPO_ROOT
  ? resolve(process.env.SIDECAR_REPO_ROOT)
  : resolve(__dirname, '..');

export const GEMINI_CONTEXT_CEILING = 256_000;   // 256k Cortex harness autocompact ceiling
export const GEMINI_NATIVE_CEILING = 1_048_576;  // 1.0M native Gemini API window
export const CLAUDE_CONTEXT_CEILING = 200_000;   // 200k tokens
export const DEFAULT_CONTEXT_CEILING = 256_000;

// antigravity-add-model lists each custom model under "custom-<the user's own model name>" and a
// borrowed Gemini provider. Such a model runs on the user's own provider, so Google plan limits,
// Gemini/Claude windows and the calibrated effort profiles don't describe it.
const CUSTOM_MODEL_ID_PATTERN = /^custom-/i;

export function isCustomModelId(modelId) {
  return CUSTOM_MODEL_ID_PATTERN.test(String(modelId || '').trim());
}

export const COMPACT_WARN_PCT = 80;
export const COMPACT_DANGER_PCT = 92;

export const MCP_META_TOOL_NAMES = new Set([
  'call_mcp_tool',
  'list_resources',
  'read_resource',
]);

export const CATEGORY_META = Object.freeze({
  messages: {
    id: 'messages',
    label: 'Messages',
    color: 'var(--chart-blue, #4e9de0)',
    inActiveContext: true,
  },
  systemTools: {
    id: 'systemTools',
    label: 'System tools',
    color: 'var(--chart-purple, #9b59b6)',
    inActiveContext: true,
  },
  systemPrompt: {
    id: 'systemPrompt',
    label: 'System prompt',
    color: '#2ec4b6',
    inActiveContext: true,
  },
  skills: {
    id: 'skills',
    label: 'Skills',
    color: 'var(--chart-yellow, #b5a642)',
    inActiveContext: true,
  },
  mcpToolsActive: {
    id: 'mcpToolsActive',
    label: 'MCP tools',
    color: 'var(--chart-green, #388a34)',
    inActiveContext: true,
  },
  mcpToolsDeferred: {
    id: 'mcpToolsDeferred',
    label: 'MCP tools (deferred)',
    color: '#64748b',
    inActiveContext: false,
  },
  freeSpace: {
    id: 'freeSpace',
    label: 'Free space (to compact)',
    color: 'transparent',
    inActiveContext: false,
  },
});

export const UI_STATIC_ASSETS = Object.freeze([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ['/components.css', 'components.css', 'text/css; charset=utf-8'],
  ['/core.js', 'core.js', 'text/javascript; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/components/context-drawers.js', 'components/context-drawers.js', 'text/javascript; charset=utf-8'],
  ['/components/subagent-drawer.js', 'components/subagent-drawer.js', 'text/javascript; charset=utf-8'],
  ['/components/context-tab.js', 'components/context-tab.js', 'text/javascript; charset=utf-8'],
  ['/components/mcp-budgets-tab.js', 'components/mcp-budgets-tab.js', 'text/javascript; charset=utf-8'],
  ['/components/diagnostics-tab.js', 'components/diagnostics-tab.js', 'text/javascript; charset=utf-8'],
]);

export const MUTATION_ROUTES = Object.freeze([
  ['/api/ai-credits/toggle', 'ai-credits-toggle'],
  ['/api/quota/ai-credits', 'ai-credits-toggle'],
  ['/api/mcp/toggle', 'mcp-toggle'],
  ['/api/mcp/refresh', 'mcp-refresh'],
  ['/api/terminals/close', 'close-terminal'],
  ['/api/diagnostics/close-terminal', 'close-terminal'],
  ['/api/sidecars/restart', 'restart-sidecar'],
  ['/api/diagnostics/restart-sidecar', 'restart-sidecar'],
]);

export function createSidecarAppInstance(sdk) {
  const pages = new Map();
  const apis = new Map();
  let inst = null;
  try {
    inst = sdk?.SidecarApp ? new sdk.SidecarApp() : null;
  } catch {}
  if (!inst) {
    return { pages, apis, page: (p, fn) => pages.set(p, fn), api: (p, fn) => apis.set(p, fn), run: async () => null };
  }
  const origPage = inst.page.bind(inst);
  const origApi = inst.api.bind(inst);
  inst.pages = pages;
  inst.apis = apis;
  inst.page = (p, fn) => {
    const wrapped = (d) => fn(d ?? getCurrentRequestContext());
    pages.set(p, wrapped);
    return origPage(p, wrapped);
  };
  inst.api = (p, fn, m = 'POST') => {
    const wrapped = (d, ctx) => fn(d, ctx ?? getCurrentRequestContext());
    apis.set(p, wrapped);
    return origApi(p, wrapped, m);
  };
  return inst;
}

export function wrapMonitorStateSync(sync, { mutators, checkAuth }) {
  const origMutate = sync.mutate.bind(sync);
  const origHandleMutate = sync.handleMutate.bind(sync);
  const origCheckAuth = typeof sync.checkAuth === 'function' ? sync.checkAuth.bind(sync) : null;
  sync.setState = (patch) => origMutate(patch);
  sync.writeServerInfo = (info = {}) =>
    writeServerInfo(sync.dataDir, {
      port: info.port || Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0) || 52320,
      pid: info.pid ?? process.pid,
      token: info.token ?? (process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || null),
    });
  sync.removeServerInfo = () => removeServerInfo(sync.dataDir);
  if (origCheckAuth) sync.checkAuth = origCheckAuth;
  else if (checkAuth) sync.checkAuth = checkAuth;
  sync.mutate = async (actionOrPatch, payload = {}) => {
    if (typeof actionOrPatch !== 'string') return origMutate(actionOrPatch, payload);
    const fn = Object.hasOwn(mutators, actionOrPatch) ? mutators[actionOrPatch] : null;
    if (typeof fn !== 'function') throw new Error(`Unknown mutation action: ${actionOrPatch}`);
    const result = await fn(payload);
    const prev = sync.getState() || {};
    const lastMutationAt = Math.max(Date.now(), (prev.lastMutationAt || 0) + 1);
    return { ...origMutate({ ...prev, lastMutationAt, lastAction: actionOrPatch, result }, { replace: true }), result };
  };
  sync.handleMutate = async (data, ctx = {}) => {
    if (!data || typeof data.action !== 'string') return origHandleMutate(data, ctx);
    const authErr = sync.checkAuth(data, ctx);
    if (authErr) return authErr;
    const fn = Object.hasOwn(mutators, data.action) ? mutators[data.action] : null;
    if (typeof fn !== 'function') return { ok: false, status: 400, error: `Unknown mutation action: ${data.action}` };
    try {
      const state = await sync.mutate(data.action, data.payload || {});
      return { ok: true, version: sync.globalState.currentVersion, state, result: state?.result };
    } catch (err) {
      return { ok: false, status: 500, error: String(err?.message || err) };
    }
  };
  return sync;
}
