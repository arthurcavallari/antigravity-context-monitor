/** @fileoverview Main frontend controller for the Context Monitor sidecar. */
(function () {
  const {
    apiCall,
    applyTheme,
    esc,
    html,
    setHtml,
    ensureShellMounted,
    renderTopHeaderAndTabs,
    renderSessionOptions,
    renderTelemetryPillText,
    renderContextTab,
    renderMcpBudgetsTab,
    handleContextClick,
    handleMcpAction,
    handleDiagnosticsAction,
    mergeIncomingLogs,
    syncDiagnosticsDom,
    nextPollDelayMs,
    createVisibilityPoller,
    focusKeyOf,
    restoreFocus,
  } = window.ContextMonitor;

  const PULSE_HOLD_MS = 2500;
  const ACTION_MSG_MS = 4000;
  const isFramed = window.parent !== window;
  const appRoot = document.getElementById('app');
  const state = {
    activeTab: 'context',
    pinnedCascadeId: '',
    autoRootCascadeId: '',
    hostCascadeId: window.sidecar?.conversationId || new URLSearchParams(window.location.search).get('conversationId') || (isFramed ? '_new' : ''),
    workspaceUris: [],
    subagentsExpanded: false,
    subagentsShowAll: false,
    mcpExpanded: false,
    compactionsExpanded: false,
    effortFitExpanded: false,
    culpritsExpanded: false,
    contextHelpOpen: false,
    modelProfileOpen: false,
    openCheckpoints: new Set(),
    logTailingEnabled: false,
    logAutoScroll: true,
    isProgrammaticScroll: false,
    logBuffer: [],
    renderedLogCount: 0,
    isRefreshing: false,
    lastTotalTokens: null,
    lastCascadeId: '',
    lastRootCascadeId: '',
    lastTokenChangeAt: 0,
    lastHeaderHtml: '',
    lastTabHtml: '',
    lastDiagHeaderHtml: '',
    lastDiagListsHtml: '',
    lastOptionsSig: '',
    isSelectMenuOpen: false,
    latestData: null,
    diagData: null,
  };
  let telemetrySeq = 0;
  let telemetryInFlight = false;
  let diagInFlight = null;
  let pendingConfirm = { key: '', until: 0 };
  let lastSeenMutationAt = 0;
  const isPinnedToSubagent = () => Boolean(
    state.pinnedCascadeId && (
      state.latestData?.session?.isSubagent ||
      state.latestData?.subagents?.items?.some((s) => s?.cascadeId === state.pinnedCascadeId)
    ),
  );
  const syncActiveConvId = (activeId = state.lastCascadeId) => {
    window.ContextMonitor.activeConversationId = state.pinnedCascadeId ||
      activeId ||
      (state.hostCascadeId && state.hostCascadeId !== '_new' ? state.hostCascadeId : '');
  };
  syncActiveConvId('');

  function resetPinTracking(nextPin) {
    state.pinnedCascadeId = nextPin;
    syncActiveConvId();
    state.openCheckpoints.clear();
    state.lastTotalTokens = null;
    state.lastOptionsSig = '';
  }

  const computeTabBodyHtml = () => (
    state.activeTab === 'mcp' ? renderMcpBudgetsTab(state.latestData) : renderContextTab(state.latestData, state)
  );
  const showActionMessage = (text, isError = true) => window.ContextMonitor.showToast?.(text, isError, ACTION_MSG_MS);

  function confirmAction(key, message) {
    if (pendingConfirm.key === key && Date.now() < pendingConfirm.until) {
      pendingConfirm = { key: '', until: 0 };
      showActionMessage('', false);
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

  async function handleAppClick(e) {
    const target = e?.target?.nodeType === 3 ? e.target.parentElement : e?.target;
    if (!target || typeof target.closest !== 'function') return;
    if (handleContextClick?.(target, state, resetPinTracking, refreshTelemetry, refreshDiagnostics, render)) return;
    if (await handleMcpAction?.(target, state, computeTabBodyHtml, runAction, refreshTelemetry, apiCall, render)) return;
    await handleDiagnosticsAction?.(target, e, state, confirmAction, runAction, refreshDiagnostics);
  }

  function render() {
    if (!state.latestData || !appRoot) return;
    ensureShellMounted(appRoot, state, resetPinTracking, refreshTelemetry);
    const headerSlot = document.getElementById('card-header-slot');
    const tabSlot = document.getElementById('card-tab-slot');
    const sessionSelect = document.getElementById('session-select');
    const telemetryPill = document.getElementById('telemetry-pill');
    if (headerSlot) {
      const isPulseActive = Boolean(state.latestData.isExecuting || Date.now() - state.lastTokenChangeAt < PULSE_HOLD_MS);
      const nextHdr = renderTopHeaderAndTabs(state.latestData, state, isPulseActive);
      if (nextHdr !== state.lastHeaderHtml) {
        const activeHdrId = headerSlot.contains?.(document.activeElement) ? document.activeElement?.id : '';
        const restoreTabFocus = Boolean(
          document.activeElement && headerSlot.querySelector?.('#tab-nav')?.contains?.(document.activeElement),
        );
        setHtml(headerSlot, nextHdr);
        state.lastHeaderHtml = nextHdr;
        if (restoreTabFocus) {
          headerSlot.querySelector?.('#tab-nav .agy-toggle-item.active')?.focus?.();
        } else if (activeHdrId) {
          document.getElementById(activeHdrId)?.focus?.();
        }
      }
    }
    tabSlot?.setAttribute?.('aria-labelledby', `tab-${state.activeTab}`);
    if (state.activeTab === 'diagnostics') {
      syncDiagnosticsDom(state);
    } else if (tabSlot) {
      const nextBody = computeTabBodyHtml();
      if (nextBody !== state.lastTabHtml) {
        const focusKey = tabSlot.contains?.(document.activeElement) ? focusKeyOf(document.activeElement) : '';
        const savedScrolls = new Map();
        tabSlot.querySelectorAll('.checkpoint-details[data-cp-index]').forEach((det) => {
          const box = det.querySelector('.checkpoint-summary');
          if (box && box.scrollTop > 0) savedScrolls.set(det.getAttribute('data-cp-index'), box.scrollTop);
        });
        setHtml(tabSlot, nextBody);
        state.lastTabHtml = nextBody;
        savedScrolls.forEach((scrollTop, idx) => {
          const box = tabSlot.querySelector(`.checkpoint-details[data-cp-index="${idx}"] .checkpoint-summary`);
          if (box) box.scrollTop = scrollTop;
        });
        restoreFocus(tabSlot, focusKey);
      }
    }
    if (telemetryPill) {
      telemetryPill.textContent = renderTelemetryPillText(state.latestData.context, state.latestData.turnInsights);
    }
    if (sessionSelect && !state.isSelectMenuOpen) {
      const nextHtml = renderSessionOptions(state.latestData.sessions, state.latestData.session, state.pinnedCascadeId);
      if (nextHtml !== state.lastOptionsSig) {
        setHtml(sessionSelect, nextHtml);
        sessionSelect.value = state.pinnedCascadeId;
        state.lastOptionsSig = nextHtml;
      }
    }
  }

  async function refreshDiagnostics() {
    if (state.activeTab !== 'diagnostics') return;
    if (diagInFlight) return diagInFlight;
    diagInFlight = (async () => {
      try {
        state.diagData = await apiCall('/api/diagnostics', {
          includeLogs: state.logTailingEnabled,
        });
        if (state.logTailingEnabled && Array.isArray(state.diagData?.logs)) {
          mergeIncomingLogs(state, state.diagData.logs);
        }
        render();
      } catch {
        /* ignore */
      } finally {
        diagInFlight = null;
      }
    })();
    return diagInFlight;
  }

  async function refreshTelemetry(manual = false, force = false) {
    if (!manual && !force && telemetryInFlight) return;
    const reqId = ++telemetrySeq;
    telemetryInFlight = true;
    if (manual) {
      state.isRefreshing = true;
      render();
    }
    try {
      const data = await apiCall('/api/telemetry', {
        cascadeId: state.pinnedCascadeId,
        hostCascadeId: state.hostCascadeId,
        workspaceUris: state.workspaceUris,
      });
      if (reqId !== telemetrySeq) return;
      if (data?.theme) applyTheme(data.theme);
      const activeId = data?.session?.cascadeId || '';
      const rootId = data?.subagents?.rootCascadeId || data?.session?.rootConversationId || activeId;
      const totalUsed = data?.context?.totalUsedTokens ?? 0;
      if (state.lastCascadeId && state.lastCascadeId !== activeId) state.openCheckpoints.clear();
      if (state.lastRootCascadeId && rootId && state.lastRootCascadeId !== rootId) {
        state.subagentsShowAll = false;
      }
      if (state.lastTotalTokens !== null && state.lastCascadeId === activeId && totalUsed !== state.lastTotalTokens) {
        state.lastTokenChangeAt = Date.now();
      }
      if (!state.pinnedCascadeId && !data?.session?.isSubagent && activeId) {
        state.autoRootCascadeId = activeId;
      }
      state.lastCascadeId = activeId;
      if (rootId) state.lastRootCascadeId = rootId;
      syncActiveConvId(activeId);
      state.lastTotalTokens = totalUsed;
      state.latestData = data;
      state.isRefreshing = false;
      render();
    } catch (err) {
      if (reqId !== telemetrySeq) return;
      state.isRefreshing = false;
      if (!state.latestData && appRoot) {
        setHtml(appRoot, html`<div class="error-banner" role="alert">Telemetry sync error: ${esc(err.message)}</div>`);
      }
    } finally {
      if (reqId === telemetrySeq) telemetryInFlight = false;
    }
  }

  appRoot?.addEventListener('click', handleAppClick);
  appRoot?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target?.nodeType === 3 ? e.target.parentElement : e.target;
    const roleBtn = target?.closest?.('[role="button"], .collapsible-toggle');
    if (!roleBtn || roleBtn.tagName === 'BUTTON') return;
    e.preventDefault();
    handleAppClick(e);
  });
  // Escape closes the header drawers. Focus stays where it is; the header re-render restores it by id.
  document.addEventListener?.('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !(state.modelProfileOpen || state.contextHelpOpen)) return;
    if (e.target?.closest?.('select')) return;
    state.modelProfileOpen = false;
    state.contextHelpOpen = false;
    render();
  });
  appRoot?.addEventListener('toggle', (e) => {
    const det = e.target;
    if (!(det instanceof HTMLDetailsElement) || !det.classList.contains('checkpoint-details')) return;
    const idx = det.getAttribute('data-cp-index');
    if (idx) state.openCheckpoints[det.open ? 'add' : 'delete'](idx);
  }, true);

  window.sidecar?.onWorkspaceChange?.((uris) => {
    const next = Array.isArray(uris) ? uris : [];
    if (JSON.stringify(next) === JSON.stringify(state.workspaceUris)) return;
    state.workspaceUris = next;
    state.autoRootCascadeId = '';
    if (!state.hostCascadeId && isPinnedToSubagent()) {
      state.pinnedCascadeId = '';
      syncActiveConvId();
    }
    refreshTelemetry(false, true);
  });

  const poller = createVisibilityPoller({
    autoStart: true,
    getIntervalMs: () => nextPollDelayMs({
      isExecuting: Boolean(state.latestData?.isExecuting),
      activeTab: state.activeTab,
    }),
    onPoll: () => Promise.all([refreshTelemetry(false), state.activeTab === 'diagnostics' ? refreshDiagnostics() : null]),
    onHostMessage: (e) => {
      if (e.data?.type === 'theme-change' && e.data?.payload) applyTheme(e.data.payload);
      if (e.data?.type === 'conversation-change' && typeof e.data?.payload?.conversationId === 'string') {
        if (e.data.payload.conversationId !== state.hostCascadeId) {
          state.hostCascadeId = e.data.payload.conversationId;
          state.autoRootCascadeId = '';
          if (isPinnedToSubagent()) state.pinnedCascadeId = '';
          syncActiveConvId();
          refreshTelemetry(false, true);
        }
      }
    },
  });

  window.AgyShell?.subscribeStateSyncEvents?.({
    url: '/api/events',
    immediate: true,
    onStateEvent: (st) => {
      if (st?.lastMutationAt && st.lastMutationAt > lastSeenMutationAt) {
        lastSeenMutationAt = st.lastMutationAt;
        if (!poller.isVisible()) return;
        refreshTelemetry(false, true);
        if (state.activeTab === 'diagnostics') refreshDiagnostics();
      }
    },
  });
})();
