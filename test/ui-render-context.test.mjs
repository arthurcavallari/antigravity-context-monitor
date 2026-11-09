import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { buildAgyUiJs } from 'antigravity-sidecar-kit';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const UI_SCRIPTS = [
  'core.js',
  'components/subagent-drawer.js',
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
  assert.equal(ui.renderTelemetryPillText(ctx, { performance: { turnCacheHitPct: 97 } }), 'in 1.2k · cache 45.7k (97%)');
  assert.equal(ui.renderTelemetryPillText({ rawUsage: {} }, { performance: { turnCacheHitPct: 0 } }), 'in 0k · cache 0k');
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
      subagents: { totalCount: 2, runningCount: 1, activeSubagentLabel: `DeepCoder ${HOSTILE}` },
      model: { badgeLabel: 'Gemini 4 Argon (High)' },
      context: { formattedUsed: '42.0k', formattedCeiling: '256k', formattedUsedPct: '16.4%' },
    },
    { activeTab: 'context' },
    false
  );
  assert.ok(!headerHtml.includes(HOSTILE));
  assert.ok(headerHtml.includes(`class="activity-pulse active" title="Subagent executing: DeepCoder ${HOSTILE_ESCAPED}"`));
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
        cascadeId: 'sub-l1', nestingDepth: 1, typeName: 'argon-840k', role: 'Coordinator',
        title: `Coordinator ${HOSTILE}`, modelBadge: `Gemini 4 Argon ${HOSTILE}`, statusBadge: 'Done',
        isRunning: false, stepCount: 12, durationFormatted: '2m 10s',
        formattedParentContextTokens: '4.8k', spawnStepRef: '#4', promptPreview: `Prompt ${HOSTILE}`,
      },
      {
        cascadeId: `sub-l2-${HOSTILE}`, nestingDepth: 2, typeName: 'research', role: 'Worker',
        title: 'Worker (research)', modelBadge: 'Inherited', statusBadge: 'Running',
        isRunning: true, stepCount: 7, durationFormatted: '35s', promptPreview: 'Check ast',
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
  assert.ok(expanded.includes('Viewing') && expanded.includes('Inspect'));
  assert.ok(expanded.includes('4.8k in parent') && expanded.includes('(#4)'));
  assert.ok(expanded.includes('class="agy-badge ready"') && expanded.includes('class="agy-badge active"'));
  assert.ok(expanded.includes('class="agy-badge-dot"'));
  assert.ok(!expanded.includes('subagents-show-more-btn'), 'no toggle button when all items are in default visible slice');

  // With runningCount > 0 and completed items, default slice hides completed items unless pinned/viewing
  const mixed = {
    totalCount: 4, runningCount: 1, totalSteps: 30,
    items: [
      ...subagents.items,
      { cascadeId: 'done-1', nestingDepth: 1, title: 'Old 1', statusBadge: 'Done', isRunning: false, stepCount: 5 },
      { cascadeId: 'done-2', nestingDepth: 1, title: 'Old 2', statusBadge: 'Done', isRunning: false, stepCount: 6 },
    ],
  };
  const activeOnly = ui.renderSubagentsDrawer(mixed, true, 'root-1', false);
  assert.ok(activeOnly.includes('data-subagent-id="sub-l1"'), 'L1 parent of running L2 worker stays visible');
  assert.ok(!activeOnly.includes('data-subagent-id="done-1"') && !activeOnly.includes('data-subagent-id="done-2"'));
  assert.ok(activeOnly.includes('Show 2 completed subagents ▾'));

  const pinnedDone = ui.renderSubagentsDrawer(mixed, true, 'done-2', false);
  assert.ok(pinnedDone.includes('data-subagent-id="done-2"'), 'currently viewed completed subagent stays visible');
  assert.ok(pinnedDone.includes('Show 1 completed subagent ▾'));

  const allShown = ui.renderSubagentsDrawer(mixed, true, 'root-1', true);
  assert.ok(allShown.includes('data-subagent-id="done-1"') && allShown.includes('data-subagent-id="done-2"'));
  assert.ok(allShown.includes('Hide 2 completed subagents ▴'));

  // With runningCount === 0 and > 3 items, top 3 newest render by default with "Show N earlier subagents ▾"
  const allIdle = {
    totalCount: 5, runningCount: 0, totalSteps: 25,
    items: [1, 2, 3, 4, 5].map((n) => ({ cascadeId: `idle-${n}`, nestingDepth: 1, title: `Idle ${n}`, statusBadge: 'Done', isRunning: false, stepCount: 5 })),
  };
  const idleDefault = ui.renderSubagentsDrawer(allIdle, true, 'root-1', false);
  assert.ok(idleDefault.includes('data-subagent-id="idle-1"') && idleDefault.includes('data-subagent-id="idle-3"'));
  assert.ok(!idleDefault.includes('data-subagent-id="idle-4"') && idleDefault.includes('Show 2 earlier subagents ▾'));
});

test('mounts <agy-toggle-group> and <agy-switch> in linkedom with AgyUI loaded without losing declarative children', () => {
  const { window, document, HTMLElement, customElements, CustomEvent } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const ctx = vm.createContext({ window, document, HTMLElement, customElements, CustomEvent, URLSearchParams });
  vm.runInContext(buildAgyUiJs(['core', 'tabs', 'overlays', 'controls', 'surfaces']), ctx, { filename: 'ui.js' });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  const cm = window.ContextMonitor;
  const root = document.getElementById('root');
  cm.setHtml(root, cm.renderTopHeaderAndTabs({ model: { badgeLabel: 'Gemini' }, context: {} }, { activeTab: 'mcp' }) + cm.renderContextTab({ context: { categories: [] }, planUsage: { aiCredits: { useAiCredits: true } }, turnInsights: {} }));
  assert.equal(root.querySelectorAll('agy-toggle-group .agy-toggle-item').length, 3);
  assert.equal(root.querySelector('agy-toggle-group .agy-toggle-item.active')?.getAttribute('data-tab'), 'mcp');
  assert.ok(root.querySelector('#ai-overage-toggle agy-switch.agy-switch.on'));
});

test('custom models get a neutral badge, no Gemini window claims, and a plan-usage note', () => {
  const data = {
    model: { badgeLabel: 'Qwen3 Coder (Ollama)', label: 'Qwen3 Coder (Ollama)', isCustom: true, isGemini: false },
    context: { formattedUsed: '42.0k', formattedCeiling: '96k', formattedNativeCeiling: '96k', formattedUsedPct: '43.8%' },
  };
  const header = ui.renderTopHeaderAndTabs(data, { activeTab: 'context' }, false);
  assert.ok(header.includes('class="model-badge custom clickable"'));
  assert.ok(header.includes('Custom model: its window is set by your provider'));
  assert.ok(!header.includes('context-help-btn'));

  const drawers = ui.renderHeaderDrawers(data, { modelProfileOpen: true, contextHelpOpen: true });
  assert.ok(drawers.includes('Set by your provider'));
  assert.ok(drawers.includes('Not checked for custom models'));
  assert.ok(!drawers.includes('single-turn burst'));
  assert.ok(!drawers.includes('Cortex Harness'));

  const tab = ui.renderContextTab({
    context: {},
    planUsage: {
      customModel: true,
      activeGroupId: '',
      groups: [{ id: 'gemini', displayName: 'Gemini Models', fiveHour: {}, weekly: {} }],
    },
    turnInsights: {
      effortAdvisor: {
        totalTurns: 1,
        optimalTurns: 1,
        flaggedTurnsCount: 0,
        customTurns: 2,
        latestTurnFit: { turnNumber: 1, promptPreview: 'p', status: 'optimal', badge: 'Good fit', shortModelLabel: 'Flash (Low)', reason: 'r', phaseSplit: {} },
        recentFlaggedTurns: [],
      },
    },
  });
  assert.ok(tab.includes('class="plan-note"'));
  assert.ok(!tab.includes('Active</span>'));
  assert.ok(tab.includes('1/1 matched · 2 custom skipped'));

  const builtIn = ui.renderTopHeaderAndTabs({ model: { badgeLabel: 'Gemini 4 Argon (High)' }, context: {} }, { activeTab: 'context' }, false);
  assert.ok(builtIn.includes('context-help-btn'));
  assert.ok(builtIn.includes('class="model-badge clickable"'));
});
