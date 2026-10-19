/**
 * @fileoverview Renders Tab 2 (Skills & Rules Token Budgets + Live MCP Server Controls).
 */

(function () {
  window.ContextMonitor = window.ContextMonitor || {};
  const { esc, icon, formatBadgeLabel } = window.ContextMonitor;

  function renderMcpBudgetsTab(data) {
    const budgets = data?.turnInsights?.budgets || {};
    const skillsB = budgets.skills || {
      formattedUsed: '0',
      formattedLimit: '20.0k',
      pct: 0,
      formattedPct: '0.0%',
    };
    const rulesB = budgets.rules || {
      formattedUsed: '0',
      formattedLimit: '20.0k',
      pct: 0,
      formattedPct: '0.0%',
    };
    const catalog = data?.mcpCatalog || { servers: [], counts: {} };
    const counts = catalog.counts || {};
    const servers = Array.isArray(catalog.servers) ? catalog.servers : [];

    const refreshSvg = icon('refresh', 14);
    const serversHtml =
      servers.length > 0
        ? `<div class="mcp-list-card">${servers
            .map((srv) => {
              let badgeCls = 'status-badge off';
              if (srv.isError) badgeCls = 'status-badge error';
              else if (srv.enabled) badgeCls = 'status-badge ready';

              return `
                <div class="mcp-card-row ${srv.enabled ? '' : 'disabled'}">
                  <div class="mcp-card-info">
                    <div class="mcp-card-title">
                      <span class="mcp-server-name ${srv.enabled ? '' : 'strike'}" title="${esc(srv.fullServerName)}">
                        ${esc(srv.serverName)}
                      </span>
                      <span class="${badgeCls}"><span class="badge-dot"></span>${esc(formatBadgeLabel(srv.statusBadge))}</span>
                    </div>
                    <div class="mcp-card-meta">
                      ${esc(srv.toolCount)} tools (${esc(srv.eagerCount)} eager · ${esc(srv.deferredCount)} deferred) · ~${esc(srv.formattedTokens)}
                    </div>
                    ${
                      srv.errorMessage
                        ? `<div class="mcp-error-text ${srv.enabled ? '' : 'muted'}">Error: ${esc(srv.errorMessage)}</div>`
                        : ''
                    }
                  </div>
                  <div class="mcp-card-actions">
                    <button
                      class="icon-btn mcp-refresh-btn"
                      data-server="${esc(srv.fullServerName)}"
                      title="Reload ${esc(srv.serverName)}"
                    >${refreshSvg}</button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked="${Boolean(srv.enabled)}"
                      class="overage-toggle mcp-toggle-btn"
                      data-server="${esc(srv.fullServerName)}"
                      data-enabled="${srv.enabled ? '1' : '0'}"
                      title="Enable or disable ${esc(srv.serverName)}"
                    >
                      <span class="switch-track ${srv.enabled ? 'on' : ''}">
                        <span class="switch-thumb"></span>
                      </span>
                    </button>
                  </div>
                </div>`;
            })
            .join('')}</div>`
        : '<div class="empty-hint">No MCP servers configured</div>';

    const skillsFillPct = Math.max(0, Math.min(100, skillsB.pct || 0));
    const rulesFillPct = Math.max(0, Math.min(100, rulesB.pct || 0));

    return `
      <div class="sub-card">
        <div class="plan-header" style="margin-bottom:10px">
          <span class="plan-title">Context usage</span>
          <span class="telemetry-pill" title="Single user message input cap">
            Max msg: ${esc(budgets.formattedMaxChatInput || '16.4k')}
          </span>
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
      </div>

      <div class="plan-header" style="margin:14px 0 8px">
        <span class="plan-title">MCP Servers <span class="count-pill">${servers.length}</span></span>
        <button id="mcp-refresh-all-btn" class="agy-btn" title="Refresh all MCP servers">
          ${refreshSvg}<span>Reload All</span>
        </button>
      </div>

      <div>
        ${serversHtml}
      </div>`;
  }

  Object.assign(window.ContextMonitor, { renderMcpBudgetsTab });
})();
