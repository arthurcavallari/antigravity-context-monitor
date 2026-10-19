/**
 * @fileoverview Renders Tab 3 (Opt-in Memory-Safe Diagnostics Log Tail,
 * Auto-Scroll Toggle, Active Background Terminals Reaper, and Sidecar Matrix)
 * and manages incremental DOM updates for zero-jitter log scrolling.
 */

(function () {
  window.ContextMonitor = window.ContextMonitor || {};
  const { esc, icon, formatBadgeLabel } = window.ContextMonitor;

  const MAX_LIVE_LOG_LINES = 80;
  const MAX_PAUSED_LOG_LINES = 300;

  function mergeIncomingLogs(state, incoming = []) {
    if (!Array.isArray(incoming) || incoming.length === 0) return;
    if (state.logBuffer.length === 0) {
      state.logBuffer = incoming.slice(-MAX_LIVE_LOG_LINES);
      return;
    }
    const lastExisting = state.logBuffer[state.logBuffer.length - 1]?.text;
    let appendFrom = incoming.length;
    for (let i = incoming.length - 1; i >= 0; i--) {
      if (incoming[i]?.text === lastExisting) {
        appendFrom = i + 1;
        break;
      }
    }
    if (appendFrom < incoming.length) {
      for (let i = appendFrom; i < incoming.length; i++) {
        if (state.logBuffer.length < MAX_PAUSED_LOG_LINES) state.logBuffer.push(incoming[i]);
      }
    } else if (incoming[incoming.length - 1]?.text !== lastExisting) {
      for (const item of incoming) {
        if (state.logBuffer.length < MAX_PAUSED_LOG_LINES) state.logBuffer.push(item);
      }
    }
    if (state.logAutoScroll && state.logBuffer.length > MAX_LIVE_LOG_LINES) {
      state.logBuffer = state.logBuffer.slice(-MAX_LIVE_LOG_LINES);
      state.renderedLogCount = 0;
    }
  }

  function renderDiagnosticsControls(logsCount, uiState = {}) {
    const tailOn = Boolean(uiState.logTailingEnabled);
    const autoScroll = Boolean(uiState.logAutoScroll);
    const hideStyle = tailOn ? '' : ' style="display:none"';
    return `
      <span class="plan-title">Task Logs <span id="diag-log-count-pill" class="count-pill">${
        tailOn ? logsCount : 'Paused'
      }</span></span>
      <div class="mcp-card-actions" style="flex-wrap:wrap">
        <button id="diag-clear-logs-btn" class="agy-btn"${hideStyle}>Clear</button>
        <button id="diag-autoscroll-toggle" type="button" role="switch" aria-checked="${autoScroll}" class="overage-toggle" title="Toggle automatic scrolling to newest log lines"${hideStyle}>
          <span>Auto-scroll</span>
          <span class="switch-track sm ${autoScroll ? 'on' : ''}">
            <span class="switch-thumb"></span>
          </span>
        </button>
        <button id="diag-log-toggle" type="button" role="switch" aria-checked="${tailOn}" class="overage-toggle" title="Toggle live Language Server log tailing">
          <span>Tail</span>
          <span class="switch-track sm ${tailOn ? 'on' : ''}">
            <span class="switch-thumb"></span>
          </span>
        </button>
      </div>`;
  }

  function renderDiagnosticsLists(diagData) {
    const closeSvg = icon('close', 14);
    const refreshSvg = icon('refresh', 14);
    const terminals = Array.isArray(diagData?.terminals) ? diagData.terminals : [];
    const sidecars = Array.isArray(diagData?.sidecars) ? diagData.sidecars : [];

    const terminalsHtml =
      terminals.length > 0
        ? `<div class="mcp-list-card">${terminals
            .map(
              (t) => `
              <div class="mcp-card-row">
                <div class="mcp-card-info">
                  <div class="mcp-card-title">
                    <span>${esc(t.title)}</span>
                    <span class="status-badge off"><span class="badge-dot"></span>PID ${esc(t.pid)}</span>
                  </div>
                  <div class="mcp-card-meta" title="${esc(t.workspaceUri)}">
                    ${esc(t.workspaceUri || 'No workspace')}
                  </div>
                </div>
                <div class="mcp-card-actions">
                  <button
                    class="icon-btn term-kill-btn"
                    data-terminal-id="${esc(t.terminalId)}"
                    title="Terminate process ${esc(t.pid)}"
                  >${closeSvg}</button>
                </div>
              </div>`
            )
            .join('')}</div>`
        : '<div class="empty-hint">No active background terminals</div>';

    const sidecarsHtml =
      sidecars.length > 0
        ? `<div class="mcp-list-card">${sidecars
            .map((s) => {
              let badgeCls = 'status-badge off';
              if (s.isRunning) badgeCls = 'status-badge ready';
              else if (s.isErrored) badgeCls = 'status-badge error';

              return `
                <div class="mcp-card-row">
                  <div class="mcp-card-info">
                    <div class="mcp-card-title">
                      <span>${esc(s.displayName)}</span>
                      <span class="${badgeCls}"><span class="badge-dot"></span>${esc(formatBadgeLabel(s.statusBadge))}</span>
                    </div>
                    <div class="mcp-card-meta">
                      ${s.webPort ? `Port ${esc(s.webPort)}` : 'No port'}
                      ${s.lastError ? ` · ${esc(s.lastError)}` : ''}
                    </div>
                  </div>
                  <div class="mcp-card-actions">
                    <button
                      class="icon-btn sidecar-restart-btn"
                      data-sidecar-id="${esc(s.sidecarId)}"
                      title="Restart ${esc(s.displayName)}"
                    >${refreshSvg}</button>
                  </div>
                </div>`;
            })
            .join('')}</div>`
        : '<div class="empty-hint">No sidecars registered</div>';

    return `
      <div class="plan-header" style="margin:12px 0 8px">
        <span class="plan-title">Active Background Terminals <span class="count-pill">${terminals.length}</span></span>
      </div>
      <div>${terminalsHtml}</div>

      <div class="plan-header" style="margin:12px 0 8px">
        <span class="plan-title">Sidecar Processes <span class="count-pill">${sidecars.length}</span></span>
      </div>
      <div>${sidecarsHtml}</div>`;
  }

  function renderDiagnosticsTab(diagData, uiState = {}) {
    const logs = Array.isArray(uiState.displayLogs) ? uiState.displayLogs : [];
    return `
      <div class="sub-card">
        <div id="diag-log-header" class="plan-header" style="margin-bottom:6px;flex-wrap:wrap;gap:6px">
          ${renderDiagnosticsControls(logs.length, uiState)}
        </div>
        <div id="diag-log-body"></div>
      </div>
      <div id="diag-lists-slot">
        ${renderDiagnosticsLists(diagData)}
      </div>`;
  }

  function syncDiagnosticsDom(state) {
    const tabSlot = document.getElementById('card-tab-slot');
    if (!tabSlot) return;

    if (!document.getElementById('diag-log-body')) {
      tabSlot.innerHTML = renderDiagnosticsTab(state.diagData, {
        logTailingEnabled: state.logTailingEnabled,
        logAutoScroll: state.logAutoScroll,
        displayLogs: state.logBuffer,
      });
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
    const autoBtn = document.getElementById('diag-autoscroll-toggle');
    if (autoBtn) {
      autoBtn.style.display = tailOn ? '' : 'none';
      autoBtn.setAttribute('aria-checked', String(autoScroll));
      autoBtn.querySelector('.switch-track')?.classList.toggle('on', autoScroll);
    }
    const tailBtn = document.getElementById('diag-log-toggle');
    if (tailBtn) {
      tailBtn.setAttribute('aria-checked', String(tailOn));
      tailBtn.querySelector('.switch-track')?.classList.toggle('on', tailOn);
    }

    const bodyEl = document.getElementById('diag-log-body');
    if (bodyEl) {
      if (!state.logTailingEnabled) {
        bodyEl.innerHTML =
          '<div class="empty-hint">Log tailing is OFF by default to conserve memory. Toggle ON above to inspect live HTTP 429 retries and Language Server traces.</div>';
        state.renderedLogCount = 0;
      } else if (state.logBuffer.length === 0) {
        bodyEl.innerHTML = '<div class="empty-hint">Waiting for diagnostic log lines…</div>';
        state.renderedLogCount = 0;
      } else {
        let logEl = document.getElementById('diag-log-console');
        if (!logEl) {
          bodyEl.innerHTML = '<div id="diag-log-console" class="log-console"></div>';
          logEl = document.getElementById('diag-log-console');
          state.renderedLogCount = 0;
          logEl?.addEventListener('scroll', () => {
            if (!logEl || state.isProgrammaticScroll) return;
            const distFromBottom = logEl.scrollHeight - logEl.clientHeight - logEl.scrollTop;
            const nextAuto = distFromBottom <= 16;
            if (nextAuto !== state.logAutoScroll) {
              state.logAutoScroll = nextAuto;
              syncDiagnosticsDom(state);
            }
          });
        }
        if (logEl) {
          if (state.renderedLogCount === 0 || state.renderedLogCount > state.logBuffer.length) {
            logEl.innerHTML = state.logBuffer
              .map((l) => `<div class="log-line ${esc(l.level || 'info')}">${esc(l.text)}</div>`)
              .join('');
            state.renderedLogCount = state.logBuffer.length;
          } else if (state.renderedLogCount < state.logBuffer.length) {
            const frag = document.createDocumentFragment();
            for (let i = state.renderedLogCount; i < state.logBuffer.length; i++) {
              const row = document.createElement('div');
              row.className = `log-line ${state.logBuffer[i].level || 'info'}`;
              row.textContent = state.logBuffer[i].text;
              frag.appendChild(row);
            }
            logEl.appendChild(frag);
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
        listsEl.innerHTML = nextLists;
        state.lastDiagListsHtml = nextLists;
      }
    }
  }

  Object.assign(window.ContextMonitor, {
    mergeIncomingLogs,
    renderDiagnosticsControls,
    renderDiagnosticsLists,
    renderDiagnosticsTab,
    syncDiagnosticsDom,
  });
})();
