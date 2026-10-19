import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDiagnosticLogs, MAX_DIAGNOSTIC_LOG_LINES } from '../lib/diagnostics.mjs';
import { buildMcpAndCustomizationsCatalog } from '../lib/mcp-manager.mjs';

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
