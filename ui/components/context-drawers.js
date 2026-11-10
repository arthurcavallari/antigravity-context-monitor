/** @fileoverview Expandable drawers for the Context Monitor header and Context tab. */
(function () {
  const cm = (window.ContextMonitor = window.ContextMonitor || {});
  const { esc, html } = cm;
  const HELP_ENTRIES = [
    { key: 'ceiling', title: 'Autocompact Ceiling' },
    { key: 'native', title: 'Native Model Window' },
  ];

  function renderModelProfileDrawer(data, state = {}) {
    if (!state.modelProfileOpen) return '';
    const { model = {}, context = {}, turnInsights = {} } = data || {};
    const adv = turnInsights?.effortAdvisor;
    const lat = adv?.latestTurnFit;
    let fitText = lat
      ? `${lat.status === 'optimal' ? 'Good fit' : `Try ${lat.recommendedModel}`} (${adv.optimalTurns}/${adv.totalTurns} matched)`
      : 'Good fit';
    if (model.isCustom) fitText = 'Not checked for custom models';
    const ceilingText = context.formattedCeiling || '256k';
    const nativeText = model.isCustom
      ? 'Set by your provider'
      : `${context.formattedNativeCeiling || model.nativeCeilingFormatted || '1.0M'} single-turn burst`;
    return html`
      <div id="model-profile-drawer" class="model-profile-drawer">
        <div class="context-help-title">
          <span>${esc(model.label || model.modelId)}</span>
          <span>Model Profile</span>
        </div>
        <div class="model-spec-grid">
          <div class="model-spec-item">
            <span class="spec-label">Reasoning Tier:</span>
            <strong>${esc(model.thinkingEffort || (model.isCustom ? 'Set by your provider' : 'Standard'))}</strong>
          </div>
          <div class="model-spec-item">
            <span class="spec-label">Harness Ceiling:</span>
            <strong>${esc(ceilingText)} autocompact</strong>
          </div>
          <div class="model-spec-item">
            <span class="spec-label">Native Window:</span>
            <strong>${esc(nativeText)}</strong>
          </div>
          <div class="model-spec-item">
            <span class="spec-label">Max Output:</span>
            <strong>${model.maxOutputFormatted
              ? html`${esc(model.maxOutputFormatted)} tokens/turn`
              : (model.isCustom ? 'Set by your provider' : '65.5k tokens/turn')}</strong>
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
    const { model = {}, context = {} } = data || {};
    // The harness-vs-native explanation describes Antigravity's built-in models only
    if (!state.contextHelpOpen || model.isCustom) return '';
    const ceilingText = context.formattedCeiling || '256k';
    const nativeText = context.formattedNativeCeiling || model.nativeCeilingFormatted || '1.0M';
    return html`
      <div id="context-help-drawer" class="context-help-drawer">
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
        <div id="mcp-tree" class="mcp-tree">
          ${mcpServers.map((s) => html`
            <div class="mcp-server-row">
              <span class="mcp-server-name" title="${esc(s.fullServerName)}">
                <span class="dot sm status-ok"></span>
                <span>${esc(s.serverName)}</span>
              </span>
              <span class="mcp-server-count">${esc(s.toolCount)} tools</span>
            </div>
          `)}
        </div>
      `
      : '';
    return html`
      ${cm.drawerToggleHtml({
        id: 'mcp-collapse-toggle',
        controls: 'mcp-tree',
        expanded: mcpExpanded,
        label: `MCP tools (${mcpServers.length} servers)`,
        summary: `${mcp.totalToolCount ?? 0} tools · ${mcp.formattedTotalTokens ?? ''}`,
      })}
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
        <div id="compactions-drawer" class="culprits-drawer">
          ${checkpoints.map((cp) => {
            const isOpen = openCheckpoints instanceof Set && openCheckpoints.has(String(cp.index));
            const deltaText = cp.beforeTokens > 0
              ? html`${esc(cp.formattedBefore)} → ${esc(cp.formattedAfter)} (-${esc(cp.formattedSaved)})`
              : html`Step @${esc(cp.stepIndex)}`;
            const detailsHtml = cp.summary
              ? html`
                <details class="checkpoint-details" data-cp-index="${esc(cp.index)}" ${isOpen ? 'open' : ''}>
                  <summary>Checkpoint summary</summary>
                  <div class="checkpoint-summary" tabindex="0" role="region" aria-label="Checkpoint ${esc(cp.index)} summary">${esc(cp.summary)}</div>
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
      ${cm.drawerToggleHtml({
        id: 'compactions-collapse-toggle',
        controls: 'compactions-drawer',
        expanded: compactionsExpanded,
        label: `Compaction checkpoints (${compaction.count})`,
        summary: latestDropText,
      })}
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
    let fitRightLabel = advisor.flaggedTurnsCount > 0
      ? `${advisor.optimalTurns}/${advisor.totalTurns} matched · ${advisor.flaggedTurnsCount} tip${advisor.flaggedTurnsCount === 1 ? '' : 's'}`
      : `${advisor.optimalTurns}/${advisor.totalTurns} matched`;
    if (advisor.customTurns > 0) fitRightLabel += ` · ${advisor.customTurns} custom skipped`;
    let drawerBody = '';
    if (effortOpen) {
      const latestHtml = latTurn
        ? html`
          <div class="culprit-group">
            <h4 class="culprit-group-title">Latest Prompt</h4>
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
          <div class="culprit-group">
            <h4 class="culprit-group-title">
              Prompts Where Another Model Fits Better (${esc(advisor.flaggedTurnsCount)} of ${esc(advisor.totalTurns)})
            </h4>
            ${flaggedTurns.map((ft) => html`
              <div class="fit-card">
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
      const emptyHtml = !latestHtml && !flaggedHtml
        ? html`<div class="empty-hint">${advisor.customTurns > 0
          ? 'Prompt fit is not checked for custom models.'
          : 'No prompts to compare yet.'}</div>`
        : '';
      drawerBody = html`<div id="effort-fit-drawer" class="culprits-drawer">${latestHtml}${flaggedHtml}${emptyHtml}</div>`;
    }
    return html`
      ${cm.drawerToggleHtml({
        id: 'effort-fit-collapse-toggle',
        controls: 'effort-fit-drawer',
        expanded: effortOpen,
        label: 'Prompt & effort fit',
        summary: fitRightLabel,
        summaryCls: advisor.flaggedTurnsCount > 0 ? 'warn' : '',
      })}
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
        const labelText = st.label || st.name || '';
        // A subagent step's title is the card's one button, stretched over the card (see components.css).
        const labelHtml = st.subagentId
          ? html`
            <button
              type="button"
              class="fit-prompt subagent-open no-focus-ring"
              data-subagent-id="${esc(st.subagentId)}"
              aria-label="Inspect subagent ${labelText}"
              title="${labelText}"
            >${labelText}</button>
          `
          : html`<span class="fit-prompt" title="${labelText}">${labelText}</span>`;
        return html`
          <div class="${st.subagentId ? 'fit-card subagent-culprit clickable' : 'fit-card'}">
            <div class="fit-header">
              <div class="fit-flow" style="min-width:0;flex:1;flex-wrap:nowrap">
                <span class="fit-pill">${esc(st.badge || 'Step')}</span>
                ${labelHtml}
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
        <div id="culprits-drawer" class="culprits-drawer">
          <div class="culprit-group">
            <h4 class="culprit-group-title">Largest Active Conversation Steps</h4>
            ${stepsHtml}
          </div>
          <div class="culprit-group">
            <h4 class="culprit-group-title">System Prompt Breakdown (${esc(culprits.formattedPromptTotalTokens || '0')} total)</h4>
            <div class="fit-card">${sectionsHtml}</div>
          </div>
        </div>
      `
      : '';
    return html`
      ${cm.drawerToggleHtml({
        id: 'culprits-collapse-toggle',
        controls: 'culprits-drawer',
        expanded: culpritsOpen,
        label: 'Largest items in context',
        summary: culpritsRightLabel,
      })}
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
