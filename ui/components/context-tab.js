/** @fileoverview Renders Top Header, Tab Bar, and Tab 1 (Context Window, Drawers, Turn Strip, Plan Usage). */
(function () {
  const cm = (window.ContextMonitor = window.ContextMonitor || {});
  const { esc, icon, html, rawHtml, setHtml, switchHtml } = cm;
  const TABS = [['context', 'Context'], ['mcp', 'MCP & Budgets'], ['diagnostics', 'Diagnostics']];
  const DRAWER_TOGGLES = {
    '#model-badge-btn': 'modelProfileOpen',
    '#context-help-btn': 'contextHelpOpen',
    '#subagents-collapse-toggle': 'subagentsExpanded',
    '#subagents-show-more-btn': 'subagentsShowAll',
    '#mcp-collapse-toggle': 'mcpExpanded',
    '#compactions-collapse-toggle': 'compactionsExpanded',
    '#effort-fit-collapse-toggle': 'effortFitExpanded',
    '#culprits-collapse-toggle': 'culpritsExpanded',
  };

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

  function ensureShellMounted(appRoot, state, resetPinTracking, refreshTelemetry) {
    if (!appRoot || document.getElementById('card-tab-slot')) return;
    document.getElementById('action-msg-slot')?.remove?.();
    setHtml(
      appRoot,
      html`
        <section class="context-card">
          <div id="card-header-slot"></div>
          <div id="card-tab-slot" class="tab-slot" role="tabpanel"></div>
          <div id="action-msg-slot" aria-live="polite"></div>
          <footer class="session-bar">
            <select id="session-select" class="session-select" title="Sync with active chat tab or pin a session"></select>
            <span id="telemetry-pill" class="telemetry-pill" title="Exact API turn telemetry: input_tokens + cache_read_tokens (cache hit %)"></span>
          </footer>
        </section>
      `,
    );
    const sel = document.getElementById('session-select');
    if (!sel) return;
    sel.addEventListener('mousedown', () => {
      state.isSelectMenuOpen = true;
    });
    sel.addEventListener('blur', () => {
      state.isSelectMenuOpen = false;
    });
    sel.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      state.isSelectMenuOpen = false;
      sel.blur();
    });
    sel.addEventListener('change', (e) => {
      state.isSelectMenuOpen = false;
      resetPinTracking(e.target.value || '');
      sel.blur();
      refreshTelemetry(true);
    });
  }

  function renderTopHeaderAndTabs(data, state = {}, isPulseActive = false) {
    const refreshSvg = icon('refresh', 14);
    const activeTab = state.activeTab || 'context';
    const { model = {}, context = {}, session = {}, subagents = {} } = data || {};
    let badgeClass = model.isGemini === false ? 'model-badge claude' : 'model-badge';
    if (model.isCustom) badgeClass = 'model-badge custom';
    const risk = context.compactionRisk || 'normal';
    const usageCls = risk === 'warn' || risk === 'danger' ? `cw-Usage-text ${risk}` : 'cw-Usage-text';
    const ceilingText = context.formattedCeiling || '256k';
    const nativeText = context.formattedNativeCeiling || model.nativeCeilingFormatted || '1.0M';
    const sessionRunning = session?.status === 'CASCADE_RUN_STATUS_RUNNING';
    const subagentsRunning = Number(subagents?.runningCount || 0) > 0;
    const pulseActive = Boolean(isPulseActive || sessionRunning || subagentsRunning);
    const pulseTitle = !sessionRunning && subagentsRunning
      ? html`Subagent executing: ${esc(subagents.activeSubagentLabel || 'subagent')}`
      : (pulseActive ? 'Agent turn executing / consuming tokens' : 'Idle');

    return html`
      <header class="cw-header">
        <div class="cw-title-group">
          <span class="cw-title">Context window</span>
          <button
            type="button"
            id="model-badge-btn"
            class="${badgeClass} clickable"
            aria-expanded="${state.modelProfileOpen ? 'true' : 'false'}"
            aria-controls="model-profile-drawer"
            title="Model profile and specs"
          >
            ${esc(model.badgeLabel || 'Gemini')}<span class="badge-chevron ${state.modelProfileOpen ? 'open' : ''}" aria-hidden="true">${icon('expand_more', 12)}</span>
          </button>
          <span class="activity-pulse ${pulseActive ? 'active' : ''}" title="${pulseTitle}" role="img" aria-label="${pulseTitle}"></span>
        </div>
        <div class="cw-summary-group">
          <span class="${usageCls}" title="${model.isCustom
            ? html`Cortex autocompact ceiling: ${esc(ceilingText)} · Custom model: its window is set by your provider`
            : html`Cortex autocompact ceiling: ${esc(ceilingText)} · Native model window: ${esc(nativeText)}`}">
            <strong>${esc(context.formattedUsed || '0')}</strong> / ${esc(ceilingText)} (${esc(context.formattedUsedPct || '0.0%')})
          </span>
          ${model.isCustom ? '' : html`
            <button
              type="button"
              id="context-help-btn"
              class="help-pill ${state.contextHelpOpen ? 'active' : ''}"
              aria-expanded="${state.contextHelpOpen ? 'true' : 'false'}"
              aria-controls="context-help-drawer"
              aria-label="Why ${esc(ceilingText)} instead of ${esc(nativeText)}?"
              title="Why ${esc(ceilingText)} instead of ${esc(nativeText)}?"
            >?</button>
          `}
          <button id="refresh-btn" class="agy-icon-btn ${state.isRefreshing ? 'spinning' : ''}" title="Refresh telemetry">${refreshSvg}</button>
        </div>
      </header>
      ${cm.renderHeaderDrawers ? cm.renderHeaderDrawers(data, state) : ''}
      <agy-toggle-group
        id="tab-nav"
        role="tablist"
        aria-label="Context Monitor views"
        class="agy-toggle-group agy-toggle-group-grid"
        layout="grid"
        value="${esc(activeTab)}"
      >
        ${TABS.map(([id, label]) => html`
          <button
            type="button"
            id="tab-${id}"
            role="tab"
            aria-selected="${activeTab === id ? 'true' : 'false'}"
            aria-controls="card-tab-slot"
            tabindex="${activeTab === id ? '0' : '-1'}"
            class="agy-toggle-item ${activeTab === id ? 'active' : ''}"
            data-tab="${id}"
          >${label}</button>
        `)}
      </agy-toggle-group>
    `;
  }

  function renderSessionOptions(sessions = [], session = {}, pinnedId = '') {
    const isSubagentPinned = Boolean(session?.isSubagent && pinnedId && !sessions.some((s) => s.cascadeId === pinnedId));
    const activeTitle = (isSubagentPinned ? session?.rootTitle || session?.parentTitle : session?.title) || 'Current conversation';
    return rawHtml(
      [
        html`<option value="" ${!pinnedId ? 'selected' : ''}>Auto-sync: ${esc(activeTitle)}</option>`,
        ...(isSubagentPinned ? [html`<option value="${esc(pinnedId)}" selected>Subagent: ${esc(session.title || pinnedId)}</option>`] : []),
        ...sessions.map((s) => html`<option value="${esc(s.cascadeId)}" ${pinnedId === s.cascadeId ? 'selected' : ''}>Pin: ${esc(s.title)}</option>`),
      ].join(''),
    );
  }

  function renderTelemetryPillText(context = {}, turnInsights = {}) {
    const raw = context.rawUsage || {};
    const inFormatted = Math.round(((raw.inputTokens || 0) / 1000) * 10) / 10;
    const cacheFormatted = Math.round(((raw.cacheReadTokens || 0) / 1000) * 10) / 10;
    const hitPct = turnInsights?.performance?.turnCacheHitPct;
    const hitSuffix = typeof hitPct === 'number' && (raw.inputTokens || raw.cacheReadTokens) ? ` (${hitPct}%)` : '';
    return `in ${inFormatted}k · cache ${cacheFormatted}k${hitSuffix}`;
  }

  function renderPerfStrip(perf = {}, compaction = {}) {
    const latestCp = compaction.checkpoints?.[0] || null;
    const retryWarn = (perf.lastTurnRetries || 0) > 0 || (perf.sessionRetries || 0) > 0;
    const compactLabel = compaction.count > 0 && latestCp ? `${compaction.count} (#${latestCp.index} @${latestCp.stepIndex})` : '0';
    const outTotal = (perf.responseTokens || 0) + (perf.thinkingTokens || 0);
    const thinkPct = outTotal > 0 ? Math.round(((perf.thinkingTokens || 0) / outTotal) * 100) : 0;
    const respPct = Math.max(0, 100 - thinkPct);
    const turnEst = perf.thinkingEstimated ? ' (est.)' : '';
    const sessionEst = perf.sessionThinkingEstimated ? ' (est.)' : '';
    const outThinkTooltip = (cm.rawHtml || String)([
      `Turn: ${esc(perf.formattedResponse || '0')} resp · ${esc(perf.formattedThinking || '0')} think (${esc(perf.thinkingRatioPct || 0)}% reasoning)${turnEst}`,
      `Session: ${esc(perf.formattedSessionResponse || '0')} resp · ${esc(perf.formattedSessionThinking || '0')} think (${esc(perf.sessionThinkingRatioPct || 0)}% reasoning)${sessionEst}`,
    ].join('\n'));

    return html`
      <div class="perf-strip">
        <div class="perf-cell" title="Time to first token on latest turn">
          <span class="perf-label">TTFT</span>
          <span class="perf-val">${esc(perf.ttftFormatted || '—')}</span>
        </div>
        <div class="perf-cell" title="Streaming output throughput">
          <span class="perf-label">Speed</span>
          <span class="perf-val">${esc(perf.tpsFormatted || '—')}</span>
        </div>
        <div class="perf-cell" title="${outThinkTooltip}">
          <span class="perf-label">Out / Think</span>
          <span class="perf-val">${esc(perf.formattedResponse || '0')} / ${esc(perf.formattedThinking || '0')}</span>
          <div class="thinking-track">
            <div class="thinking-bar-response" style="width:${respPct}%"></div>
            <div class="thinking-bar-thinking" style="width:${thinkPct}%"></div>
          </div>
          <span class="thinking-sub">${esc(perf.thinkingRatioPct ?? 0)}% reasoning</span>
        </div>
        <div class="perf-cell" title="Session prompt cache hit: ${esc(perf.sessionCacheHitPct ?? 0)}% · Active step offset: ${esc(compaction.activeStartStepIndex ?? 0)}">
          <span class="perf-label">Compactions</span>
          <span class="perf-val ${compaction.justCompacted ? 'warn' : ''}">${esc(compactLabel)}</span>
        </div>
        <div class="perf-cell" title="API 429 / transient retries (latest turn / session total)">
          <span class="perf-label">Retries</span>
          <span class="perf-val ${retryWarn ? 'warn' : ''}">${esc(perf.lastTurnRetries ?? 0)} (${esc(perf.sessionRetries ?? 0)} tot)</span>
        </div>
      </div>
    `;
  }

  function renderPlanUsageSection(planUsage = {}) {
    const rawGroups = Array.isArray(planUsage.groups) && planUsage.groups.length > 0
      ? planUsage.groups
      : [{
        id: planUsage.activeGroupId || 'gemini',
        displayName: planUsage.groupName || 'Gemini Models',
        fiveHour: planUsage.fiveHour || { remainingPct: 100, effectivePct: 100, statusText: '100%' },
        weekly: planUsage.weekly || { remainingPct: 100, statusText: '100%' },
      }];

    const groupsGridHtml = rawGroups.map((grp) => {
      const isAct = grp.id === planUsage.activeGroupId;
      const fillCls = grp.id === 'claude_gpt' ? 'quota-fill claude' : 'quota-fill';
      const fh = grp.fiveHour || {};
      const wk = grp.weekly || {};
      const fhFill = Math.max(0, Math.min(100, fh.effectivePct ?? fh.remainingPct ?? 0));
      const wkFill = Math.max(0, Math.min(100, wk.remainingPct ?? 0));
      return html`
        <div class="quota-group-card">
          <div class="quota-row">
            <span class="quota-label">${esc(grp.displayName)}</span>
            ${isAct ? html`<span class="agy-badge active"><span class="agy-badge-dot"></span>Active</span>` : ''}
          </div>
          <div class="quota-item">
            <div class="quota-row">
              <span class="quota-meta">5-hour limit</span>
              <span class="quota-meta">${esc(fh.statusText || '—')}</span>
            </div>
            <div class="quota-track"><div class="${fillCls}" style="width:${fhFill}%"></div></div>
          </div>
          <div class="quota-item">
            <div class="quota-row">
              <span class="quota-meta">Weekly limit</span>
              <span class="quota-meta">${esc(wk.statusText || '—')}</span>
            </div>
            <div class="quota-track"><div class="${fillCls}" style="width:${wkFill}%"></div></div>
          </div>
        </div>
      `;
    });

    const aiCredits = planUsage.aiCredits || {};
    const overageOn = Boolean(aiCredits.useAiCredits);
    const lastTurnSuffix = aiCredits.lastTurnUsed ? html` (last turn -${esc(aiCredits.lastTurnUsed)})` : '';
    const sessionBurnText = aiCredits.sessionUsed > 0
      ? html`Session: -${esc(aiCredits.formattedSessionUsed)}${lastTurnSuffix}`
      : 'No AI credits used in this session';

    return html`
      <div class="plan-section">
        <div class="plan-header"><span class="plan-title">Plan usage</span></div>
        ${planUsage.customModel
          ? html`<div class="plan-note">This conversation uses a custom model. Its requests go to your own provider and don't count against these limits.</div>`
          : ''}
        <div class="quota-groups-grid">${groupsGridHtml}</div>
        <div class="credits-box">
          <div class="credits-info">
            <div class="credits-main">
              <span>Available AI Credits: ${esc(aiCredits.formattedAvailable ?? '—')}</span>
              <span class="tier-pill">${esc(aiCredits.tierName || 'Pro')}</span>
            </div>
            <div class="credits-sub">${sessionBurnText}</div>
          </div>
          <span class="cm-switch-row">
            <label id="ai-overage-label" for="ai-overage-toggle">Enable AI credit overages</label>
            ${switchHtml({ on: overageOn, attrs: 'id="ai-overage-toggle" aria-labelledby="ai-overage-label"' })}
          </span>
        </div>
      </div>
    `;
  }

  function renderContextTab(data, uiState = {}) {
    if (data?.newConversation && !data?.session) {
      return html`<div class="empty-hint">No conversation yet. Its context appears here once you send the first message.</div>`;
    }
    const { context = {}, planUsage = {}, turnInsights = {}, session = {}, subagents = {} } = data || {};
    const categories = Array.isArray(context.categories) ? context.categories : [];
    const mcp = context.mcp || { servers: [], formattedTotalTokens: '0', totalToolCount: 0 };
    const perf = turnInsights.performance || {};
    const compaction = turnInsights.compaction || { count: 0, checkpoints: [], activeStartStepIndex: 0 };
    const culprits = turnInsights.culprits || { topChatSteps: [], promptSections: [] };
    const advisor = turnInsights.effortAdvisor || {
      totalTurns: 0,
      optimalTurns: 0,
      flaggedTurnsCount: 0,
      latestTurnFit: null,
      recentFlaggedTurns: [],
    };
    const barSegmentsHtml = categories
      .filter((c) => c.inActiveContext && c.tokens > 0)
      .map((c) => {
        const widthPct = Math.max(0.35, Math.min(100, c.pct)).toFixed(2);
        return html`
          <div
            class="bar-segment"
            style="width:${widthPct}%;background:${esc(c.color)}"
            title="${esc(c.label)}: ${esc(c.formattedTokens)} (${esc(c.formattedPct)})"
          ></div>
        `;
      });
    const risk = context.compactionRisk || 'normal';
    const rowsHtml = categories.map((c) => {
      const isFree = c.id === 'freeSpace';
      const isDeferred = !c.inActiveContext;
      const dotStyle = isFree ? '' : (cm.rawHtml ? cm.rawHtml(`style="background:${esc(c.color)}"`) : `style="background:${esc(c.color)}"`);
      const labelClass = isDeferred && !isFree ? 'row-label muted' : 'row-label';
      const riskCls = isFree && (risk === 'warn' || risk === 'danger') ? ` ${risk}` : '';
      return html`
        <div class="breakdown-row" data-category="${esc(c.id)}">
          <div class="${labelClass}">
            <span class="${isFree ? 'dot hollow' : 'dot'}" ${dotStyle}></span>
            <span>${esc(c.label)}</span>
          </div>
          <div class="row-tokens">${esc(c.formattedTokens)}</div>
          <div class="${isDeferred ? 'row-pct muted' : 'row-pct'}${riskCls}">${esc(c.formattedPct)}</div>
        </div>
      `;
    });

    return html`
      ${cm.renderSubagentBanner ? cm.renderSubagentBanner(session) : ''}
      <div class="segmented-bar">${barSegmentsHtml}</div>
      <div class="breakdown-list">
        ${rowsHtml}
        ${cm.renderSubagentsDrawer ? cm.renderSubagentsDrawer(subagents, Boolean(uiState.subagentsExpanded), session?.cascadeId || '', Boolean(uiState.subagentsShowAll)) : ''}
        ${cm.renderMcpTreeDrawer ? cm.renderMcpTreeDrawer(mcp, Boolean(uiState.mcpExpanded)) : ''}
        ${cm.renderCompactionsDrawer ? cm.renderCompactionsDrawer(compaction, Boolean(uiState.compactionsExpanded), uiState.openCheckpoints) : ''}
        ${cm.renderEffortFitDrawer ? cm.renderEffortFitDrawer(advisor, Boolean(uiState.effortFitExpanded)) : ''}
        ${cm.renderCulpritsDrawer ? cm.renderCulpritsDrawer(culprits, context.ceilingTokens || 256000, Boolean(uiState.culpritsExpanded)) : ''}
      </div>
      ${renderPerfStrip(perf, compaction)}
      <div class="section-divider"></div>
      ${renderPlanUsageSection(planUsage)}
    `;
  }

  Object.assign(cm, {
    DRAWER_TOGGLES,
    ensureShellMounted,
    renderTopHeaderAndTabs,
    renderSessionOptions,
    renderTelemetryPillText,
    renderContextTab,
    handleContextClick,
  });
})();
