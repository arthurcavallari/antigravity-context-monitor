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

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms = 0) {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const [id, next] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0] || [];
        if (!next || next.at > end) break;
        now = next.at;
        timers.delete(id);
        next.fn();
      }
      now = end;
      await flush();
    },
  };
}

test('the context tab shows an empty state on a new-conversation pane', () => {
  const window = {};
  const ctx = vm.createContext({ window, document: { documentElement: { style: {}, dataset: {} } } });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  const html = window.ContextMonitor.renderContextTab({ newConversation: true, session: null, context: {} });
  assert.match(html, /No conversation yet/);
});

test('app.js asks for no conversation when Antigravity frames it without an id, and guesses only in a plain tab', () => {
  const firstHostId = (search, framed) => {
    const bodies = [];
    const window = { location: { search }, addEventListener() {} };
    window.parent = framed ? {} : window;
    const ctx = vm.createContext({
      window,
      document: {
        hidden: false,
        getElementById: () => null,
        addEventListener() {},
        documentElement: { style: { setProperty() {}, removeProperty() {} }, dataset: {} },
      },
      URLSearchParams,
      setTimeout: () => 0,
      clearTimeout() {},
    });
    for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    window.ContextMonitor.apiCall = (path, body) => {
      if (path === '/api/telemetry') bodies.push(body);
      return new Promise(() => {});
    };
    vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
    return bodies[0]?.hostCascadeId;
  };
  assert.equal(firstHostId('', true), '_new');
  assert.equal(firstHostId('?conversationId=conv-1', true), 'conv-1');
  assert.equal(firstHostId('', false), '');
});

test('applyTheme preserves live host theme-change postMessage variables across subsequent /api/telemetry polls', () => {
  const props = new Map();
  const document = {
    documentElement: {
      dataset: {},
      style: {
        setProperty: (k, v) => props.set(k, v),
        removeProperty: (k) => props.delete(k),
      },
    },
  };
  const window = {};
  const ctx = vm.createContext({ window, document });
  vm.runInContext(readFileSync(join(UI_DIR, 'core.js'), 'utf8'), ctx, { filename: 'core.js' });
  const { applyTheme } = window.ContextMonitor;

  applyTheme({ mode: 'dark', vars: { '--cm-bg': '#181818', '--cm-text': '#ffffff' } });
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(props.get('--cm-bg'), '#181818');

  applyTheme({
    themeType: 'light',
    isDark: false,
    cssVariables: {
      '--background': '#f8f9fc',
      '--foreground': '#121317',
      '--agy-canvas': '#181818',
      '--agy-ink-soft': 'color-mix(in srgb, #ffffff 88%, #181818)',
    },
  });
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(props.get('--background'), '#f8f9fc');
  assert.equal(props.has('--cm-bg'), false, 'CM fallback keys removed when --background is present');
  assert.equal(props.has('--agy-canvas'), false, 'static --agy-canvas not set inline when --background is present');
  assert.equal(props.has('--agy-ink-soft'), false, 'static --agy-ink-soft not set inline when --background is present');

  applyTheme({ mode: 'dark', vars: { '--cm-bg': '#181818', '--cm-text': '#ffffff' } });
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(props.has('--cm-bg'), false);
  assert.equal(props.get('--background'), '#f8f9fc');
});

test('app.js drills into a subagent on [data-subagent-id] click and returns to auto-sync parent on breadcrumb click', async () => {
  const timers = fakeTimers();
  const calls = [];
  const { window: domWin, document: domDoc, HTMLElement, Element, customElements, CustomEvent } = parseHTML(
    '<!doctype html><html><body><div id="app"></div></body></html>'
  );
  Object.defineProperty(domDoc, 'hidden', { value: false, configurable: true });
  const window = Object.assign(domWin, {
    parent: {},
    location: { search: '?conversationId=root-conv' },
    HTMLElement,
    Element,
    customElements,
    CustomEvent,
  });
  const ctx = vm.createContext({
    window,
    document: domDoc,
    HTMLElement,
    Element,
    customElements,
    CustomEvent,
    URLSearchParams,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  window.ContextMonitor.apiCall = async (path, body) => {
    calls.push({ path, body });
    const activeId = body.cascadeId || body.hostCascadeId || 'root-conv';
    return {
      isExecuting: false,
      session: { cascadeId: activeId, isSubagent: activeId !== 'root-conv', parentConversationId: 'root-conv', rootConversationId: 'root-conv' },
      subagents: {
        rootCascadeId: 'root-conv',
        totalCount: 3,
        runningCount: 1,
        items: [
          { cascadeId: 'sub-l1', parentConversationId: 'root-conv', role: 'Auditor', status: 'CASCADE_RUN_STATUS_RUNNING', isRunning: true },
          { cascadeId: 'sub-old-1', parentConversationId: 'root-conv', role: 'Old 1', status: 'CASCADE_RUN_STATUS_IDLE', isRunning: false },
          { cascadeId: 'sub-old-2', parentConversationId: 'root-conv', role: 'Old 2', status: 'CASCADE_RUN_STATUS_IDLE', isRunning: false },
        ],
      },
      context: { totalUsedTokens: 1000 },
      sessions: [{ cascadeId: 'root-conv', title: 'Root' }],
    };
  };
  vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  await timers.advance(0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.cascadeId, '');
  assert.equal(calls[0].body.hostCascadeId, 'root-conv');

  domDoc.getElementById('subagents-collapse-toggle')?.click();
  assert.equal(domDoc.querySelector('[data-subagent-id="sub-old-1"]'), null, 'inactive subagents hidden by default when runningCount > 0');
  const showMoreBtn = domDoc.getElementById('subagents-show-more-btn');
  assert.ok(showMoreBtn, 'must render #subagents-show-more-btn when inactive subagents are hidden');
  assert.match(showMoreBtn.textContent, /Show 2 completed subagents/);
  showMoreBtn.click();
  assert.ok(domDoc.querySelector('[data-subagent-id="sub-old-1"]'), 'clicking #subagents-show-more-btn reveals completed subagents');
  assert.match(domDoc.getElementById('subagents-show-more-btn')?.textContent || '', /Hide 2 completed subagents/);

  const subRow = domDoc.querySelector('[data-subagent-id="sub-l1"]');
  assert.ok(subRow, 'Real DOM must render [data-subagent-id="sub-l1"] row');
  subRow.click();
  await timers.advance(0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.cascadeId, 'sub-l1');
  assert.equal(window.ContextMonitor.activeConversationId, 'sub-l1');
  assert.ok(domDoc.querySelector('[data-subagent-id="sub-old-1"]'), 'subagentsShowAll persists while inspecting subagent under same root');

  const rootCrumb = domDoc.querySelector('[data-subagent-id="root-conv"]');
  assert.ok(rootCrumb, 'Real DOM must render [data-subagent-id="root-conv"] return breadcrumb');
  rootCrumb.click();
  await timers.advance(0);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.cascadeId, '');
  assert.equal(window.ContextMonitor.activeConversationId, 'root-conv');
  assert.ok(domDoc.querySelector('[data-subagent-id="sub-old-1"]'), 'subagentsShowAll persists when returning to same root');
});

test('app.js restores Auto-sync when returning from subagent to workspace-matched root and clears subagent pin on conversation-change', async () => {
  const timers = fakeTimers();
  const winListeners = {};
  const calls = [];
  const { window: domWin, document: domDoc, HTMLElement, Element, customElements, CustomEvent } = parseHTML(
    '<!doctype html><html><body><div id="app"></div></body></html>'
  );
  Object.defineProperty(domDoc, 'hidden', { value: false, configurable: true });
  const origAddListener = domWin.addEventListener.bind(domWin);
  const window = Object.assign(domWin, {
    location: { search: '' },
    HTMLElement,
    Element,
    customElements,
    CustomEvent,
    addEventListener: (type, fn, opts) => {
      winListeners[type] = fn;
      return origAddListener(type, fn, opts);
    },
  });
  window.parent = window;
  const ctx = vm.createContext({
    window,
    document: domDoc,
    HTMLElement,
    Element,
    customElements,
    CustomEvent,
    URLSearchParams,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  window.ContextMonitor.apiCall = async (path, body) => {
    calls.push({ path, body });
    const activeId = body.cascadeId || body.hostCascadeId || 'ws-root-2';
    const rootId = activeId === 'new-host-root' ? 'new-host-root' : 'ws-root-2';
    return {
      isExecuting: false,
      session: { cascadeId: activeId, isSubagent: activeId === 'sub-ws-1', parentConversationId: rootId, rootConversationId: rootId },
      subagents: {
        rootCascadeId: rootId,
        totalCount: 2,
        runningCount: 1,
        items: [
          { cascadeId: 'sub-ws-run', parentConversationId: rootId, role: 'Runner', status: 'RUNNING', isRunning: true },
          { cascadeId: 'sub-ws-1', parentConversationId: rootId, role: 'Worker', status: 'DONE', isRunning: false },
        ],
      },
      context: { totalUsedTokens: 1000 },
      sessions: [{ cascadeId: 'other-root-1', title: 'Other Root' }, { cascadeId: 'ws-root-2', title: 'Workspace Root' }],
    };
  };
  vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  await timers.advance(0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.cascadeId, '');

  domDoc.getElementById('subagents-collapse-toggle')?.click();
  domDoc.getElementById('subagents-show-more-btn')?.click();
  const subRow = domDoc.querySelector('[data-subagent-id="sub-ws-1"]');
  assert.ok(subRow);
  subRow.click();
  await timers.advance(0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.cascadeId, 'sub-ws-1');

  const rootCrumb = domDoc.querySelector('[data-subagent-id="ws-root-2"]');
  assert.ok(rootCrumb);
  rootCrumb.click();
  await timers.advance(0);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.cascadeId, '');

  domDoc.querySelector('[data-subagent-id="sub-ws-1"]').click();
  await timers.advance(0);
  assert.equal(calls[3].body.cascadeId, 'sub-ws-1');
  winListeners.message({ source: window.parent, data: { type: 'conversation-change', payload: { conversationId: 'new-host-root' } } });
  await timers.advance(0);
  assert.equal(calls[4].body.cascadeId, '');
  assert.equal(calls[4].body.hostCascadeId, 'new-host-root');
  assert.equal(domDoc.querySelector('[data-subagent-id="sub-ws-1"]'), null, 'switching root conversation resets subagentsShowAll to false');
});

test('diagnostics-tab and context-tab delegate clicks cleanly through #app without duplicate document listeners or _cmFixHandled', async () => {
  const timers = fakeTimers();
  const { window: domWin, document: domDoc, HTMLElement, Element, customElements, CustomEvent } = parseHTML(
    '<!doctype html><html><body><div id="app"></div></body></html>'
  );
  const posted = [];
  const notifyCalls = [];
  const apiCalls = [];
  let appClickHandler = null;
  const appEl = domDoc.getElementById('app');
  const origAddEvent = appEl.addEventListener.bind(appEl);
  appEl.addEventListener = (type, fn, opts) => {
    if (type === 'click') appClickHandler = fn;
    return origAddEvent(type, fn, opts);
  };
  const window = {
    parent: { postMessage: (msg, origin) => posted.push({ msg, origin }) },
    location: { search: '?conversationId=c-diag', origin: 'http://127.0.0.1:52320' },
    addEventListener() {},
  };
  const document = {
    hidden: false,
    referrer: 'http://127.0.0.1:53555/',
    getElementById: (id) => domDoc.getElementById(id),
    createElement: (tag) => domDoc.createElement(tag),
    querySelector: (sel) => domDoc.querySelector(sel),
    querySelectorAll: (sel) => domDoc.querySelectorAll(sel),
    addEventListener() {},
    documentElement: { style: { setProperty() {}, removeProperty() {} }, dataset: {} },
  };
  const ctx = vm.createContext({
    window,
    document,
    HTMLElement,
    Element,
    customElements,
    CustomEvent,
    URL,
    URLSearchParams,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  window.ContextMonitor.notifyAgent = async (payload) => {
    notifyCalls.push(payload);
    return { ok: true };
  };
  window.ContextMonitor.apiCall = async (path, body) => {
    apiCalls.push({ path, body });
    if (path === '/api/diagnostics') {
      return {
        terminals: [{ terminalId: 'term-z', pid: 777, title: 'pwsh', workspaceUri: 'file:///c:/repo' }],
        sidecars: [{ sidecarId: 'broken-sc', displayName: 'Broken', statusBadge: 'ERRORED', isErrored: true, pluginId: 'broken-plugin' }],
      };
    }
    return { isExecuting: false, session: { cascadeId: 'c-diag' }, context: { totalUsedTokens: 500 } };
  };
  vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  await timers.advance(0);

  const diagTabBtn = domDoc.querySelector('[data-tab="diagnostics"]');
  assert.ok(diagTabBtn);
  document.activeElement = diagTabBtn;
  let focusedActiveTab = false;
  const origFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function () {
    if (this.getAttribute?.('data-tab') === 'diagnostics') focusedActiveTab = true;
  };
  try {
    await appClickHandler({ target: diagTabBtn });
    await timers.advance(0);
  } finally {
    HTMLElement.prototype.focus = origFocus;
  }
  assert.equal(focusedActiveTab, true, 'headerSlot replacement must restore focus to active #tab-nav button when focus was inside #tab-nav');

  const logToggleBtn = domDoc.getElementById('diag-log-toggle');
  assert.ok(logToggleBtn);
  await appClickHandler({ target: logToggleBtn });
  assert.equal(logToggleBtn.getAttribute('aria-checked'), 'true');
  assert.equal(logToggleBtn.classList.contains('on'), true);

  const optsHtml = window.ContextMonitor.renderSessionOptions([{ cascadeId: 's1', title: 'Alpha' }], { title: 'Main' }, '');
  assert.equal(
    String(window.ContextMonitor.html`<select>${optsHtml}</select>`).includes('<option value="" selected>Auto-sync: Main</option>'),
    true,
    'renderSessionOptions must return rawHtml so interpolating into html does not double-escape <option> tags'
  );

  const fixBtn = domDoc.querySelector('[data-action="fix-with-agent"]');
  assert.ok(fixBtn);
  const fixEv = { target: fixBtn };
  await appClickHandler(fixEv);
  assert.equal(notifyCalls.length, 0, 'Ask agent to fix opens a confirmation before starting a turn');
  assert.equal('_cmFixHandled' in fixEv, false);
  const dialog = domDoc.getElementById('cm-dialog');
  assert.ok(dialog, 'the confirmation dialog is open');
  assert.match(dialog.textContent, /Send this diagnostic to the agent\?/);
  dialog.querySelector('[data-dialog="confirm"]').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifyCalls.length, 1);
  assert.equal(domDoc.getElementById('cm-dialog'), null, 'the dialog closes once the diagnostic is sent');

  const navBtn = domDoc.querySelector('[data-action="hangar-navigate"]');
  assert.ok(navBtn);
  await appClickHandler({ target: navBtn });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].msg.type, 'hangar-navigate');
  assert.equal(posted[0].msg.pluginId, 'broken-plugin');
});
