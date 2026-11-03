/** @fileoverview Thin routing entrypoint for the Context Monitor sidecar. */
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FallbackResponse,
  createAgyCssHandler,
  createAssetHandler,
  createShellClientHandler,
  createShellCssHandler,
} from 'antigravity-sidecar-kit/server';
import { registerUiRoutes } from 'antigravity-sidecar-kit';
import { exitWithLanguageServer } from 'antigravity-sidecar-kit/lifecycle';
import { registerStateSyncRoutes } from 'antigravity-sidecar-kit/state-sync';
import {
  MUTATION_ROUTES,
  UI_STATIC_ASSETS,
  createSidecarAppInstance,
  wrapMonitorStateSync,
} from './lib/constants.mjs';
import { fetchFullTelemetry, getLatestConversationSteps } from './lib/context-telemetry.mjs';
import { fetchDiagnosticsSnapshot } from './lib/diagnostics.mjs';
import { buildMcpTools, checkMonitorAuth, createMonitorMutators } from './lib/mcp-tools.mjs';

const sdk = await import('sidecar_sdk').catch(() => null);
const Response = sdk?.Response || FallbackResponse;
const __filename = realpathSync(fileURLToPath(import.meta.url));
const UI_DIR = join(dirname(__filename), 'ui');
let isMain = false;
try {
  isMain = realpathSync(resolve(process.argv[1])) === __filename;
} catch {
  /* ignore */
}
let lastActiveCascadeId = '';

export function createMonitorStateSync(targetApp, options = {}) {
  const mutators = createMonitorMutators(options.rpcOptions || {}, options.mutators || {});
  let sync;
  let lastNotifyMeta = { severity: 'info', triggerTurn: true };
  const mcpTools = buildMcpTools({
    getSync: () => sync,
    rpcOpts: options.rpcOptions || {},
    fetchTelemetry: options.fetchTelemetry || fetchFullTelemetry,
    onCascadeId: (id) => {
      lastActiveCascadeId = id;
    },
  });
  const notifyOpt = options.notifyAgent
    ? (msg, meta) => options.notifyAgent(msg, { ...meta, ...lastNotifyMeta })
    : undefined;
  sync = registerStateSyncRoutes(targetApp, {
    sidecarId: 'context-monitor',
    initialState: () => ({ lastMutationAt: 0, lastAction: null }),
    mcpTools,
    ...options,
    ...(notifyOpt ? { notifyAgent: notifyOpt } : {}),
  });
  return wrapMonitorStateSync(sync, {
    mutators,
    checkAuth: (d, ctx = {}) => checkMonitorAuth(d, ctx, options.authToken),
    onNotifyMeta: (meta) => {
      lastNotifyMeta = meta;
    },
    resolveConversation: (data, ctx) => {
      const expConv = data.conversationId ?? data.conversation_id ?? data.cascadeId ?? ctx?.query?.conversationId;
      const isNew = typeof expConv === 'string' && expConv.trim().toLowerCase() === '_new';
      const fallbackConv = options.notifyAgent ? 'default' : '';
      return isNew
        ? (fallbackConv || '_new')
        : String(expConv || lastActiveCascadeId || targetApp?.config?.conversationId || fallbackConv);
    },
  });
}

export const app = createSidecarAppInstance(sdk);
for (const [route, file, type] of UI_STATIC_ASSETS) {
  app.page(route, createAssetHandler(UI_DIR, file, type, { ResponseClass: Response }));
}
app.page('/compiled_tailwind.css', createAgyCssHandler({ ResponseClass: Response }));
app.page('/shell.css', createShellCssHandler({ ResponseClass: Response }));
app.page('/shell.js', createShellClientHandler({ ResponseClass: Response }));
registerUiRoutes(app, { modules: ['core', 'tabs', 'overlays', 'controls', 'surfaces'], ResponseClass: Response });
export const stateSync = createMonitorStateSync(app, isMain ? {} : { dataDir: '' });

const handleTelemetry = async (d) => {
  const res = await fetchFullTelemetry({
    cascadeId: String(d?.cascadeId || ''),
    hostCascadeId: String(d?.hostCascadeId || ''),
    workspaceUris: Array.isArray(d?.workspaceUris) ? d.workspaceUris : [],
  });
  if (res?.session?.cascadeId) lastActiveCascadeId = res.session.cascadeId;
  return res;
};
for (const m of ['POST', 'GET']) {
  app.api('/api/telemetry', handleTelemetry, m);
}
app.api('/api/diagnostics', async (d) => fetchDiagnosticsSnapshot({
  includeLogs: Boolean(d?.includeLogs),
  steps: Array.isArray(d?.steps)
    ? d.steps
    : getLatestConversationSteps(String(d?.cascadeId || lastActiveCascadeId || '')),
}), 'POST');
for (const [p, act] of MUTATION_ROUTES) {
  app.api(p, async (d, ctx) => stateSync.checkAuth(d, ctx) || (await stateSync.mutate(act, d || {})).result, 'POST');
}
if (sdk?.SidecarApp && isMain) {
  const cleanup = () => stateSync.stop();
  process.once('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => process.exit(0));
  }
  await app.run();
  exitWithLanguageServer({ app, onExit: cleanup });
}
