/**
 * @fileoverview Main frontend controller for the Context Monitor sidecar.
 * Manages 3 tabs (Context, MCP & Budgets, Diagnostics), persistent dropdown,
 * decoupled header/body slots, root event delegation, and zero-jitter log tailing.
 */

(function () {
  const {
    apiCall,
    applyTheme,
    esc,
    renderTopHeaderAndTabs,
    renderSessionOptions,
    renderTelemetryPillText,
    renderContextTab,
    renderMcpBudgetsTab,
    mergeIncomingLogs,
    syncDiagnosticsDom,
  } = window.ContextMonitor;

  const POLL_INTERVAL_MS = 1500;
const PULSE_HOLD_MS = 2500;
const ACTION_MSG_MS = 4000;
const DRAWER_TOGGLES = {
  '#model-badge-btn': 'modelProfileOpen',
  '#context-help-btn': 'contextHelpOpen',
  '#mcp-collapse-toggle': 'mcpExpanded',
  '#compactions-collapse-toggle': 'compactionsExpanded',
  '#effort-fit-collapse-toggle': 'effortFitExpanded',
  '#culprits-collapse-toggle': 'culpritsExpanded',
};

const state = {
  activeTab: 'context', pinnedCascadeId: '',
  hostCascadeId: window.sidecar?.conversationId || new URLSearchParams(window.location.search).get('conversationId') || '',
  workspaceUris: [], mcpExpanded: false, compactionsExpanded: false, effortFitExpanded: false, culpritsExpanded: false,
  contextHelpOpen: false, modelProfileOpen: false, openCheckpoints: new Set(), logTailingEnabled: false,
  logAutoScroll: true, isProgrammaticScroll: false, logBuffer: [], renderedLogCount: 0, isRefreshing: false,
  lastTotalTokens: null, lastCascadeId: '', lastTokenChangeAt: 0, lastHeaderHtml: '', lastTabHtml: '',
  lastDiagHeaderHtml: '', lastDiagListsHtml: '', lastOptionsSig: '', isSelectMenuOpen: false, latestData: null, diagData: null,
};

const appRoot = document.getElementById('app');
let telemetrySeq = 0;
let telemetryInFlight = false;
let pollTimer = 0;
let actionMsgTimer = 0;
let pendingConfirm = { key: '', until: 0 };

function ensureShellMounted() {
  if (!appRoot || document.getElementById('card-tab-slot')) return;
  appRoot.innerHTML = `
    <section class="context-card">
      <div id="card-header-slot"></div>
      <div id="card-tab-slot" class="tab-slot"></div>
      <div id="action-msg-slot"></div>
      <footer class="session-bar">
        <select id="session-select" class="session-select" title="Sync with active chat tab or pin a session"></select>
        <span id="telemetry-pill" class="telemetry-pill" title="Exact API turn telemetry: input_tokens + cache_read_tokens (cache hit %)"></span>
      </footer>
    </section>`;
  const sel = document.getElementById('session-select');
  if (!sel) return;
  sel.addEventListener('mousedown', () => { state.isSelectMenuOpen = true; });
  sel.addEventListener('blur', () => { state.isSelectMenuOpen = false; });
  sel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { state.isSelectMenuOpen = false; sel.blur(); } });
  sel.addEventListener('change', (e) => {
    state.isSelectMenuOpen = false;
    state.pinnedCascadeId = e.target.value || '';
    state.openCheckpoints.clear();
    state.lastTotalTokens = null;
    state.lastOptionsSig = '';
    sel.blur();
    refreshTelemetry(true);
  });
}

function computeTabBodyHtml() {
  if (state.activeTab === 'mcp') return renderMcpBudgetsTab(state.latestData);
  return renderContextTab(state.latestData, {
    mcpExpanded: state.mcpExpanded, compactionsExpanded: state.compactionsExpanded,
    effortFitExpanded: state.effortFitExpanded, culpritsExpanded: state.culpritsExpanded, openCheckpoints: state.openCheckpoints,
  });
}

function showActionMessage(text, isError = true) {
  const slot = document.getElementById('action-msg-slot');
  if (!slot) return;
  slot.innerHTML = `<div class="${isError ? 'error-banner' : 'loading-state'} action-msg">${esc(text)}</div>`;
  clearTimeout(actionMsgTimer);
  actionMsgTimer = setTimeout(() => { slot.innerHTML = ''; }, ACTION_MSG_MS);
}

// Sandboxed iframes without allow-modals make confirm() return false instantly; fall back to click-again
function confirmAction(key, message) {
  const startedAt = performance.now();
  if (window.confirm(message)) return true;
  if (performance.now() - startedAt > 50) return false;
  if (pendingConfirm.key === key && Date.now() < pendingConfirm.until) {
    pendingConfirm = { key: '', until: 0 };
    return true;
  }
  pendingConfirm = { key, until: Date.now() + ACTION_MSG_MS };
  showActionMessage(`${message} Click again to confirm.`, false);
  return false;
}

async function runAction(failureText, path, body) {
  try {
    await apiCall(path, body);
  } catch (err) {
    showActionMessage(`${failureText}: ${err.message}`);
  }
}

async function handleMcpToggle(btn) {
  const serverName = btn.getAttribute('data-server');
  const next = btn.getAttribute('data-enabled') !== '1';
  if (!serverName) return;
  const srv = (state.latestData?.mcpCatalog?.servers || []).find((s) => s.fullServerName === serverName || s.serverName === serverName);
  if (srv) {
    srv.enabled = next;
    srv.statusBadge = next ? 'READY' : 'OFF';
    srv.isError = false;
    btn.setAttribute('data-enabled', next ? '1' : '0');
    btn.setAttribute('aria-checked', String(next));
    btn.querySelector('.switch-track')?.classList.toggle('on', next);
    const row = btn.closest('.mcp-card-row');
    row?.classList.toggle('disabled', !next);
    row?.querySelector('.mcp-server-name')?.classList.toggle('strike', !next);
    const badge = row?.querySelector('.status-badge');
    if (badge) {
      badge.className = `status-badge ${next ? 'ready' : 'off'}`;
      badge.innerHTML = `<span class="badge-dot"></span>${next ? 'Ready' : 'Off'}`;
    }
    state.lastTabHtml = computeTabBodyHtml();
  }
  await runAction(`Could not ${next ? 'enable' : 'disable'} ${serverName}`, '/api/mcp/toggle', { serverName, enabled: next });
  await refreshTelemetry(false);
}

async function handleAppClick(e) {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const tabBtn = target.closest('.tab-btn');
  if (tabBtn) {
    state.activeTab = tabBtn.getAttribute('data-tab') || 'context';
    state.lastTabHtml = '';
    if (state.activeTab === 'diagnostics') refreshDiagnostics();
    render();
    return;
  }
  for (const [selector, stateKey] of Object.entries(DRAWER_TOGGLES)) {
    if (target.closest(selector)) { state[stateKey] = !state[stateKey]; render(); return; }
  }
  if (target.closest('#refresh-btn')) {
    refreshTelemetry(true);
    if (state.activeTab === 'diagnostics') refreshDiagnostics();
    return;
  }
  const overageBtn = target.closest('#ai-overage-toggle');
  if (overageBtn && state.latestData?.planUsage?.aiCredits) {
    const next = !state.latestData.planUsage.aiCredits.useAiCredits;
    state.latestData.planUsage.aiCredits.useAiCredits = next;
    overageBtn.setAttribute('aria-checked', String(next));
    overageBtn.querySelector('.switch-track')?.classList.toggle('on', next);
    state.lastTabHtml = computeTabBodyHtml();
    try {
      await apiCall('/api/ai-credits/toggle', { enabled: next });
      await refreshTelemetry(false);
    } catch {
      state.latestData.planUsage.aiCredits.useAiCredits = !next;
      render();
    }
    return;
  }
  if (target.closest('#mcp-refresh-all-btn')) {
    await runAction('Could not refresh MCP servers', '/api/mcp/refresh', {});
    await refreshTelemetry(true);
    return;
  }
  const mcpRefreshBtn = target.closest('.mcp-refresh-btn');
  if (mcpRefreshBtn) {
    const serverName = mcpRefreshBtn.getAttribute('data-server');
    if (serverName) { await runAction(`Could not refresh ${serverName}`, '/api/mcp/refresh', { serverName }); await refreshTelemetry(true); }
    return;
  }
  const mcpToggleBtn = target.closest('.mcp-toggle-btn');
  if (mcpToggleBtn) { await handleMcpToggle(mcpToggleBtn); return; }
  if (target.closest('#diag-log-toggle')) {
    state.logTailingEnabled = !state.logTailingEnabled;
    if (state.logTailingEnabled) state.logAutoScroll = true;
    else { state.logBuffer = []; state.renderedLogCount = 0; }
    refreshDiagnostics();
    syncDiagnosticsDom(state);
    return;
  }
  if (target.closest('#diag-autoscroll-toggle')) {
    state.logAutoScroll = !state.logAutoScroll;
    if (state.logAutoScroll && state.logBuffer.length > 80) { state.logBuffer = state.logBuffer.slice(-80); state.renderedLogCount = 0; }
    syncDiagnosticsDom(state);
    return;
  }
  if (target.closest('#diag-clear-logs-btn')) {
    state.logBuffer = [];
    state.renderedLogCount = 0;
    syncDiagnosticsDom(state);
    return;
  }
  const termKillBtn = target.closest('.term-kill-btn');
  if (termKillBtn) {
    const terminalId = termKillBtn.getAttribute('data-terminal-id');
    const term = (state.diagData?.terminals || []).find((t) => t.terminalId === terminalId);
    if (terminalId && confirmAction(`kill:${terminalId}`, `Terminate "${term?.title || 'terminal'}" (PID ${term?.pid || '?'})?`)) {
      await runAction('Could not terminate terminal', '/api/terminals/close', { terminalId });
      await refreshDiagnostics();
    }
    return;
  }
  const sidecarRestartBtn = target.closest('.sidecar-restart-btn');
  if (sidecarRestartBtn) {
    const sidecarId = sidecarRestartBtn.getAttribute('data-sidecar-id');
    const sidecar = (state.diagData?.sidecars || []).find((s) => s.sidecarId === sidecarId);
    if (sidecarId && confirmAction(`restart:${sidecarId}`, `Restart ${sidecar?.displayName || sidecarId}?`)) {
      await runAction('Could not restart sidecar', '/api/sidecars/restart', { sidecarId });
      await refreshDiagnostics();
    }
  }
}

function render() {
  if (!state.latestData || !appRoot) return;
  ensureShellMounted();
  const headerSlot = document.getElementById('card-header-slot');
  const tabSlot = document.getElementById('card-tab-slot');
  const sessionSelect = document.getElementById('session-select');
  const telemetryPill = document.getElementById('telemetry-pill');
  if (headerSlot) {
    const isPulseActive = Boolean(state.latestData.isExecuting || Date.now() - state.lastTokenChangeAt < PULSE_HOLD_MS);
    const nextHdr = renderTopHeaderAndTabs(state.latestData, state, isPulseActive);
    if (nextHdr !== state.lastHeaderHtml) { headerSlot.innerHTML = nextHdr; state.lastHeaderHtml = nextHdr; }
  }
  if (state.activeTab === 'diagnostics') {
    syncDiagnosticsDom(state);
  } else if (tabSlot) {
    const nextBody = computeTabBodyHtml();
    if (nextBody !== state.lastTabHtml) {
      const savedScrolls = new Map();
      tabSlot.querySelectorAll('.checkpoint-details[data-cp-index]').forEach((det) => {
        const box = det.querySelector('.checkpoint-summary');
        if (box && box.scrollTop > 0) savedScrolls.set(det.getAttribute('data-cp-index'), box.scrollTop);
      });
      tabSlot.innerHTML = nextBody;
      state.lastTabHtml = nextBody;
      savedScrolls.forEach((scrollTop, idx) => {
        const box = tabSlot.querySelector(`.checkpoint-details[data-cp-index="${idx}"] .checkpoint-summary`);
        if (box) box.scrollTop = scrollTop;
      });
    }
  }
  if (telemetryPill) telemetryPill.textContent = renderTelemetryPillText(state.latestData.context, state.latestData.turnInsights);
  if (sessionSelect && !state.isSelectMenuOpen) {
    const nextHtml = renderSessionOptions(state.latestData.sessions, state.latestData.session, state.pinnedCascadeId);
    if (nextHtml !== state.lastOptionsSig) {
      sessionSelect.innerHTML = nextHtml;
      sessionSelect.value = state.pinnedCascadeId;
      state.lastOptionsSig = nextHtml;
    }
  }
}

async function refreshDiagnostics() {
  if (state.activeTab !== 'diagnostics') return;
  try {
    state.diagData = await apiCall('/api/diagnostics', { includeLogs: state.logTailingEnabled });
    if (state.logTailingEnabled && Array.isArray(state.diagData?.logs)) mergeIncomingLogs(state, state.diagData.logs);
    render();
  } catch { /* ignore transient polling error */ }
}

async function refreshTelemetry(manual = false) {
  if (!manual && telemetryInFlight) return;
  const reqId = ++telemetrySeq;
  telemetryInFlight = true;
  if (manual) { state.isRefreshing = true; render(); }
  try {
    const data = await apiCall('/api/telemetry', {
      cascadeId: state.pinnedCascadeId, hostCascadeId: state.hostCascadeId, workspaceUris: state.workspaceUris,
    });
    if (reqId !== telemetrySeq) return;
    if (data?.theme) applyTheme(data.theme);
    const activeId = data?.session?.cascadeId || '';
    const totalUsed = data?.context?.totalUsedTokens ?? 0;
    if (state.lastCascadeId && state.lastCascadeId !== activeId) state.openCheckpoints.clear();
    if (state.lastTotalTokens !== null && state.lastCascadeId === activeId && totalUsed !== state.lastTotalTokens) {
      state.lastTokenChangeAt = Date.now();
    }
    state.lastCascadeId = activeId;
    state.lastTotalTokens = totalUsed;
    state.latestData = data;
    state.isRefreshing = false;
    render();
  } catch (err) {
    if (reqId !== telemetrySeq) return;
    state.isRefreshing = false;
    if (!state.latestData && appRoot) {
      appRoot.innerHTML = `<div class="error-banner">Telemetry sync error: ${esc(err.message)}</div>`;
    }
  } finally {
    if (reqId === telemetrySeq) telemetryInFlight = false;
  }
}

appRoot?.addEventListener('click', handleAppClick);
appRoot?.addEventListener('toggle', (e) => {
  const det = e.target;
  if (det instanceof HTMLDetailsElement && det.classList.contains('checkpoint-details')) {
    const idx = det.getAttribute('data-cp-index');
    if (idx) { if (det.open) state.openCheckpoints.add(idx); else state.openCheckpoints.delete(idx); }
  }
}, true);

window.sidecar?.onWorkspaceChange?.((uris) => { state.workspaceUris = Array.isArray(uris) ? uris : []; refreshTelemetry(false); });
window.addEventListener('message', (e) => {
  if (e.data?.type === 'theme-change' && e.data?.payload) applyTheme(e.data.payload);
  if (e.data?.type === 'conversation-change' && typeof e.data?.payload?.conversationId === 'string') {
    state.hostCascadeId = e.data.payload.conversationId;
    refreshTelemetry(false);
  }
});
function pollTick() {
  refreshTelemetry(false);
  if (state.activeTab === 'diagnostics') refreshDiagnostics();
}

// Pause polling while the pane is hidden; refresh immediately once it is visible again
function syncPolling() {
  clearInterval(pollTimer);
  pollTimer = 0;
  if (document.hidden) return;
  pollTick();
  pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
}

document.addEventListener('visibilitychange', syncPolling);
  syncPolling();
})();
