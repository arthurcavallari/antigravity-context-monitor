/**
 * @fileoverview Expandable drawers for the Context Monitor header and Context tab.
 */

(function () {
  window.ContextMonitor = window.ContextMonitor || {};
  const { esc, icon } = window.ContextMonitor;

  function renderHeaderDrawers(data, state) {
  const { model = {}, context = {}, turnInsights = {} } = data;
  const adv = turnInsights?.effortAdvisor;
  const lat = adv?.latestTurnFit;
  const fitText = lat
    ? `${lat.status === 'optimal' ? 'Good fit' : `Try ${lat.recommendedModel}`} (${adv.optimalTurns}/${adv.totalTurns} matched)`
    : 'Good fit';
  const ceilingText = context.formattedCeiling || '256k';
  const nativeText = context.formattedNativeCeiling || model.nativeCeilingFormatted || '1.0M';

  const modelProfileHtml = state.modelProfileOpen
    ? `
      <div class="model-profile-drawer">
        <div class="context-help-title">
          <span>${esc(model.label || model.modelId)}</span>
          <span>Model Profile</span>
        </div>
        <div class="model-spec-grid">
          <div class="model-spec-item"><span class="spec-label">Reasoning Tier:</span> <strong>${esc(model.thinkingEffort || 'Standard')}</strong></div>
          <div class="model-spec-item"><span class="spec-label">Harness Ceiling:</span> <strong>${esc(ceilingText)} autocompact</strong></div>
          <div class="model-spec-item"><span class="spec-label">Native Window:</span> <strong>${esc(nativeText)} single-turn burst</strong></div>
          <div class="model-spec-item"><span class="spec-label">Max Output:</span> <strong>${esc(model.maxOutputFormatted || '65.5k')} tokens/turn</strong></div>
          <div class="model-spec-item" style="grid-column:span 2"><span class="spec-label">Prompt Fit:</span> <strong>${esc(fitText)}</strong></div>
        </div>
      </div>`
    : '';

  const helpDrawerHtml = state.contextHelpOpen
    ? `
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
      </div>`
    : '';

  return `${modelProfileHtml}${helpDrawerHtml}`;
}

  function renderMcpTreeDrawer(mcp = {}, mcpExpanded = false) {
    const mcpServers = Array.isArray(mcp.servers) ? mcp.servers : [];
    if (mcpServers.length === 0) return '';
    const chevronSvg = icon('chevron_right', 14);
    const rowsHtml = mcpExpanded
      ? `<div class="mcp-tree">${mcpServers
          .map(
            (s) => `
            <div class="mcp-server-row">
              <span class="mcp-server-name" title="${esc(s.fullServerName)}">
                <span class="dot sm" style="background:var(--chart-green, #388a34)"></span>
                <span>${esc(s.serverName)}</span>
              </span>
              <span class="mcp-server-count">${esc(s.toolCount)} tools</span>
            </div>`
          )
          .join('')}</div>`
      : '';

    return `
      <div id="mcp-collapse-toggle" class="breakdown-row collapsible-toggle" title="Click to expand/collapse MCP servers">
        <div class="row-label muted">
          <span class="chevron ${mcpExpanded ? 'open' : ''}">${chevronSvg}</span>
          <span>MCP tools (${mcpServers.length} servers)</span>
        </div>
        <div class="row-tokens">${esc(mcp.totalToolCount)} tools · ${esc(mcp.formattedTotalTokens)}</div>
      </div>
      ${rowsHtml}`;
  }

  function renderCompactionsDrawer(compaction = {}, compactionsExpanded = false, openCheckpoints = new Set()) {
    if (!compaction.count) return '';
    const chevronSvg = icon('chevron_right', 14);
    const checkpoints = Array.isArray(compaction.checkpoints) ? compaction.checkpoints : [];
    const latestCp = checkpoints[0] || null;
    const latestDropText =
      latestCp && latestCp.beforeTokens > 0
        ? `Last: ${esc(latestCp.formattedBefore)} → ${esc(latestCp.formattedAfter)}`
        : `${esc(compaction.count)} total`;

    const cardsHtml = compactionsExpanded
      ? `<div class="culprits-drawer">${checkpoints
          .map((cp) => {
            const isOpen = openCheckpoints instanceof Set && openCheckpoints.has(String(cp.index));
            const deltaText =
              cp.beforeTokens > 0
                ? `${esc(cp.formattedBefore)} → ${esc(cp.formattedAfter)} (-${esc(cp.formattedSaved)})`
                : `Step @${esc(cp.stepIndex)}`;
            const detailsHtml = cp.summary
              ? `<details class="checkpoint-details" data-cp-index="${esc(cp.index)}" ${isOpen ? 'open' : ''}>
                  <summary>Checkpoint summary</summary>
                  <div class="checkpoint-summary">${esc(cp.summary)}</div>
                </details>`
              : '';
            return `
              <div class="checkpoint-card">
                <div class="culprit-row">
                  <span class="culprit-name"><strong>#${esc(cp.index)}</strong> · Steps ${esc(cp.stepRange)}</span>
                  <span class="culprit-tokens">${deltaText}</span>
                </div>
                ${detailsHtml}
              </div>`;
          })
          .join('')}</div>`
      : '';

    return `
      <div id="compactions-collapse-toggle" class="breakdown-row collapsible-toggle" style="margin-top:4px" title="Inspect session compaction checkpoints and summaries">
        <div class="row-label muted">
          <span class="chevron ${compactionsExpanded ? 'open' : ''}">${chevronSvg}</span>
          <span>Compaction checkpoints (${compaction.count})</span>
        </div>
        <div class="row-tokens">${latestDropText}</div>
      </div>
      ${cardsHtml}`;
  }

  function renderFitBadge(status, badgeText) {
    let cls = 'active';
    if (status === 'optimal') cls = 'ready';
    else if (status === 'thrashing') cls = 'error';
    return `<span class="status-badge ${cls}"><span class="badge-dot"></span>${esc(badgeText)}</span>`;
  }

  function renderEffortFitDrawer(advisor = {}, effortOpen = false) {
    if (!advisor.totalTurns) return '';
    const chevronSvg = icon('chevron_right', 14);
    const latTurn = advisor.latestTurnFit;
    const ps = latTurn?.phaseSplit || {};
    const flaggedTurns = Array.isArray(advisor.recentFlaggedTurns) ? advisor.recentFlaggedTurns : [];
    const fitCls = advisor.flaggedTurnsCount > 0 ? 'row-tokens warn' : 'row-tokens';
    const fitRightLabel =
      advisor.flaggedTurnsCount > 0
        ? `${advisor.optimalTurns}/${advisor.totalTurns} matched · ${advisor.flaggedTurnsCount} tip${advisor.flaggedTurnsCount === 1 ? '' : 's'}`
        : `${advisor.optimalTurns}/${advisor.totalTurns} matched`;

    let drawerBody = '';
    if (effortOpen) {
      const latestHtml = latTurn
        ? `<div>
            <div class="culprit-group-title">Latest Prompt</div>
            <div class="fit-card">
              <div class="fit-header">
                <span class="fit-prompt">#${esc(latTurn.turnNumber)} "${esc(latTurn.promptPreview)}"</span>
                ${renderFitBadge(latTurn.status, latTurn.badge)}
              </div>
              <div class="fit-flow">
                <span class="fit-pill">${esc(latTurn.shortModelLabel)}</span>
                ${
                  latTurn.status === 'optimal'
                    ? '<span>✓ Matched to task</span>'
                    : `<span>→</span><span class="fit-pill rec ${latTurn.status === 'thrashing' ? 'upgrade' : ''}">Better fit: ${esc(latTurn.recommendedModel)}</span>`
                }
              </div>
              <div class="fit-legend">
                <span class="fit-legend-item"><span class="dot sm" style="background:var(--cm-accent)"></span>${esc(ps.planAndEditSharePct ?? 100)}% plan &amp; edits</span>
                <span class="fit-legend-item"><span class="dot sm purple"></span>${esc(ps.loopSharePct ?? 0)}% file/cmd reads (${esc(ps.loopCount ?? 0)})</span>
              </div>
              <div class="thinking-track">
                <div class="thinking-bar-response" style="width:${esc(ps.planAndEditSharePct ?? 100)}%"></div>
                <div class="thinking-bar-thinking" style="width:${esc(ps.loopSharePct ?? 0)}%"></div>
              </div>
              <div class="fit-reason">${esc(latTurn.reason)}</div>
            </div>
          </div>`
        : '';

      const flaggedHtml =
        flaggedTurns.length > 0
          ? `<div>
              <div class="culprit-group-title">Prompts Where Another Model Fits Better (${esc(advisor.flaggedTurnsCount)} of ${esc(advisor.totalTurns)})</div>
              ${flaggedTurns
                .map(
                  (ft) => `
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
                  </div>`
                )
                .join('')}
            </div>`
          : '';

      drawerBody = `<div class="culprits-drawer">${latestHtml}${flaggedHtml}</div>`;
    }

    return `
      <div id="effort-fit-collapse-toggle" class="breakdown-row collapsible-toggle" style="margin-top:4px" title="Inspect per-prompt model &amp; thinking effort fit">
        <div class="row-label muted">
          <span class="chevron ${effortOpen ? 'open' : ''}">${chevronSvg}</span>
          <span>Prompt &amp; effort fit</span>
        </div>
        <div class="${fitCls}">${esc(fitRightLabel)}</div>
      </div>
      ${drawerBody}`;
  }

  function renderCulpritsDrawer(culprits = {}, ceilingTokens = 256000, culpritsOpen = false) {
    const chevronSvg = icon('chevron_right', 14);
    const topSteps = culprits.topChatSteps || [];
    const topSections = culprits.promptSections || [];
    const ceilingNum = Number(ceilingTokens || 256000);
    const topStepsPct =
      ceilingNum > 0 && culprits.topStepsTokens > 0
        ? ` (${((culprits.topStepsTokens / ceilingNum) * 100).toFixed(1)}%)`
        : '';
    const culpritsRightLabel =
      culprits.topStepsTokens > 0
        ? `Top ${topSteps.length} steps: ${esc(culprits.formattedTopStepsTokens.replace(/\s*top\s+\d+$/i, ''))}${topStepsPct}`
        : '';

    const stepsHtml =
      topSteps.length > 0
        ? topSteps
            .map(
              (st) => `
              <div class="fit-card" style="margin-bottom:5px">
                <div class="fit-header">
                  <div class="fit-flow" style="min-width:0;flex:1;flex-wrap:nowrap">
                    <span class="fit-pill">${esc(st.badge || 'Step')}</span>
                    <span class="fit-prompt" title="${esc(st.label || st.name)}">${esc(st.label || st.name)}</span>
                    ${st.stepRef ? `<span class="thinking-sub" style="flex-shrink:0">${esc(st.stepRef)}</span>` : ''}
                  </div>
                  <span class="culprit-tokens">${esc(st.formattedTokens)}</span>
                </div>
                <div class="thinking-track">
                  <div class="thinking-bar-response" style="width:${esc(st.barPct ?? 100)}%"></div>
                </div>
              </div>`
            )
            .join('')
        : '<div class="empty-hint">No step breakdown available</div>';

    const sectionsHtml = topSections
      .map(
        (sec) => `
        <div>
          <div class="fit-header">
            <span class="fit-prompt" style="font-weight:400" title="${esc(sec.name)}">${esc(sec.label || sec.name)}</span>
            <span class="culprit-tokens">${esc(sec.formattedTokens)}</span>
          </div>
          <div class="thinking-track">
            <div class="thinking-bar-thinking" style="width:${esc(sec.barPct ?? 100)}%"></div>
          </div>
        </div>`
      )
      .join('');

    return `
      <div id="culprits-collapse-toggle" class="breakdown-row collapsible-toggle" style="margin-top:4px" title="Inspect largest steps and system prompt sections in active memory">
        <div class="row-label muted">
          <span class="chevron ${culpritsOpen ? 'open' : ''}">${chevronSvg}</span>
          <span>Largest items in context</span>
        </div>
        <div class="row-tokens">${culpritsRightLabel}</div>
      </div>
      ${
        culpritsOpen
          ? `<div class="culprits-drawer">
              <div>
                <div class="culprit-group-title">Largest Active Conversation Steps</div>
                ${stepsHtml}
              </div>
              <div>
                <div class="culprit-group-title">System Prompt Breakdown (${esc(culprits.formattedPromptTotalTokens || '0')} total)</div>
                <div class="fit-card">${sectionsHtml}</div>
              </div>
            </div>`
          : ''
      }`;
  }

  Object.assign(window.ContextMonitor, { renderHeaderDrawers, renderMcpTreeDrawer, renderCompactionsDrawer, renderEffortFitDrawer, renderCulpritsDrawer });
})();
