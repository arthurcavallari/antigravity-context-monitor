/**
 * @fileoverview Thin routing entrypoint for the Context Monitor sidecar (<= 140 lines).
 */
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FallbackResponse, createAgyCssHandler, createAssetHandler, createShellClientHandler, createShellCssHandler } from 'antigravity-sidecar-kit/server';
import { registerUiRoutes } from 'antigravity-sidecar-kit';
import { exitWithLanguageServer } from 'antigravity-sidecar-kit/lifecycle';
import { registerStateSyncRoutes, removeServerInfo, writeServerInfo, isLoopbackOrigin, verifySidecarToken } from 'antigravity-sidecar-kit/state-sync';
import { fetchFullTelemetry, getLatestConversationSteps } from './lib/context-telemetry.mjs';
import { setAiCreditsOverageSetting } from './lib/plan-quota.mjs';
import { toggleMcpServerState, refreshMcpServerState } from './lib/mcp-manager.mjs';
import { fetchDiagnosticsSnapshot, closeTerminalById, restartSidecarById } from './lib/diagnostics.mjs';

const sdk = await import('sidecar_sdk').catch(() => null);
const Response = sdk?.Response || FallbackResponse;
class StubApp {
  constructor() { this.pages = new Map(); this.apis = new Map(); }
  page(p, fn) { this.pages.set(p, fn); }
  api(p, fn) { this.apis.set(p, fn); }
  async run() { return null; }
}

const __filename = realpathSync(fileURLToPath(import.meta.url)), __dirname = dirname(__filename);
const isMain = (() => { try { return realpathSync(resolve(process.argv[1])) === __filename; } catch { return false; } })();
const UI_DIR = join(__dirname, 'ui');
const serveAsset = (rel, type) => createAssetHandler(UI_DIR, rel, type, { ResponseClass: Response });
const serveShellClient = createShellClientHandler({ ResponseClass: Response });
let lastActiveCascadeId = '';

export function createMonitorStateSync(targetApp, options = {}) {
  const rpcOpts = options.rpcOptions || {};
  const mutators = {
    'mcp-toggle': (p) => toggleMcpServerState(String(p?.serverName || ''), Boolean(p?.enabled), rpcOpts),
    'mcp-refresh': (p) => refreshMcpServerState(String(p?.serverName || ''), rpcOpts),
    'ai-credits-toggle': (p) => setAiCreditsOverageSetting(Boolean(p?.enabled), rpcOpts),
    'restart-sidecar': (p) => restartSidecarById(String(p?.id || p?.sidecarId || ''), rpcOpts),
    'close-terminal': (p) => closeTerminalById(String(p?.id || p?.terminalId || ''), rpcOpts),
    ...(options.mutators || {}),
  };

  let sync, lastNotifyMeta = { severity: 'info', triggerTurn: true };
  const mcpTools = [
    {
      name: 'get_context_telemetry',
      description: 'Fetch context window breakdown, prompt fit advisor, MCP catalog, and quota telemetry.',
      inputSchema: { type: 'object', properties: { cascadeId: { type: 'string' }, hostCascadeId: { type: 'string' }, workspaceUris: { type: 'array', items: { type: 'string' } } } },
      handler: async (args, ctx) => {
        const res = await (options.fetchTelemetry || fetchFullTelemetry)({ ...rpcOpts, cascadeId: String(args?.cascadeId || ''), hostCascadeId: String(args?.hostCascadeId || ctx?.conversationId || ''), workspaceUris: Array.isArray(args?.workspaceUris) ? args.workspaceUris : [] });
        if (res?.session?.cascadeId) lastActiveCascadeId = res.session.cascadeId;
        return res;
      },
    },
    { name: 'toggle_mcp_server', description: 'Enable or disable an MCP server.', inputSchema: { type: 'object', properties: { serverName: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['serverName', 'enabled'] }, handler: (args) => sync.mutate('mcp-toggle', { serverName: String(args?.serverName || ''), enabled: Boolean(args?.enabled) }) },
    { name: 'refresh_mcp_servers', description: 'Reload MCP server definitions.', inputSchema: { type: 'object', properties: { serverName: { type: 'string' } } }, handler: (args) => sync.mutate('mcp-refresh', { serverName: String(args?.serverName || '') }) },
    { name: 'set_ai_credits_overage', description: 'Toggle AI credit overages setting.', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] }, handler: (args) => sync.mutate('ai-credits-toggle', { enabled: Boolean(args?.enabled) }) },
    { name: 'restart_sidecar', description: 'Restart a sidecar process by ID.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, sidecarId: { type: 'string' } } }, handler: (args) => sync.mutate('restart-sidecar', { id: String(args?.id || args?.sidecarId || '') }) },
    { name: 'close_terminal', description: 'Terminate a background terminal by ID.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, terminalId: { type: 'string' } } }, handler: (args) => sync.mutate('close-terminal', { id: String(args?.id || args?.terminalId || '') }) },
  ];

  const notifyOpt = options.notifyAgent ? (msg, meta) => options.notifyAgent(msg, { ...meta, ...lastNotifyMeta }) : undefined;
  sync = registerStateSyncRoutes(targetApp, { sidecarId: 'context-monitor', initialState: () => ({ lastMutationAt: 0, lastAction: null }), mcpTools, ...options, ...(notifyOpt ? { notifyAgent: notifyOpt } : {}) });

  const origMutate = sync.mutate.bind(sync), origHandleMutate = sync.handleMutate.bind(sync), origHandleNotify = sync.handleNotify.bind(sync);
  sync.setState = (patch) => origMutate(patch);
  sync.writeServerInfo = (info = {}) => writeServerInfo(sync.dataDir, { port: info.port || Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0) || 52320, pid: info.pid ?? process.pid, token: info.token ?? (process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || null) });
  sync.removeServerInfo = () => removeServerInfo(sync.dataDir);
  sync.mutate = async (actionOrPatch, payload = {}) => {
    if (typeof actionOrPatch === 'string') {
      const fn = mutators[actionOrPatch];
      if (!fn) throw new Error(`Unknown mutation action: ${actionOrPatch}`);
      const result = await fn(payload), lastMutationAt = Math.max(Date.now(), (sync.getState()?.lastMutationAt || 0) + 1);
      return { ...origMutate({ lastMutationAt, lastAction: actionOrPatch, result }, { replace: true }), result };
    }
    return origMutate(actionOrPatch, payload);
  };
  const checkAuth = (d, ctx = {}) => {
    const hdrs = ctx?.headers || d?.headers, exp = options.authToken ?? process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    if (hdrs?.origin && !isLoopbackOrigin(hdrs.origin)) return { ok: false, status: 403, error: 'Forbidden origin' };
    if (exp && !verifySidecarToken(hdrs?.['x-sidecar-token'] || hdrs?.['X-Sidecar-Token'] || ctx?.query?.token || d?.token, exp)) return { ok: false, status: 401, error: 'Unauthorized' };
    return null;
  };
  sync.handleMutate = async (data, ctx = {}) => {
    if (data && typeof data.action === 'string') {
      const authErr = checkAuth(data, ctx);
      if (authErr) return authErr;
      const state = await sync.mutate(data.action, data.payload || {});
      return { ok: true, version: sync.globalState.currentVersion, state };
    }
    return origHandleMutate(data, ctx);
  };
  sync.handleNotify = async (data, ctx = {}) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return origHandleNotify(data, ctx);
    lastNotifyMeta = { severity: String(data.severity || 'info'), triggerTurn: data.triggerTurn !== false };
    const expConv = data.conversationId ?? data.conversation_id ?? data.cascadeId ?? ctx?.query?.conversationId;
    const isNew = typeof expConv === 'string' && expConv.trim().toLowerCase() === '_new';
    const resolvedConv = isNew ? (options.notifyAgent ? 'default' : '_new') : String(expConv || lastActiveCascadeId || targetApp?.config?.conversationId || (options.notifyAgent ? 'default' : ''));
    return origHandleNotify({ ...data, ...(resolvedConv ? { conversationId: resolvedConv } : {}) }, ctx);
  };
  sync.checkAuth = checkAuth;
  return sync;
}

export const app = (() => {
  const inst = (() => { try { return sdk?.SidecarApp ? new sdk.SidecarApp() : new StubApp(); } catch { return new StubApp(); } })();
  if (!inst.pages) { const pages = new Map(), orig = inst.page.bind(inst); inst.pages = pages; inst.page = (p, fn) => (pages.set(p, fn), orig(p, fn)); }
  if (!inst.apis) { const apis = new Map(), orig = inst.api.bind(inst); inst.apis = apis; inst.api = (p, fn, m = 'POST') => (apis.set(p, fn), orig(p, fn, m)); }
  return inst;
})();
for (const [route, file, type] of [
  ['/', 'index.html', 'text/html; charset=utf-8'], ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'], ['/components.css', 'components.css', 'text/css; charset=utf-8'],
  ['/core.js', 'core.js', 'text/javascript; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/components/context-drawers.js', 'components/context-drawers.js', 'text/javascript; charset=utf-8'], ['/components/context-tab.js', 'components/context-tab.js', 'text/javascript; charset=utf-8'],
  ['/components/mcp-budgets-tab.js', 'components/mcp-budgets-tab.js', 'text/javascript; charset=utf-8'], ['/components/diagnostics-tab.js', 'components/diagnostics-tab.js', 'text/javascript; charset=utf-8'],
]) app.page(route, serveAsset(file, type));
app.page('/compiled_tailwind.css', createAgyCssHandler({ ResponseClass: Response }));
app.page('/shell.css', createShellCssHandler({ ResponseClass: Response }));
app.page('/shell.js', serveShellClient);
registerUiRoutes(app, { modules: ['core', 'tabs', 'overlays', 'controls', 'surfaces'], ResponseClass: Response });
export const stateSync = createMonitorStateSync(app, isMain ? {} : { dataDir: '' });
const handleTelemetry = async (d) => {
  const res = await fetchFullTelemetry({ cascadeId: String(d?.cascadeId || ''), hostCascadeId: String(d?.hostCascadeId || ''), workspaceUris: Array.isArray(d?.workspaceUris) ? d.workspaceUris : [] });
  if (res?.session?.cascadeId) lastActiveCascadeId = res.session.cascadeId;
  return res;
};
for (const m of ['POST', 'GET']) app.api('/api/telemetry', handleTelemetry, m);
app.api('/api/diagnostics', async (d) => fetchDiagnosticsSnapshot({ includeLogs: Boolean(d?.includeLogs), steps: Array.isArray(d?.steps) ? d.steps : getLatestConversationSteps(String(d?.cascadeId || lastActiveCascadeId || '')) }), 'POST');
for (const [p, act] of [['/api/ai-credits/toggle', 'ai-credits-toggle'], ['/api/quota/ai-credits', 'ai-credits-toggle'], ['/api/mcp/toggle', 'mcp-toggle'], ['/api/mcp/refresh', 'mcp-refresh'], ['/api/terminals/close', 'close-terminal'], ['/api/diagnostics/close-terminal', 'close-terminal'], ['/api/sidecars/restart', 'restart-sidecar'], ['/api/diagnostics/restart-sidecar', 'restart-sidecar']]) app.api(p, async (d, ctx) => stateSync.checkAuth(d, ctx) || (await stateSync.mutate(act, d || {})).result, 'POST');
if (sdk?.SidecarApp && isMain) {
  const cleanup = () => stateSync.stop();
  process.once('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { cleanup(); process.exit(0); });
  await app.run();
  exitWithLanguageServer({ app, onExit: cleanup });
}
