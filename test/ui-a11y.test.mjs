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

function loadDom({ withKit = false } = {}) {
  const { window, document, HTMLElement, customElements, CustomEvent } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  // linkedom's window falls through to Node's global, so globals set by an earlier load would leak in.
  for (const key of ['AgyUI', 'AgyShell', 'ContextMonitor']) window[key] = undefined;
  const ctx = vm.createContext({
    window, document, HTMLElement, customElements, CustomEvent, URLSearchParams, setTimeout, clearTimeout,
  });
  if (withKit) vm.runInContext(buildAgyUiJs(['core', 'tabs', 'overlays', 'controls', 'surfaces']), ctx, { filename: 'ui.js' });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  return { document, cm: window.ContextMonitor, root: document.getElementById('root') };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('header exposes a labelled tablist, disclosure state, and a named activity dot', () => {
  const { cm } = loadDom();
  const closed = cm.renderTopHeaderAndTabs({ model: { badgeLabel: 'Gemini' }, context: {} }, { activeTab: 'mcp' });
  assert.match(closed, /id="tab-nav"\s+role="tablist"\s+aria-label="Context Monitor views"/);
  assert.match(closed, /id="tab-mcp"\s+role="tab"\s+aria-selected="true"\s+aria-controls="card-tab-slot"\s+tabindex="0"/);
  assert.match(closed, /id="tab-context"\s+role="tab"\s+aria-selected="false"[^>]*tabindex="-1"/);
  assert.match(closed, /id="model-badge-btn"[^>]*aria-expanded="false"\s+aria-controls="model-profile-drawer"/);
  assert.match(closed, /id="context-help-btn"[^>]*aria-expanded="false"[^>]*aria-label="Why 256k instead of 1\.0M\?"/);
  assert.match(closed, /class="activity-pulse " title="Idle" role="img" aria-label="Idle"/);
  assert.ok(!closed.includes('▾'), 'the model badge uses an icon, not a glyph screen readers read aloud');

  const open = cm.renderTopHeaderAndTabs(
    { model: { badgeLabel: 'Gemini' }, context: {} },
    { activeTab: 'context', modelProfileOpen: true, contextHelpOpen: true },
  );
  assert.match(open, /id="model-badge-btn"[^>]*aria-expanded="true"/);
  assert.match(open, /id="context-help-btn"[^>]*aria-expanded="true"/);
  assert.ok(open.includes('id="model-profile-drawer"') && open.includes('id="context-help-drawer"'));
});

test('with the kit loaded, the tab bar stays a tablist and switches are single focusable tracks', () => {
  const { cm, root } = loadDom({ withKit: true });
  cm.setHtml(
    root,
    cm.renderTopHeaderAndTabs({ model: { badgeLabel: 'Gemini' }, context: {} }, { activeTab: 'diagnostics' }) +
      cm.renderContextTab({ context: { categories: [] }, planUsage: { aiCredits: { useAiCredits: true } }, turnInsights: {} }),
  );
  const tabs = [...root.querySelectorAll('#tab-nav .agy-toggle-item')];
  assert.equal(root.querySelector('#tab-nav').getAttribute('role'), 'tablist');
  assert.deepEqual(tabs.map((t) => t.getAttribute('role')), ['tab', 'tab', 'tab']);
  assert.deepEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['false', 'false', 'true']);
  assert.ok(tabs.every((t) => !t.hasAttribute('aria-checked')), 'tabs must not be announced as radios');

  const sw = root.querySelector('#ai-overage-toggle');
  assert.equal(sw.getAttribute('role'), 'switch');
  assert.equal(sw.getAttribute('aria-labelledby'), 'ai-overage-label');
  assert.equal(root.querySelector('label#ai-overage-label').getAttribute('for'), 'ai-overage-toggle');
  assert.equal(sw.querySelectorAll('button, [tabindex], agy-switch').length, 0, 'one focusable element, so one focus ring');
  cm.setSwitch(sw, false);
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.equal(sw.classList.contains('on'), false);
});

test('diagnostics switches are labelled tracks, and Auto-scroll hides together with its label', () => {
  const { cm } = loadDom();
  const off = cm.renderDiagnosticsControls(0, { logTailingEnabled: false, logAutoScroll: true });
  assert.match(off, /id="diag-autoscroll-row" class="cm-switch-row" style="display:none"/);
  assert.match(off, /<label id="diag-log-label" for="diag-log-toggle">Tail<\/label>/);
  assert.match(off, /role="switch" aria-checked="false" class="agy-switch sm" id="diag-log-toggle" aria-labelledby="diag-log-label"/);
  assert.match(off, /role="switch" aria-checked="true" class="agy-switch sm on" id="diag-autoscroll-toggle"/);
});

test('focus keys find the same control again after an innerHTML re-render', () => {
  const { cm, root, document } = loadDom();
  const subagents = {
    totalCount: 1,
    runningCount: 1,
    items: [{ cascadeId: 'sa-1', title: 'reviewer', nestingDepth: 1, isRunning: true, stepCount: 3 }],
  };
  const compaction = { count: 1, checkpoints: [{ index: 2, stepIndex: 9, stepRange: '0–9', beforeTokens: 0, summary: 'text' }] };
  const render = () => cm.setHtml(
    root,
    cm.renderSubagentsDrawer(subagents, true, '', false) + cm.renderCompactionsDrawer(compaction, true, new Set()),
  );
  render();
  const before = [
    root.querySelector('.subagent-open'),
    root.querySelector('#subagents-collapse-toggle'),
    root.querySelector('.checkpoint-details summary'),
  ];
  const keys = before.map((el) => cm.focusKeyOf(el));
  assert.ok(keys.every(Boolean), `every control gets a key: ${keys.join(' | ')}`);

  render();
  const after = keys.map((k) => root.querySelector(k));
  after.forEach((el, i) => {
    assert.ok(el, `key ${keys[i]} finds a node after re-render`);
    assert.notEqual(el, before[i]);
    assert.equal(el.tagName, before[i].tagName);
  });
  assert.equal(cm.focusKeyOf(document.body), '');
  assert.equal(cm.focusKeyOf(document.createElement('div')), '', 'a node with no id or data key gets no key');
});

test('toasts are announced: the kit toast gets a live-region role, the fallback slot is a live region', () => {
  const kit = loadDom({ withKit: true });
  kit.cm.showToast('Could not restart sidecar', true, 1);
  const toast = kit.document.querySelector('.agy-toast');
  assert.equal(toast?.getAttribute('role'), 'alert');
  assert.equal(toast?.getAttribute('aria-live'), 'assertive');
  kit.cm.showToast('', false);
  assert.equal(kit.document.querySelector('.agy-toast'), null, 'an empty message clears the toast');

  // A kit that announces from its own live region keeps the toast (and its close button) out of it.
  const modern = loadDom();
  modern.document.defaultView.AgyUI = {
    showToast() {
      const live = modern.document.createElement('div');
      live.className = 'agy-toast-live';
      const toast = modern.document.createElement('div');
      toast.className = 'agy-toast';
      modern.document.body.append(live, toast);
      return toast;
    },
  };
  modern.cm.showToast('Reloaded github-mcp', false, 1);
  assert.equal(modern.document.querySelector('.agy-toast').hasAttribute('role'), false);

  const bare = loadDom();
  bare.cm.showToast('Terminate "pwsh"? Click again to confirm.', false, 1);
  const slot = bare.document.getElementById('action-msg-slot');
  assert.equal(slot.getAttribute('aria-live'), 'polite');
  bare.cm.showToast('Failed to notify Agent', 'error', 1);
  assert.equal(slot.querySelector('.error-banner')?.getAttribute('role'), 'alert');
});

test('a failed refresh marks the numbers stale, and the spinning refresh button ignores clicks', () => {
  const { cm, root } = loadDom();
  const data = { model: { badgeLabel: 'Gemini' }, context: {} };
  const stale = cm.renderTopHeaderAndTabs(data, { syncError: 'Language Server unreachable' });
  assert.match(stale, /class="cm-attention-chip" role="status" title="Last refresh failed: Language Server unreachable">Stale</);
  assert.doesNotMatch(stale, /id="refresh-btn"[^>]*aria-disabled/);

  const spinning = cm.renderTopHeaderAndTabs(data, { isRefreshing: true });
  assert.match(spinning, /id="refresh-btn"[^>]*aria-label="Refresh telemetry"[^>]*aria-disabled="true"/);
  assert.ok(!spinning.includes('cm-attention-chip'));
  cm.setHtml(root, spinning);
  let refreshes = 0;
  const handled = cm.handleContextClick(root.querySelector('#refresh-btn'), { isRefreshing: true }, () => {}, () => refreshes++, () => {}, () => {});
  assert.equal(handled, true);
  assert.equal(refreshes, 0);
});

test('diagnostics lists show loading and error states, and Stop/Restart are named and show progress', () => {
  const { cm } = loadDom();
  assert.match(cm.renderDiagnosticsLists(null), /class="empty-hint" role="status">[\s\S]*Loading terminals and sidecars/);
  assert.match(cm.renderDiagnosticsLists(null, { error: 'ECONNREFUSED' }), /role="alert">Could not load diagnostics: ECONNREFUSED/);
  assert.ok(cm.renderDiagnosticsLists({}).includes('No active background terminals'), 'an empty result is still an empty state');

  const data = {
    terminals: [{ terminalId: 't1', pid: 7, title: 'npm run dev' }],
    sidecars: [{ sidecarId: 'hangar', displayName: 'Hangar', isErrored: true, statusBadge: 'ERRORED', lastError: 'EADDRINUSE' }],
  };
  const idle = cm.renderDiagnosticsLists(data);
  assert.match(idle, /aria-label="Stop npm run dev \(PID 7\)"/);
  assert.match(idle, /aria-label="Restart Hangar"/);
  assert.match(idle, /Ask agent to fix/);
  assert.ok(!idle.includes('aria-busy'));
  const busy = cm.renderDiagnosticsLists(data, { pending: new Set(['term:t1']), error: 'timeout' });
  assert.match(busy, /data-terminal-id="t1"[^>]*aria-disabled="true" aria-busy="true"/);
  assert.match(busy, /data-sidecar-id="hangar"\s+aria-label="Restart Hangar"\s+title="Restart Hangar"\s*>/, 'only the pending button is busy');
  assert.match(busy, /class="error-banner diag-error" role="alert"/);
});

test('quota bars are colored by what is left, and the overage switch has a description', () => {
  const { cm } = loadDom();
  const html = cm.renderContextTab({
    context: { categories: [] },
    turnInsights: {},
    planUsage: {
      activeGroupId: 'gemini',
      groups: [
        { id: 'gemini', displayName: 'Gemini', fiveHour: { remainingPct: 62 }, weekly: { remainingPct: 20 } },
        { id: 'claude_gpt', displayName: 'Claude', fiveHour: { remainingPct: 9 }, weekly: { remainingPct: 90 } },
      ],
      aiCredits: { useAiCredits: false },
    },
  });
  const levels = [...html.matchAll(/class="quota-fill (\w+)" style="width:(\d+)%"/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(levels, [['62', 'ok'], ['20', 'warn'], ['9', 'danger'], ['90', 'ok']]);
  assert.match(html, /aria-describedby="ai-overage-desc"/);
  assert.match(html, /id="ai-overage-desc"[^>]*>Uses AI credits only after your model quota runs out\./);
});

test('custom models show no made-up specs, and an empty prompt-fit drawer says why', () => {
  const { cm } = loadDom();
  const profile = cm.renderModelProfileDrawer({ model: { isCustom: true, label: 'qwen' }, context: {} }, { modelProfileOpen: true });
  assert.ok(!profile.includes('Standard') && !profile.includes('65.5k'));
  assert.equal((profile.match(/Set by your provider/g) || []).length, 3);
  const fit = cm.renderEffortFitDrawer(
    { totalTurns: 2, optimalTurns: 0, flaggedTurnsCount: 0, customTurns: 2, latestTurnFit: null, recentFlaggedTurns: [] },
    true,
  );
  assert.match(fit, /Prompt fit is not checked for custom models\./);
});

test('the confirm dialog shows progress, keeps failures inside it, and closes on success', async () => {
  const { cm, document } = loadDom();
  document.body.innerHTML = '<div id="app"></div>';
  const attempts = [];
  const dlg = cm.openConfirmDialog({
    title: 'Send this diagnostic to the agent?',
    body: 'Sidecar "Hangar" is unhealthy',
    confirmLabel: 'Send to agent',
    onConfirm: () => new Promise((resolve, reject) => attempts.push({ resolve, reject })),
  });
  assert.equal(dlg.getAttribute('aria-labelledby'), 'cm-dialog-title');
  assert.match(dlg.querySelector('.cm-dialog-quote').textContent, /Sidecar "Hangar" is unhealthy/);

  const confirm = () => dlg.querySelector('[data-dialog="confirm"]');
  confirm().click();
  assert.equal(confirm().getAttribute('aria-disabled'), 'true');
  assert.ok(confirm().querySelector('svg'), 'a spinner shows beside the label while sending');
  confirm().click();
  assert.equal(attempts.length, 1, 'a second click while sending is ignored');

  attempts[0].reject(new Error('Agent offline'));
  await flush();
  assert.equal(dlg.querySelector('.cm-dialog-error').textContent, 'Agent offline');
  assert.equal(confirm().hasAttribute('aria-disabled'), false);

  confirm().click();
  attempts[1].resolve();
  await flush();
  assert.equal(document.getElementById('cm-dialog'), null);
});

test('drawer rows are real buttons whose label and summary can be recovered when truncated', () => {
  const { cm } = loadDom();
  const html = cm.renderCompactionsDrawer(
    { count: 2, checkpoints: [{ index: 2, stepIndex: 9, stepRange: '0–9', beforeTokens: 251000, formattedBefore: '251k', formattedAfter: '31k' }] },
    false,
    new Set(),
  );
  assert.match(html, /<button\s+type="button"\s+id="compactions-collapse-toggle"\s+class="breakdown-row collapsible-toggle"\s+aria-expanded="false"\s+aria-controls="compactions-drawer"/);
  assert.ok(!html.includes('role="button"') && !html.includes('tabindex="0"'), 'a real button needs neither');
  assert.match(html, /<span title="Compaction checkpoints \(2\)">Compaction checkpoints \(2\)<\/span>/);
  assert.match(html, /<span class="row-tokens" title="Last: 251k → 31k">Last: 251k → 31k<\/span>/);
  assert.match(cm.renderCompactionsDrawer({ count: 1, checkpoints: [{ index: 1, stepIndex: 3, stepRange: '0–3', beforeTokens: 0 }] }, true, new Set()), /id="compactions-drawer"/);
});

test('subagent cards and culprit rows have one stretched title button instead of nested controls', () => {
  const { cm, root } = loadDom();
  const subagents = {
    totalCount: 2,
    items: [
      { cascadeId: 'sa-1', title: 'reviewer', nestingDepth: 1, stepCount: 3 },
      { cascadeId: 'sa-2', title: 'writer', nestingDepth: 1, stepCount: 1 },
    ],
  };
  cm.setHtml(root, cm.renderSubagentsDrawer(subagents, true, 'sa-2', false));
  const cards = [...root.querySelectorAll('.subagent-card')];
  assert.equal(cards.length, 2);
  cards.forEach((card) => {
    assert.equal(card.hasAttribute('role') || card.hasAttribute('tabindex'), false, 'the card itself is not a control');
    assert.equal(card.querySelectorAll('button').length, 1, 'one focusable control per card');
  });
  const [first, current] = cards.map((c) => c.querySelector('button.subagent-open'));
  assert.equal(first.getAttribute('aria-label'), 'Inspect reviewer');
  assert.equal(current.getAttribute('aria-label'), 'Viewing writer');
  assert.equal(current.getAttribute('aria-current'), 'true');
  assert.equal(root.querySelector('.subagent-inspect-btn'), null);

  const culprits = cm.renderCulpritsDrawer(
    { topStepsTokens: 1000, formattedTopStepsTokens: '1.0k', topChatSteps: [{ badge: 'Subagent', label: 'code-reviewer', subagentId: 'sa-1', formattedTokens: '1.0k' }] },
    256000,
    true,
  );
  assert.match(culprits, /class="fit-card subagent-culprit clickable" style="margin-bottom:5px">/);
  assert.match(culprits, /class="fit-prompt subagent-open no-focus-ring"\s+data-subagent-id="sa-1"\s+aria-label="Inspect subagent code-reviewer"/);
});

test('narrow-pane helpers: tab labels can truncate, and category rows carry their share', () => {
  const { cm } = loadDom();
  const header = cm.renderTopHeaderAndTabs({ model: { badgeLabel: 'Gemini' }, context: {} }, { activeTab: 'context' });
  assert.match(header, /data-tab="mcp"\s+title="MCP &amp; Budgets"\s*><span class="tab-label">MCP &amp; Budgets<\/span>/);
  const tab = cm.renderContextTab({
    context: { categories: [{ id: 'messages', label: 'Messages', color: '#111', inActiveContext: true, tokens: 5, pct: 20, formattedTokens: '50.0k', formattedPct: '20.0%' }] },
    planUsage: {},
    turnInsights: {},
  });
  assert.match(tab, /class="row-tokens" data-pct="20\.0%">50\.0k</);
});
