import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { LAUNCHER_CONFIG, startContextMonitorLauncher } from '../launch.mjs';
import { app, createMonitorStateSync } from '../server.mjs';
import { MCP_CONV_META_KEY } from 'antigravity-sidecar-kit/state-sync';
import { resolveHostTheme } from 'antigravity-sidecar-kit/theme';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(ROOT_DIR, 'ui');
const UI_SCRIPTS = ['core.js', 'components/context-drawers.js', 'components/context-tab.js', 'components/mcp-budgets-tab.js', 'components/diagnostics-tab.js'];

function collectRuntimeSourceFiles(dir, out = []) {
  const skipDirs = new Set(['node_modules', '.git', 'test', 'tests', '.idea']);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectRuntimeSourceFiles(full, out);
    else if (/\.(m?js|cjs)$/.test(entry.name) && entry.name !== 'setup.mjs') out.push(full);
  }
  return out;
}

test('launch.mjs exports expected config and repo preserves TIER_1_TELEMETRY in Hangar scanner', async () => {
  assert.equal(LAUNCHER_CONFIG.sidecarId, 'context-monitor');
  assert.equal(LAUNCHER_CONFIG.entryScript, 'server.mjs');
  assert.equal(LAUNCHER_CONFIG.port, 52320);
  assert.equal(LAUNCHER_CONFIG.healthPath, '/api/telemetry');

  let calledWith = null;
  await startContextMonitorLauncher({ runLauncher: async (opts) => { calledWith = opts; return { child: { pid: 9999 } }; } });
  assert.equal(calledWith.port, 52320);
  assert.equal(calledWith.healthPath, '/api/telemetry');

  const files = collectRuntimeSourceFiles(ROOT_DIR);
  assert.ok(files.length >= 8);
  const tier2Regex = /node:child_process|['"]child_process['"]/;
  const tier3Regex = /StartCascade|SendUserCascadeMessage|sidecar\.agent\.(sendMessage|startConversation)/;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    assert.equal(tier2Regex.test(src), false, `TIER_2 match in ${file}`);
    assert.equal(tier3Regex.test(src), false, `TIER_3 match in ${file}`);
  }
});

test('StateSync mutators, /api/notify, and /mcp tools including conversation_id scoping', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cm-sync-test-'));
  try {
    const calls = [];
    let notified = null;
    const mockApp = { apis: new Map(), api(path, fn) { this.apis.set(path, fn); } };

    const sync = createMonitorStateSync(mockApp, {
      dataRoot: tmpRoot,
      notifyAgent: async (msg, opts) => { notified = { msg, opts }; },
      fetchTelemetry: async (opts) => {
        calls.push({ fn: 'fetchFullTelemetry', opts });
        return { session: { cascadeId: opts.hostCascadeId || opts.cascadeId || 'default' }, context: { totalUsedTokens: 512 } };
      },
      mutators: {
        'mcp-toggle': async (p) => { calls.push({ fn: 'mcp-toggle', p }); return { ok: true, ...p }; },
        'mcp-refresh': async (p) => { calls.push({ fn: 'mcp-refresh', p }); return { refreshed: true }; },
        'ai-credits-toggle': async (p) => { calls.push({ fn: 'ai-credits-toggle', p }); return { useAiCredits: Boolean(p?.enabled) }; },
        'restart-sidecar': async (p) => { calls.push({ fn: 'restart-sidecar', p }); return { restarted: p?.id || p?.sidecarId }; },
        'close-terminal': async (p) => { calls.push({ fn: 'close-terminal', p }); return { closed: p?.id || p?.terminalId }; },
      },
    });

    let lastVal = null;
    for (const [action, payload, expectedKey, staleKey] of [
      ['mcp-toggle', { serverName: 'github', enabled: true }, 'serverName', null],
      ['mcp-refresh', { serverName: 'github' }, 'refreshed', 'serverName'],
      ['ai-credits-toggle', { enabled: true }, 'useAiCredits', 'refreshed'],
      ['restart-sidecar', { sidecarId: 'sc-1' }, 'restarted', 'useAiCredits'],
      ['close-terminal', { terminalId: 'term-1' }, 'closed', 'restarted'],
    ]) {
      const res = await mockApp.apis.get('/api/mutate')({ action, payload }, {});
      assert.equal(res.ok, true);
      assert.equal(res.state.lastAction, action);
      assert.ok(res.state.lastMutationAt > 0);
      assert.ok(expectedKey in res.state.result, `Expected ${expectedKey} in result`);
      if (staleKey) assert.equal(staleKey in res.state.result, false, `Stale key ${staleKey} leaked into ${action} result`);
      lastVal = res.state.result;
    }
    assert.deepEqual(lastVal, { closed: 'term-1' });

    const notifyRes = await mockApp.apis.get('/api/notify')({ message: 'Sidecar unhealthy', severity: 'warning', triggerTurn: true, conversationId: '_new' }, {});
    assert.equal(notifyRes.ok, true);
    assert.match(notified.msg, /Sidecar unhealthy/);
    assert.equal(notified.opts.conversationId, 'default');
    assert.equal(notified.opts.severity, 'warning');
    assert.equal(notified.opts.triggerTurn, true);

    const callMcp = (rpc) => mockApp.apis.get('/mcp')(rpc, {});
    const initRes = await callMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(initRes.result.serverInfo.name, 'context-monitor');

    const listRes = await callMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const toolNames = listRes.result.tools.map((t) => t.name);
    for (const expected of ['get_context_telemetry', 'toggle_mcp_server', 'refresh_mcp_servers', 'set_ai_credits_overage', 'restart_sidecar', 'close_terminal']) {
      assert.ok(toolNames.includes(expected), `Missing MCP tool ${expected}`);
    }
    const restartTool = listRes.result.tools.find((t) => t.name === 'restart_sidecar');
    const closeTool = listRes.result.tools.find((t) => t.name === 'close_terminal');
    assert.ok(restartTool.inputSchema.properties.sidecarId);
    assert.ok(closeTool.inputSchema.properties.terminalId);

    const callRes = await callMcp({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_context_telemetry', arguments: { workspaceUris: ['file:///c:/repo'] }, _meta: { [MCP_CONV_META_KEY]: 'conv-meta-777' } },
    });
    const telemPayload = JSON.parse(callRes.result.content[0].text);
    assert.equal(telemPayload.session.cascadeId, 'conv-meta-777');
    assert.equal(calls.findLast((c) => c.fn === 'fetchFullTelemetry').opts.hostCascadeId, 'conv-meta-777');

    await mockApp.apis.get('/api/notify')({ message: 'Follow-up after telemetry', severity: 'error', triggerTurn: false }, {});
    assert.equal(notified.opts.conversationId, 'conv-meta-777');
    assert.equal(notified.opts.severity, 'error');
    assert.equal(notified.opts.triggerTurn, false);

    await callMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'toggle_mcp_server', arguments: { serverName: 'rea', enabled: false } } });
    await callMcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'refresh_mcp_servers', arguments: {} } });
    await callMcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'set_ai_credits_overage', arguments: { enabled: false } } });
    await callMcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'restart_sidecar', arguments: { sidecarId: 'sc-2' } } });
    await callMcp({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'close_terminal', arguments: { terminalId: 'term-2' } } });
    assert.equal(sync.getState().lastAction, 'close-terminal');
    assert.deepEqual(sync.getState().result, { closed: 'term-2' });
    sync.stop();
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('SSE /api/events stream broadcasts live mutations, /shell.css serves AGY tokens, and server_info.json cleans up', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cm-sse-test-'));
  const mockApp = { apis: new Map(), api(p, fn) { this.apis.set(p, fn); } };
  const sync = createMonitorStateSync(mockApp, { dataRoot: tmpRoot, mutators: { 'mcp-refresh': async () => ({ refreshed: true }) } });

  const shellPage = await app.pages.get('/shell.css')();
  assert.equal(shellPage.status, 200);
  assert.match(shellPage.body, /--agy-ink-soft/);

  const agyUiCss = await app.pages.get('/ui.css')();
  assert.equal(agyUiCss.status, 200);
  for (const mod of ['core', 'tabs', 'overlays', 'controls', 'surfaces']) {
    assert.ok(agyUiCss.body.includes(`/* AgyUI Module: ${mod} */`), `Expected AgyUI module ${mod}`);
  }
  assert.equal(agyUiCss.body.includes('/* AgyUI Module: layout */'), false);

  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  sync.onServerStarted(server);
  const infoPath = join(sync.dataDir, 'server_info.json');

  try {
    assert.equal(existsSync(infoPath), true);
    const ssePayloads = [];
    await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/events`, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          for (const block of chunk.split('\n\n')) {
            const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
            if (dataLine) ssePayloads.push(JSON.parse(dataLine.slice(6)));
          }
          if (ssePayloads.length === 1) sync.mutate('mcp-refresh', {}).catch(reject);
          else if (ssePayloads.length >= 2) { req.destroy(); resolve(); }
        });
      });
      req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
    });
    assert.equal(ssePayloads[0].state.lastMutationAt, 0);
    assert.equal(ssePayloads[1].state.lastAction, 'mcp-refresh');
    assert.ok(ssePayloads[1].state.lastMutationAt > 0);
  } finally {
    sync.stop();
    await new Promise((r) => server.close(r));
    assert.equal(existsSync(infoPath), false);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('UI preserves 88% contrast across repeated polls with AgyShell loaded, suppresses SSE in hidden panes, reconnects on error, and sends Fix with Agent', async () => {
  const props = new Map(), docListeners = {}, winListeners = {}, createdEventSources = [], fetchCalls = [], scheduledTimers = [];
  class MockEventSource {
    constructor(url) { this.url = url; this.listeners = {}; createdEventSources.push(this); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    close() { this.closed = true; }
    emitState(payload) {
      const ev = { data: JSON.stringify(payload) };
      if (this.listeners.state) this.listeners.state(ev);
      else if (this.onmessage) this.onmessage(ev);
    }
  }
  const document = {
    readyState: 'loading', hidden: false, getElementById: () => null, addEventListener: (type, fn) => (docListeners[type] = fn),
    documentElement: { dataset: {}, style: { setProperty: (k, v) => props.set(k, v), getPropertyValue: (k) => props.get(k) || '', removeProperty: (k) => props.delete(k) } },
  };
  const window = {
    parent: {}, location: { search: '?conversationId=c1' }, EventSource: MockEventSource, addEventListener: (type, fn) => (winListeners[type] = fn),
    fetch: async (url, opts) => { fetchCalls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null }); return { ok: true, json: async () => ({ ok: true }) }; },
  };
  const ctx = vm.createContext({
    window, document, URLSearchParams, fetch: window.fetch,
    setTimeout: (fn, ms) => { scheduledTimers.push({ fn, ms }); return scheduledTimers.length; },
    clearTimeout() {},
  });
  const agyShellRes = await app.pages.get('/shell.js')();
  vm.runInContext(agyShellRes.body, ctx, { filename: 'shell.js' });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });

  let telemetryRefreshCount = 0;
  const origApiCall = window.ContextMonitor.apiCall;
  window.ContextMonitor.apiCall = async (path, body) => {
    if (path === '/api/telemetry') {
      telemetryRefreshCount++;
      return { isExecuting: false, session: { cascadeId: 'c1' }, context: { totalUsedTokens: 10 } };
    }
    return origApiCall(path, body);
  };

  const hostTheme = resolveHostTheme({ '--vscode-editor-background': '#18181b', '--vscode-editor-foreground': '#e4e4e7' });
  window.ContextMonitor.applyTheme(hostTheme);
  window.ContextMonitor.applyTheme(hostTheme);
  assert.match(props.get('--cm-muted'), /65%/);
  assert.match(props.get('--cm-secondary-fg'), /85%/);
  assert.match(props.get('--agy-ink-soft'), /88%/);

  vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  assert.equal(createdEventSources.length, 0);

  winListeners.load();
  assert.equal(createdEventSources.length, 1);
  const beforeCount = telemetryRefreshCount;
  createdEventSources[0].emitState({ state: { lastMutationAt: 0, lastAction: null } });
  assert.equal(telemetryRefreshCount, beforeCount);
  createdEventSources[0].emitState({ state: { lastMutationAt: 123456, lastAction: 'mcp-toggle' } });
  assert.equal(telemetryRefreshCount, beforeCount + 1);

  document.hidden = true;
  createdEventSources[0].emitState({ state: { lastMutationAt: 234567, lastAction: 'mcp-refresh' } });
  assert.equal(telemetryRefreshCount, beforeCount + 1);
  document.hidden = false;

  createdEventSources[0].onerror();
  assert.equal(createdEventSources[0].closed, true);
  scheduledTimers.at(-1).fn();
  assert.equal(createdEventSources.length, 2);
  assert.equal(typeof createdEventSources[1].listeners.state_changed, 'function');
  createdEventSources[1].listeners.state_changed({ data: JSON.stringify({ state: { lastMutationAt: 345678, lastAction: 'mcp-toggle' } }) });
  assert.equal(telemetryRefreshCount, beforeCount + 2);

  // CM-AUD-03: /api/diagnostics forwards steps to fetchDiagnosticsSnapshot and returns TOOL_OUTPUT_BLOAT advisories
  const diagApiRes = await app.apis.get('/api/diagnostics')({
    includeLogs: false,
    steps: [{ type: 'CORTEX_STEP_TYPE_VIEW_FILE', viewFile: { content: 'z'.repeat(40000) } }],
  });
  assert.equal(Array.isArray(diagApiRes.warnings), true);
  assert.equal(diagApiRes.warnings.length, 1);
  assert.equal(diagApiRes.warnings[0].code, 'TOOL_OUTPUT_BLOAT');

  const diagHtml = window.ContextMonitor.renderDiagnosticsLists({
    sidecars: [{ sidecarId: 'broken-sc', displayName: 'Broken Sidecar', statusBadge: 'ERRORED', isErrored: true, lastError: 'ECONNREFUSED' }],
  });
  assert.match(diagHtml, /data-action="fix-with-agent"/);
  assert.match(diagHtml, /Fix with Agent/);

  const res = await window.ContextMonitor.handleFixWithAgent({ getAttribute: (name) => (name === 'data-summary' ? 'Broken Sidecar ECONNREFUSED' : null) });
  assert.equal(res.ok, true);
  assert.equal(fetchCalls.at(-1).url, '/api/notify');
  assert.equal(fetchCalls.at(-1).body.message, 'Broken Sidecar ECONNREFUSED');
  assert.equal(fetchCalls.at(-1).body.severity, 'warning');
  assert.equal(fetchCalls.at(-1).body.conversationId, 'c1');
  assert.equal(fetchCalls.at(-1).body.title, 'Context Monitor Diagnostics');
});

test('CM-AUD-01 & CM-AUD-02: action mutations and direct POST routes enforce token & origin auth, return post-mutation version, and UI forwards token/workspace/_new', async () => {
  const prevToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-cm-tok-99';
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cm-auth-test-'));
  try {
    const mockApp = { apis: new Map(), api(p, fn) { this.apis.set(p, fn); } };
    const sync = createMonitorStateSync(mockApp, {
      dataRoot: tmpRoot,
      mutators: { 'mcp-refresh': async () => ({ refreshed: true }) },
    });

    const v0 = sync.globalState.currentVersion;
    // Unauthenticated action mutation must be rejected with 401
    const unauthRes = await sync.handleMutate({ action: 'mcp-refresh', payload: {} }, { headers: {} });
    assert.equal(unauthRes.ok, false);
    assert.equal(unauthRes.status, 401);

    // Cross-origin action mutation must be rejected with 403
    const badOriginRes = await sync.handleMutate(
      { action: 'mcp-refresh', payload: {} },
      { headers: { origin: 'https://evil.example.com', 'x-sidecar-token': 'secret-cm-tok-99' } }
    );
    assert.equal(badOriginRes.ok, false);
    assert.equal(badOriginRes.status, 403);

    // Authenticated action mutation succeeds and returns incremented version
    const authRes = await sync.handleMutate(
      { action: 'mcp-refresh', payload: {} },
      { headers: { origin: 'http://127.0.0.1:52320', 'x-sidecar-token': 'secret-cm-tok-99' } }
    );
    assert.equal(authRes.ok, true);
    assert.equal(authRes.version, v0 + 1);
    assert.equal(authRes.version, sync.globalState.currentVersion);

    // Direct POST route in app.apis must also reject unauthenticated calls when token is set
    const directUnauth = await app.apis.get('/api/mcp/refresh')({}, { headers: {} });
    assert.equal(directUnauth.ok, false);
    assert.equal(directUnauth.status, 401);

    // UI apiCall and notifyAgent forward X-Sidecar-Token, workspace, and preserve _new conversationId
    const uiCalls = [];
    const uiWin = {
      parent: {},
      location: { search: '?conversationId=_new&token=secret-cm-tok-99&workspace=C%3A%2Frepo' },
      sidecar: { workspace: 'C:/repo' },
      fetch: async (url, opts) => {
        uiCalls.push({ url, headers: opts?.headers, body: opts?.body ? JSON.parse(opts.body) : null });
        return { ok: true, json: async () => ({ ok: true }) };
      },
    };
    const uiCtx = vm.createContext({ window: uiWin, document: { documentElement: { dataset: {}, style: {} } }, URLSearchParams });
    vm.runInContext(readFileSync(join(UI_DIR, 'core.js'), 'utf8'), uiCtx, { filename: 'core.js' });

    await uiWin.ContextMonitor.notifyAgent({ message: 'Test notify from _new', severity: 'warning' });
    assert.equal(uiCalls.length, 1);
    assert.equal(uiCalls[0].headers['X-Sidecar-Token'], 'secret-cm-tok-99');
    assert.equal(uiCalls[0].body.conversationId, '_new');
    assert.equal(uiCalls[0].body.workspace, 'C:/repo');

    sync.stop();
  } finally {
    if (prevToken === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevToken;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

