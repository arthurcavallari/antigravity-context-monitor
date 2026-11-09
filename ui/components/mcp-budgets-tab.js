/** @fileoverview Renders Tab 2 (Skills & Rules Token Budgets + Live MCP Server Controls). */
(function () {
  const cm = (window.ContextMonitor = window.ContextMonitor || {});
  const { esc, icon, formatBadgeLabel, html, setHtml, switchHtml, setSwitch } = cm;

  function renderMcpServerRow(srv, refreshSvg) {
    const badgeCls = srv.isError ? 'agy-badge error' : (srv.enabled ? 'agy-badge ready' : 'agy-badge off');
    const pluginRef = srv.pluginName || srv.pluginId || '';
    const hangarBtn = pluginRef
      ? html`
        <button type="button" class="agy-btn agy-btn-secondary" data-action="hangar-navigate" data-plugin-id="${esc(pluginRef)}" title="Inspect ${esc(pluginRef)} in Hangar">
          Inspect in Hangar
        </button>
      `
      : '';
    return html`
      <div class="mcp-card-row ${srv.enabled ? '' : 'disabled'}">
        <div class="mcp-card-info">
          <div class="mcp-card-title">
            <span class="mcp-server-name ${srv.enabled ? '' : 'strike'}" title="${esc(srv.fullServerName)}">${esc(srv.serverName)}</span>
            <span class="${badgeCls}"><span class="agy-badge-dot"></span>${esc(formatBadgeLabel(srv.statusBadge))}</span>
          </div>
          <div class="mcp-card-meta">
            ${esc(srv.toolCount)} tools (${esc(srv.eagerCount)} eager · ${esc(srv.deferredCount)} deferred) · ~${esc(srv.formattedTokens)}
          </div>
          ${srv.errorMessage ? html`<div class="mcp-error-text ${srv.enabled ? '' : 'muted'}">Error: ${esc(srv.errorMessage)}</div>` : ''}
        </div>
        <div class="mcp-card-actions">
          ${hangarBtn}
          <button class="agy-icon-btn mcp-refresh-btn" data-server="${esc(srv.fullServerName)}" title="Reload ${esc(srv.serverName)}">
            ${refreshSvg}
          </button>
          ${switchHtml({
            on: Boolean(srv.enabled),
            cls: 'mcp-toggle-btn',
            attrs: `data-server="${esc(srv.fullServerName)}" data-enabled="${srv.enabled ? '1' : '0'}" aria-label="Toggle ${esc(srv.serverName)}" title="Enable or disable ${esc(srv.serverName)}"`,
          })}
        </div>
      </div>
    `;
  }

  function renderMcpBudgetsTab(data) {
    const budgets = data?.turnInsights?.budgets || {};
    const skillsB = budgets.skills || { formattedUsed: '0', formattedLimit: '20.0k', pct: 0, formattedPct: '0.0%' };
    const rulesB = budgets.rules || { formattedUsed: '0', formattedLimit: '20.0k', pct: 0, formattedPct: '0.0%' };
    const catalog = data?.mcpCatalog || { servers: [], counts: {} };
    const counts = catalog.counts || {};
    const servers = Array.isArray(catalog.servers) ? catalog.servers : [];
    const refreshSvg = icon('refresh', 14);
    const serversHtml = servers.length
      ? html`<div class="mcp-list-card">${servers.map((srv) => renderMcpServerRow(srv, refreshSvg))}</div>`
      : html`<div class="empty-hint">No MCP servers configured</div>`;
    const skillsFillPct = Math.max(0, Math.min(100, skillsB.pct || 0));
    const rulesFillPct = Math.max(0, Math.min(100, rulesB.pct || 0));
    const skillInj = data?.skillInjectionMetrics ||
      data?.turnInsights?.topCulprits?.skillInjections ||
      data?.turnInsights?.culprits?.skillInjections ||
      null;
    const injList = Array.isArray(skillInj?.injections) ? skillInj.injections : [];
    const skillInjHtml = injList.length
      ? html`
        <div class="quota-item" style="margin-top:8px">
          <div class="quota-row">
            <span class="quota-label">Dynamic Skill Injections (${esc(injList.length)})</span>
            <span class="quota-meta">~${esc(skillInj.estimatedTokens ?? 0)} tokens (${esc(skillInj.totalInjectedBytes ?? 0)} B)</span>
          </div>
          <div class="mcp-card-meta">
            ${(cm.rawHtml || String)(injList.map((it) => {
              const injected = (it.injectedSkills || []).map(esc).join(', ') || 'none';
              const dropped = [...(it.droppedByCap || []), ...(it.droppedByBudget || [])].map(esc);
              return `#${esc(it.stepIndex)} ${esc(it.hookEvent)}: ${injected}${dropped.length ? ` (dropped: ${dropped.join(', ')})` : ''}`;
            }).join(' · '))}
          </div>
        </div>
      `
      : '';

    return html`
      <div class="sub-card">
        <div class="plan-header" style="margin-bottom:10px">
          <span class="plan-title">Context usage</span>
          <span class="telemetry-pill" title="Single user message input cap">Max msg: ${esc(budgets.formattedMaxChatInput || '16.4k')}</span>
        </div>
        <div class="quota-item">
          <div class="quota-row">
            <span class="quota-label">Customizations (${esc(counts.enabledSkills ?? 0)} skills)</span>
            <span class="quota-meta">${esc(skillsB.formattedUsed)} / ${esc(skillsB.formattedLimit)} tokens (${esc(skillsB.formattedPct)})</span>
          </div>
          <div class="quota-track">
            <div class="quota-fill" style="width:${skillsFillPct}%;background:var(--chart-yellow, #b5a642)"></div>
          </div>
        </div>
        <div class="quota-item">
          <div class="quota-row">
            <span class="quota-label">Rules (${esc(counts.enabledRules ?? 0)} active)</span>
            <span class="quota-meta">${esc(rulesB.formattedUsed)} / ${esc(rulesB.formattedLimit)} tokens (${esc(rulesB.formattedPct)})</span>
          </div>
          <div class="quota-track">
            <div class="quota-fill" style="width:${rulesFillPct}%;background:#2ec4b6"></div>
          </div>
        </div>
        ${skillInjHtml}
      </div>
      <div class="plan-header" style="margin:14px 0 8px">
        <span class="plan-title">MCP Servers <span class="agy-count-pill">${servers.length}</span></span>
        <button id="mcp-refresh-all-btn" class="agy-btn agy-btn-secondary" title="Refresh all MCP servers">
          ${refreshSvg}<span>Reload All</span>
        </button>
      </div>
      <div>${serversHtml}</div>
    `;
  }

  async function handleMcpToggle(btn, state, computeTabBodyHtml, runAction, refreshTelemetry) {
    const serverName = btn.getAttribute('data-server');
    const next = btn.getAttribute('data-enabled') !== '1';
    if (!serverName) return;
    const srv = (state.latestData?.mcpCatalog?.servers || []).find(
      (s) => s.fullServerName === serverName || s.serverName === serverName,
    );
    if (srv) {
      Object.assign(srv, { enabled: next, statusBadge: next ? 'READY' : 'OFF', isError: false });
      btn.setAttribute('data-enabled', next ? '1' : '0');
      setSwitch(btn, next);
      const row = btn.closest('.mcp-card-row');
      row?.classList.toggle('disabled', !next);
      row?.querySelector('.mcp-server-name')?.classList.toggle('strike', !next);
      const badge = row?.querySelector('.agy-badge');
      if (badge) {
        badge.className = `agy-badge ${next ? 'ready' : 'off'}`;
        setHtml(badge, html`<span class="agy-badge-dot"></span>${next ? 'Ready' : 'Off'}`);
      }
      state.lastTabHtml = computeTabBodyHtml();
    }
    await runAction(
      `Could not ${next ? 'enable' : 'disable'} ${serverName}`,
      '/api/mcp/toggle',
      { serverName, enabled: next },
    );
    await refreshTelemetry(false);
  }

  async function handleMcpAction(target, state, computeTabBodyHtml, runAction, refreshTelemetry, apiCall, render) {
    const overageBtn = target.closest('#ai-overage-toggle');
    if (overageBtn && state.latestData?.planUsage?.aiCredits) {
      const next = !state.latestData.planUsage.aiCredits.useAiCredits;
      state.latestData.planUsage.aiCredits.useAiCredits = next;
      setSwitch(overageBtn, next);
      state.lastTabHtml = computeTabBodyHtml();
      try {
        await apiCall('/api/ai-credits/toggle', { enabled: next });
        await refreshTelemetry(false);
      } catch {
        state.latestData.planUsage.aiCredits.useAiCredits = !next;
        render();
      }
      return true;
    }
    if (target.closest('#mcp-refresh-all-btn')) {
      await runAction('Could not refresh MCP servers', '/api/mcp/refresh', {});
      await refreshTelemetry(true);
      return true;
    }
    const mcpRefreshBtn = target.closest('.mcp-refresh-btn');
    if (mcpRefreshBtn) {
      const serverName = mcpRefreshBtn.getAttribute('data-server');
      if (serverName) {
        await runAction(`Could not refresh ${serverName}`, '/api/mcp/refresh', { serverName });
        await refreshTelemetry(true);
      }
      return true;
    }
    const mcpToggleBtn = target.closest('.mcp-toggle-btn');
    if (mcpToggleBtn) {
      await handleMcpToggle(mcpToggleBtn, state, computeTabBodyHtml, runAction, refreshTelemetry);
      return true;
    }
    return false;
  }

  Object.assign(cm, {
    renderMcpBudgetsTab,
    handleMcpToggle,
    handleMcpAction,
  });
})();
