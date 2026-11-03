import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAUNCHER_CONFIG, startContextMonitorLauncher } from '../launch.mjs';
import { app, createMonitorStateSync } from '../server.mjs';
import { MCP_CONV_META_KEY } from 'antigravity-sidecar-kit/state-sync';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(ROOT_DIR, 'ui');

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
  await startContextMonitorLauncher({
    runLauncher: async (opts) => {
      calledWith = opts;
      return { child: { pid: 9999 } };
    },
  });
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
  const stylesSrc = readFileSync(join(UI_DIR, 'styles.css'), 'utf8');
  assert.ok(stylesSrc.includes('--agy-ink-soft'));
  assert.ok(stylesSrc.includes('forced-colors: active'));

  for (const cssRel of ['styles.css', 'components.css']) {
    const css = readFileSync(join(UI_DIR, cssRel), 'utf8');
    const packedCss = css.split(/\r?\n/).filter((l) => (l.match(/;/g) || []).length >= 3);
    assert.deepEqual(packedCss, [], `ui/${cssRel} contains packed multi-property single-line rules`);
  }

  for (const jsRel of [
    'app.js',
    'core.js',
    'components/context-tab.js',
    'components/context-drawers.js',
    'components/subagent-drawer.js',
    'components/mcp-budgets-tab.js',
    'components/diagnostics-tab.js',
  ]) {
    const src = readFileSync(join(UI_DIR, jsRel), 'utf8');
    const commaDecls = src
      .split(/\r?\n/)
      .filter((l) => /^\s*(let|const)\s+[A-Za-z0-9_$]+\s*=\s*[^,;(]+,\s*[A-Za-z0-9_$]+\s*=/.test(l));
    assert.deepEqual(commaDecls, [], `ui/${jsRel} contains comma-chained variable declarations`);
    const multiStmt = src
      .split(/\r?\n/)
      .filter((l) => !l.includes('for (') && (l.match(/;/g) || []).length >= 3);
    assert.deepEqual(multiStmt, [], `ui/${jsRel} contains packed multi-statement lines`);
  }
});

test('StateSync mutators, /api/notify, and /mcp tools including conversation_id scoping', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cm-sync-test-'));
  try {
    const calls = [];
    let notified = null;
    const mockApp = {
      apis: new Map(),
      api(path, fn) {
        this.apis.set(path, fn);
      },
    };
    const sync = createMonitorStateSync(mockApp, {
      dataRoot: tmpRoot,
      notifyAgent: async (msg, opts) => {
        notified = { msg, opts };
      },
      fetchTelemetry: async (opts) => {
        calls.push({ fn: 'fetchFullTelemetry', opts });
        return { session: { cascadeId: opts.hostCascadeId || opts.cascadeId || 'default' }, context: { totalUsedTokens: 512 } };
      },
      mutators: {
        'mcp-toggle': async (p) => {
          calls.push({ fn: 'mcp-toggle', p });
          return { ok: true, ...p };
        },
        'mcp-refresh': async (p) => {
          calls.push({ fn: 'mcp-refresh', p });
          return { refreshed: true };
        },
        'ai-credits-toggle': async (p) => {
          calls.push({ fn: 'ai-credits-toggle', p });
          return { useAiCredits: Boolean(p?.enabled) };
        },
        'restart-sidecar': async (p) => {
          calls.push({ fn: 'restart-sidecar', p });
          return { restarted: p?.id || p?.sidecarId };
        },
        'close-terminal': async (p) => {
          calls.push({ fn: 'close-terminal', p });
          return { closed: p?.id || p?.terminalId };
        },
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
    assert.ok(listRes.result.tools.find((t) => t.name === 'restart_sidecar').inputSchema.properties.sidecarId);
    assert.ok(listRes.result.tools.find((t) => t.name === 'close_terminal').inputSchema.properties.terminalId);

    const callRes = await callMcp({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_context_telemetry', arguments: { workspaceUris: ['file:///c:/repo'] }, _meta: { [MCP_CONV_META_KEY]: 'conv-meta-777' } },
    });
    assert.equal(JSON.parse(callRes.result.content[0].text).session.cascadeId, 'conv-meta-777');
    assert.equal(calls.findLast((c) => c.fn === 'fetchFullTelemetry').opts.hostCascadeId, 'conv-meta-777');

    await mockApp.apis.get('/api/notify')({ message: 'Follow-up after telemetry', severity: 'error', triggerTurn: false }, {});
    assert.equal(notified.opts.conversationId, 'conv-meta-777');
    assert.equal(notified.opts.severity, 'error');
    assert.equal(notified.opts.triggerTurn, false);

    for (const [id, name, args] of [
      [4, 'toggle_mcp_server', { serverName: 'rea', enabled: false }],
      [5, 'refresh_mcp_servers', {}],
      [6, 'set_ai_credits_overage', { enabled: false }],
      [7, 'restart_sidecar', { sidecarId: 'sc-2' }],
      [8, 'close_terminal', { terminalId: 'term-2' }],
    ]) {
      await callMcp({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    }
    assert.equal(sync.getState().lastAction, 'close-terminal');
    assert.deepEqual(sync.getState().result, { closed: 'term-2' });
    sync.stop();
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('SSE /api/events stream broadcasts live mutations, /shell.css serves AGY tokens, and server_info.json cleans up', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cm-sse-test-'));
  const mockApp = {
    apis: new Map(),
    api(p, fn) {
      this.apis.set(p, fn);
    },
  };
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

  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
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
          else if (ssePayloads.length >= 2) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', (err) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
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
