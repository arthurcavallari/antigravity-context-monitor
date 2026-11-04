import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

import { app, createMonitorStateSync } from '../server.mjs';
import { MUTATION_ROUTES, createSidecarAppInstance } from '../lib/constants.mjs';
import { checkMonitorAuth } from '../lib/mcp-tools.mjs';
import { resolveHostTheme } from 'antigravity-sidecar-kit/theme';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(ROOT_DIR, 'ui');
const UI_SCRIPTS = [
  'core.js',
  'components/subagent-drawer.js',
  'components/context-drawers.js',
  'components/context-tab.js',
  'components/mcp-budgets-tab.js',
  'components/diagnostics-tab.js',
];

test('UI preserves 88% contrast across repeated polls with AgyShell loaded, suppresses SSE in hidden panes, reconnects on error, and sends Fix with Agent', async () => {
  const props = new Map();
  const docListeners = {};
  const winListeners = {};
  const createdEventSources = [];
  const fetchCalls = [];
  const scheduledTimers = [];

  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      createdEventSources.push(this);
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    close() {
      this.closed = true;
    }
    emitState(payload) {
      const ev = { data: JSON.stringify(payload) };
      if (this.listeners.state) this.listeners.state(ev);
      else if (this.onmessage) this.onmessage(ev);
    }
  }

  const { document: domDoc, HTMLElement, Element, customElements, CustomEvent } = parseHTML(
    '<!doctype html><html><body><div id="app"></div></body></html>'
  );
  const document = {
    readyState: 'loading',
    hidden: false,
    getElementById: (id) => domDoc.getElementById(id),
    createElement: (tag) => domDoc.createElement(tag),
    querySelector: (sel) => domDoc.querySelector(sel),
    querySelectorAll: (sel) => domDoc.querySelectorAll(sel),
    addEventListener: (type, fn) => (docListeners[type] = fn),
    documentElement: {
      dataset: {},
      style: {
        setProperty: (k, v) => props.set(k, v),
        getPropertyValue: (k) => props.get(k) || '',
        removeProperty: (k) => props.delete(k),
      },
    },
  };
  const window = {
    parent: {},
    location: { search: '?conversationId=c1' },
    EventSource: MockEventSource,
    addEventListener: (type, fn) => (winListeners[type] = fn),
    fetch: async (url, opts) => {
      fetchCalls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      return { ok: true, json: async () => ({ ok: true }) };
    },
  };
  const ctx = vm.createContext({
    window,
    document,
    HTMLElement,
    Element,
    customElements,
    CustomEvent,
    URLSearchParams,
    fetch: window.fetch,
    setTimeout: (fn, ms) => {
      scheduledTimers.push({ fn, ms });
      return scheduledTimers.length;
    },
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
  await new Promise((r) => setImmediate(r));
  assert.ok(document.getElementById('card-tab-slot'), 'real linkedom #app rendered #card-tab-slot on SSE refresh');

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

  const diagApiRes = await app.apis.get('/api/diagnostics')({
    includeLogs: false,
    steps: [{ type: 'CORTEX_STEP_TYPE_VIEW_FILE', viewFile: { content: 'z'.repeat(40000) } }],
  });
  assert.equal(diagApiRes.warnings?.[0]?.code, 'TOOL_OUTPUT_BLOAT');

  const diagHtml = window.ContextMonitor.renderDiagnosticsLists({
    sidecars: [{ sidecarId: 'broken-sc', displayName: 'Broken Sidecar', statusBadge: 'ERRORED', isErrored: true, lastError: 'ECONNREFUSED' }],
  });
  assert.match(diagHtml, /data-action="fix-with-agent"/);
  assert.match(diagHtml, /Fix with Agent/);

  const res = await window.ContextMonitor.handleFixWithAgent({
    getAttribute: (name) => (name === 'data-summary' ? 'Broken Sidecar ECONNREFUSED' : null),
  });
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
    const mockApp = {
      apis: new Map(),
      api(p, fn) {
        this.apis.set(p, fn);
      },
    };
    const sync = createMonitorStateSync(mockApp, {
      dataRoot: tmpRoot,
      mutators: { 'mcp-refresh': async () => ({ refreshed: true }) },
    });
    const v0 = sync.globalState.currentVersion;
    assert.equal((await sync.handleMutate({ action: 'mcp-refresh', payload: {} }, { headers: {} })).status, 401);
    assert.equal(
      (await sync.handleMutate({ action: 'mcp-refresh', payload: {} }, { headers: { origin: 'https://evil.example.com', 'x-sidecar-token': 'secret-cm-tok-99' } })).status,
      403
    );
    const authRes = await sync.handleMutate(
      { action: 'mcp-refresh', payload: {} },
      { headers: { origin: 'http://127.0.0.1:52320', 'x-sidecar-token': 'secret-cm-tok-99' } }
    );
    assert.equal(authRes.ok, true);
    assert.equal(authRes.version, v0 + 1);
    const badActionRes = await sync.handleMutate(
      { action: 'toString', payload: {} },
      { headers: { origin: 'http://127.0.0.1:52320', 'x-sidecar-token': 'secret-cm-tok-99' } }
    );
    assert.equal(badActionRes.ok, false);
    assert.equal(badActionRes.status, 400);
    const urlQueryAuthRes = await sync.handleMutate(
      { action: 'mcp-refresh', payload: {} },
      { headers: { origin: 'http://127.0.0.1:52320' }, url: '/api/mutate?token=secret-cm-tok-99' }
    );
    assert.equal(urlQueryAuthRes.ok, true);
    assert.equal((await app.apis.get('/api/mcp/refresh')({}, { headers: {} })).status, 401);
    assert.equal((await app.apis.get('/api/telemetry')({}, { headers: {} })).status, 401);
    assert.equal((await app.apis.get('/api/telemetry')({}, { headers: { origin: 'https://evil.example', 'x-sidecar-token': 'secret-cm-tok-99' } })).status, 403);
    assert.equal((await app.apis.get('/api/diagnostics')({}, { headers: {} })).status, 401);
    assert.equal((await app.apis.get('/api/diagnostics')({}, { headers: { origin: 'https://evil.example', 'x-sidecar-token': 'secret-cm-tok-99' } })).status, 403);

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
    assert.equal(uiCalls[0].headers['X-Sidecar-Token'], 'secret-cm-tok-99');
    assert.equal(uiCalls[0].body.conversationId, '_new');
    assert.equal(uiCalls[0].body.workspace, 'C:/repo');
    assert.equal(
      uiWin.ContextMonitor.html`<div>${'<script>evil()</script>'}<span>${uiWin.ContextMonitor.esc('<b>ok</b>')}</span></div>`,
      '<div>&lt;script&gt;evil()&lt;/script&gt;<span>&lt;b&gt;ok&lt;/b&gt;</span></div>'
    );
    sync.setState({ extraKey: 'keep-me' });
    await sync.mutate('mcp-refresh', {});
    assert.equal(sync.getState().extraKey, 'keep-me', 'wrapMonitorStateSync.mutate must preserve top-level state keys outside result');
    assert.equal(checkMonitorAuth({ checkAuth: () => null }, {}, {}), null, 'checkMonitorAuth must work on plain mock sync objects');
    const fbPoller = uiWin.ContextMonitor.createVisibilityPoller(() => 'sync-poll-result', { autoStart: false });
    assert.equal(fbPoller.triggerNow(), 'sync-poll-result', 'fallback createVisibilityPoller.triggerNow must execute onPoll even when stopped');
    sync.stop();

    // Verify SidecarApp 1-arg handler(data) invocation over real HTTP propagates req headers/query to checkAuth & StateSync
    class MockSdkSidecarApp {
      constructor() {
        this._apis = new Map();
      }
      page() {}
      api(p, fn) {
        this._apis.set(p, fn);
      }
      run() {
        const srv = http.createServer((req, res) => {
          const u = new URL(req.url, 'http://127.0.0.1');
          const handler = this._apis.get(u.pathname);
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            const data = body ? JSON.parse(body) : {};
            const out = await handler(data); // 1 arg only, matching sidecar_sdk
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out));
          });
        });
        return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
      }
    }
    const sdkApp = createSidecarAppInstance({ SidecarApp: MockSdkSidecarApp });
    const sdkSync = createMonitorStateSync(sdkApp, {
      dataRoot: tmpRoot,
      mutators: { 'mcp-toggle': async (p) => ({ serverName: p.serverName, enabled: p.enabled, source: 'plugin-config' }) },
    });
    for (const [p, act] of MUTATION_ROUTES) {
      sdkApp.api(p, async (d, ctx) => sdkSync.checkAuth(d, ctx) || (await sdkSync.mutate(act, d || {})).result, 'POST');
    }
    const httpSrv = await sdkApp.run();
    const port = httpSrv.address().port;
    try {
      const okToggle = await fetch(`http://127.0.0.1:${port}/api/mcp/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'secret-cm-tok-99' },
        body: JSON.stringify({ serverName: 'science_biomolecular_structure_viewer_mcp', enabled: false }),
      }).then((r) => r.json());
      assert.equal(okToggle.serverName, 'science_biomolecular_structure_viewer_mcp');
      assert.equal(okToggle.enabled, false);

      const badToggle = await fetch(`http://127.0.0.1:${port}/api/mcp/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'wrong-token' },
        body: JSON.stringify({ serverName: 'science_biomolecular_structure_viewer_mcp', enabled: false }),
      }).then((r) => r.json());
      assert.equal(badToggle.status, 401);
      assert.equal(badToggle.error, 'Unauthorized');

      // Verify 1-arg sync.handleMutate(data) inside runWithRequestContext resolves headers/query via checkMonitorAuth
      const { runWithRequestContext } = await import('antigravity-sidecar-kit/state-sync');
      const oneArgActionRes = await runWithRequestContext(
        { headers: { origin: 'http://127.0.0.1:52320', 'x-sidecar-token': 'secret-cm-tok-99' } },
        () => sdkSync.handleMutate({ action: 'mcp-toggle', payload: { serverName: 'srv-1', enabled: true } })
      );
      assert.equal(oneArgActionRes.ok, true);
      assert.equal(oneArgActionRes.result.serverName, 'srv-1');

      // Verify rawHtml refreshes LRU order for reused fragments so they are not evicted after 2,000 unique fragments
      const hotBadge = uiWin.ContextMonitor.rawHtml('<span class="hot-badge">ACTIVE</span>');
      for (let i = 0; i < 2500; i++) {
        if (i % 500 === 0) uiWin.ContextMonitor.rawHtml('<span class="hot-badge">ACTIVE</span>');
        uiWin.ContextMonitor.rawHtml(`<i>frag-${i}</i>`);
      }
      assert.equal(
        String(uiWin.ContextMonitor.html`<div>${hotBadge}</div>`),
        '<div><span class="hot-badge">ACTIVE</span></div>'
      );
    } finally {
      sdkSync.stop();
      await new Promise((r) => httpSrv.close(r));
    }
  } finally {
    if (prevToken === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevToken;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
