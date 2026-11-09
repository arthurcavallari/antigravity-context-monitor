/** @fileoverview Renders Tab 3 (Diagnostics Log Tail, Auto-Scroll, Terminals Reaper, Sidecar Matrix). */
(function () {
  const cm = (window.ContextMonitor = window.ContextMonitor || {});
  const { esc, icon, formatBadgeLabel, html, setHtml, switchHtml, setSwitch, focusKeyOf, restoreFocus } = cm;
  const MAX_LIVE_LOG_LINES = 80;
  const MAX_PAUSED_LOG_LINES = 300;
  const SAFE_ID_RE = /^[a-zA-Z0-9._-]+$/;
  const LOOPBACK_ORIGIN_RE = /^(?:https?:\/\/)(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
  const isSafePluginId = (id) => (
    typeof id === 'string' && SAFE_ID_RE.test(id) && !id.includes('..') && id !== '.'
  );
  const getLogText = (entry) => (typeof entry === 'string' ? entry : (entry?.text ?? ''));

  function navigateToHangarPlugin(pluginId) {
    const raw = typeof pluginId === 'string' ? pluginId.trim() : '';
    const parts = raw.split('/');
    if (parts.length > 2 || raw.includes('..')) return { ok: false, pluginId: '' };
    const candidate = parts.length === 2 ? parts[0].trim() : raw;
    const subCandidate = parts.length === 2 ? parts[1].trim() : '';
    if (!isSafePluginId(candidate) || (parts.length === 2 && !isSafePluginId(subCandidate))) {
      return { ok: false, pluginId: '' };
    }
    const payload = {
      type: 'hangar-navigate',
      targetTab: 'plugins',
      pluginId: candidate,
      ...(subCandidate ? { targetId: `${candidate}/${subCandidate}` } : {}),
    };
    if (typeof window !== 'undefined' && window.parent && typeof window.parent.postMessage === 'function') {
      let targetOrigin = '*';
      try {
        const refOrigin = typeof document !== 'undefined' && document.referrer
          ? new URL(document.referrer).origin
          : '';
        if (refOrigin && LOOPBACK_ORIGIN_RE.test(refOrigin)) {
          targetOrigin = refOrigin;
        } else if (window.parent === window && window.location?.origin && LOOPBACK_ORIGIN_RE.test(window.location.origin)) {
          targetOrigin = window.location.origin;
        }
      } catch {
        /* ignore */
      }
      window.parent.postMessage(payload, targetOrigin);
    }
    return { ok: true, pluginId: candidate, payload };
  }

  function findLogOverlapOffset(existing, incoming) {
    if (!Array.isArray(existing) || !existing.length || !Array.isArray(incoming) || !incoming.length) return 0;
    const maxOverlap = Math.min(existing.length, incoming.length);
    for (let k = maxOverlap; k >= (existing.length < 3 ? 1 : 2); k--) {
      if (existing.slice(-k).every((item, j) => getLogText(incoming[j]) === getLogText(item))) return k;
    }
    const anchorLen = Math.min(3, existing.length, incoming.length);
    const anchor = existing.slice(-anchorLen).map(getLogText);
    for (let i = incoming.length - anchorLen; i >= 0; i--) {
      if (anchor.every((txt, j) => getLogText(incoming[i + j]) === txt)) return i + anchorLen;
    }
    return 0;
  }

  function mergeIncomingLogs(stateOrExisting, incoming = [], maxLines = MAX_PAUSED_LOG_LINES) {
    if (Array.isArray(stateOrExisting)) {
      const existing = stateOrExisting;
      if (!Array.isArray(incoming) || !incoming.length) return existing.slice(-maxLines);
      const isStr = existing.length > 0 ? typeof existing[0] === 'string' : typeof incoming[0] === 'string';
      const norm = (item) => (isStr ? getLogText(item) : item);
      if (!existing.length) return incoming.slice(-maxLines).map(norm);
      return existing.concat(incoming.slice(findLogOverlapOffset(existing, incoming)).map(norm)).slice(-maxLines);
    }
    const state = stateOrExisting;
    if (!state || !Array.isArray(state.logBuffer) || !Array.isArray(incoming) || !incoming.length) {
      return state?.logBuffer;
    }
    if (!state.logBuffer.length) {
      state.logBuffer = incoming.slice(-MAX_LIVE_LOG_LINES);
      return state.logBuffer;
    }
    for (let i = findLogOverlapOffset(state.logBuffer, incoming); i < incoming.length && state.logBuffer.length < maxLines; i++) {
      state.logBuffer.push(incoming[i]);
    }
    if (state.logAutoScroll && state.logBuffer.length > MAX_LIVE_LOG_LINES) {
      state.logBuffer = state.logBuffer.slice(-MAX_LIVE_LOG_LINES);
      state.renderedLogCount = 0;
    }
    return state.logBuffer;
  }

  function renderDiagnosticsControls(logsCount, uiState = {}) {
    const tailOn = Boolean(uiState.logTailingEnabled);
    const autoScroll = Boolean(uiState.logAutoScroll);
    const hideStyle = tailOn ? '' : (cm.rawHtml ? cm.rawHtml(' style="display:none"') : ' style="display:none"');
    return html`
      <span class="plan-title">
        Task Logs <span id="diag-log-count-pill" class="agy-count-pill">${tailOn ? logsCount : 'Paused'}</span>
      </span>
      <div class="mcp-card-actions" style="flex-wrap:wrap">
        <button id="diag-clear-logs-btn" type="button" class="agy-btn agy-btn-secondary"${hideStyle}>Clear</button>
        <span id="diag-autoscroll-row" class="cm-switch-row"${hideStyle}>
          <label id="diag-autoscroll-label" for="diag-autoscroll-toggle">Auto-scroll</label>
          ${switchHtml({
            on: autoScroll,
            size: 'sm',
            attrs: 'id="diag-autoscroll-toggle" aria-labelledby="diag-autoscroll-label" title="Toggle automatic scrolling to newest log lines"',
          })}
        </span>
        <span class="cm-switch-row">
          <label id="diag-log-label" for="diag-log-toggle">Tail</label>
          ${switchHtml({
            on: tailOn,
            size: 'sm',
            attrs: 'id="diag-log-toggle" aria-labelledby="diag-log-label" title="Toggle live Language Server log tailing"',
          })}
        </span>
      </div>
    `;
  }

  function renderDiagnosticsLists(diagData) {
    const closeSvg = icon('close', 14);
    const refreshSvg = icon('refresh', 14);
    const terminals = Array.isArray(diagData?.terminals) ? diagData.terminals : [];
    const sidecars = Array.isArray(diagData?.sidecars) ? diagData.sidecars : [];
    const terminalsHtml = terminals.length
      ? html`
        <div class="mcp-list-card">
          ${terminals.map((t) => html`
            <div class="mcp-card-row">
              <div class="mcp-card-info">
                <div class="mcp-card-title">
                  <span>${esc(t.title)}</span>
                  <span class="agy-badge off"><span class="agy-badge-dot"></span>PID ${esc(t.pid)}</span>
                </div>
                <div class="mcp-card-meta" title="${esc(t.workspaceUri)}">${esc(t.workspaceUri || 'No workspace')}</div>
              </div>
              <div class="mcp-card-actions">
                <button class="agy-icon-btn term-kill-btn" data-terminal-id="${esc(t.terminalId)}" title="Terminate process ${esc(t.pid)}">
                  ${closeSvg}
                </button>
              </div>
            </div>
          `)}
        </div>
      `
      : html`<div class="empty-hint">No active background terminals</div>`;
    const sidecarsHtml = sidecars.length
      ? html`
        <div class="mcp-list-card">
          ${sidecars.map((s) => {
            const badgeCls = s.isRunning ? 'agy-badge ready' : (s.isErrored ? 'agy-badge error' : 'agy-badge off');
            const isUnhealthy = Boolean(
              s.isErrored || s.lastError || s.statusBadge === 'ERRORED' || s.statusBadge === 'ERROR' || s.healthy === false,
            );
            const fixSummary = `Sidecar "${s.displayName || s.sidecarId}" is unhealthy (${s.statusBadge || 'ERRORED'})${s.lastError ? `: ${s.lastError}` : ''}. Please inspect and fix it.`;
            const navTarget = s.pluginId || s.pluginName || s.sidecarId || '';
            const hangarBtnHtml = isUnhealthy && navTarget
              ? html`
                <button type="button" class="agy-btn agy-btn-secondary" data-action="hangar-navigate" data-plugin-id="${esc(navTarget)}" title="Inspect ${esc(s.displayName || navTarget)} in Hangar">
                  Inspect in Hangar
                </button>
              `
              : '';
            const fixBtnHtml = isUnhealthy
              ? html`
                <button type="button" class="agy-btn agy-btn-secondary fix-with-agent-btn" data-action="fix-with-agent" data-sidecar-id="${esc(s.sidecarId)}" data-summary="${esc(fixSummary)}" title="Send diagnostic to Agent">
                  Fix with Agent
                </button>
              `
              : '';
            return html`
              <div class="mcp-card-row">
                <div class="mcp-card-info">
                  <div class="mcp-card-title">
                    <span>${esc(s.displayName)}</span>
                    <span class="${badgeCls}"><span class="agy-badge-dot"></span>${esc(formatBadgeLabel(s.statusBadge))}</span>
                  </div>
                  <div class="mcp-card-meta">
                    ${s.webPort ? html`Port ${esc(s.webPort)}` : 'No port'}${s.lastError ? html` · ${esc(s.lastError)}` : ''}
                  </div>
                </div>
                <div class="mcp-card-actions">
                  ${hangarBtnHtml}
                  ${fixBtnHtml}
                  <button class="agy-icon-btn sidecar-restart-btn" data-sidecar-id="${esc(s.sidecarId)}" title="Restart ${esc(s.displayName)}">
                    ${refreshSvg}
                  </button>
                </div>
              </div>
            `;
          })}
        </div>
      `
      : html`<div class="empty-hint">No sidecars registered</div>`;
    return html`
      <div class="plan-header" style="margin:12px 0 8px">
        <span class="plan-title">Active Background Terminals <span class="agy-count-pill">${terminals.length}</span></span>
      </div>
      <div>${terminalsHtml}</div>
      <div class="plan-header" style="margin:12px 0 8px">
        <span class="plan-title">Sidecar Processes <span class="agy-count-pill">${sidecars.length}</span></span>
      </div>
      <div>${sidecarsHtml}</div>
    `;
  }

  async function handleFixWithAgent(targetOrSummary) {
    const summary = typeof targetOrSummary === 'string'
      ? targetOrSummary
      : (targetOrSummary?.getAttribute?.('data-summary') || targetOrSummary?.dataset?.summary || 'Context Monitor diagnostic warning reported.');
    try {
      if (typeof cm.notifyAgent === 'function') {
        const res = await cm.notifyAgent({
          message: summary,
          severity: 'warning',
          triggerTurn: true,
          title: 'Context Monitor Diagnostics',
        });
        if (res?.ok === false) throw new Error(res.error || 'Notification rejected');
      }
      cm.showToast?.('Sent diagnostic to Agent', 'info');
      return { ok: true, message: summary };
    } catch (err) {
      cm.showToast?.(`Failed to notify Agent: ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
  }

  function renderDiagnosticsTab(diagData, uiState = {}) {
    const logs = Array.isArray(uiState.displayLogs) ? uiState.displayLogs : [];
    return html`
      <div class="sub-card">
        <div id="diag-log-header" class="plan-header" style="margin-bottom:6px;flex-wrap:wrap;gap:6px">
          ${renderDiagnosticsControls(logs.length, uiState)}
        </div>
        <div id="diag-log-body"></div>
      </div>
      <div id="diag-lists-slot">${renderDiagnosticsLists(diagData)}</div>
    `;
  }

  function syncDiagnosticsDom(state) {
    const tabSlot = document.getElementById('card-tab-slot');
    if (!tabSlot) return;
    if (!document.getElementById('diag-log-body')) {
      setHtml(
        tabSlot,
        renderDiagnosticsTab(state.diagData, {
          logTailingEnabled: state.logTailingEnabled,
          logAutoScroll: state.logAutoScroll,
          displayLogs: state.logBuffer,
        }),
      );
      state.lastDiagHeaderHtml = 'mounted';
      state.lastDiagListsHtml = '';
      state.renderedLogCount = 0;
    }
    const tailOn = Boolean(state.logTailingEnabled);
    const autoScroll = Boolean(state.logAutoScroll);
    const pillEl = document.getElementById('diag-log-count-pill');
    if (pillEl) pillEl.textContent = tailOn ? String(state.logBuffer.length) : 'Paused';
    const clearBtn = document.getElementById('diag-clear-logs-btn');
    if (clearBtn) clearBtn.style.display = tailOn ? '' : 'none';
    const autoScrollRow = document.getElementById('diag-autoscroll-row');
    if (autoScrollRow) autoScrollRow.style.display = tailOn ? '' : 'none';
    setSwitch(document.getElementById('diag-autoscroll-toggle'), autoScroll);
    setSwitch(document.getElementById('diag-log-toggle'), tailOn);
    const bodyEl = document.getElementById('diag-log-body');
    if (bodyEl) {
      if (!tailOn) {
        setHtml(
          bodyEl,
          html`
            <div class="empty-hint">
              Log tailing is OFF by default to conserve memory. Toggle ON above to inspect live HTTP 429 retries and Language Server traces.
            </div>
          `,
        );
        state.renderedLogCount = 0;
      } else if (!state.logBuffer.length) {
        setHtml(bodyEl, html`<div class="empty-hint">Waiting for diagnostic log lines…</div>`);
        state.renderedLogCount = 0;
      } else {
        let logEl = document.getElementById('diag-log-console');
        if (!logEl) {
          setHtml(bodyEl, html`<div id="diag-log-console" class="log-console"></div>`);
          logEl = document.getElementById('diag-log-console');
          state.renderedLogCount = 0;
          logEl?.addEventListener('scroll', () => {
            if (!logEl || state.isProgrammaticScroll) return;
            const nextAuto = logEl.scrollHeight - logEl.clientHeight - logEl.scrollTop <= 16;
            if (nextAuto !== state.logAutoScroll) {
              state.logAutoScroll = nextAuto;
              syncDiagnosticsDom(state);
            }
          });
        }
        if (logEl) {
          if (state.renderedLogCount !== state.logBuffer.length) {
            setHtml(
              logEl,
              state.logBuffer.map((l) => html`<div class="log-line ${esc(l.level || 'info')}">${esc(l.text)}</div>`).join(''),
            );
            state.renderedLogCount = state.logBuffer.length;
          }
          if (state.logAutoScroll) {
            state.isProgrammaticScroll = true;
            logEl.scrollTop = logEl.scrollHeight;
            requestAnimationFrame(() => {
              state.isProgrammaticScroll = false;
            });
          }
        }
      }
    }
    const listsEl = document.getElementById('diag-lists-slot');
    if (listsEl) {
      const nextLists = renderDiagnosticsLists(state.diagData);
      if (nextLists !== state.lastDiagListsHtml) {
        const focusKey = listsEl.contains?.(document.activeElement) ? focusKeyOf(document.activeElement) : '';
        setHtml(listsEl, nextLists);
        state.lastDiagListsHtml = nextLists;
        restoreFocus(listsEl, focusKey);
      }
    }
  }

  async function handleDiagnosticsAction(target, _e, state, confirmAction, runAction, refreshDiagnostics) {
    const navBtn = target.closest('[data-action="hangar-navigate"]');
    if (navBtn) {
      navigateToHangarPlugin(navBtn.getAttribute?.('data-plugin-id') || navBtn.dataset?.pluginId || '');
      return true;
    }
    if (target.closest('#diag-log-toggle')) {
      state.logTailingEnabled = !state.logTailingEnabled;
      if (state.logTailingEnabled) {
        state.logAutoScroll = true;
      } else {
        state.logBuffer = [];
        state.renderedLogCount = 0;
      }
      refreshDiagnostics();
      syncDiagnosticsDom(state);
      return true;
    }
    if (target.closest('#diag-autoscroll-toggle')) {
      state.logAutoScroll = !state.logAutoScroll;
      if (state.logAutoScroll && state.logBuffer.length > MAX_LIVE_LOG_LINES) {
        state.logBuffer = state.logBuffer.slice(-MAX_LIVE_LOG_LINES);
        state.renderedLogCount = 0;
      }
      syncDiagnosticsDom(state);
      return true;
    }
    if (target.closest('#diag-clear-logs-btn')) {
      state.logBuffer = [];
      state.renderedLogCount = 0;
      syncDiagnosticsDom(state);
      return true;
    }
    const termKillBtn = target.closest('.term-kill-btn');
    if (termKillBtn) {
      const terminalId = termKillBtn.getAttribute('data-terminal-id');
      const term = (state.diagData?.terminals || []).find((t) => t.terminalId === terminalId);
      if (terminalId && confirmAction(`kill:${terminalId}`, `Terminate "${term?.title || 'terminal'}" (PID ${term?.pid || '?'})?`)) {
        await runAction('Could not terminate terminal', '/api/terminals/close', { terminalId });
        await refreshDiagnostics();
      }
      return true;
    }
    const fixBtn = target.closest('[data-action="fix-with-agent"]');
    if (fixBtn) {
      await handleFixWithAgent(fixBtn);
      return true;
    }
    const sidecarRestartBtn = target.closest('.sidecar-restart-btn');
    if (sidecarRestartBtn) {
      const sidecarId = sidecarRestartBtn.getAttribute('data-sidecar-id');
      const sidecar = (state.diagData?.sidecars || []).find((s) => s.sidecarId === sidecarId);
      if (sidecarId && confirmAction(`restart:${sidecarId}`, `Restart ${sidecar?.displayName || sidecarId}?`)) {
        await runAction('Could not restart sidecar', '/api/sidecars/restart', { sidecarId });
        await refreshDiagnostics();
      }
      return true;
    }
    return false;
  }

  Object.assign(cm, {
    mergeIncomingLogs,
    renderDiagnosticsControls,
    renderDiagnosticsLists,
    renderDiagnosticsTab,
    syncDiagnosticsDom,
    handleFixWithAgent,
    navigateToHangarPlugin,
    handleDiagnosticsAction,
  });
})();
