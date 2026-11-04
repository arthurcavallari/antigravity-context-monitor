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
    pending: () => timers.size,
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

function bootApp() {
  const timers = fakeTimers();
  const docListeners = {};
  const winListeners = {};
  const parent = {};
  const host = { executing: false, telemetryCalls: 0 };
  const observers = [];
  class IntersectionObserver {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe(target) {
      this.target = target;
    }
  }
  const { document: domDoc, HTMLElement, Element, customElements, CustomEvent } = parseHTML(
    '<!doctype html><html><body><div id="app"></div></body></html>'
  );
  const document = {
    hidden: false,
    getElementById: (id) => domDoc.getElementById(id),
    createElement: (tag) => domDoc.createElement(tag),
    querySelector: (sel) => domDoc.querySelector(sel),
    querySelectorAll: (sel) => domDoc.querySelectorAll(sel),
    addEventListener: (type, fn) => (docListeners[type] = fn),
    documentElement: { style: { setProperty() {}, removeProperty() {} }, dataset: {} },
  };
  const window = {
    parent,
    location: { search: '' },
    addEventListener: (type, fn) => (winListeners[type] = fn),
  };
  const ctx = vm.createContext({
    window,
    document,
    HTMLElement,
    Element,
    customElements,
    CustomEvent,
    URLSearchParams,
    IntersectionObserver,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  window.ContextMonitor.apiCall = async (path) => {
    if (path === '/api/telemetry') host.telemetryCalls++;
    return { isExecuting: host.executing, session: { cascadeId: 'c1' }, context: { totalUsedTokens: 1 } };
  };
  vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });

  return {
    ui: window.ContextMonitor,
    timers,
    host,
    document,
    post: (data) => winListeners.message({ source: parent, data }),
    fireVisibilityChange: () => docListeners.visibilitychange(),
    setInViewport: (isIntersecting) => {
      for (const o of observers) if (o.target === document.documentElement) o.cb([{ isIntersecting }]);
    },
  };
}

test('nextPollDelayMs polls fast while executing or tailing diagnostics, slowly while idle', () => {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(readFileSync(join(UI_DIR, 'core.js'), 'utf8'), ctx);
  const ui = ctx.window.ContextMonitor;
  assert.equal(ui.nextPollDelayMs({ isExecuting: true }), ui.POLL_FAST_MS);
  assert.equal(ui.nextPollDelayMs({ activeTab: 'diagnostics' }), ui.POLL_FAST_MS);
  assert.equal(ui.nextPollDelayMs({ isExecuting: false, activeTab: 'context' }), ui.POLL_IDLE_MS);
  assert.ok(ui.POLL_IDLE_MS > ui.POLL_FAST_MS);

  assert.equal(ui.readHostVisibility({ type: 'sidecar-visibility', payload: { visible: false } }), false);
  assert.equal(ui.readHostVisibility({ type: 'sidecar-visibility', payload: { visible: true } }), true);
  assert.equal(ui.readHostVisibility({ type: 'sidecar-visibility', payload: { visible: 'no' } }), null);
  assert.equal(ui.readHostVisibility({ type: 'theme-change', payload: {} }), null);
});

test('app.js polls adaptively and pauses while Hangar hides the frame', async () => {
  const app = bootApp();
  const { POLL_FAST_MS, POLL_IDLE_MS } = app.ui;
  await app.timers.advance(0);
  assert.equal(app.host.telemetryCalls, 1);
  assert.ok(app.document.getElementById('card-tab-slot'), 'real linkedom #app mounted #card-tab-slot during poll');

  await app.timers.advance(POLL_IDLE_MS - 1);
  assert.equal(app.host.telemetryCalls, 1);
  await app.timers.advance(1);
  assert.equal(app.host.telemetryCalls, 2);

  app.host.executing = true;
  await app.timers.advance(POLL_IDLE_MS);
  assert.equal(app.host.telemetryCalls, 3);
  await app.timers.advance(POLL_FAST_MS);
  assert.equal(app.host.telemetryCalls, 4);

  app.post({ type: 'sidecar-visibility', payload: { visible: false } });
  await app.timers.advance(60_000);
  assert.equal(app.host.telemetryCalls, 4);
  assert.equal(app.timers.pending(), 0);

  app.post({ type: 'sidecar-visibility', payload: { visible: true } });
  await app.timers.advance(0);
  assert.equal(app.host.telemetryCalls, 5);
  app.post({ type: 'sidecar-visibility', payload: { visible: true } });
  await app.timers.advance(0);
  assert.equal(app.host.telemetryCalls, 5);
  await app.timers.advance(POLL_FAST_MS);
  assert.equal(app.host.telemetryCalls, 6);

  app.document.hidden = true;
  app.fireVisibilityChange();
  await app.timers.advance(60_000);
  assert.equal(app.host.telemetryCalls, 6);
  assert.equal(app.timers.pending(), 0);
});

test('app.js pauses when a host hides the frame with CSS without telling it', async () => {
  const app = bootApp();
  const { POLL_IDLE_MS } = app.ui;
  await app.timers.advance(0);
  assert.equal(app.host.telemetryCalls, 1);
  assert.ok(app.document.getElementById('card-tab-slot'), 'real linkedom #app mounted #card-tab-slot during poll');

  app.setInViewport(false);
  await app.timers.advance(10 * POLL_IDLE_MS);
  assert.equal(app.host.telemetryCalls, 1);
  assert.equal(app.timers.pending(), 0);

  app.setInViewport(true);
  await app.timers.advance(0);
  assert.equal(app.host.telemetryCalls, 2);
  await app.timers.advance(POLL_IDLE_MS);
  assert.equal(app.host.telemetryCalls, 3);
});

test('app.js sends the frame conversation raw, and a real change supersedes the poll in flight', async () => {
  const timers = fakeTimers();
  const winListeners = {};
  const parent = {};
  const calls = [];
  let onWorkspaceChange = null;
  const document = {
    hidden: false,
    getElementById: () => null,
    addEventListener() {},
    documentElement: { style: { setProperty() {}, removeProperty() {} }, dataset: {} },
  };
  const window = {
    parent,
    location: { search: '?conversationId=_new' },
    sidecar: { onWorkspaceChange: (cb) => (onWorkspaceChange = cb) },
    addEventListener: (type, fn) => (winListeners[type] = fn),
  };
  const ctx = vm.createContext({
    window,
    document,
    URLSearchParams,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  for (const rel of UI_SCRIPTS) vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  window.ContextMonitor.apiCall = (path, body) => new Promise((resolve) => calls.push({ path, body, resolve }));
  vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.hostCascadeId, '_new');

  const post = (conversationId) =>
    winListeners.message({ source: parent, data: { type: 'conversation-change', payload: { conversationId } } });
  post('conv-live');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.hostCascadeId, 'conv-live');
  post('conv-live');
  assert.equal(calls.length, 2);

  onWorkspaceChange(['file:///c:/repo']);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].body.workspaceUris, ['file:///c:/repo']);
  onWorkspaceChange(['file:///c:/repo']);
  assert.equal(calls.length, 3);
});
