import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

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
  const appListeners = {};
  const calls = [];
  const appRoot = { innerHTML: '', addEventListener: (type, fn) => (appListeners[type] = fn) };
  const document = {
    hidden: false,
    getElementById: (id) => (id === 'app' ? appRoot : null),
    addEventListener() {},
    documentElement: { style: { setProperty() {}, removeProperty() {} }, dataset: {} },
  };
  class Element {}
  const window = { parent: {}, location: { search: '?conversationId=root-conv' }, addEventListener() {} };
  const ctx = vm.createContext({
    window,
    document,
    Element,
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
      session: { cascadeId: activeId, isSubagent: activeId !== 'root-conv', parentConversationId: 'root-conv' },
      context: { totalUsedTokens: 1000 },
      sessions: [{ cascadeId: 'root-conv', title: 'Root' }],
    };
  };
  vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  await timers.advance(0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.cascadeId, '');
  assert.equal(calls[0].body.hostCascadeId, 'root-conv');

  const makeTarget = (subagentId) =>
    Object.assign(new Element(), {
      closest: (sel) => (sel === '[data-subagent-id]' ? { getAttribute: (attr) => (attr === 'data-subagent-id' ? subagentId : null) } : null),
    });

  await appListeners.click({ target: makeTarget('sub-l1') });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.cascadeId, 'sub-l1');
  assert.equal(window.ContextMonitor.activeConversationId, 'sub-l1');

  await appListeners.click({ target: makeTarget('root-conv') });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.cascadeId, '');
  assert.equal(window.ContextMonitor.activeConversationId, 'root-conv');
});

test('app.js restores Auto-sync when returning from subagent to workspace-matched root and clears subagent pin on conversation-change', async () => {
  const timers = fakeTimers();
  const appListeners = {};
  const winListeners = {};
  const calls = [];
  const appRoot = { innerHTML: '', addEventListener: (type, fn) => (appListeners[type] = fn) };
  const document = {
    hidden: false,
    getElementById: (id) => (id === 'app' ? appRoot : null),
    addEventListener() {},
    documentElement: { style: { setProperty() {}, removeProperty() {} }, dataset: {} },
  };
  class Element {}
  const window = { location: { search: '' }, addEventListener: (type, fn) => (winListeners[type] = fn) };
  window.parent = window;
  const ctx = vm.createContext({
    window,
    document,
    Element,
    URLSearchParams,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  window.ContextMonitor.apiCall = async (path, body) => {
    calls.push({ path, body });
    const activeId = body.cascadeId || body.hostCascadeId || 'ws-root-2';
    return {
      isExecuting: false,
      session: { cascadeId: activeId, isSubagent: activeId === 'sub-ws-1', parentConversationId: 'ws-root-2', rootConversationId: 'ws-root-2' },
      subagents: { items: [{ cascadeId: 'sub-ws-1', parentConversationId: 'ws-root-2' }] },
      context: { totalUsedTokens: 1000 },
      sessions: [{ cascadeId: 'other-root-1', title: 'Other Root' }, { cascadeId: 'ws-root-2', title: 'Workspace Root' }],
    };
  };
  vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  await timers.advance(0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.cascadeId, '');

  const makeTarget = (subagentId) =>
    Object.assign(new Element(), {
      closest: (sel) => (sel === '[data-subagent-id]' ? { getAttribute: (attr) => (attr === 'data-subagent-id' ? subagentId : null) } : null),
    });

  await appListeners.click({ target: makeTarget('sub-ws-1') });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.cascadeId, 'sub-ws-1');

  await appListeners.click({ target: makeTarget('ws-root-2') });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.cascadeId, '');

  await appListeners.click({ target: makeTarget('sub-ws-1') });
  assert.equal(calls[3].body.cascadeId, 'sub-ws-1');
  winListeners.message({ source: window.parent, data: { type: 'conversation-change', payload: { conversationId: 'new-host-root' } } });
  await timers.advance(0);
  assert.equal(calls[4].body.cascadeId, '');
  assert.equal(calls[4].body.hostCascadeId, 'new-host-root');
});
