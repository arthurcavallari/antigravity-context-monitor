/** @fileoverview Expandable drawers for the Context Monitor header and Context tab. */
(function () {
  const cm = (window.ContextMonitor = window.ContextMonitor || {});
  const { esc, icon, html } = cm;
  const HELP_ENTRIES = [
    { key: 'ceiling', title: 'Autocompact Ceiling' },
    { key: 'native', title: 'Native Model Window' },
  ];

  function renderModelProfileDrawer(data, state = {}) {
    if (!state.modelProfileOpen) return '';
    const { model = {}, context = {}, turnInsights = {} } = data || {};
    const adv = turnInsights?.effortAdvisor;
    const lat = adv?.latestTurnFit;
    const fitText = lat
      ? `${lat.status === 'optimal' ? 'Good fit' : `Try ${lat.recommendedModel}`} (${adv.optimalTurns}/${adv.totalTurns} matched)`
      : 'Good fit';
    const ceilingText = context.formattedCeiling || '256k';
    const nativeText = context.formattedNativeCeiling || model.nativeCeilingFormatted || '1.0M';
    return html`
      <div class="model-profile-drawer">
        <div class="context-help-title">
          <span>${esc(model.label || model.modelId)}</span>
          <span>Model Profile</span>
        </div>
        <div class="model-spec-grid">
          <div class="model-spec-item">
            <span class="spec-label">Reasoning Tier:</span>
            <strong>${esc(model.thinkingEffort || 'Standard')}</strong>
          </div>
          <div class="model-spec-item">
            <span class="spec-label">Harness Ceiling:</span>
            <strong>${esc(ceilingText)} autocompact</strong>
          </div>
          <div class="model-spec-item">
            <span class="spec-label">Native Window:</span>
            <strong>${esc(nativeText)} single-turn burst</strong>
          </div>
          <div class="model-spec-item">
            <span class="spec-label">Max Output:</span>
            <strong>${esc(model.maxOutputFormatted || '65.5k')} tokens/turn</strong>
          </div>
          <div class="model-spec-item" style="grid-column:span 2">
            <span class="spec-label">Prompt Fit:</span>
            <strong>${esc(fitText)}</strong>
          </div>
        </div>
      </div>
    `;
  }

  function renderHelpDrawer(data, state = {}) {
    if (!state.contextHelpOpen) return '';
    const { model = {}, context = {} } = data || {};
    const ceilingText = context.formattedCeiling || '256k';
    const nativeText = context.formattedNativeCeiling || model.nativeCeilingFormatted || '1.0M';
    return html`
      <div class="context-help-drawer">
        <div class="context-help-title">
          <span>Why ${esc(ceilingText)} instead of ${esc(nativeText)}?</span>
          <span>Cortex Harness</span>
        </div>
        <div class="context-help-item">
          <strong>${esc(ceilingText)} Autocompact Ceiling:</strong> Antigravity sets <code>maxContextTokens: ${esc(context.ceilingTokens || 256000)}</code>. Multi-turn history compacts into a <code>&lt;summary&gt;</code> checkpoint (~20k–48k) at ${esc(ceilingText)} to prevent quadratic token burn across multi-step tool loops, keep TTFT fast (~1–3s), and purge stale file reads.
        </div>
        <div class="context-help-item">
          <strong>${esc(nativeText)} Native Model Window:</strong> Reserved for single-turn multimodal inputs (video, audio, large PDFs) and in-turn tool/subagent bursts that exceed ${esc(ceilingText)} before the next pre-turn checkpoint runs.
        </div>
      </div>
    `;
  }

  function renderHeaderDrawers(data, state = {}) {
    return html`${renderModelProfileDrawer(data, state)}${renderHelpDrawer(data, state)}`;
  }

  function renderMcpTreeDrawer(mcp = {}, mcpExpanded = false) {
    const mcpServers = Array.isArray(mcp.servers) ? mcp.servers : [];
    if (mcpServers.length === 0) return '';
    const rowsHtml = mcpExpanded
      ? html`
        <div class="mcp-tree">
          ${mcpServers.map((s) => html`
            <div class="mcp-server-row">
              <span class="mcp-server-name" title="${esc(s.fullServerName)}">
                <span class="dot sm" style="background:var(--chart-green, #388a34)"></span>
                <span>${esc(s.serverName)}</span>
              </span>
              <span class="mcp-server-count">${esc(s.toolCount)} tools</span>
            </div>
          `)}
        </div>
      `
      : '';
    return html`
      <div id="mcp-collapse-toggle" class="breakdown-row collapsible-toggle" title="Click to expand/collapse MCP servers">
        <div class="row-label muted">
          <span class="chevron ${mcpExpanded ? 'open' : ''}">${icon('chevron_right', 14)}</span>
          <span>MCP tools (${mcpServers.length} servers)</span>
        </div>
        <div class="row-tokens">${esc(mcp.totalToolCount)} tools · ${esc(mcp.formattedTotalTokens)}</div>
      </div>
      ${rowsHtml}
    `;
  }

  function renderCompactionsDrawer(compaction = {}, compactionsExpanded = false, openCheckpoints = new Set()) {
    if (!compaction.count) return '';
    const checkpoints = Array.isArray(compaction.checkpoints) ? compaction.checkpoints : [];
    const latestCp = checkpoints[0] || null;
    const latestDropText = latestCp && latestCp.beforeTokens > 0
      ? html`Last: ${esc(latestCp.formattedBefore)} → ${esc(latestCp.formattedAfter)}`
      : html`${esc(compaction.count)} total`;
    const cardsHtml = compactionsExpanded
      ? html`
        <div class="culprits-drawer">
          ${checkpoints.map((cp) => {
            const isOpen = openCheckpoints instanceof Set && openCheckpoints.has(String(cp.index));
            const deltaText = cp.beforeTokens > 0
              ? html`${esc(cp.formattedBefore)} → ${esc(cp.formattedAfter)} (-${esc(cp.formattedSaved)})`
              : html`Step @${esc(cp.stepIndex)}`;
            const detailsHtml = cp.summary
              ? html`
                <details class="checkpoint-details" data-cp-index="${esc(cp.index)}" ${isOpen ? 'open' : ''}>
                  <summary>Checkpoint summary</summary>
                  <div class="checkpoint-summary">${esc(cp.summary)}</div>
                </details>
              `
              : '';
            return html`
              <div class="checkpoint-card">
                <div class="culprit-row">
                  <span class="culprit-name"><strong>#${esc(cp.index)}</strong> · Steps ${esc(cp.stepRange)}</span>
                  <span class="culprit-tokens">${deltaText}</span>
                </div>
                ${detailsHtml}
              </div>
            `;
          })}
        </div>
      `
      : '';
    return html`
      <div id="compactions-collapse-toggle" class="breakdown-row collapsible-toggle" style="margin-top:4px" title="Inspect session compaction checkpoints and summaries">
        <div class="row-label muted">
          <span class="chevron ${compactionsExpanded ? 'open' : ''}">${icon('chevron_right', 14)}</span>
          <span>Compaction checkpoints (${compaction.count})</span>
        </div>
        <div class="row-tokens">${latestDropText}</div>
      </div>
      ${cardsHtml}
    `;
  }

  function renderFitBadge(status, badgeText) {
    const cls = status === 'optimal' ? 'ready' : (status === 'thrashing' ? 'error' : 'active');
    return html`<span class="agy-badge ${cls}"><span class="agy-badge-dot"></span>${esc(badgeText)}</span>`;
  }

  function renderEffortFitDrawer(advisor = {}, effortOpen = false) {
    if (!advisor.totalTurns) return '';
    const latTurn = advisor.latestTurnFit;
    const ps = latTurn?.phaseSplit || {};
    const flaggedTurns = Array.isArray(advisor.recentFlaggedTurns) ? advisor.recentFlaggedTurns : [];
    const fitCls = advisor.flaggedTurnsCount > 0 ? 'row-tokens warn' : 'row-tokens';
    const fitRightLabel = advisor.flaggedTurnsCount > 0
      ? `${advisor.optimalTurns}/${advisor.totalTurns} matched · ${advisor.flaggedTurnsCount} tip${advisor.flaggedTurnsCount === 1 ? '' : 's'}`
      : `${advisor.optimalTurns}/${advisor.totalTurns} matched`;
    let drawerBody = '';
    if (effortOpen) {
      const latestHtml = latTurn
        ? html`
          <div>
            <div class="culprit-group-title">Latest Prompt</div>
            <div class="fit-card">
              <div class="fit-header">
                <span class="fit-prompt">#${esc(latTurn.turnNumber)} "${esc(latTurn.promptPreview)}"</span>
                ${renderFitBadge(latTurn.status, latTurn.badge)}
              </div>
              <div class="fit-flow">
                <span class="fit-pill">${esc(latTurn.shortModelLabel)}</span>
                ${latTurn.status === 'optimal'
                  ? html`<span>✓ Matched to task</span>`
                  : html`
                    <span>→</span>
                    <span class="fit-pill rec ${latTurn.status === 'thrashing' ? 'upgrade' : ''}">Better fit: ${esc(latTurn.recommendedModel)}</span>
                  `}
              </div>
              <div class="fit-legend">
                <span class="fit-legend-item">
                  <span class="dot sm" style="background:var(--cm-accent)"></span>
                  ${esc(ps.planAndEditSharePct ?? 100)}% plan &amp; edits
                </span>
                <span class="fit-legend-item">
                  <span class="dot sm purple"></span>
                  ${esc(ps.loopSharePct ?? 0)}% file/cmd reads (${esc(ps.loopCount ?? 0)})
                </span>
              </div>
              <div class="thinking-track">
                <div class="thinking-bar-response" style="width:${esc(ps.planAndEditSharePct ?? 100)}%"></div>
                <div class="thinking-bar-thinking" style="width:${esc(ps.loopSharePct ?? 0)}%"></div>
              </div>
              <div class="fit-reason">${esc(latTurn.reason)}</div>
            </div>
          </div>
        `
        : '';
      const flaggedHtml = flaggedTurns.length
        ? html`
          <div>
            <div class="culprit-group-title">
              Prompts Where Another Model Fits Better (${esc(advisor.flaggedTurnsCount)} of ${esc(advisor.totalTurns)})
            </div>
            ${flaggedTurns.map((ft) => html`
              <div class="fit-card" style="margin-bottom:5px">
                <div class="fit-header">
                  <span class="fit-prompt">#${esc(ft.turnNumber)} "${esc(ft.promptPreview)}"</span>
                  ${renderFitBadge(ft.status, ft.badge)}
                </div>
                <div class="fit-flow">
                  <span class="fit-pill">${esc(ft.shortModelLabel)}</span>
                  <span>→</span>
                  <span class="fit-pill rec ${ft.status === 'thrashing' ? 'upgrade' : ''}">Better fit: ${esc(ft.recommendedModel)}</span>
                </div>
                <div class="fit-reason">Why: ${esc(ft.reason)}</div>
              </div>
            `)}
          </div>
        `
        : '';
      drawerBody = html`<div class="culprits-drawer">${latestHtml}${flaggedHtml}</div>`;
    }
    return html`
      <div id="effort-fit-collapse-toggle" class="breakdown-row collapsible-toggle" style="margin-top:4px" title="Inspect per-prompt model &amp; thinking effort fit">
        <div class="row-label muted">
          <span class="chevron ${effortOpen ? 'open' : ''}">${icon('chevron_right', 14)}</span>
          <span>Prompt &amp; effort fit</span>
        </div>
        <div class="${fitCls}">${esc(fitRightLabel)}</div>
      </div>
      ${drawerBody}
    `;
  }

  function renderCulpritsDrawer(culprits = {}, ceilingTokens = 256000, culpritsOpen = false) {
    const topSteps = culprits.topChatSteps || [];
    const topSections = culprits.promptSections || [];
    const ceilingNum = Number(ceilingTokens || 256000);
    const topStepsPct = ceilingNum > 0 && culprits.topStepsTokens > 0
      ? ` (${((culprits.topStepsTokens / ceilingNum) * 100).toFixed(1)}%)`
      : '';
    const culpritsRightLabel = culprits.topStepsTokens > 0
      ? html`Top ${topSteps.length} steps: ${esc(culprits.formattedTopStepsTokens.replace(/\s*top\s+\d+$/i, ''))}${topStepsPct}`
      : '';
    const stepsHtml = topSteps.length
      ? topSteps.map((st) => {
        const rawSubIdAttr = st.subagentId
          ? ` data-subagent-id="${esc(st.subagentId)}" title="Click to inspect subagent (${esc(st.subagentId)})"`
          : '';
        const subIdAttr = rawSubIdAttr && cm.rawHtml ? cm.rawHtml(rawSubIdAttr) : rawSubIdAttr;
        return html`
          <div class="${st.subagentId ? 'fit-card subagent-culprit clickable' : 'fit-card'}" style="margin-bottom:5px"${subIdAttr}>
            <div class="fit-header">
              <div class="fit-flow" style="min-width:0;flex:1;flex-wrap:nowrap">
                <span class="fit-pill">${esc(st.badge || 'Step')}</span>
                <span class="fit-prompt" title="${esc(st.label || st.name)}">${esc(st.label || st.name)}</span>
                ${st.stepRef ? html`<span class="thinking-sub" style="flex-shrink:0">${esc(st.stepRef)}</span>` : ''}
              </div>
              <span class="culprit-tokens">${esc(st.formattedTokens)}</span>
            </div>
            <div class="thinking-track">
              <div class="thinking-bar-response" style="width:${esc(st.barPct ?? 100)}%"></div>
            </div>
          </div>
        `;
      })
      : html`<div class="empty-hint">No step breakdown available</div>`;
    const sectionsHtml = topSections.map((sec) => html`
      <div>
        <div class="fit-header">
          <span class="fit-prompt" style="font-weight:400" title="${esc(sec.name)}">${esc(sec.label || sec.name)}</span>
          <span class="culprit-tokens">${esc(sec.formattedTokens)}</span>
        </div>
        <div class="thinking-track">
          <div class="thinking-bar-thinking" style="width:${esc(sec.barPct ?? 100)}%"></div>
        </div>
      </div>
    `);
    const drawerContent = culpritsOpen
      ? html`
        <div class="culprits-drawer">
          <div>
            <div class="culprit-group-title">Largest Active Conversation Steps</div>
            ${stepsHtml}
          </div>
          <div>
            <div class="culprit-group-title">System Prompt Breakdown (${esc(culprits.formattedPromptTotalTokens || '0')} total)</div>
            <div class="fit-card">${sectionsHtml}</div>
          </div>
        </div>
      `
      : '';
    return html`
      <div id="culprits-collapse-toggle" class="breakdown-row collapsible-toggle" style="margin-top:4px" title="Inspect largest steps and system prompt sections in active memory">
        <div class="row-label muted">
          <span class="chevron ${culpritsOpen ? 'open' : ''}">${icon('chevron_right', 14)}</span>
          <span>Largest items in context</span>
        </div>
        <div class="row-tokens">${culpritsRightLabel}</div>
      </div>
      ${drawerContent}
    `;
  }

  Object.assign(cm, {
    HELP_ENTRIES,
    renderModelProfileDrawer,
    renderHelpDrawer,
    renderHeaderDrawers,
    renderMcpTreeDrawer,
    renderCompactionsDrawer,
    renderEffortFitDrawer,
    renderCulpritsDrawer,
  });
})();
