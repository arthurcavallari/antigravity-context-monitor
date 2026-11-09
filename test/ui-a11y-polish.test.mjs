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

test('the conversation picker has a real label and a tooltip-free default', () => {
  const { cm, root } = loadDom();
  cm.ensureShellMounted(root, {}, () => {}, () => {});
  const select = root.querySelector('#session-select');
  const label = root.querySelector('label[for="session-select"]');
  assert.equal(label?.textContent, 'Conversation');
  assert.ok(label.classList.contains('cm-sr-only'));
  assert.equal(select.hasAttribute('title'), false, 'the old instruction-as-title is gone; app.js sets the selected title');
});
