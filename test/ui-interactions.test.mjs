import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { buildAgyUiJs } from 'antigravity-sidecar-kit';
import { AGY_CLIENT_JS } from 'antigravity-sidecar-kit/shell';

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

  assert.equal(
    domDoc.querySelector('[data-action="hangar-navigate"]'),
    null,
    'native Aux Pane (no ?host=hangar) must not render dead Inspect in Hangar buttons'
  );
  window.location.search = '?conversationId=c-diag&host=hangar';
  const contextTabBtn = domDoc.querySelector('[data-tab="context"]');
  await appClickHandler({ target: contextTabBtn });
  await appClickHandler({ target: domDoc.querySelector('[data-tab="diagnostics"]') });
  await timers.advance(0);

  const navBtn = domDoc.querySelector('[data-action="hangar-navigate"]');
  assert.ok(navBtn, '?host=hangar renders Inspect in Hangar button');
  await appClickHandler({ target: navBtn });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].msg.type, 'hangar-navigate');
  assert.equal(posted[0].msg.targetTab, 'sidecars');
  assert.equal(posted[0].msg.pluginId, 'broken-plugin');
  assert.equal(posted[0].msg.targetId, 'broken-sc');
});

test('notifyAgent resolves async window.sidecar.getWorkspaceUris() on _new conversation panes [CM-08]', async () => {
  const notifyBodies = [];
  const window = {
    location: { search: '?conversationId=_new' },
    sidecar: {
      conversationId: '_new',
      getWorkspaceUris: async () => ['file:///c%3A/Users/arthu/IdeaProjects/antigravity-context-monitor'],
      onWorkspaceChange: () => () => {},
    },
    addEventListener() {},
  };
  window.parent = {};
  const ctx = vm.createContext({
    window,
    document: { documentElement: { style: { setProperty() {}, removeProperty() {} }, dataset: {} } },
    URLSearchParams,
  });
  vm.runInContext(readFileSync(join(UI_DIR, 'core.js'), 'utf8'), ctx, { filename: 'core.js' });
  window.ContextMonitor.apiCall = async (path, body) => {
    notifyBodies.push({ path, body });
    return { ok: true };
  };

  await window.ContextMonitor.notifyAgent({
    message: 'Sidecar docker-ops failed with EADDRINUSE',
    title: 'Sidecar Diagnostic',
  });

  assert.equal(notifyBodies.length, 1);
  assert.equal(notifyBodies[0].path, '/api/notify');
  assert.equal(notifyBodies[0].body.conversationId, '_new');
  assert.equal(notifyBodies[0].body.workspace, 'file:///c%3A/Users/arthu/IdeaProjects/antigravity-context-monitor');
  assert.equal(window.ContextMonitor.activeWorkspaceUri, 'file:///c%3A/Users/arthu/IdeaProjects/antigravity-context-monitor');
});

test('clicking [data-file-uri] dispatches background toggle-aux-pane for files and artifacts, and #new-conv-btn dispatches new-conversation with compactionRisk accents', async () => {
  const timers = fakeTimers();
  const { window: domWin, document: domDoc, HTMLElement, Element, customElements, CustomEvent } = parseHTML(
    '<!doctype html><html><body><div id="app"></div></body></html>'
  );
  Object.defineProperty(domDoc, 'hidden', { value: false, configurable: true });
  const posted = [];
  let currentRisk = 'normal';
  let currentSessionId = 'conv-active-1';
  const window = Object.assign(domWin, {
    parent: { postMessage: (msg, origin) => posted.push({ msg, origin }) },
    location: { search: '?conversationId=conv-active-1' },
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
  window.ContextMonitor.apiCall = async () => ({
    isExecuting: false,
    session: currentSessionId ? { cascadeId: currentSessionId, title: 'Main' } : null,
    newConversation: !currentSessionId,
    context: {
      totalUsedTokens: 180_000,
      ceilingTokens: 256_000,
      compactionRisk: currentRisk,
      categories: [],
    },
    turnInsights: {
      culprits: {
        topStepsTokens: 9000,
        formattedTopStepsTokens: '9.0k top 2',
        topChatSteps: [
          {
            badge: 'Read',
            label: 'Viewed server.mjs',
            stepRef: '#1',
            fileUri: 'file:///c:/repo/server.mjs',
            isArtifact: false,
            formattedTokens: '5.0k',
            barPct: 100,
          },
          {
            badge: 'Edit',
            label: 'Edited plan.md',
            stepRef: '#2',
            fileUri: 'file:///c:/Users/arthu/.gemini/antigravity/brain/conv-active-1/plan.md',
            isArtifact: true,
            formattedTokens: '4.0k',
            barPct: 80,
          },
        ],
        promptSections: [],
      },
    },
    sessions: [{ cascadeId: 'conv-active-1', title: 'Main' }],
  });

  vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  await timers.advance(0);

  const newConvBtn = domDoc.getElementById('new-conv-btn');
  assert.ok(newConvBtn, 'mounts #new-conv-btn in .session-bar');
  assert.equal(newConvBtn.classList.contains('warn'), false);
  assert.equal(newConvBtn.classList.contains('danger'), false);

  newConvBtn.click();
  assert.equal(posted.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0].msg)), { type: 'new-conversation' });

  currentRisk = 'warn';
  domDoc.getElementById('refresh-btn').click();
  await timers.advance(0);
  assert.equal(newConvBtn.classList.contains('warn'), true);
  assert.equal(newConvBtn.classList.contains('danger'), false);

  currentRisk = 'danger';
  domDoc.getElementById('refresh-btn').click();
  await timers.advance(0);
  assert.equal(newConvBtn.classList.contains('warn'), false);
  assert.equal(newConvBtn.classList.contains('danger'), true);

  domDoc.getElementById('culprits-collapse-toggle').click();
  const fileBtns = [...domDoc.querySelectorAll('[data-file-uri]')];
  assert.equal(fileBtns.length, 2);

  fileBtns[0].click();
  assert.equal(posted.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[1].msg)), {
    type: 'toggle-aux-pane',
    payload: {
      tabType: 'fileView',
      uri: 'file:///c:/repo/server.mjs',
      background: true,
      keepOpen: true,
      targetConversationId: 'conv-active-1',
    },
  });

  fileBtns[1].click();
  assert.equal(posted.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[2].msg)), {
    type: 'toggle-aux-pane',
    payload: {
      tabType: 'artifactView',
      uri: 'file:///c:/Users/arthu/.gemini/antigravity/brain/conv-active-1/plan.md',
      background: true,
      targetConversationId: 'conv-active-1',
    },
  });
  assert.equal('keepOpen' in posted[2].msg.payload, false, 'artifactView omits keepOpen');

  window.ContextMonitor.activeConversationId = '_new';
  currentSessionId = '';
  fileBtns[0].click();
  assert.equal(posted.length, 4);
  assert.equal('targetConversationId' in posted[3].msg.payload, false);
});

test('clicking #diag-export-btn invokes AgyShell.downloadFile producing valid JSON containing diagnostics and logs', async () => {
  const timers = fakeTimers();
  const { window: domWin, document: domDoc, HTMLElement, Element, customElements, CustomEvent } = parseHTML(
    '<!doctype html><html><body><div id="app"></div></body></html>'
  );
  Object.defineProperty(domDoc, 'hidden', { value: false, configurable: true });
  const downloadCalls = [];
  const window = Object.assign(domWin, {
    parent: {},
    location: { search: '?conversationId=c-exp' },
    HTMLElement,
    Element,
    customElements,
    CustomEvent,
    AgyShell: {
      downloadFile: async (opts) => {
        const raw = await opts.produce();
        downloadCalls.push({ opts, raw });
        return { ok: true, mode: 'direct' };
      },
    },
  });
  const ctx = vm.createContext({
    window,
    document: domDoc,
    HTMLElement,
    Element,
    customElements,
    CustomEvent,
    URLSearchParams,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  window.ContextMonitor.apiCall = async (path) => {
    if (path === '/api/diagnostics') {
      return {
        terminals: [{ terminalId: 'term-1', pid: 101, title: 'node', workspaceUri: 'file:///c:/repo' }],
        sidecars: [{ sidecarId: 'cm', displayName: 'Context Monitor', statusBadge: 'RUNNING', isRunning: true }],
        logs: [{ level: 'warn', text: 'HTTP 429 retry #1' }],
      };
    }
    return {
      isExecuting: false,
      session: { cascadeId: 'c-exp', title: 'Export Session' },
      model: { label: 'Gemini 4 Argon (High)' },
      context: { totalUsedTokens: 12_000 },
      turnInsights: { performance: { ttftFormatted: '0.8s' } },
    };
  };

  vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  await timers.advance(0);

  domDoc.querySelector('[data-tab="diagnostics"]').click();
  await timers.advance(0);
  domDoc.getElementById('diag-log-toggle').click();
  await timers.advance(0);

  const exportBtn = domDoc.getElementById('diag-export-btn');
  assert.ok(exportBtn, 'renders #diag-export-btn in diagnostics controls');
  exportBtn.click();
  await timers.advance(0);

  assert.equal(downloadCalls.length, 1);
  assert.equal(downloadCalls[0].opts.filename, 'context-monitor-diagnostics.json');
  assert.equal(downloadCalls[0].opts.mimeType, 'application/json');
  assert.equal(downloadCalls[0].opts.title, 'Context Monitor Diagnostics');

  const parsed = JSON.parse(downloadCalls[0].raw);
  assert.equal(typeof parsed.exportedAt, 'string');
  assert.equal(parsed.session.cascadeId, 'c-exp');
  assert.equal(parsed.model.label, 'Gemini 4 Argon (High)');
  assert.equal(parsed.context.totalUsedTokens, 12_000);
  assert.equal(parsed.turnInsights.performance.ttftFormatted, '0.8s');
  assert.equal(parsed.diagnostics.terminals[0].terminalId, 'term-1');
  assert.deepEqual(parsed.logs, [{ level: 'warn', text: 'HTTP 429 retry #1' }]);

  // Also verify delegation through real AgyShell + AgyUI (sandboxed iframe fallback modal)
  const { window: kitWin, document: kitDoc, HTMLElement: KitEl, customElements: kitCE, CustomEvent: KitEv } = parseHTML(
    '<!doctype html><html><body><div id="app"></div></body></html>'
  );
  for (const key of ['AgyUI', 'AgyShell', 'ContextMonitor']) kitWin[key] = undefined;
  const kitPosted = [];
  Object.assign(kitWin, {
    parent: { postMessage: (msg, origin) => kitPosted.push({ msg, origin }) },
    location: { search: '?conversationId=conv-kit' },
    Blob,
    URL,
    HTMLElement: KitEl,
    customElements: kitCE,
    CustomEvent: KitEv,
  });
  const kitCtx = vm.createContext({
    window: kitWin,
    document: kitDoc,
    HTMLElement: KitEl,
    customElements: kitCE,
    CustomEvent: KitEv,
    Blob,
    URL,
    URLSearchParams,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  vm.runInContext(AGY_CLIENT_JS, kitCtx, { filename: 'shell.js' });
  vm.runInContext(buildAgyUiJs(['core', 'tabs', 'overlays', 'controls', 'surfaces']), kitCtx, { filename: 'ui.js' });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), kitCtx, { filename: rel });

  kitWin.ContextMonitor.newConversation();
  kitWin.ContextMonitor.toggleAuxPane({ tabType: 'fileView', uri: 'file:///c:/a.js', background: true, keepOpen: true });
  assert.deepEqual(JSON.parse(JSON.stringify(kitPosted[0].msg)), { type: 'new-conversation' });
  assert.deepEqual(JSON.parse(JSON.stringify(kitPosted[1].msg)), {
    type: 'toggle-aux-pane',
    payload: { tabType: 'fileView', uri: 'file:///c:/a.js', background: true, keepOpen: true },
  });
  const modalRes = await kitWin.ContextMonitor.downloadFile({
    filename: 'context-monitor-diagnostics.json',
    mimeType: 'application/json',
    title: 'Context Monitor Diagnostics',
    produce: () => '{"diagnostics":{},"logs":[]}',
  });
  assert.equal(modalRes.ok, true);
  assert.equal(modalRes.mode, 'fallback');
  assert.ok(kitDoc.querySelector('.agy-download-modal'), 'real AgyShell.downloadFile opens AgyUI download modal in sandboxed iframe');
});
