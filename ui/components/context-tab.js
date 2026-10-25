/**
 * @fileoverview Renders Top Header, Tab Bar, and Tab 1 (Context Window, Collapsible Drawers,
 * Turn Performance Strip, and Dual Plan Usage).
 */

(function () {
  window.ContextMonitor = window.ContextMonitor || {};
  const {
    esc,
    icon,
    renderHeaderDrawers,
    renderMcpTreeDrawer,
    renderCompactionsDrawer,
    renderEffortFitDrawer,
    renderCulpritsDrawer,
  } = window.ContextMonitor;

  function renderTopHeaderAndTabs(data, state, isPulseActive) {
    const refreshSvg = icon('refresh', 14);
    const { model = {}, context = {} } = data;
    const badgeClass = model.isGemini === false ? 'model-badge claude' : 'model-badge';
    const risk = context.compactionRisk || 'normal';
    const usageCls = risk === 'warn' || risk === 'danger' ? `cw-Usage-text ${risk}` : 'cw-Usage-text';
    const ceilingText = context.formattedCeiling || '256k';
    const nativeText = context.formattedNativeCeiling || model.nativeCeilingFormatted || '1.0M';

    return `
      <header class="cw-header">
        <div class="cw-title-group">
          <span class="cw-title">Context window</span>
          <button id="model-badge-btn" class="${badgeClass} clickable" title="Click to view model profile &amp; specs">
            ${esc(model.badgeLabel || 'Gemini')} <span class="badge-chevron ${state.modelProfileOpen ? 'open' : ''}">▾</span>
          </button>
          <span class="activity-pulse ${isPulseActive ? 'active' : ''}" title="${isPulseActive ? 'Agent turn executing / consuming tokens' : 'Idle'}"></span>
        </div>
        <div class="cw-summary-group">
          <span class="${usageCls}" title="Cortex autocompact ceiling: ${esc(ceilingText)} · Native model window: ${esc(nativeText)}">
            <strong>${esc(context.formattedUsed || '0')}</strong> / ${esc(ceilingText)} (${esc(context.formattedUsedPct || '0.0%')})
          </span>
          <button id="context-help-btn" class="help-pill ${state.contextHelpOpen ? 'active' : ''}" title="Why ${esc(ceilingText)} instead of ${esc(nativeText)}?">?</button>
          <button id="refresh-btn" class="icon-btn ${state.isRefreshing ? 'spinning' : ''}" title="Refresh telemetry">${refreshSvg}</button>
        </div>
      </header>
      ${renderHeaderDrawers(data, state)}
      <nav class="tab-bar">
        <button class="tab-btn ${state.activeTab === 'context' ? 'active' : ''}" data-tab="context">Context</button>
        <button class="tab-btn ${state.activeTab === 'mcp' ? 'active' : ''}" data-tab="mcp">MCP &amp; Budgets</button>
        <button class="tab-btn ${state.activeTab === 'diagnostics' ? 'active' : ''}" data-tab="diagnostics">Diagnostics</button>
      </nav>`;
  }

  function renderSessionOptions(sessions = [], session = {}, pinnedId = '') {
    const activeTitle = session?.title || 'Current conversation';
    return [
      `<option value="" ${!pinnedId ? 'selected' : ''}>Auto-sync: ${esc(activeTitle)}</option>`,
      ...sessions.map(
        (s) =>
          `<option value="${esc(s.cascadeId)}" ${pinnedId === s.cascadeId ? 'selected' : ''}>Pin: ${esc(s.title)}</option>`
      ),
    ].join('');
  }

  function renderTelemetryPillText(context = {}, turnInsights = {}) {
    const raw = context.rawUsage || {};
    const inFormatted = Math.round(((raw.inputTokens || 0) / 1000) * 10) / 10;
    const cacheFormatted = Math.round(((raw.cacheReadTokens || 0) / 1000) * 10) / 10;
    const hitPct = turnInsights?.performance?.turnCacheHitPct;
    const hitSuffix =
      typeof hitPct === 'number' && (raw.inputTokens || raw.cacheReadTokens) ? ` (${hitPct}%)` : '';
    return `in ${inFormatted}k · cache ${cacheFormatted}k${hitSuffix}`;
  }

  function renderContextTab(data, uiState = {}) {
  if (data.newConversation && !data.session) {
    return '<div class="empty-hint">No conversation yet. Its context appears here once you send the first message.</div>';
  }
  const { context = {}, planUsage = {}, turnInsights = {} } = data;
  const categories = Array.isArray(context.categories) ? context.categories : [];
  const mcp = context.mcp || { servers: [], formattedTotalTokens: '0', totalToolCount: 0 };
  const perf = turnInsights.performance || {};
  const compaction = turnInsights.compaction || { count: 0, checkpoints: [], activeStartStepIndex: 0 };
  const culprits = turnInsights.culprits || { topChatSteps: [], promptSections: [] };
  const advisor = turnInsights.effortAdvisor || {
    totalTurns: 0, optimalTurns: 0, flaggedTurnsCount: 0, latestTurnFit: null, recentFlaggedTurns: [],
  };

  const barSegmentsHtml = categories
    .filter((c) => c.inActiveContext && c.tokens > 0)
    .map((c) => {
      const widthPct = Math.max(0.35, Math.min(100, c.pct)).toFixed(2);
      return `<div class="bar-segment" style="width:${widthPct}%;background:${esc(c.color)}" title="${esc(c.label)}: ${esc(c.formattedTokens)} (${esc(c.formattedPct)})"></div>`;
    })
    .join('');

  const risk = context.compactionRisk || 'normal';
  const rowsHtml = categories
    .map((c) => {
      const isFree = c.id === 'freeSpace';
      const isDeferred = !c.inActiveContext;
      const dotStyle = isFree ? '' : `style="background:${esc(c.color)}"`;
      const labelClass = isDeferred && !isFree ? 'row-label muted' : 'row-label';
      const riskCls = isFree && (risk === 'warn' || risk === 'danger') ? ` ${risk}` : '';
      const pctClass = `${isDeferred ? 'row-pct muted' : 'row-pct'}${riskCls}`;
      return `
        <div class="breakdown-row" data-category="${esc(c.id)}">
          <div class="${labelClass}">
            <span class="${isFree ? 'dot hollow' : 'dot'}" ${dotStyle}></span>
            <span>${esc(c.label)}</span>
          </div>
          <div class="row-tokens">${esc(c.formattedTokens)}</div>
          <div class="${pctClass}">${esc(c.formattedPct)}</div>
        </div>`;
    })
    .join('');

  const mcpTreeHtml = renderMcpTreeDrawer(mcp, Boolean(uiState.mcpExpanded));
  const compactionsHtml = renderCompactionsDrawer(
    compaction,
    Boolean(uiState.compactionsExpanded),
    uiState.openCheckpoints
  );
  const effortFitHtml = renderEffortFitDrawer(advisor, Boolean(uiState.effortFitExpanded));
  const culpritsHtml = renderCulpritsDrawer(
    culprits,
    context.ceilingTokens || 256000,
    Boolean(uiState.culpritsExpanded)
  );

  const latestCp = compaction.checkpoints?.[0] || null;
  const retryWarn = (perf.lastTurnRetries || 0) > 0 || (perf.sessionRetries || 0) > 0;
  const compactLabel =
    compaction.count > 0 && latestCp ? `${compaction.count} (#${latestCp.index} @${latestCp.stepIndex})` : '0';
  const outTotal = (perf.responseTokens || 0) + (perf.thinkingTokens || 0);
  const thinkPct = outTotal > 0 ? Math.round(((perf.thinkingTokens || 0) / outTotal) * 100) : 0;
  const respPct = Math.max(0, 100 - thinkPct);
  const turnEst = perf.thinkingEstimated ? ' (est.)' : '';
  const sessionEst = perf.sessionThinkingEstimated ? ' (est.)' : '';
  const outThinkTooltip = [
    `Turn: ${esc(perf.formattedResponse || '0')} resp · ${esc(perf.formattedThinking || '0')} think (${esc(perf.thinkingRatioPct || 0)}% reasoning)${turnEst}`,
    `Session: ${esc(perf.formattedSessionResponse || '0')} resp · ${esc(perf.formattedSessionThinking || '0')} think (${esc(perf.sessionThinkingRatioPct || 0)}% reasoning)${sessionEst}`,
  ].join('\n');

  const perfStripHtml = `
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
    </div>`;

  const rawGroups =
    Array.isArray(planUsage.groups) && planUsage.groups.length > 0
      ? planUsage.groups
      : [
          {
            id: planUsage.activeGroupId || 'gemini',
            displayName: planUsage.groupName || 'Gemini Models',
            fiveHour: planUsage.fiveHour || { remainingPct: 100, effectivePct: 100, statusText: '100%' },
            weekly: planUsage.weekly || { remainingPct: 100, statusText: '100%' },
          },
        ];

  const groupsGridHtml = rawGroups
    .map((grp) => {
      const isAct = grp.id === planUsage.activeGroupId;
      const fillCls = grp.id === 'claude_gpt' ? 'quota-fill claude' : 'quota-fill';
      const fh = grp.fiveHour || {};
      const wk = grp.weekly || {};
      const fhFill = Math.max(0, Math.min(100, fh.effectivePct ?? fh.remainingPct ?? 0));
      const wkFill = Math.max(0, Math.min(100, wk.remainingPct ?? 0));
      return `
        <div class="quota-group-card">
          <div class="quota-row">
            <span class="quota-label">${esc(grp.displayName)}</span>
            ${isAct ? '<span class="status-badge active"><span class="badge-dot"></span>Active</span>' : ''}
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
        </div>`;
    })
    .join('');

  const aiCredits = planUsage.aiCredits || {};
  const overageOn = Boolean(aiCredits.useAiCredits);
  const sessionBurnText =
    aiCredits.sessionUsed > 0
      ? `Session: -${esc(aiCredits.formattedSessionUsed)} (${
          aiCredits.lastTurnUsed ? `last turn -${esc(aiCredits.lastTurnUsed)}` : ''
        })`
      : 'No AI credits used in this session';

  return `
    <div class="segmented-bar">${barSegmentsHtml}</div>
    <div class="breakdown-list">
      ${rowsHtml}
      ${mcpTreeHtml}
      ${compactionsHtml}
      ${effortFitHtml}
      ${culpritsHtml}
    </div>
    ${perfStripHtml}
    <div class="section-divider"></div>
    <div class="plan-section">
      <div class="plan-header"><span class="plan-title">Plan usage</span></div>
      <div class="quota-groups-grid">${groupsGridHtml}</div>
      <div class="credits-box">
        <div class="credits-info">
          <div class="credits-main">
            <span>Available AI Credits: ${esc(aiCredits.formattedAvailable ?? '—')}</span>
            <span class="tier-pill">${esc(aiCredits.tierName || 'Pro')}</span>
          </div>
          <div class="credits-sub">${sessionBurnText}</div>
        </div>
        <button id="ai-overage-toggle" type="button" role="switch" aria-checked="${overageOn}" class="overage-toggle" title="Toggle Enable AI Credit Overages">
          <span>Overage</span>
          <span class="switch-track ${overageOn ? 'on' : ''}"><span class="switch-thumb"></span></span>
        </button>
      </div>
    </div>`;
  }

  Object.assign(window.ContextMonitor, {
    renderTopHeaderAndTabs,
    renderSessionOptions,
    renderTelemetryPillText,
    renderContextTab,
  });
})();
