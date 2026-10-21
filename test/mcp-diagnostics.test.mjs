import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyLogLine,
  extractDiagnosticLogs,
  normalizeTerminals,
  MAX_DIAGNOSTIC_LOG_LINES,
} from '../lib/diagnostics.mjs';
import {
  buildMcpAndCustomizationsCatalog,
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
