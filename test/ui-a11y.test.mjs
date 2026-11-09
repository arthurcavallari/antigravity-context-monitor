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
  const before = [root.querySelector('.subagent-inspect-btn'), root.querySelector('.subagent-card'), root.querySelector('.checkpoint-details summary')];
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

  const bare = loadDom();
  bare.cm.showToast('Terminate "pwsh"? Click again to confirm.', false, 1);
  const slot = bare.document.getElementById('action-msg-slot');
  assert.equal(slot.getAttribute('aria-live'), 'polite');
  bare.cm.showToast('Failed to notify Agent', 'error', 1);
  assert.equal(slot.querySelector('.error-banner')?.getAttribute('role'), 'alert');
});
