/** @fileoverview Subagent hierarchy banner, tree connector rows, and drill-down drawer. */
(function () {
  const cm = (window.ContextMonitor = window.ContextMonitor || {});
  const { esc, html, rawHtml, icon } = cm;

  function renderSubagentStatusBadge(sa = {}) {
    const rawStatus = sa.statusBadge || (
      sa.isRunning || sa.status === 'CASCADE_RUN_STATUS_RUNNING'
        ? 'Running'
        : (sa.isError ? 'Error' : 'Done')
    );
    const cls = rawStatus === 'Running'
      ? 'active'
      : (rawStatus === 'Error' ? 'error' : (rawStatus === 'Stopped' ? 'off' : 'ready'));
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
      ? html`
        <button type="button" class="agy-btn subagent-root-btn" data-subagent-id="${esc(rootId)}" title="Return to root conversation: ${esc(rootTitle)}">
          Root
        </button>
      `
      : '';
    return html`
      <div class="subagent-banner">
        <div class="subagent-banner-nav">
          <button type="button" class="agy-btn subagent-back-btn" data-subagent-id="${esc(parentId)}" title="Return to parent conversation: ${esc(parentTitle)}">
            ${icon('arrow_back', 14)} Parent: ${esc(parentTitle)}
          </button>
          ${rootBtnHtml}
        </div>
        <span class="subagent-banner-label" title="${esc(labelText)}">
          <span class="fit-pill">L${esc(depth)}</span>
          <strong>${esc(labelText)}</strong>
        </span>
      </div>
    `;
  }

  function renderSubagentRow(sa = {}, activeCascadeId = '') {
    const depth = Math.max(1, Number(sa.nestingDepth) || 1);
    const isNested = depth > 1;
    const isCurrent = Boolean(activeCascadeId && sa.cascadeId === activeCascadeId);
    const depthBadge = isNested
      ? html`
        <span class="fit-pill subagent-depth-badge" title="Nested worker subagent (depth ${esc(depth)})">
          ${icon('subdirectory_arrow_right', 12)}L${esc(depth)}
        </span>
      `
      : '';
    const roleText = String(sa.role || '').trim();
    const typeText = String(sa.typeName || '').trim();
    const combinedRole = roleText && typeText && roleText.toLowerCase() !== typeText.toLowerCase()
      ? `${roleText} (${typeText})`
      : (roleText || typeText || sa.cascadeId);
    const titleText = sa.title || combinedRole;
    const promptText = sa.promptPreview || sa.initialPrompt || '';
    const cardCls = ['fit-card', 'subagent-card', isNested ? 'nested' : '', isCurrent ? 'active-subagent' : '']
      .filter(Boolean)
      .join(' ');
    return html`
      <div class="${cardCls}">
        <div class="fit-header">
          <div class="fit-flow" style="min-width:0;flex:1;flex-wrap:nowrap">
            ${depthBadge}
            <button
              type="button"
              class="fit-prompt subagent-open no-focus-ring"
              data-subagent-id="${esc(sa.cascadeId)}"
              aria-label="${isCurrent ? 'Viewing' : 'Inspect'} ${esc(titleText)}"${isCurrent ? rawHtml(' aria-current="true"') : ''}
              title="${esc(titleText)}"
            >${esc(titleText)}</button>
          </div>
          ${renderSubagentStatusBadge(sa)}
        </div>
        <div class="fit-flow">
          <span class="fit-pill">${esc(sa.modelBadge || 'Gemini')}</span>
          <span>${esc(sa.stepCount ?? 0)} step${Number(sa.stepCount) === 1 ? '' : 's'}</span>
          ${sa.durationFormatted && sa.durationFormatted !== '—' ? html`<span>· ${esc(sa.durationFormatted)}</span>` : ''}
          ${sa.formattedParentContextTokens ? html`<span>· ${esc(sa.formattedParentContextTokens)} in parent</span>` : ''}
          ${sa.spawnStepRef ? html`<span class="thinking-sub">(${esc(sa.spawnStepRef)})</span>` : ''}
          ${isCurrent ? html`<span class="subagent-viewing">Viewing</span>` : ''}
        </div>
        ${promptText ? html`<div class="fit-reason">"${esc(promptText)}"</div>` : ''}
      </div>
    `;
  }

  const DEFAULT_IDLE_VISIBLE = 3;

  function isSubagentRunning(sa = {}) {
    return Boolean(sa?.isRunning || sa?.status === 'CASCADE_RUN_STATUS_RUNNING' || sa?.statusBadge === 'Running');
  }

  function selectDefaultVisibleSubagents(items = [], runningCount = 0, activeCascadeId = '') {
    const indexById = new Map();
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.cascadeId) indexById.set(items[i].cascadeId, i);
    }
    const visibleIdx = new Set();
    const includeWithAncestors = (startIdx) => {
      let currIdx = startIdx;
      const seen = new Set();
      while (currIdx >= 0 && currIdx < items.length && !seen.has(currIdx)) {
        seen.add(currIdx);
        visibleIdx.add(currIdx);
        const curr = items[currIdx];
        const depth = Math.max(1, Number(curr?.nestingDepth) || 1);
        const pId = curr?.parentConversationId;
        if (pId && indexById.has(pId)) {
          currIdx = indexById.get(pId);
          continue;
        }
        if (depth <= 1) break;
        let prevParentIdx = -1;
        for (let j = currIdx - 1; j >= 0; j--) {
          if (Math.max(1, Number(items[j]?.nestingDepth) || 1) < depth) {
            prevParentIdx = j;
            break;
          }
        }
        currIdx = prevParentIdx;
      }
    };

    if (runningCount > 0) {
      for (let i = 0; i < items.length; i++) {
        if (isSubagentRunning(items[i])) includeWithAncestors(i);
      }
    }
    if (visibleIdx.size === 0) {
      const limit = Math.min(items.length, DEFAULT_IDLE_VISIBLE);
      for (let i = 0; i < limit; i++) includeWithAncestors(i);
    }
    if (activeCascadeId && indexById.has(activeCascadeId)) {
      includeWithAncestors(indexById.get(activeCascadeId));
    }
    return items.filter((_, idx) => visibleIdx.has(idx));
  }

  function renderSubagentsDrawer(subagents = {}, subagentsExpanded = false, activeCascadeId = '', subagentsShowAll = false) {
    const items = Array.isArray(subagents?.items) ? subagents.items : [];
    const totalCount = Number(subagents?.totalCount ?? items.length) || 0;
    if (totalCount === 0 || items.length === 0) return '';
    const runningCount = Number(subagents?.runningCount ?? items.filter(isSubagentRunning).length);
    const totalSteps = Number(subagents?.totalSteps ?? items.reduce((sum, x) => sum + (Number(x?.stepCount) || 0), 0));
    const parentTokensText = subagents?.formattedParentContextTokens || '';
    const rightParts = [];
    if (runningCount > 0) rightParts.push(`${esc(runningCount)} running`);
    rightParts.push(`${esc(totalSteps)} step${totalSteps === 1 ? '' : 's'}`);
    if (parentTokensText) rightParts.push(`${esc(parentTokensText)} in context`);
    const runningDotHtml = runningCount > 0
      ? html`
        <span class="dot sm status-ok" title="${esc(runningCount)} subagent(s) running"></span>
      `
      : '';
    let cardsHtml = '';
    if (subagentsExpanded) {
      const defaultSlice = selectDefaultVisibleSubagents(items, runningCount, activeCascadeId);
      const hiddenCount = Math.max(0, items.length - defaultSlice.length);
      const visibleItems = subagentsShowAll || hiddenCount === 0 ? items : defaultSlice;
      const kind = runningCount > 0 ? 'completed' : 'earlier';
      const noun = hiddenCount === 1 ? 'subagent' : 'subagents';
      const moreBtnLabel = subagentsShowAll
        ? `Hide ${hiddenCount} ${kind} ${noun}`
        : `Show ${hiddenCount} ${kind} ${noun}`;
      const moreBtnHtml = hiddenCount > 0
        ? html`
          <button
            type="button"
            id="subagents-show-more-btn"
            class="agy-btn subagent-more-btn"
            aria-expanded="${subagentsShowAll ? 'true' : 'false'}"
          >
            ${esc(moreBtnLabel)}${icon(subagentsShowAll ? 'keyboard_arrow_up' : 'expand_more', 14)}
          </button>
        `
        : '';
      cardsHtml = html`
        <div id="subagents-drawer" class="culprits-drawer">
          ${visibleItems.map((sa) => renderSubagentRow(sa, activeCascadeId))}
          ${moreBtnHtml}
        </div>
      `;
    }
    return html`
      ${cm.drawerToggleHtml({
        id: 'subagents-collapse-toggle',
        controls: 'subagents-drawer',
        expanded: subagentsExpanded,
        label: `Subagents (${totalCount})`,
        summary: rawHtml(rightParts.join(' · ')),
        extra: runningDotHtml,
      })}
      ${cardsHtml}
    `;
  }

  Object.assign(cm, {
    renderSubagentStatusBadge,
    renderSubagentBanner,
    renderSubagentsBanner: renderSubagentBanner,
    renderSubagentRow,
    selectDefaultVisibleSubagents,
    renderSubagentsDrawer,
  });
})();
