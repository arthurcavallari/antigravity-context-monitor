/** @fileoverview Subagent hierarchy banner, tree connector rows, and drill-down drawer. */
(function () {
  const cm = (window.ContextMonitor = window.ContextMonitor || {});
  const { esc, icon, html } = cm;
  const DRAWER_TOGGLES = {
    '#model-badge-btn': 'modelProfileOpen', '#context-help-btn': 'contextHelpOpen',
    '#subagents-collapse-toggle': 'subagentsExpanded', '#mcp-collapse-toggle': 'mcpExpanded',
    '#compactions-collapse-toggle': 'compactionsExpanded', '#effort-fit-collapse-toggle': 'effortFitExpanded',
    '#culprits-collapse-toggle': 'culpritsExpanded',
  };

  function renderSubagentStatusBadge(sa = {}) {
    const rawStatus = sa.statusBadge || (sa.isRunning || sa.status === 'CASCADE_RUN_STATUS_RUNNING' ? 'Running' : sa.isError ? 'Error' : 'Done');
    const cls = rawStatus === 'Running' ? 'active' : rawStatus === 'Error' ? 'error' : rawStatus === 'Stopped' ? 'off' : 'ready';
    return html`<span class="agy-badge ${cls}"><span class="agy-badge-dot"></span>${esc(rawStatus)}</span>`;
  }

  function renderSubagentBanner(session = {}) {
    if (!session?.isSubagent) return '';
    const parentId = session.parentConversationId || session.rootConversationId || '';
    const parentTitle = session.parentTitle || 'Parent';
    const rootId = session.rootConversationId || parentId;
    const rootTitle = session.rootTitle || 'Root';
    const depth = Math.max(1, Number(session.nestingDepth) || 1);
    const labelText = session.title || session.role || session.typeName || 'Subagent';
    const rootBtnHtml = depth > 1 && rootId
      ? html`<button type="button" class="agy-btn subagent-root-btn" data-subagent-id="${esc(rootId)}" title="Return to root conversation: ${esc(rootTitle)}">Root</button>`
      : '';
    return html`<div class="subagent-banner">
        <div class="subagent-banner-nav">
          <button type="button" class="agy-btn subagent-back-btn" data-subagent-id="${esc(parentId)}" title="Return to parent conversation: ${esc(parentTitle)}">← Parent: ${esc(parentTitle)}</button>
          ${rootBtnHtml}
        </div>
        <span class="subagent-banner-label" title="${esc(labelText)}"><span class="fit-pill">L${esc(depth)}</span><strong>${esc(labelText)}</strong></span>
      </div>`;
  }

  function renderSubagentRow(sa = {}, activeCascadeId = '') {
    const depth = Math.max(1, Number(sa.nestingDepth) || 1);
    const isNested = depth > 1;
    const isCurrent = Boolean(activeCascadeId && sa.cascadeId === activeCascadeId);
    const depthBadge = isNested
      ? html`<span class="fit-pill subagent-depth-badge" title="Nested worker subagent (depth ${esc(depth)})">↳ L${esc(depth)}</span>`
      : '';
    const roleText = String(sa.role || '').trim();
    const typeText = String(sa.typeName || '').trim();
    const titleText = sa.title || (roleText && typeText && roleText.toLowerCase() !== typeText.toLowerCase() ? `${roleText} (${typeText})` : roleText || typeText || sa.cascadeId);
    const promptText = sa.promptPreview || sa.initialPrompt || '';
    const cardCls = ['fit-card', 'subagent-card', isNested ? 'nested' : '', isCurrent ? 'active-subagent' : ''].filter(Boolean).join(' ');
    return html`<div class="${cardCls}" data-subagent-id="${esc(sa.cascadeId)}" title="Click to inspect subagent (${esc(sa.cascadeId)})">
        <div class="fit-header">
          <div class="fit-flow" style="min-width:0;flex:1;flex-wrap:nowrap">${depthBadge}<span class="fit-prompt" title="${esc(titleText)}">${esc(titleText)}</span></div>
          ${renderSubagentStatusBadge(sa)}
        </div>
        <div class="fit-flow">
          <span class="fit-pill">${esc(sa.modelBadge || 'Gemini')}</span>
          <span>${esc(sa.stepCount ?? 0)} step${Number(sa.stepCount) === 1 ? '' : 's'}</span>
          ${sa.durationFormatted && sa.durationFormatted !== '—' ? html`<span>· ${esc(sa.durationFormatted)}</span>` : ''}
          ${sa.formattedParentContextTokens ? html`<span>· ${esc(sa.formattedParentContextTokens)} in parent</span>` : ''}
          ${sa.spawnStepRef ? html`<span class="thinking-sub">(${esc(sa.spawnStepRef)})</span>` : ''}
          <button type="button" class="agy-btn subagent-inspect-btn" data-subagent-id="${esc(sa.cascadeId)}">${isCurrent ? 'Viewing' : 'Inspect'}</button>
        </div>
        ${promptText ? html`<div class="fit-reason">"${esc(promptText)}"</div>` : ''}
      </div>`;
  }

  function renderSubagentsDrawer(subagents = {}, subagentsExpanded = false, activeCascadeId = '') {
    const items = Array.isArray(subagents?.items) ? subagents.items : [];
    const totalCount = Number(subagents?.totalCount ?? items.length) || 0;
    if (totalCount === 0 || items.length === 0) return '';
    const chevronSvg = icon('chevron_right', 14);
    const runningCount = Number(subagents?.runningCount ?? items.filter((x) => x?.isRunning || x?.status === 'CASCADE_RUN_STATUS_RUNNING').length);
    const totalSteps = Number(subagents?.totalSteps ?? items.reduce((sum, x) => sum + (Number(x?.stepCount) || 0), 0));
    const parentTokensText = subagents?.formattedParentContextTokens || '';
    const rightParts = [];
    if (runningCount > 0) rightParts.push(`${esc(runningCount)} running`);
    rightParts.push(`${esc(totalSteps)} step${totalSteps === 1 ? '' : 's'}`);
    if (parentTokensText) rightParts.push(`${esc(parentTokensText)} in context`);
    const runningDotHtml = runningCount > 0
      ? html`<span class="dot sm" style="background:var(--cm-green-dot);opacity:1" title="${esc(runningCount)} subagent(s) running"></span>`
      : '';
    const cardsHtml = subagentsExpanded
      ? html`<div class="culprits-drawer">${items.map((sa) => renderSubagentRow(sa, activeCascadeId))}</div>`
      : '';
    return html`<div id="subagents-collapse-toggle" class="breakdown-row collapsible-toggle" style="margin-top:4px" title="Inspect spawned L1/L2 subagents and click to view their context window">
        <div class="row-label muted"><span class="chevron ${subagentsExpanded ? 'open' : ''}">${chevronSvg}</span><span>Subagents (${esc(totalCount)})</span>${runningDotHtml}</div>
        <div class="row-tokens">${rightParts.join(' · ')}</div>
      </div>${cardsHtml}`;
  }

  function handleContextClick(target, state, resetPinTracking, refreshTelemetry, refreshDiagnostics, render) {
    const tabBtn = target.closest('.agy-toggle-item');
    if (tabBtn) {
      state.activeTab = tabBtn.getAttribute('data-tab') || 'context';
      state.lastTabHtml = '';
      if (state.activeTab === 'diagnostics') refreshDiagnostics();
      render();
      return true;
    }
    for (const [selector, stateKey] of Object.entries(DRAWER_TOGGLES)) {
      if (target.closest(selector)) {
        state[stateKey] = !state[stateKey];
        render();
        return true;
      }
    }
    const subagentTarget = target.closest('[data-subagent-id]');
    if (subagentTarget) {
      const targetId = subagentTarget.getAttribute('data-subagent-id') || '';
      if (targetId && targetId !== state.latestData?.session?.cascadeId) {
        const autoRootId = state.autoRootCascadeId || state.hostCascadeId || state.latestData?.sessions?.[0]?.cascadeId || '';
        resetPinTracking(autoRootId && targetId === autoRootId ? '' : targetId);
        refreshTelemetry(true);
      }
      return true;
    }
    if (target.closest('#refresh-btn')) {
      refreshTelemetry(true);
      if (state.activeTab === 'diagnostics') refreshDiagnostics();
      return true;
    }
    return false;
  }

  async function handleDiagnosticsAction(target, e, state, confirmAction, runAction, refreshDiagnostics) {
    const { syncDiagnosticsDom, handleFixWithAgent } = cm;
    if (target.closest('#diag-log-toggle')) {
      state.logTailingEnabled = !state.logTailingEnabled;
      if (state.logTailingEnabled) state.logAutoScroll = true;
      else {
        state.logBuffer = [];
        state.renderedLogCount = 0;
      }
      refreshDiagnostics();
      syncDiagnosticsDom(state);
      return true;
    }
    if (target.closest('#diag-autoscroll-toggle')) {
      state.logAutoScroll = !state.logAutoScroll;
      if (state.logAutoScroll && state.logBuffer.length > 80) {
        state.logBuffer = state.logBuffer.slice(-80);
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
      if (!e._cmFixHandled) {
        e._cmFixHandled = true;
        await handleFixWithAgent?.(fixBtn);
      }
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

  Object.assign(cm, { renderSubagentStatusBadge, renderSubagentBanner, renderSubagentsBanner: renderSubagentBanner, renderSubagentRow, renderSubagentsDrawer, handleContextClick, handleDiagnosticsAction });
})();
