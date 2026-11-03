import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readJsonFile, writeJsonAtomic, writeJsonFile } from '../lib/constants.mjs';
import {
  analyzeTrajectoryHealth,
  classifyLogLine,
  detectToolOutputBloat,
  extractDiagnosticLogs,
  normalizeSidecars,
  normalizeTerminals,
  MAX_DIAGNOSTIC_LOG_LINES,
} from '../lib/diagnostics.mjs';
import {
  buildMcpAndCustomizationsCatalog,
  estimateDiskMcpSchemaTokens,
  refreshMcpServerState,
  toggleMcpServerState,
} from '../lib/mcp-manager.mjs';
import { callLsRpcCached } from '../lib/rpc-cache.mjs';

test('classifyLogLine uses the glog severity prefix instead of substring or timestamp matches', () => {
  const level = (line) => classifyLogLine(line).level;
  assert.equal(level('Found 3 MCP servers'), 'info');
  assert.equal(level('Fetching quota summary'), 'info');
  assert.equal(level('I1020 10:04:31.429117 ...'), 'info');
  assert.equal(level('0 errors, 0 warnings'), 'info');
  assert.equal(level('I1020 10:04:31.429117   4242 client.go:429] connected'), 'info');
  assert.equal(level('W1020 10:04:31.429117 4242 cache.go:88] cache miss'), 'warn');
  assert.equal(level('E1020 10:04:31.429117 4242 server.go:12] dial tcp: connection refused'), 'error');
  assert.equal(level('F1020 10:04:31.429117 4242 main.go:7] unrecoverable state'), 'error');
  // Rate limits in the message body still surface as errors
  assert.equal(level('I1020 10:04:31.429117 4242 model.go:51] got HTTP 429, retrying'), 'error');
  assert.equal(level('rpc error: code = ResourceExhausted desc = RESOURCE_EXHAUSTED'), 'error');
});

test('normalizeTerminals decodes POSIX and Windows file URIs and falls back to the raw string', () => {
  const uris = normalizeTerminals({
    terminals: [
      { workspaceUri: 'file:///home/x/my%20proj' },
      { workspaceUri: 'file:///c%3A/Users/arthu/My%20Repo' },
      { workspaceUri: 'file://build-server/share' },
      { workspaceUri: 'vscode-remote://wsl+Ubuntu/home/x' },
      {},
    ],
  }).map((t) => t.workspaceUri);
  assert.deepEqual(uris, [
    '/home/x/my proj',
    'c:\\Users\\arthu\\My Repo',
    'file://build-server/share',
    'vscode-remote://wsl+Ubuntu/home/x',
    '',
  ]);
});

test('toggleMcpServerState rejects non-object mcp_config.json entries instead of throwing a TypeError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-mcp-'));
  const configPath = join(dir, 'mcp_config.json');
  writeFileSync(configPath, JSON.stringify({ mcpServers: { broken: null, text: 'oops', ok: { command: 'x' } } }));
  const options = {
    lsAddress: '127.0.0.1:59998',
    csrfToken: 'mock-csrf',
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          url.endsWith('/GetMcpServerStates')
            ? { states: ['broken', 'text', 'ok'].map((serverName) => ({ spec: { serverName, configPath } })) }
            : {}
        ),
    }),
  };

  try {
    await assert.rejects(toggleMcpServerState('broken', true, options), /Could not update MCP server "broken"/);
    await assert.rejects(toggleMcpServerState('text', false, options), /Could not update MCP server "text"/);
    const res = await toggleMcpServerState('ok', false, options);
    assert.equal(res.source, 'plugin-config');
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers, {
      broken: null,
      text: 'oops',
      ok: { command: 'x', disabled: true },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractDiagnosticLogs caps ring buffer at MAX_DIAGNOSTIC_LOG_LINES (80) and classifies severity', () => {
  const manyLines = Array.from(
    { length: 150 },
    (_, idx) => (idx === 149 ? 'E1016 429 RESOURCE_EXHAUSTED line-150' : `I1016 line-${idx + 1}`)
  );
  const logs = extractDiagnosticLogs({
    languageServerDiagnostics: {
      logs: manyLines,
    },
  });

  assert.equal(logs.length, MAX_DIAGNOSTIC_LOG_LINES);
  assert.equal(logs[0].text, 'I1016 line-71');
  assert.equal(logs[0].level, 'info');
  assert.equal(logs[logs.length - 1].text, 'E1016 429 RESOURCE_EXHAUSTED line-150');
  assert.equal(logs[logs.length - 1].level, 'error');
});

test('buildMcpAndCustomizationsCatalog merges live MCP states, disabled flags, and errors', () => {
  const catalog = buildMcpAndCustomizationsCatalog(
    {
      states: [
        {
          status: 'MCP_SERVER_STATUS_READY',
          spec: {
            serverName: 'code-index',
            originalServerName: 'code-index',
            disabled: true,
            toolConfig: {
              search_symbols: { eager: true },
            },
          },
          tools: [
            { name: 'search_symbols', description: 'Search workspace symbols', jsonSchemaString: '{}' },
            { name: 'find_references', description: 'Find symbol references', jsonSchemaString: '{}' },
          ],
        },
        {
          status: 'MCP_SERVER_STATUS_ERROR',
          error: 'google: could not find default credentials',
          spec: {
            serverName: 'google-developer-knowledge_google-developer-knowledge',
            originalServerName: 'google-developer-knowledge',
          },
          tools: [],
        },
      ],
    },
    {
      states: [
        { type: 'CUSTOMIZATION_TYPE_SKILL', status: 'STATUS_ENABLED' },
        { type: 'CUSTOMIZATION_TYPE_SKILL', status: 'STATUS_DISABLED' },
        { type: 'CUSTOMIZATION_TYPE_RULE', status: 'STATUS_ENABLED' },
      ],
    }
  );

  assert.equal(catalog.servers.length, 2);
  assert.equal(catalog.servers[0].serverName, 'code-index');
  assert.equal(catalog.servers[0].enabled, false);
  assert.equal(catalog.servers[0].statusBadge, 'OFF');
  assert.equal(catalog.servers[0].toolCount, 2);
  assert.equal(catalog.servers[0].eagerCount, 1);
  assert.equal(catalog.servers[0].deferredCount, 1);
  assert.equal(catalog.servers[1].serverName, 'google-developer-knowledge');
  assert.equal(catalog.servers[1].isError, true);
  assert.equal(catalog.servers[1].statusBadge, 'ERROR');
  assert.equal(catalog.servers[1].errorMessage, 'google: could not find default credentials');
  assert.equal(catalog.counts.enabledSkills, 1);
  assert.equal(catalog.counts.totalSkills, 2);
  assert.equal(catalog.counts.enabledRules, 1);
});

test('MCP toggle and refresh invalidate the cached MCP and customization states', async () => {
  const calls = {};
  const options = {
    lsAddress: '127.0.0.1:59993',
    csrfToken: 'mock-csrf',
    fetchFn: async (url) => {
      const method = url.slice(url.lastIndexOf('/') + 1);
      calls[method] = (calls[method] || 0) + 1;
      return { ok: true, status: 200, text: async () => '{}' };
    },
  };
  const read = () =>
    Promise.all([
      callLsRpcCached('GetMcpServerStates', {}, options),
      callLsRpcCached('GetCustomizationStates', {}, options),
    ]);

  await read();
  await read();
  assert.equal(calls.GetMcpServerStates, 1);

  await refreshMcpServerState('', options);
  await read();
  assert.equal(calls.GetMcpServerStates, 2);
  assert.equal(calls.GetCustomizationStates, 2);

  // Not in any MCP config file: goes through ToggleMcpServer (and reads states uncached first)
  await toggleMcpServerState('some-server', false, options);
  await read();
  assert.equal(calls.ToggleMcpServer, 1);
  assert.equal(calls.GetCustomizationStates, 3);
});

test('writeJsonFile writes atomically via writeJsonAtomic and leaves no temp files behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-atomic-'));
  const filePath = join(dir, 'atomic-config.json');
  try {
    assert.equal(typeof writeJsonAtomic, 'function');
    const raw = writeJsonFile(filePath, { mcpServers: { demo: { disabled: false } } });
    assert.equal(typeof raw, 'string');
    assert.deepEqual(readJsonFile(filePath, { strict: true }), {
      mcpServers: { demo: { disabled: false } },
    });
    assert.deepEqual(readdirSync(dir), ['atomic-config.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectToolOutputBloat flags single tool steps exceeding 8000 estimated tokens and surfaces TOOL_OUTPUT_BLOAT in analyzeTrajectoryHealth', () => {
  const steps = [
    { stepIndex: 2, type: 'CORTEX_STEP_TYPE_MCP_TOOL', toolName: 'small_tool', content: 'ok' },
    {
      stepIndex: 7,
      type: 'CORTEX_STEP_TYPE_MCP_TOOL',
      toolName: 'exabeam_search_events',
      content: 'x'.repeat(40_000),
    },
  ];
  const bloat = detectToolOutputBloat(steps, { tokenThreshold: 8000, contextCeiling: 200000 });
  assert.equal(bloat.length, 1);
  assert.equal(bloat[0].stepIndex, 7);
  assert.equal(bloat[0].toolName, 'exabeam_search_events');
  assert.ok(bloat[0].estimatedTokens >= 10000);
  assert.ok(bloat[0].pctOfCeiling > 4);

  const health = analyzeTrajectoryHealth(steps, { tokenThreshold: 8000, contextCeiling: 200000 });
  assert.equal(health.advisories.length, 1);
  assert.equal(health.advisories[0].code, 'TOOL_OUTPUT_BLOAT');
  assert.equal(health.advisories[0].stepIndex, 7);
});

test('estimateDiskMcpSchemaTokens reads <appDataDir>/mcp/<serverName>/*.json and returns 0s on ENOENT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-mcp-disk-'));
  try {
    const missing = estimateDiskMcpSchemaTokens(dir, 'nonexistent-server');
    assert.deepEqual(missing, { toolCount: 0, schemaBytes: 0, estimatedTokens: 0 });

    const serverDir = join(dir, 'mcp', 'science_viewer');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'load_structure.json'), JSON.stringify({ name: 'load_structure', description: 'Load 3D structure', inputSchema: { type: 'object' } }));
    writeFileSync(join(serverDir, 'highlight_region.json'), JSON.stringify({ name: 'highlight_region', description: 'Highlight residues', inputSchema: { type: 'object' } }));
    writeFileSync(join(serverDir, 'instructions.md'), '# Ignore non-json');

    const res = estimateDiskMcpSchemaTokens(dir, 'science_viewer');
    assert.equal(res.toolCount, 2);
    assert.ok(res.schemaBytes > 100);
    assert.ok(res.estimatedTokens > 25);

    // CM-AUD-01: Path traversal or invalid serverName must never escape <appDataDir>/mcp
    writeFileSync(join(dir, 'secret.json'), JSON.stringify({ secret: 'must-not-be-read' }));
    assert.deepEqual(estimateDiskMcpSchemaTokens(dir, '..'), { toolCount: 0, schemaBytes: 0, estimatedTokens: 0 });
    assert.deepEqual(estimateDiskMcpSchemaTokens(dir, '../'), { toolCount: 0, schemaBytes: 0, estimatedTokens: 0 });
    assert.deepEqual(estimateDiskMcpSchemaTokens(dir, '.'), { toolCount: 0, schemaBytes: 0, estimatedTokens: 0 });
    assert.deepEqual(estimateDiskMcpSchemaTokens(dir, 'science_viewer/..'), { toolCount: 0, schemaBytes: 0, estimatedTokens: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CM-AUD-04 & CM-AUD-05: toggleMcpServerState supports bare-map .mcp.json and detectToolOutputBloat handles real Cortex payloads and exclusions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-bare-mcp-'));
  const configPath = join(dir, '.mcp.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      $schema: 'https://modelcontextprotocol.io/schema/mcp.json',
      version: '1.0',
      bare_server: { command: 'node', args: ['srv.js'] },
    })
  );
  const options = {
    lsAddress: '127.0.0.1:59997',
    csrfToken: 'mock-csrf',
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          url.endsWith('/GetMcpServerStates')
            ? { states: [{ spec: { serverName: 'bare_server', configPath } }] }
            : {}
        ),
    }),
  };

  try {
    const res = await toggleMcpServerState('bare_server', false, options);
    assert.equal(res.source, 'plugin-config');
    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(updated.$schema, 'https://modelcontextprotocol.io/schema/mcp.json');
    assert.equal(updated.bare_server.disabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // CM-AUD-05: detectToolOutputBloat inspects real Cortex tool step fields, enforces step exclusions, and honors tokenThreshold: 0
  const steps = [
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      toolName: 'should_be_ignored',
      toolResult: { content: 'x'.repeat(50000) },
    },
    {
      type: 'CORTEX_STEP_TYPE_READ_URL_CONTENT',
      readUrlContent: { content: 'u'.repeat(40000) },
    },
    {
      type: 'CORTEX_STEP_TYPE_GREP_SEARCH',
      grepSearch: { results: 'g'.repeat(35000) },
    },
    {
      type: 'CORTEX_STEP_TYPE_COMMAND_STATUS',
      commandStatus: { output: 'c'.repeat(35000) },
    },
  ];
  const bloated = detectToolOutputBloat(steps, { tokenThreshold: 8000, contextCeiling: 200000 });
  assert.equal(bloated.length, 3);
  assert.deepEqual(bloated.map((b) => b.stepIndex), [1, 2, 3]);

  const zeroThreshold = detectToolOutputBloat(
    [{ type: 'CORTEX_STEP_TYPE_VIEW_FILE', viewFile: { content: 'small file' } }],
    { tokenThreshold: 0 }
  );
  assert.equal(zeroThreshold.length, 1);
});

test('navigateToHangarPlugin posts hangar-navigate message and Hangar core.js validates origin and SAFE_ID_RE', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cmUiDir = join(here, '..', 'ui');
  const hangarCorePath = join(here, '..', '..', 'antigravity-sidecar-hub', 'ui', 'core.js');

  const posted = [];
  const cmWindow = {
    parent: {
      postMessage: (msg, targetOrigin) => posted.push({ msg, targetOrigin }),
    },
  };
  const cmCtx = vm.createContext({ window: cmWindow });
  for (const rel of ['core.js', 'components/diagnostics-tab.js']) {
    vm.runInContext(readFileSync(join(cmUiDir, rel), 'utf8'), cmCtx, { filename: rel });
  }

  assert.equal(typeof cmWindow.ContextMonitor.navigateToHangarPlugin, 'function');
  cmWindow.ContextMonitor.navigateToHangarPlugin('vercel-plugin');
  assert.equal(posted.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0].msg)), {
    type: 'hangar-navigate',
    targetTab: 'plugins',
    pluginId: 'vercel-plugin',
  });

  // Rejects unsafe pluginId on sender side (including 3-segment paths)
  cmWindow.ContextMonitor.navigateToHangarPlugin('../evil<script>');
  cmWindow.ContextMonitor.navigateToHangarPlugin('org/repo/extra');
  assert.equal(posted.length, 1);

  // Supports composite plugin/subId and uses document.referrer origin when present
  const refPosted = [];
  const refCtx = vm.createContext({
    window: {
      location: { origin: 'http://127.0.0.1:52320' },
      parent: { postMessage: (msg, targetOrigin) => refPosted.push({ msg, targetOrigin }) },
    },
    document: { referrer: 'http://127.0.0.1:51234/index.html' },
    URL,
  });
  for (const rel of ['core.js', 'components/diagnostics-tab.js']) {
    vm.runInContext(readFileSync(join(cmUiDir, rel), 'utf8'), refCtx, { filename: rel });
  }
  const navRes = refCtx.window.ContextMonitor.navigateToHangarPlugin('android-cli-plugin/device-hub');
  assert.equal(navRes.ok, true);
  assert.equal(refPosted.length, 1);
  assert.equal(refPosted[0].targetOrigin, 'http://127.0.0.1:51234');
  assert.equal(refPosted[0].msg.pluginId, 'android-cli-plugin');
  assert.equal(refPosted[0].msg.targetId, 'android-cli-plugin/device-hub');

  // Test Hangar receiver in antigravity-sidecar-hub/ui/core.js
  const listeners = {};
  const subTabs = [];
  const hangarWindow = {
    location: { origin: 'http://127.0.0.1:51234' },
    addEventListener: (type, fn) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    Hangar: {
      setExtensionsSubTab: (tab) => subTabs.push(tab),
    },
  };
  const hangarCtx = vm.createContext({ window: hangarWindow, document: {} });
  vm.runInContext(readFileSync(hangarCorePath, 'utf8'), hangarCtx, { filename: 'core.js' });

  const dispatchMessage = (event) => {
    for (const fn of listeners.message || []) fn(event);
  };

  // Untrusted external origin is ignored
  dispatchMessage({
    origin: 'https://evil.example.com',
    data: { type: 'hangar-navigate', targetTab: 'plugins', pluginId: 'vercel-plugin' },
  });
  assert.equal(subTabs.length, 0);

  // Unsafe pluginId is ignored
  dispatchMessage({
    origin: 'http://127.0.0.1:52320',
    data: { type: 'hangar-navigate', targetTab: 'plugins', pluginId: '../traversal' },
  });
  assert.equal(subTabs.length, 0);

  // Valid loopback origin and SAFE_ID_RE pluginId switches tab
  dispatchMessage({
    origin: 'http://127.0.0.1:52320',
    data: { type: 'hangar-navigate', targetTab: 'plugins', pluginId: 'vercel-plugin' },
  });
  assert.equal(hangarWindow.Hangar.activeNavigatedPluginId, 'vercel-plugin');
  assert.ok(subTabs.length >= 1);
});

test('CM-AUD-03, CM-AUD-04, CM-AUD-05: getLatestConversationSteps isolates conversations, detectToolOutputBloat handles BigInt/pctOfCeiling/256k ceiling, computeMcpSummary estimates disk schemas, and normalizeSidecars preserves pluginId', async () => {
  const { computeMcpSummary, getLatestConversationSteps, clearConversationDetails } = await import('../lib/context-telemetry.mjs');
  clearConversationDetails();
  assert.deepEqual(getLatestConversationSteps('_new'), []);
  assert.equal(getLatestConversationSteps('missing-cascade-id'), null);

  // detectToolOutputBloat handles BigInt payloads without throwing, defaults to 256k ceiling, and triggers when pctOfCeiling > 15
  const bloatSteps = [
    {
      stepIndex: 2,
      type: 'CORTEX_STEP_TYPE_MCP_TOOL',
      toolName: 'mcp_rea_binary_overview',
      pluginId: 'rea',
      result: { addr: 4096n, text: 'a'.repeat(35000) },
    },
    {
      stepIndex: 3,
      type: 'CORTEX_STEP_TYPE_VIEW_FILE',
      estimatedTokens: 6000,
    },
  ];
  const bloat = detectToolOutputBloat(bloatSteps, { tokenThreshold: 10000, contextCeiling: 30000 });
  assert.equal(bloat.length, 2);
  assert.equal(bloat[1].stepIndex, 3);
  assert.equal(bloat[1].pctOfCeiling, 20);

  const defaultCeilingBloat = detectToolOutputBloat(
    [{ stepIndex: 0, type: 'CORTEX_STEP_TYPE_VIEW_FILE', estimatedTokens: 25600 }],
    { tokenThreshold: 8000, contextCeiling: NaN }
  );
  assert.equal(defaultCeilingBloat[0].pctOfCeiling, 10);

  const health = analyzeTrajectoryHealth(bloatSteps, { tokenThreshold: 10000, contextCeiling: 30000 });
  assert.equal(health.advisories[0].pluginId, 'rea');

  // normalizeSidecars preserves pluginId and pluginName
  const sidecars = normalizeSidecars({
    sidecars: [{ sidecarId: 'sc-1', pluginId: 'my-plugin', config: { displayName: 'SC 1', pluginName: 'my-plugin-name' } }],
  });
  assert.equal(sidecars[0].pluginId, 'my-plugin');
  assert.equal(sidecars[0].pluginName, 'my-plugin-name');

  // computeMcpSummary skips enabled:false / DISABLED status and falls back to disk schema estimation for lazy servers
  const dir = mkdtempSync(join(tmpdir(), 'cm-summary-disk-'));
  try {
    const srvDir = join(dir, 'mcp', 'lazy_srv');
    mkdirSync(srvDir, { recursive: true });
    writeFileSync(join(srvDir, 'tool1.json'), JSON.stringify({ name: 'tool1', description: 'Lazy tool schema', inputSchema: { type: 'object' } }));
    const summary = computeMcpSummary(
      {
        states: [
          { spec: { serverName: 'lazy_srv' }, status: 'MCP_SERVER_STATUS_READY', tools: [] },
          { spec: { serverName: 'disabled_srv' }, status: 'MCP_SERVER_STATUS_DISABLED', tools: [{ name: 't', description: 'd', jsonSchemaString: '{}' }] },
          { spec: { serverName: 'off_srv' }, enabled: false, tools: [{ name: 't2', description: 'd2', jsonSchemaString: '{}' }] },
        ],
      },
      0.28,
      { appDataDir: dir }
    );
    assert.equal(summary.servers.length, 1);
    assert.equal(summary.servers[0].serverName, 'lazy_srv');
    assert.equal(summary.totalToolCount, 1);
    assert.ok(summary.deferredTokens > 0);

    const catalog = buildMcpAndCustomizationsCatalog(
      { states: [{ spec: { serverName: 'lazy_srv', pluginName: 'lazy-plugin' }, status: 'MCP_SERVER_STATUS_READY', tools: [] }] },
      {},
      0.28,
      { appDataDir: dir }
    );
    assert.equal(catalog.servers[0].pluginId, 'lazy-plugin');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // navigateToHangarPlugin uses '*' when framed without referrer (so cross-port parent Hangar receives it) and rejects non-loopback referrer
  const here = dirname(fileURLToPath(import.meta.url));
  const cmUiDir = join(here, '..', 'ui');
  const framedPosted = [];
  const framedCtx = vm.createContext({
    window: {
      location: { origin: 'http://127.0.0.1:52320' },
      parent: { postMessage: (msg, targetOrigin) => framedPosted.push({ msg, targetOrigin }) },
    },
    document: { referrer: 'https://evil.example.com/frame' },
    URL,
  });
  for (const rel of ['core.js', 'components/diagnostics-tab.js']) {
    vm.runInContext(readFileSync(join(cmUiDir, rel), 'utf8'), framedCtx, { filename: rel });
  }
  framedCtx.window.ContextMonitor.navigateToHangarPlugin('vercel-plugin');
  assert.equal(framedPosted.length, 1);
  assert.equal(framedPosted[0].targetOrigin, '*');
});


