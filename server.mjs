/**
 * @fileoverview Thin routing entrypoint for the Context Monitor sidecar.
 */

import { SidecarApp, Response } from 'sidecar_sdk';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetHandler, createAgyCssHandler } from 'antigravity-sidecar-kit/server';
import { exitWithLanguageServer } from 'antigravity-sidecar-kit/lifecycle';
import { fetchFullTelemetry } from './lib/context-telemetry.mjs';
import { setAiCreditsOverageSetting } from './lib/plan-quota.mjs';
import { toggleMcpServerState, refreshMcpServerState } from './lib/mcp-manager.mjs';
import {
  fetchDiagnosticsSnapshot,
  closeTerminalById,
  restartSidecarById,
} from './lib/diagnostics.mjs';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));
const UI_DIR = join(__dirname, 'ui');
const serveAsset = (relPath, contentType) =>
  createAssetHandler(UI_DIR, relPath, contentType, { ResponseClass: Response });
const serveAgyCss = createAgyCssHandler({ ResponseClass: Response });

const app = new SidecarApp();

// Static UI asset routes
app.page('/', serveAsset('index.html', 'text/html; charset=utf-8'));
app.page('/index.html', serveAsset('index.html', 'text/html; charset=utf-8'));
app.page('/compiled_tailwind.css', serveAgyCss);
app.page('/styles.css', serveAsset('styles.css', 'text/css; charset=utf-8'));
app.page('/components.css', serveAsset('components.css', 'text/css; charset=utf-8'));
app.page('/core.js', serveAsset('core.js', 'text/javascript; charset=utf-8'));
app.page('/app.js', serveAsset('app.js', 'text/javascript; charset=utf-8'));
app.page('/components/context-drawers.js', serveAsset('components/context-drawers.js', 'text/javascript; charset=utf-8'));
app.page('/components/context-tab.js', serveAsset('components/context-tab.js', 'text/javascript; charset=utf-8'));
app.page('/components/mcp-budgets-tab.js', serveAsset('components/mcp-budgets-tab.js', 'text/javascript; charset=utf-8'));
app.page('/components/diagnostics-tab.js', serveAsset('components/diagnostics-tab.js', 'text/javascript; charset=utf-8'));

// Authenticated JSON API routes
app.api('/api/telemetry', async (data) => fetchFullTelemetry({
  cascadeId: data?.cascadeId ? String(data.cascadeId) : '',
  hostCascadeId: data?.hostCascadeId ? String(data.hostCascadeId) : '',
  workspaceUris: Array.isArray(data?.workspaceUris) ? data.workspaceUris : [],
}), 'POST');

app.api('/api/ai-credits/toggle', async (data) => setAiCreditsOverageSetting(Boolean(data?.enabled)), 'POST');
app.api('/api/mcp/toggle', async (data) => toggleMcpServerState(String(data?.serverName || ''), Boolean(data?.enabled)), 'POST');
app.api('/api/mcp/refresh', async (data) => refreshMcpServerState(String(data?.serverName || '')), 'POST');
app.api('/api/diagnostics', async (data) => fetchDiagnosticsSnapshot({ includeLogs: Boolean(data?.includeLogs) }), 'POST');
app.api('/api/terminals/close', async (data) => closeTerminalById(String(data?.terminalId || '')), 'POST');
app.api('/api/sidecars/restart', async (data) => restartSidecarById(String(data?.sidecarId || '')), 'POST');

await app.run();
// Antigravity on Windows doesn't stop sidecars when it quits; exit once its language server is gone.
exitWithLanguageServer({ app });
