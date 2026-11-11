import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const UI_SCRIPTS = ['core.js', 'components/subagent-drawer.js', 'components/context-drawers.js', 'components/context-tab.js', 'components/mcp-budgets-tab.js', 'components/diagnostics-tab.js'];

function loadUi() {
  const ctx = vm.createContext({ window: {} });
  for (const rel of UI_SCRIPTS) {
    vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  }
  return ctx.window.ContextMonitor;
}

const ui = loadUi();
const HOSTILE = '<img src=x onerror="alert(1)">';
const HOSTILE_ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;';

test('renderMcpBudgetsTab shows empty state, escapes server data, and clamps fills', () => {
  const empty = ui.renderMcpBudgetsTab({});
  assert.ok(empty.includes('No MCP servers configured'));

  const html = ui.renderMcpBudgetsTab({
    turnInsights: {
      budgets: {
        skills: { formattedUsed: '30k', formattedLimit: '20k', pct: 150, formattedPct: '150%' },
        rules: { formattedUsed: '0', formattedLimit: '20k', pct: -5, formattedPct: '0%' },
      },
    },
    mcpCatalog: {
      counts: { enabledSkills: 2, enabledRules: 1 },
      servers: [
        {
          serverName: HOSTILE,
          fullServerName: 'plugin/evil"name',
          statusBadge: 'ERROR',
          enabled: true,
          isError: true,
          errorMessage: '<script>boom</script>',
          toolCount: 3,
          eagerCount: 1,
          deferredCount: 2,
          formattedTokens: '1.2k',
        },
        { serverName: 'off-server', fullServerName: 'off-server', statusBadge: 'OFF', enabled: false },
      ],
    },
  });

  assert.ok(!html.includes(HOSTILE));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes(HOSTILE_ESCAPED));
  assert.ok(html.includes('data-server="plugin/evil&quot;name"'));
  assert.ok(html.includes('Error: &lt;script&gt;boom&lt;/script&gt;'));
  assert.match(html, /aria-checked="true"[^>]*data-server="plugin\/evil&quot;name"\s+data-enabled="1"/);
  assert.match(html, /aria-checked="false"[^>]*data-server="off-server"\s+data-enabled="0"/);
  assert.ok(html.includes('width:100%;background:var(--chart-yellow'));
  assert.ok(html.includes('width:0%;background:var(--cm-chart-teal, #2ec4b6)'));
});

test('mergeIncomingLogs caps, appends only new lines, and trims on auto-scroll', () => {
  const lines = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ text: `line-${from + i}`, level: 'info' }));
  const texts = (state) => state.logBuffer.map((l) => l.text);

  const state = { logBuffer: [], logAutoScroll: true, renderedLogCount: 0 };
  ui.mergeIncomingLogs(state, lines(1, 100));
  assert.equal(state.logBuffer.length, 80);
  assert.equal(texts(state)[0], 'line-21');

  ui.mergeIncomingLogs(state, lines(50, 105));
  assert.equal(state.logBuffer.length, 80);
  assert.equal(texts(state).at(-1), 'line-105');
  assert.equal(new Set(texts(state)).size, 80, 'no duplicated overlap lines');

  const paused = { logBuffer: lines(1, 290), logAutoScroll: false, renderedLogCount: 0 };
  ui.mergeIncomingLogs(paused, lines(291, 320));
  assert.equal(paused.logBuffer.length, 300);
  assert.equal(texts(paused).at(-1), 'line-300');

  paused.logAutoScroll = true;
  ui.mergeIncomingLogs(paused, lines(301, 310));
  assert.equal(paused.logBuffer.length, 80);
  assert.equal(paused.renderedLogCount, 0);
});

test('mergeIncomingLogs preserves intermediate lines when incoming batch ends with a repeated message matching lastExisting', () => {
  const existing = ['line-1', 'line-2', 'HTTP 429 rate limit'];
  const incoming = [
    { text: 'line-1' },
    { text: 'line-2' },
    { text: 'HTTP 429 rate limit' },
    { text: 'important error A' },
    { text: 'important error B' },
    { text: 'HTTP 429 rate limit' },
  ];
  const state = {
    logBuffer: existing.map((text) => ({ text, level: 'info' })),
    logAutoScroll: false,
    renderedLogCount: 3,
  };
  ui.mergeIncomingLogs(state, incoming);
  const expected = ['line-1', 'line-2', 'HTTP 429 rate limit', 'important error A', 'important error B', 'HTTP 429 rate limit'];
  assert.deepEqual(state.logBuffer.map((l) => l.text), expected);
  assert.deepEqual(ui.mergeIncomingLogs(existing, incoming), expected);

  const singleExisting = ['HTTP 429 rate limit'];
  const singleIncoming = [{ text: 'HTTP 429 rate limit' }, { text: 'important error A' }, { text: 'HTTP 429 rate limit' }];
  assert.deepEqual(ui.mergeIncomingLogs(singleExisting, singleIncoming), [
    'HTTP 429 rate limit',
    'important error A',
    'HTTP 429 rate limit',
  ]);

  assert.deepEqual(ui.mergeIncomingLogs(['L1', 'L2', 'L3'], ['L3', 'L4', 'L5'], 80), ['L1', 'L2', 'L3', 'L3', 'L4', 'L5']);
  assert.deepEqual(ui.mergeIncomingLogs(['L1', 'L2', 'L3'], ['L4', 'L5'], 4), ['L2', 'L3', 'L4', 'L5']);
});

test('renderDiagnosticsLists escapes terminal titles and sidecar errors', () => {
  const html = ui.renderDiagnosticsLists({
    terminals: [{ terminalId: 't"1', pid: 42, title: HOSTILE, workspaceUri: '/home/u/proj' }],
    sidecars: [{ sidecarId: 'sc', displayName: 'Side', statusBadge: 'ERRORED', isErrored: true, webPort: 0, lastError: HOSTILE }],
  });
  assert.ok(!html.includes(HOSTILE));
  assert.ok(html.includes(`<span>${HOSTILE_ESCAPED}</span>`));
  assert.ok(html.includes(` · ${HOSTILE_ESCAPED}`));
  assert.ok(html.includes('data-terminal-id="t&quot;1"'));
  assert.ok(html.includes('PID 42'));

  const empty = ui.renderDiagnosticsLists({});
  assert.ok(empty.includes('No active background terminals'));
  assert.ok(empty.includes('No sidecars registered'));

  const mcpWithPlugin = ui.renderMcpBudgetsTab({
    turnInsights: {
      topCulprits: {
        skillInjections: {
          totalInjectedBytes: 4200,
          estimatedTokens: 1176,
          injections: [{ stepIndex: 3, hookEvent: 'PreToolUse', injectedSkills: ['nextjs'], bytes: 4200 }],
        },
      },
    },
    mcpCatalog: {
      servers: [{
        serverName: 'vercel-mcp',
        fullServerName: 'vercel-mcp',
        pluginName: 'vercel-plugin',
        statusBadge: 'READY',
        enabled: true,
        toolCount: 4,
        eagerCount: 0,
        deferredCount: 4,
        formattedTokens: '1.1k',
      }],
    },
  });
  assert.match(mcpWithPlugin, /data-action="hangar-navigate"\s+data-plugin-id="vercel-plugin"/);
  assert.ok(mcpWithPlugin.includes('nextjs'));

  const diagWithSidecars = ui.renderDiagnosticsLists({
    sidecars: [
      { sidecarId: 'sc-1', pluginId: 'science-plugin', displayName: 'Science', statusBadge: 'ERRORED', isErrored: true },
      { sidecarId: 'broken-sc', displayName: 'Broken', statusBadge: 'ERRORED', isErrored: true },
      { sidecarId: 'aem-sc', pluginDir: 'aem-65-plugin', pluginName: 'AEM 6.5', displayName: 'AEM', statusBadge: 'ERRORED', isErrored: true },
    ],
  });
  assert.match(diagWithSidecars, /data-action="hangar-navigate"\s+data-plugin-id="science-plugin"\s+data-target-tab="sidecars"\s+data-sidecar-id="sc-1"/);
  assert.match(diagWithSidecars, /data-action="hangar-navigate"\s+data-plugin-id="broken-sc"\s+data-target-tab="sidecars"\s+data-sidecar-id="broken-sc"/);
  assert.match(diagWithSidecars, /data-action="hangar-navigate"\s+data-plugin-id="aem-65-plugin"\s+data-target-tab="sidecars"\s+data-sidecar-id="aem-sc"/);

  const mcpPluginVariants = ui.renderMcpBudgetsTab({
    mcpCatalog: {
      servers: [
        {
          serverName: 'aem-65-mcp',
          fullServerName: 'aem-65-plugin_aem-65-mcp',
          pluginId: 'aem-65-plugin',
          pluginDir: 'aem-65-plugin',
          pluginName: 'aem-65',
          statusBadge: 'READY',
          enabled: true,
          toolCount: 46,
          eagerCount: 0,
          deferredCount: 46,
          formattedTokens: '16.0k',
        },
        {
          serverName: 'display-only-mcp',
          fullServerName: 'display-only-mcp',
          pluginName: 'Display Name With Spaces',
          statusBadge: 'READY',
          enabled: true,
          toolCount: 1,
          eagerCount: 0,
          deferredCount: 1,
          formattedTokens: '100',
        },
        {
          serverName: 'atlassian',
          fullServerName: 'atlassian',
          statusBadge: 'READY',
          enabled: true,
          toolCount: 12,
          eagerCount: 0,
          deferredCount: 12,
          formattedTokens: '1.2k',
        },
      ],
    },
  });
  assert.match(
    mcpPluginVariants,
    /data-action="hangar-navigate"\s+data-plugin-id="aem-65-plugin"\s+title="Inspect aem-65 in Hangar"/
  );
  assert.equal((mcpPluginVariants.match(/data-action="hangar-navigate"/g) || []).length, 1);
});

test('renderContextTab renders .subagent-banner breadcrumb with Parent and Root navigation when inspecting a subagent', () => {
  const l2Html = ui.renderContextTab({
    session: {
      cascadeId: 'sub-l2',
      isSubagent: true,
      parentConversationId: 'sub-l1',
      parentTitle: `L1 Coord ${HOSTILE}`,
      rootConversationId: 'root-1',
      rootTitle: `Root ${HOSTILE}`,
      nestingDepth: 2,
      title: `Worker ${HOSTILE}`,
    },
    context: { categories: [] },
    planUsage: {},
    turnInsights: {
      culprits: {
        topStepsTokens: 3200,
        formattedTopStepsTokens: '3.2k top 1',
        topChatSteps: [{
          name: 'Step 2 (SYSTEM_MESSAGE)',
          label: 'Subagent reply: research',
          badge: 'Subagent',
          stepRef: '#2',
          subagentId: 'sub-l2',
          tokens: 3200,
          formattedTokens: '3.2k',
          barPct: 100,
        }],
        promptSections: [],
      },
    },
  }, { culpritsExpanded: true });

  assert.ok(!l2Html.includes(HOSTILE));
  assert.ok(l2Html.includes('class="subagent-banner"'));
  assert.match(l2Html, /<\/svg> Parent: L1 Coord /, 'the back button leads with the arrow_back icon');
  assert.ok(l2Html.includes(`Parent: L1 Coord ${HOSTILE_ESCAPED}`));
  assert.ok(l2Html.includes('data-subagent-id="sub-l1"'));
  assert.ok(l2Html.includes('class="agy-btn subagent-root-btn" data-subagent-id="root-1"'));
  assert.ok(l2Html.includes('class="fit-card subagent-culprit clickable"'));

  const optsHtml = ui.renderSessionOptions(
    [{ cascadeId: 'root-1', title: 'Root Session' }],
    { cascadeId: 'sub-l2', isSubagent: true, title: `Worker ${HOSTILE}`, rootTitle: 'Root Session' },
    'sub-l2'
  );
  assert.ok(!optsHtml.includes(HOSTILE));
  assert.match(optsHtml, /<option value="sub-l2" selected>Subagent: Worker &lt;img/);
  assert.equal((optsHtml.match(/Pin:/g) || []).length, 1);

  const mcpInjHtml = ui.renderMcpBudgetsTab({
    turnInsights: {
      budgets: { skills: { formattedUsed: '2.0k', formattedLimit: '20.0k', pct: 10, formattedPct: '10.0%' } },
      culprits: {
        skillInjections: {
          totalInjectedBytes: 5000,
          estimatedTokens: 1400,
          injections: [{ stepIndex: 3, hookEvent: 'PreToolUse', injectedSkills: ['nextjs'], droppedByCap: ['geist'], droppedByBudget: ['ai-sdk'] }],
        },
      },
    },
    mcpCatalog: { servers: [], counts: { enabledSkills: 2, enabledRules: 1 } },
  });
  assert.match(mcpInjHtml, /dropped:/i);
  assert.match(mcpInjHtml, /geist/);
  assert.match(mcpInjHtml, /ai-sdk/);

  const existingLogs = ['L1', 'L2', 'A', 'B', 'C'];
  const incomingLogs = ['A', 'B', 'C', 'NEW_ERR_429', 'A', 'B', 'C'];
  const mergedLogs = ui.mergeIncomingLogs(existingLogs, incomingLogs, 80);
  assert.deepEqual(Array.from(mergedLogs), ['L1', 'L2', 'A', 'B', 'C', 'NEW_ERR_429', 'A', 'B', 'C']);
  const logTarget = { innerHTML: '' };
  ui.setHtml(logTarget, [{ level: 'error', text: HOSTILE }].map((l) => ui.html`<div class="log-line ${ui.esc(l.level)}">${ui.esc(l.text)}</div>`));
  assert.equal(logTarget.innerHTML, `<div class="log-line error">${HOSTILE_ESCAPED}</div>`);
  assert.equal(typeof ui.createVisibilityPoller, 'function');
});
