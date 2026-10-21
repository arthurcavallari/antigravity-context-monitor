/**
 * @fileoverview Core context window telemetry calculation & RPC orchestration.
 */

import { callLsRpc } from 'antigravity-sidecar-kit/rpc';
import { resolveHostTheme } from 'antigravity-sidecar-kit/theme';
import { callLsRpcCached } from './rpc-cache.mjs';
import {
  COMPACT_WARN_PCT,
  COMPACT_DANGER_PCT,
  MCP_META_TOOL_NAMES,
  CATEGORY_META,
  DEFAULT_CONFIG_PATH,
  readJsonFile,
} from './constants.mjs';
import { extractPlanUsage } from './plan-quota.mjs';
import { extractTurnPerformanceAndBudgets } from './turn-insights.mjs';
import { buildMcpAndCustomizationsCatalog, estimateToolTokens } from './mcp-manager.mjs';
import {
  formatTokenCount,
  formatCeilingCount,
  formatPct,
  resolveModelMetadata,
  selectActiveTrajectory,
} from './session-resolver.mjs';

export function computeMcpSummary(mcpStatesResponse = {}, tokensPerChar = 0.28) {
  const states = mcpStatesResponse?.states || [];
  const servers = [];
  let deferredTokens = 0;
  let totalToolCount = 0;

  for (const st of states) {
    if (st.spec?.disabled) continue;
    const tools = Array.isArray(st.tools) ? st.tools : [];
    if (tools.length === 0) continue;

    const toolConfig = st.spec?.toolConfig || {};
    const serverName = st.spec?.originalServerName || st.spec?.serverName || 'mcp-server';
    let serverDeferredTokens = 0;

    for (const tool of tools) {
      if (!toolConfig?.[tool.name]?.eager) {
        serverDeferredTokens += estimateToolTokens(tool, tokensPerChar);
      }
    }

    deferredTokens += serverDeferredTokens;
    totalToolCount += tools.length;
    servers.push({
      serverName,
      fullServerName: st.spec?.serverName || serverName,
      status: st.status || 'MCP_SERVER_STATUS_READY',
      toolCount: tools.length,
      deferredTokens: serverDeferredTokens,
    });
  }

  servers.sort((a, b) => a.serverName.localeCompare(b.serverName, undefined, { sensitivity: 'base' }));
  return { servers, deferredTokens, totalToolCount };
}

export function computeContextTelemetry(generatorMetadataList = [], mcpStates = {}, modelMeta = {}) {
  let latestWithUsage = null;
  let latestWithBreakdown = null;
  let liveMaxTokens = 0;

  for (let i = generatorMetadataList.length - 1; i >= 0; i--) {
    const item = generatorMetadataList[i];
    const u = item?.chatModel?.usage;
    if (!latestWithUsage && u && (u.inputTokens || u.cacheReadTokens)) latestWithUsage = item;
    const cw = item?.chatModel?.chatStartMetadata?.contextWindowMetadata;
    if (!liveMaxTokens && Number(cw?.maxContextTokens) > 0) liveMaxTokens = Number(cw.maxContextTokens);
    const groups = cw?.tokenBreakdown?.groups;
    if (!latestWithBreakdown && Array.isArray(groups) && groups.length > 0) latestWithBreakdown = item;
    if (latestWithUsage && latestWithBreakdown && liveMaxTokens) break;
  }

  const ceiling = liveMaxTokens > 0 ? liveMaxTokens : (modelMeta.ceiling || 256_000);
  const formattedCeiling =
    liveMaxTokens > 0
      ? formatCeilingCount(liveMaxTokens)
      : (modelMeta.ceilingFormatted || formatCeilingCount(ceiling));
  const nativeCeiling = modelMeta.nativeCeiling || ceiling;
  const formattedNativeCeiling = modelMeta.nativeCeilingFormatted || formatCeilingCount(nativeCeiling);

  const latestItem = generatorMetadataList[generatorMetadataList.length - 1] || null;
  const usage = latestWithUsage?.chatModel?.usage || {};
  const inputTokens = Number(usage.inputTokens || 0);
  const cacheReadTokens = Number(usage.cacheReadTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  const thinkingTokens = Number(usage.thinkingOutputTokens || 0);
  const realWorkingMemoryTokens = inputTokens + cacheReadTokens;

  const breakdownGroups =
    latestWithBreakdown?.chatModel?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups || [];

  let systemPromptTokens = 0;
  let skillsTokens = 0;
  let mcpServersPromptTokens = 0;
  let systemToolsTokens = 0;
  let mcpToolsEagerTokens = 0;
  let breakdownMessagesTokens = 0;

  for (const grp of breakdownGroups) {
    if (grp.type === 'TOKEN_TYPE_SYSTEM_PROMPT') {
      const children = Array.isArray(grp.children) ? grp.children : [];
      for (const ch of children) {
        const count = Number(ch.numTokens || 0);
        if (ch.name === 'skills') skillsTokens += count;
        else if (ch.name === 'mcp_servers') mcpServersPromptTokens += count;
        else systemPromptTokens += count;
      }
      if (children.length === 0) systemPromptTokens = Number(grp.numTokens || 0);
    } else if (grp.type === 'TOKEN_TYPE_TOOLS') {
      const children = Array.isArray(grp.children) ? grp.children : [];
      for (const ch of children) {
        const count = Number(ch.numTokens || 0);
        const name = String(ch.name || '');
        if (name.startsWith('mcp_') || MCP_META_TOOL_NAMES.has(name)) {
          mcpToolsEagerTokens += count;
        } else {
          systemToolsTokens += count;
        }
      }
      if (children.length === 0) systemToolsTokens = Number(grp.numTokens || 0);
    } else if (grp.type === 'TOKEN_TYPE_CHAT_MESSAGES') {
      breakdownMessagesTokens = Number(grp.numTokens || 0);
    }
  }

  let mcpToolsActiveTokens = mcpToolsEagerTokens + mcpServersPromptTokens;
  const staticTokens = systemPromptTokens + skillsTokens + systemToolsTokens + mcpToolsActiveTokens;
  const estimatedTokensUsed = Number(
    latestItem?.chatModel?.chatStartMetadata?.contextWindowMetadata?.estimatedTokensUsed ||
      latestWithBreakdown?.chatModel?.chatStartMetadata?.contextWindowMetadata?.estimatedTokensUsed ||
      0
  );
  const fallbackEstimated = estimatedTokensUsed || staticTokens + breakdownMessagesTokens;
  const totalUsedTokens = realWorkingMemoryTokens > 0 ? realWorkingMemoryTokens : fallbackEstimated;

  let messagesTokens = breakdownMessagesTokens;
  if (realWorkingMemoryTokens > 0) {
    if (realWorkingMemoryTokens >= staticTokens) {
      messagesTokens = realWorkingMemoryTokens - staticTokens;
    } else if (staticTokens > 0) {
      const scale = realWorkingMemoryTokens / (staticTokens + breakdownMessagesTokens || 1);
      systemPromptTokens = Math.round(systemPromptTokens * scale);
      skillsTokens = Math.round(skillsTokens * scale);
      systemToolsTokens = Math.round(systemToolsTokens * scale);
      mcpToolsActiveTokens = Math.round(mcpToolsActiveTokens * scale);
      messagesTokens = Math.max(
        0,
        realWorkingMemoryTokens - (systemPromptTokens + skillsTokens + systemToolsTokens + mcpToolsActiveTokens)
      );
    }
  }

  const mcpSummary = computeMcpSummary(mcpStates);
  const effectiveUsed = Math.max(totalUsedTokens, estimatedTokensUsed);
  const freeSpaceTokens = Math.max(0, ceiling - totalUsedTokens);
  const headroomTokens = Math.max(0, ceiling - effectiveUsed);
  const usedPct = ceiling > 0 ? (totalUsedTokens / ceiling) * 100 : 0;
  const effectivePct = ceiling > 0 ? (effectiveUsed / ceiling) * 100 : 0;
  const compactionRisk =
    effectivePct >= COMPACT_DANGER_PCT
      ? 'danger'
      : effectivePct >= COMPACT_WARN_PCT
      ? 'warn'
      : 'normal';

  const buildRow = (meta, tokens) => ({
    id: meta.id,
    label: meta.label,
    color: meta.color,
    inActiveContext: meta.inActiveContext,
    tokens,
    formattedTokens: formatTokenCount(tokens),
    pct: ceiling > 0 ? (tokens / ceiling) * 100 : 0,
    formattedPct: formatPct(tokens, ceiling),
  });

  const categories = [
    buildRow(CATEGORY_META.messages, messagesTokens),
    buildRow(CATEGORY_META.systemTools, systemToolsTokens),
    buildRow(CATEGORY_META.systemPrompt, systemPromptTokens),
    buildRow(CATEGORY_META.skills, skillsTokens),
    buildRow(CATEGORY_META.mcpToolsActive, mcpToolsActiveTokens),
    buildRow(CATEGORY_META.mcpToolsDeferred, mcpSummary.deferredTokens),
    buildRow(CATEGORY_META.freeSpace, freeSpaceTokens),
  ];

  return {
    totalUsedTokens,
    formattedUsed: formatTokenCount(totalUsedTokens),
    estimatedTokensUsed,
    formattedEstimated: formatTokenCount(estimatedTokensUsed),
    ceilingTokens: ceiling,
    formattedCeiling,
    nativeCeilingTokens: nativeCeiling,
    formattedNativeCeiling,
    usedPct,
    formattedUsedPct: formatPct(totalUsedTokens, ceiling),
    effectivePct,
    headroomTokens,
    formattedHeadroom: formatTokenCount(headroomTokens),
    compactionRisk,
    turnCount: generatorMetadataList.length,
    rawUsage: {
      inputTokens,
      cacheReadTokens,
      outputTokens,
      thinkingTokens,
      isExactTelemetry: realWorkingMemoryTokens > 0,
    },
    categories,
    mcp: {
      totalTokens: mcpToolsActiveTokens + mcpSummary.deferredTokens,
      formattedTotalTokens: formatTokenCount(mcpToolsActiveTokens + mcpSummary.deferredTokens),
      totalToolCount: mcpSummary.totalToolCount,
      servers: mcpSummary.servers,
    },
  };
}

export async function fetchFullTelemetry(options = {}) {
  const requestedCascadeId = options.cascadeId || '';
  const hostCascadeId = options.hostCascadeId || '';
  const workspaceUris = Array.isArray(options.workspaceUris) ? options.workspaceUris : [];
  const [trajectoriesRes, modelConfigRes, mcpStatesRes, custStatesRes, quotaRes, userStatusRes] =
    await Promise.all([
      callLsRpc('GetAllCascadeTrajectories', {}, options),
      callLsRpcCached('GetCascadeModelConfigData', options).catch(() => ({})),
      callLsRpc('GetMcpServerStates', {}, options).catch(() => ({})),
      callLsRpcCached('GetCustomizationStates', options).catch(() => ({})),
      callLsRpcCached('RetrieveUserQuotaSummary', options).catch(() => ({})),
      callLsRpcCached('GetUserStatus', options).catch(() => ({})),
    ]);

  const sessionState = selectActiveTrajectory(trajectoriesRes, {
    requestedCascadeId,
    hostCascadeId,
    workspaceUris,
  });
  const cascadeId = sessionState.activeSession?.cascadeId || '';

  let generatorMetadataList = [];
  let steps = [];
  if (cascadeId) {
    const [gmRes, stepsRes] = await Promise.all([
      callLsRpc('GetCascadeTrajectoryGeneratorMetadata', { cascadeId }, options).catch(() => ({})),
      callLsRpc('GetCascadeTrajectorySteps', { cascadeId }, options).catch(() => ({})),
    ]);
    generatorMetadataList = gmRes?.generatorMetadata || [];
    steps = stepsRes?.steps || [];
  }

  const userConfig = readJsonFile(options.configPath || DEFAULT_CONFIG_PATH);
  const latestGen = generatorMetadataList[generatorMetadataList.length - 1] || null;
  const modelMeta = resolveModelMetadata(modelConfigRes, latestGen, steps);
  const context = computeContextTelemetry(generatorMetadataList, mcpStatesRes, modelMeta);
  const planUsage = extractPlanUsage(quotaRes, modelMeta, userStatusRes, Date.now(), generatorMetadataList, {
    ...options,
    userConfig,
  });
  const turnInsights = extractTurnPerformanceAndBudgets(generatorMetadataList, userStatusRes, steps, modelConfigRes);
  const mcpCatalog = buildMcpAndCustomizationsCatalog(mcpStatesRes, custStatesRes);

  return {
    timestamp: new Date().toISOString(),
    theme: resolveHostTheme(userConfig),
    session: sessionState.activeSession,
    isExecuting: sessionState.isExecuting,
    sessions: sessionState.sessions,
    model: modelMeta,
    context,
    planUsage,
    turnInsights,
    mcpCatalog,
  };
}
