import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
// Same load order as ui/index.html; these scripts only touch the DOM inside functions
const UI_SCRIPTS = [
  'core.js',
  'components/context-drawers.js',
  'components/context-tab.js',
  'components/mcp-budgets-tab.js',
  'components/diagnostics-tab.js',
];

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

test('esc escapes HTML-significant characters and nullish values', () => {
  assert.equal(ui.esc('a & b < c > d "e"'), 'a &amp; b &lt; c &gt; d &quot;e&quot;');
  assert.equal(ui.esc("single'quote"), 'single&#39;quote');
  assert.equal(ui.esc(null), '');
  assert.equal(ui.esc(undefined), '');
  assert.equal(ui.esc(42), '42');
});

test('formatBadgeLabel capitalizes status labels but leaves PID labels alone', () => {
  assert.equal(ui.formatBadgeLabel('READY'), 'Ready');
  assert.equal(ui.formatBadgeLabel('PID 1234'), 'PID 1234');
  assert.equal(ui.formatBadgeLabel(''), '');
});

test('renderSessionOptions marks the pinned session and escapes titles', () => {
  const sessions = [
    { cascadeId: 'aaa', title: 'First' },
    { cascadeId: 'bbb', title: HOSTILE },
  ];
  const auto = ui.renderSessionOptions(sessions, { title: 'Active "chat"' }, '');
  assert.match(auto, /<option value="" selected>Auto-sync: Active &quot;chat&quot;<\/option>/);
  assert.ok(!auto.includes(HOSTILE));
  assert.ok(auto.includes(`Pin: ${HOSTILE_ESCAPED}`));

  const pinned = ui.renderSessionOptions(sessions, {}, 'bbb');
  assert.match(pinned, /<option value="bbb" selected>/);
  assert.match(pinned, /<option value="" >Auto-sync: Current conversation/);
});

test('renderTelemetryPillText formats input/cache and omits hit % without usage', () => {
  const ctx = { rawUsage: { inputTokens: 1_234, cacheReadTokens: 45_678 } };
  assert.equal(
    ui.renderTelemetryPillText(ctx, { performance: { turnCacheHitPct: 97 } }),
    'in 1.2k · cache 45.7k (97%)'
  );
  assert.equal(
    ui.renderTelemetryPillText({ rawUsage: {} }, { performance: { turnCacheHitPct: 0 } }),
    'in 0k · cache 0k'
  );
});

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
  assert.ok(html.includes('width:0%;background:#2ec4b6'));
});

test('renderContextTab renders one row per category, skips inactive bar segments, and escapes drawers', () => {
  const categories = [
    { id: 'messages', label: 'Messages', color: '#111', inActiveContext: true, tokens: 50_000, pct: 20, formattedTokens: '50.0k', formattedPct: '20.0%' },
    { id: 'systemPrompt', label: 'System prompt', color: '#222', inActiveContext: true, tokens: 10_000, pct: 4, formattedTokens: '10.0k', formattedPct: '4.0%' },
    { id: 'mcpToolsDeferred', label: 'MCP tools (deferred)', color: '#333', inActiveContext: false, tokens: 5_000, pct: 2, formattedTokens: '5.0k', formattedPct: '2.0%' },
    { id: 'freeSpace', label: 'Free space (to compact)', color: 'transparent', inActiveContext: false, tokens: 190_000, pct: 74, formattedTokens: '190.0k', formattedPct: '74.0%' },
  ];
  const data = {
    context: { categories, compactionRisk: 'normal', ceilingTokens: 256_000 },
    planUsage: {},
    turnInsights: {
      compaction: {
        count: 1,
        checkpoints: [{ index: 1, stepIndex: 12, stepRange: '0–12', beforeTokens: 0, summary: HOSTILE }],
      },
      effortAdvisor: {
        totalTurns: 1,
        optimalTurns: 0,
        flaggedTurnsCount: 1,
        latestTurnFit: {
          turnNumber: 1,
          promptPreview: HOSTILE,
          status: 'unused_effort',
          badge: 'Lower effort',
          shortModelLabel: 'Pro (High)',
          recommendedModel: 'Pro (Low)',
          reason: 'r',
          phaseSplit: {},
        },
        recentFlaggedTurns: [],
      },
    },
  };

  const html = ui.renderContextTab(data, { compactionsExpanded: true, effortFitExpanded: true });

  assert.equal((html.match(/class="breakdown-row" data-category=/g) || []).length, categories.length);
  const bar = html.match(/<div class="segmented-bar">(.*?)<\/div>\s*<div class="breakdown-list">/s)[1];
  assert.equal((bar.match(/class="bar-segment"/g) || []).length, 2);
  assert.ok(!bar.includes('MCP tools (deferred)'));
  assert.ok(!html.includes(HOSTILE));
  assert.ok(html.includes(`<div class="checkpoint-summary">${HOSTILE_ESCAPED}</div>`));
  assert.ok(html.includes(`"${HOSTILE_ESCAPED}"`));
});

test('mergeIncomingLogs caps, appends only new lines, and trims on auto-scroll', () => {
  const lines = (from, to) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ text: `line-${from + i}`, level: 'info' }));
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
  assert.deepEqual(
    state.logBuffer.map((l) => l.text),
    [
      'line-1',
      'line-2',
      'HTTP 429 rate limit',
      'important error A',
      'important error B',
      'HTTP 429 rate limit',
    ]
  );

  const merged = ui.mergeIncomingLogs(existing, incoming);
  assert.deepEqual(merged, [
    'line-1',
    'line-2',
    'HTTP 429 rate limit',
    'important error A',
    'important error B',
    'HTTP 429 rate limit',
  ]);

  const singleExisting = ['HTTP 429 rate limit'];
  const singleIncoming = [
    { text: 'HTTP 429 rate limit' },
    { text: 'important error A' },
    { text: 'HTTP 429 rate limit' },
  ];
  assert.deepEqual(ui.mergeIncomingLogs(singleExisting, singleIncoming), [
    'HTTP 429 rate limit',
    'important error A',
    'HTTP 429 rate limit',
  ]);

  // CM-AUD-04: 1-line coincidence at start of rotated batch does not drop incoming[0], and array mode keeps newest maxLines
  assert.deepEqual(
    ui.mergeIncomingLogs(['L1', 'L2', 'L3'], ['L3', 'L4', 'L5'], 80),
    ['L1', 'L2', 'L3', 'L3', 'L4', 'L5']
  );
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

  // CM-AUD-03 & XREPO-04: hangar-navigate buttons and skill injection telemetry rendered in MCP & Diagnostics tabs
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
      servers: [
        {
          serverName: 'vercel-mcp',
          fullServerName: 'vercel-mcp',
          pluginName: 'vercel-plugin',
          statusBadge: 'READY',
          enabled: true,
          toolCount: 4,
          eagerCount: 0,
          deferredCount: 4,
          formattedTokens: '1.1k',
        },
      ],
    },
  });
  assert.match(mcpWithPlugin, /data-action="hangar-navigate"\s+data-plugin-id="vercel-plugin"/);
  assert.ok(mcpWithPlugin.includes('nextjs'));

  const diagWithIssues = ui.renderDiagnosticsLists({
    warnings: [{ message: 'Step #4 produced ~12000 tokens', pluginId: 'science-plugin' }],
    sidecars: [{ sidecarId: 'broken-sc', displayName: 'Broken', statusBadge: 'ERRORED', isErrored: true }],
  });
  assert.match(diagWithIssues, /data-action="hangar-navigate"\s+data-plugin-id="science-plugin"/);
  assert.match(diagWithIssues, /data-action="hangar-navigate"\s+data-plugin-id="broken-sc"/);
});

test('renderContextTab shows the server-formatted estimate and (est.) in the perf strip', () => {
  const perf = {
    formattedResponse: '247',
    formattedThinking: '~353',
    thinkingTokens: 353,
    responseTokens: 247,
    thinkingEstimated: true,
    sessionThinkingEstimated: false,
  };
  const html = ui.renderContextTab({ context: {}, planUsage: {}, turnInsights: { performance: perf } });
  assert.ok(html.includes('247 / ~353'));
  assert.ok(html.includes('~353 think'));
  assert.ok(html.includes('reasoning) (est.)'));

  const exact = ui.renderContextTab({
    context: {},
    planUsage: {},
    turnInsights: { performance: { ...perf, formattedThinking: '353', thinkingEstimated: false } },
  });
  assert.ok(exact.includes('247 / 353'));
  assert.ok(!exact.includes('(est.)'));
});

test('renderTopHeaderAndTabs disambiguates idle parent with running subagent in .activity-pulse tooltip', () => {
  const headerHtml = ui.renderTopHeaderAndTabs(
    {
      session: { cascadeId: 'root-1', status: 'CASCADE_RUN_STATUS_IDLE' },
      subagents: {
        totalCount: 2,
        runningCount: 1,
        activeSubagentLabel: `DeepCoder ${HOSTILE}`,
      },
      model: { badgeLabel: 'Gemini 4 Argon (High)' },
      context: { formattedUsed: '42.0k', formattedCeiling: '256k', formattedUsedPct: '16.4%' },
    },
    { activeTab: 'context' },
    false
  );

  assert.ok(!headerHtml.includes(HOSTILE));
  assert.ok(
    headerHtml.includes(
      `class="activity-pulse active" title="Subagent executing: DeepCoder ${HOSTILE_ESCAPED}"`
    )
  );
});

test('renderSubagentsDrawer hides when empty and renders L1/L2 hierarchy with XSS escaping when expanded', () => {
  assert.equal(ui.renderSubagentsDrawer({ totalCount: 0, items: [] }, true), '');

  const subagents = {
    totalCount: 2,
    runningCount: 1,
    totalSteps: 19,
    formattedParentContextTokens: '4.8k',
    items: [
      {
        cascadeId: 'sub-l1',
        nestingDepth: 1,
        typeName: 'argon-840k',
        role: 'Coordinator',
        title: `Coordinator ${HOSTILE}`,
        modelBadge: `Gemini 4 Argon ${HOSTILE}`,
        statusBadge: 'Done',
        isRunning: false,
        stepCount: 12,
        durationFormatted: '2m 10s',
        formattedParentContextTokens: '4.8k',
        spawnStepRef: '#4',
        promptPreview: `Prompt ${HOSTILE}`,
      },
      {
        cascadeId: `sub-l2-${HOSTILE}`,
        nestingDepth: 2,
        typeName: 'research',
        role: 'Worker',
        title: 'Worker (research)',
        modelBadge: 'Inherited',
        statusBadge: 'Running',
        isRunning: true,
        stepCount: 7,
        durationFormatted: '35s',
        promptPreview: 'Check ast',
      },
    ],
  };

  const collapsed = ui.renderSubagentsDrawer(subagents, false, 'root-1');
  assert.ok(collapsed.includes('Subagents (2)'));
  assert.ok(collapsed.includes('1 running · 19 steps · 4.8k in context'));
  assert.ok(!collapsed.includes('subagent-card'));

  const expanded = ui.renderSubagentsDrawer(subagents, true, 'sub-l1');
  assert.ok(!expanded.includes(HOSTILE));
  assert.ok(expanded.includes(HOSTILE_ESCAPED));
  assert.ok(expanded.includes('↳ L2'));
  assert.ok(expanded.includes('data-subagent-id="sub-l1"'));
  assert.ok(expanded.includes(`data-subagent-id="sub-l2-${HOSTILE_ESCAPED}"`));
  assert.ok(expanded.includes('Viewing'));
  assert.ok(expanded.includes('Inspect'));
  assert.ok(expanded.includes('4.8k in parent'));
  assert.ok(expanded.includes('(#4)'));
  assert.ok(expanded.includes('class="agy-badge ready"'));
  assert.ok(expanded.includes('class="agy-badge active"'));
  assert.ok(expanded.includes('class="agy-badge-dot"'));
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
        topChatSteps: [
          {
            name: 'Step 2 (SYSTEM_MESSAGE)',
            label: 'Subagent reply: research',
            badge: 'Subagent',
            stepRef: '#2',
            subagentId: 'sub-l2',
            tokens: 3200,
            formattedTokens: '3.2k',
            barPct: 100,
          },
        ],
        promptSections: [],
      },
    },
  }, { culpritsExpanded: true });

  assert.ok(!l2Html.includes(HOSTILE));
  assert.ok(l2Html.includes('class="subagent-banner"'));
  assert.ok(l2Html.includes(`← Parent: L1 Coord ${HOSTILE_ESCAPED}`));
  assert.ok(l2Html.includes('data-subagent-id="sub-l1"'));
  assert.ok(l2Html.includes('class="agy-btn subagent-root-btn" data-subagent-id="root-1"'));
  assert.ok(l2Html.includes('class="fit-card subagent-culprit clickable"'));

  const optsHtml = ui.renderSessionOptions(
    [{ cascadeId: 'root-1', title: 'Root Session' }],
    {
      cascadeId: 'sub-l2',
      isSubagent: true,
      title: `Worker ${HOSTILE}`,
      rootTitle: 'Root Session',
    },
    'sub-l2'
  );
  assert.ok(!optsHtml.includes(HOSTILE));
  assert.match(optsHtml, /<option value="sub-l2" selected>Subagent: Worker &lt;img/);
  assert.equal((optsHtml.match(/Pin:/g) || []).length, 1);

  // CM-AUD-06: renderMcpBudgetsTab displays droppedByCap and droppedByBudget
  const mcpInjHtml = ui.renderMcpBudgetsTab({
    turnInsights: {
      budgets: { skills: { formattedUsed: '2.0k', formattedLimit: '20.0k', pct: 10, formattedPct: '10.0%' } },
      culprits: {
        skillInjections: {
          totalInjectedBytes: 5000,
          estimatedTokens: 1400,
          injections: [
            {
              stepIndex: 3,
              hookEvent: 'PreToolUse',
              injectedSkills: ['nextjs'],
              droppedByCap: ['geist'],
              droppedByBudget: ['ai-sdk'],
            },
          ],
        },
      },
    },
    mcpCatalog: { servers: [], counts: { enabledSkills: 2, enabledRules: 1 } },
  });
  assert.match(mcpInjHtml, /dropped:/i);
  assert.match(mcpInjHtml, /geist/);
  assert.match(mcpInjHtml, /ai-sdk/);

  // CM-AUD-07: mergeIncomingLogs preserves new intermediate lines when a 3-line anchor repeats at the end of incoming
  const existingLogs = ['L1', 'L2', 'A', 'B', 'C'];
  const incomingLogs = ['A', 'B', 'C', 'NEW_ERR_429', 'A', 'B', 'C'];
  const mergedLogs = ui.mergeIncomingLogs(existingLogs, incomingLogs, 80);
  assert.deepEqual(Array.from(mergedLogs), ['L1', 'L2', 'A', 'B', 'C', 'NEW_ERR_429', 'A', 'B', 'C']);

  // CM-AUD-08: createVisibilityPoller is exposed on window.ContextMonitor
  assert.equal(typeof ui.createVisibilityPoller, 'function');
});

