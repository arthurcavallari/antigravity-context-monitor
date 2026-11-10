import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const UI_SCRIPTS = [
  'core.js',
  'components/subagent-drawer.js',
  'components/context-drawers.js',
  'components/context-tab.js',
  'components/mcp-budgets-tab.js',
  'components/diagnostics-tab.js',
];

function loadDom() {
  const { window, document, HTMLElement, customElements, CustomEvent } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  // linkedom's window falls through to Node's global, so globals set by an earlier load would leak in.
  for (const key of ['AgyUI', 'AgyShell', 'ContextMonitor']) window[key] = undefined;
  const ctx = vm.createContext({ window, document, HTMLElement, customElements, CustomEvent, URLSearchParams, setTimeout, clearTimeout });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  return { document, cm: window.ContextMonitor, root: document.getElementById('root') };
}

const mcpData = {
  mcpCatalog: {
    servers: [
      { serverName: 'github', fullServerName: 'plugin:github/github', enabled: true, statusBadge: 'READY', toolCount: 3 },
      { serverName: 'files', fullServerName: 'files', enabled: true, statusBadge: 'READY', toolCount: 1 },
    ],
  },
};

test('section titles are real headings, so screen readers can jump between them', () => {
  const { cm, root } = loadDom();
  cm.setHtml(
    root,
    cm.renderTopHeaderAndTabs({ model: { badgeLabel: 'Gemini' }, context: {} }, { activeTab: 'context' }) +
      cm.renderContextTab({ context: { categories: [] }, planUsage: {}, turnInsights: {} }) +
      cm.renderMcpBudgetsTab(mcpData) +
      cm.renderDiagnosticsControls(0, {}) +
      cm.renderDiagnosticsLists({}) +
      cm.renderCulpritsDrawer({ topChatSteps: [], promptSections: [] }, 256000, true),
  );
  const headings = [...root.querySelectorAll('h2, h3, h4')].map((h) => `${h.tagName} ${h.textContent.trim().split(/\s+/).slice(0, 3).join(' ')}`);
  assert.deepEqual(headings, [
    'H2 Context window',
    'H3 Plan usage',
    'H3 Context usage',
    'H3 MCP Servers 2',
    'H3 Task Logs Paused',
    'H3 Active Background Terminals',
    'H3 Sidecar Processes 0',
    'H4 Largest Active Conversation',
    'H4 System Prompt Breakdown',
  ]);
});

test('an MCP reload shows progress on its own button, and Reload All marks every reload busy', () => {
  const { cm } = loadDom();
  const reloadBtn = (html, server) => html.match(new RegExp(`<button[^>]*class="agy-icon-btn mcp-refresh-btn[^"]*"\\s+data-server="${server}"[^>]*>`))[0];
  const one = cm.renderMcpBudgetsTab(mcpData, { pendingMcp: new Set(['plugin:github/github']) });
  assert.match(reloadBtn(one, 'plugin:github/github'), /mcp-refresh-btn spinning[\s\S]*aria-label="Reload github"[\s\S]*aria-disabled="true" aria-busy="true"/);
  assert.doesNotMatch(reloadBtn(one, 'files'), /aria-busy/);
  assert.doesNotMatch(one, /id="mcp-refresh-all-btn"[^>]*aria-busy/);

  const all = cm.renderMcpBudgetsTab(mcpData, { pendingMcp: new Set(['*']) });
  assert.match(all, /id="mcp-refresh-all-btn"[^>]*aria-disabled="true" aria-busy="true"/);
  assert.match(reloadBtn(all, 'files'), /aria-busy="true"/);
  assert.doesNotMatch(cm.renderMcpBudgetsTab(mcpData), /aria-busy/, 'nothing is busy by default');
});

test('the log console is a labelled, focusable log, and says each line\'s severity', () => {
  const { cm, root, document } = loadDom();
  root.id = 'card-tab-slot';
  const state = {
    activeTab: 'diagnostics',
    logTailingEnabled: true,
    logAutoScroll: false,
    logBuffer: [
      { level: 'info', text: 'GET /rpc 200' },
      { level: 'warn', text: 'retrying after 429' },
      { level: 'error', text: 'stream reset' },
    ],
    renderedLogCount: 0,
    diagData: {},
  };
  cm.syncDiagnosticsDom(state);
  const log = document.getElementById('diag-log-console');
  assert.equal(log.getAttribute('role'), 'log');
  assert.equal(log.getAttribute('aria-live'), 'off');
  assert.equal(log.getAttribute('aria-label'), 'Language Server log');
  assert.equal(log.getAttribute('tabindex'), '0');
  const lines = [...log.querySelectorAll('.log-line')].map((l) => l.textContent);
  assert.deepEqual(lines, ['GET /rpc 200', 'Warning: retrying after 429', 'Error: stream reset']);
});

test('the activity dot keeps pulsing, slower, when reduced motion is on', () => {
  const css = readFileSync(join(UI_DIR, 'styles.css'), 'utf8');
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  assert.match(css, /\.activity-pulse\.active \{[^}]*animation: cm-pulse 2s/);
  assert.match(reduced, /\.activity-pulse\.active \{\s*animation-duration: 3s;/);
  assert.doesNotMatch(reduced, /\.activity-pulse[^{]*\{[^}]*animation: none/, 'Windows turns reduced motion on whenever Animation effects is off');
});

test('kit surfaces get Antigravity\'s 16px new-UX radius even without the host stylesheet', () => {
  const css = readFileSync(join(UI_DIR, 'styles.css'), 'utf8');
  const root = css.match(/^:root \{([\s\S]*?)\n\}/m)?.[1] ?? '';
  assert.match(root, /--nux-radius-lg: 16px;/);
});

test('terminals show their workspace folder name, with the full path on hover, and a plain PID badge', () => {
  const { cm } = loadDom();
  const html = cm.renderDiagnosticsLists({
    terminals: [{ terminalId: 't1', title: 'npm run dev', pid: 41232, workspaceUri: 'c:\\Users\\arthu\\IdeaProjects\\antigravity-context-monitor' }],
  });
  assert.match(html, /<span class="agy-badge cm-badge-muted">PID 41232<\/span>/);
  assert.doesNotMatch(html, /agy-badge-dot/, 'no status dot on a neutral fact');
  assert.match(html, /class="mcp-card-meta" title="c:\\Users\\arthu\\IdeaProjects\\antigravity-context-monitor">antigravity-context-monitor<\/div>/);

  assert.equal(cm.workspaceFolderName('/home/x/my proj/'), 'my proj');
  assert.equal(cm.workspaceFolderName('file:///c%3A/Users/arthu/My%20Repo'), 'My Repo', 'raw URIs are decoded too');
  assert.equal(cm.workspaceFolderName('file://build-server/share'), 'share');
  assert.equal(cm.workspaceFolderName('vscode-remote://wsl+Ubuntu/home/x'), 'x');
  assert.equal(cm.workspaceFolderName('100%'), '100%', 'a bad escape keeps the raw text');
  assert.match(cm.renderDiagnosticsLists({ terminals: [{ terminalId: 't2', title: 'node', pid: 1 }] }), />No workspace<\/div>/);
});

test('font sizes come from tokens, and 10px is kept for chips', () => {
  const styles = readFileSync(join(UI_DIR, 'styles.css'), 'utf8');
  const components = readFileSync(join(UI_DIR, 'components.css'), 'utf8');
  const literals = [...(styles + components).matchAll(/font-size:\s*([^;]+);/g)]
    .map((m) => m[1])
    .filter((v) => !/^var\(--(text|cm-text)-/.test(v));
  assert.deepEqual(literals, ['16px'], 'only the root size is a literal');
  assert.match(styles, /--cm-text-chip: 0\.625rem;/);
  const sizeOf = (css, sel) => css.match(new RegExp(`^${sel.replace(/\./g, '\\.')} \\{[^}]*font-size: ([^;]+);`, 'm'))?.[1];
  assert.equal(sizeOf(styles, '.tier-pill'), 'var(--cm-text-chip)');
  assert.equal(sizeOf(components, '.cm-attention-chip'), 'var(--cm-text-chip)');
  assert.equal(sizeOf(components, '.spec-label'), 'var(--cm-text-meta)', 'labels move up from 10px');
  assert.equal(sizeOf(components, '.thinking-sub'), 'var(--cm-text-meta)');

  const { cm } = loadDom();
  const counts = cm.renderMcpBudgetsTab(mcpData) + cm.renderDiagnosticsControls(3, { logTailingEnabled: true }) + cm.renderDiagnosticsLists({});
  assert.equal((counts.match(/class="tier-pill"/g) || []).length, 4, 'section counts use the count chip');
  assert.doesNotMatch(counts, /agy-count-pill/);
});

test('drawer rows and drawer cards are spaced by gap, not inline margins', () => {
  const { cm } = loadDom();
  const drawers = [
    cm.renderSubagentsDrawer({ items: [{ cascadeId: 'sa-1', title: 'explorer', status: 'CASCADE_RUN_STATUS_IDLE' }] }, false, 'root', false),
    cm.renderMcpTreeDrawer({ servers: [{ name: 'github', tools: 3 }] }, false),
    cm.renderCompactionsDrawer({ count: 1, checkpoints: [] }, false, []),
    cm.renderEffortFitDrawer(
      { totalTurns: 2, optimalTurns: 1, flaggedTurnsCount: 1, recentFlaggedTurns: [{ turnNumber: 1, promptPreview: 'x', status: 'upgrade' }] },
      true,
    ),
    cm.renderCulpritsDrawer({ topChatSteps: [{ badge: 'Step', label: 'read', formattedTokens: '1.0k' }], promptSections: [] }, 256000, true),
  ].join('');
  assert.equal((drawers.match(/class="breakdown-row collapsible-toggle"/g) || []).length, 5, 'all five drawers rendered');
  assert.doesNotMatch(drawers, /style="margin/, 'no inline margins on drawer rows or cards');
  assert.ok((drawers.match(/class="culprit-group"/g) || []).length >= 3, 'titled card groups use the gap container');
  const css = readFileSync(join(UI_DIR, 'components.css'), 'utf8');
  assert.match(css, /\.collapsible-toggle \{[^}]*margin: 0 -4px;/);
  assert.match(css, /\.culprit-group \{[^}]*gap: 5px;/);
});

test('drawers draw icons, not text glyphs that render unevenly and get read aloud', () => {
  const { cm } = loadDom();
  for (const name of ['arrow_back', 'arrow_forward', 'check', 'keyboard_arrow_up', 'subdirectory_arrow_right']) {
    assert.match(cm.ICONS[name], /^[Mm]\d/, `${name} is registered`);
  }
  const subagents = [
    { cascadeId: 'a', title: 'one', nestingDepth: 1, status: 'CASCADE_RUN_STATUS_IDLE' },
    { cascadeId: 'b', title: 'two', nestingDepth: 2, status: 'CASCADE_RUN_STATUS_IDLE' },
    ...['c', 'd', 'e'].map((id) => ({ cascadeId: id, title: id, nestingDepth: 1, status: 'CASCADE_RUN_STATUS_IDLE' })),
  ];
  const html = [
    cm.renderSubagentsDrawer({ items: subagents }, true, 'root', false),
    cm.renderSubagentsDrawer({ items: subagents }, true, 'root', true),
    cm.renderEffortFitDrawer(
      {
        totalTurns: 2,
        optimalTurns: 1,
        flaggedTurnsCount: 1,
        latestTurnFit: { status: 'optimal', shortModelLabel: 'Pro', phaseSplit: {} },
        recentFlaggedTurns: [{ turnNumber: 1, promptPreview: 'x', status: 'upgrade', shortModelLabel: 'Flash', recommendedModel: 'Pro' }],
      },
      true,
    ),
  ].join('');
  assert.doesNotMatch(html, /[←→↳▾▴✓]/);
  assert.match(html, /class="cm-icon-label"><svg[\s\S]*?<\/svg>Matched to task/);
  assert.match(html, /subagent-more-btn[\s\S]*?Show \d+ earlier subagents<svg/);
  assert.match(html, /subagent-more-btn[\s\S]*?Hide \d+ earlier subagents<svg/);
});

test('every --cm-* token styles.css defines is read somewhere', () => {
  const styles = readFileSync(join(UI_DIR, 'styles.css'), 'utf8');
  const sources = [
    styles,
    readFileSync(join(UI_DIR, 'components.css'), 'utf8'),
    ...UI_SCRIPTS.map((rel) => readFileSync(join(UI_DIR, rel), 'utf8')),
    readFileSync(join(UI_DIR, '..', 'lib', 'constants.mjs'), 'utf8'),
  ].join('\n');
  const defined = [...new Set([...styles.matchAll(/^\s*(--cm-[\w-]+):/gm)].map((m) => m[1]))];
  const unread = defined.filter((name) => !new RegExp(`var\\(${name}[,)]`).test(sources));
  assert.deepEqual(unread, []);
  assert.equal(typeof loadDom().cm.barColor, 'undefined', 'the unused color helpers are gone');
});

test('the conversation picker has a real label and a tooltip-free default', () => {
  const { cm, root } = loadDom();
  cm.ensureShellMounted(root, {}, () => {}, () => {});
  const select = root.querySelector('#session-select');
  const label = root.querySelector('label[for="session-select"]');
  assert.equal(label?.textContent, 'Conversation');
  assert.ok(label.classList.contains('cm-sr-only'));
  assert.equal(select.hasAttribute('title'), false, 'the old instruction-as-title is gone; app.js sets the selected title');
});
