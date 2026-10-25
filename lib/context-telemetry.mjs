/**
 * @fileoverview Core context window telemetry calculation & RPC orchestration.
 */

import { callLsRpc, getLsConfig } from 'antigravity-sidecar-kit/rpc';
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

// Steps and generator metadata cover the whole conversation (tens of MB on long ones), so they are
// fetched once per change GetAllCascadeTrajectories reports, and concurrent polls share that fetch.
// They bypass the TTL cache on purpose: an answer cached before the change must not stand for it.
// Each kept conversation holds its parsed steps, so keep only the few that frames are showing
// (aux pane + Hangar decks, each possibly on its own conversation) and drop ones nobody polls.
export const MAX_CONVERSATION_DETAILS = 4;
export const CONVERSATION_DETAIL_IDLE_MS = 60_000;
// Incremental reads trust settled history; a periodic full read bounds any drift
export const FULL_DETAIL_REFRESH_MS = 5 * 60_000;
// A full read of a long conversation can take well over callLsRpc's 4s default
const DETAIL_RPC_TIMEOUT_MS = 30_000;
const MAX_DETAIL_PAGES = 64;
const SETTLED_STEP_STATUSES = new Set([
  'CORTEX_STEP_STATUS_DONE',
  'CORTEX_STEP_STATUS_INVALID',
  'CORTEX_STEP_STATUS_CLEARED',
  'CORTEX_STEP_STATUS_CANCELED',
  'CORTEX_STEP_STATUS_ERROR',
  'CORTEX_STEP_STATUS_INTERRUPTED',
]);
const conversationDetails = new Map(); // `${lsAddress}|${cascadeId}` -> { sig, pending, promise, usedAt, data }

export function clearConversationDetails() {
  conversationDetails.clear();
}

function trajectorySignature(summary) {
  if (!summary) return '';
  return `${summary.stepCount || 0}|${summary.lastModifiedTime || ''}|${summary.status || ''}`;
}

function stepIdentity(step) {
  const m = step?.metadata;
  return m?.createdAt ? `${step.type}|${step.status}|${m.createdAt}|${m.completedAt || ''}` : JSON.stringify(step);
}

// The Language Server stops each response at a byte cap (64 MiB by default) and says nothing about
// what it left out, so keep reading from where the last page ended until `target` items or an empty page
async function fetchPages(method, listField, offsetField, cascadeId, from, target, options) {
  const items = [];
  let lastFirst = null;
  for (let page = 0; page < MAX_DETAIL_PAGES; page++) {
    const offset = from + items.length;
    const body = offset > 0 ? { cascadeId, [offsetField]: offset } : { cascadeId };
    const res = await callLsRpc(method, body, { ...options, timeoutMs: DETAIL_RPC_TIMEOUT_MS });
    const got = res?.[listField] || [];
    // A server that ignored the offset would hand back the same page forever
    const first = got.length > 0 ? JSON.stringify(got[0]) : null;
    if (got.length === 0 || first === lastFirst) break;
    lastFirst = first;
    for (const item of got) items.push(item);
    if (target > 0 && from + items.length >= target) break;
  }
  return items;
}

// Every step the server returns costs it a locked SQLite count and a deep copy, so after the first read
// only ask for what can have changed: from the first unsettled step, one settled step earlier to check
// that the history still lines up (a revert rewrites it), plus the last two generator metadata entries
async function loadConversationDetail(cascadeId, stepTarget, prev, options, nowMs) {
  const readSteps = (from) =>
    fetchPages('GetCascadeTrajectorySteps', 'steps', 'stepOffset', cascadeId, from, stepTarget, options);
  const readGenerators = (from) =>
    fetchPages('GetCascadeTrajectoryGeneratorMetadata', 'generatorMetadata', 'generatorMetadataOffset', cascadeId, from, 0, options);

  if (prev && nowMs - prev.fullAt < FULL_DETAIL_REFRESH_MS && stepTarget >= prev.steps.length) {
    const firstOpen = prev.steps.findIndex((s) => !SETTLED_STEP_STATUSES.has(s?.status));
    const overlap = (firstOpen < 0 ? prev.steps.length : firstOpen) - 1;
    const prevGenerators = prev.generatorMetadataList;
    const genFrom = Math.max(0, prevGenerators.length - 2);
    if (overlap >= 0) {
      try {
        const [steps, generators] = await Promise.all([readSteps(overlap), readGenerators(genFrom)]);
        const linesUp =
          steps.length > 0 &&
          stepIdentity(steps[0]) === stepIdentity(prev.steps[overlap]) &&
          generators.length >= prevGenerators.length - genFrom;
        if (linesUp) {
          const detail = {
            steps: prev.steps.slice(0, overlap).concat(steps),
            generatorMetadataList: prevGenerators.slice(0, genFrom).concat(generators),
            fullAt: prev.fullAt,
          };
          return { detail, complete: true };
        }
      } catch {
        // Fall through to a full read
      }
    }
  }

  const [steps, generators] = await Promise.all([
    readSteps(0).catch(() => null),
    readGenerators(0).catch(() => null),
  ]);
  const detail = {
    steps: steps || prev?.steps || [],
    generatorMetadataList: generators || prev?.generatorMetadataList || [],
    fullAt: nowMs,
  };
  return { detail, complete: Boolean(steps && generators) };
}

function fetchConversationDetail(cascadeId, summary, options, nowMs) {
  for (const [k, e] of conversationDetails) {
    if (!e.pending && nowMs - e.usedAt > CONVERSATION_DETAIL_IDLE_MS) conversationDetails.delete(k);
  }
  const key = `${getLsConfig(options).lsAddress}|${cascadeId}`;
  const sig = trajectorySignature(summary);
  const hit = conversationDetails.get(key);
  // Without a signature there is nothing to compare, so only an in-flight fetch can be shared
  if (hit && hit.sig === sig && (sig || hit.pending)) {
    hit.usedAt = nowMs;
    conversationDetails.delete(key);
    conversationDetails.set(key, hit);
    return hit.promise;
  }

  const entry = { sig, pending: true, promise: null, usedAt: nowMs, data: hit?.data || null };
  entry.promise = loadConversationDetail(cascadeId, Number(summary?.stepCount) || 0, entry.data, options, nowMs).then(
    ({ detail, complete }) => {
      entry.pending = false;
      // An incomplete read keeps the last good data and is retried on the next poll
      if (complete) entry.data = detail;
      else entry.sig = null;
      return detail;
    }
  );
  conversationDetails.delete(key);
  conversationDetails.set(key, entry);
  while (conversationDetails.size > MAX_CONVERSATION_DETAILS) {
    conversationDetails.delete(conversationDetails.keys().next().value);
  }
  return entry.promise;
}

export async function fetchFullTelemetry(options = {}) {
  const requestedCascadeId = options.cascadeId || '';
  const hostCascadeId = options.hostCascadeId || '';
  const workspaceUris = Array.isArray(options.workspaceUris) ? options.workspaceUris : [];
  const [trajectoriesRes, modelConfigRes, mcpStatesRes, custStatesRes, quotaRes, userStatusRes] =
    await Promise.all([
      callLsRpcCached('GetAllCascadeTrajectories', {}, options),
      callLsRpcCached('GetCascadeModelConfigData', {}, options).catch(() => ({})),
      callLsRpcCached('GetMcpServerStates', {}, options).catch(() => ({})),
      callLsRpcCached('GetCustomizationStates', {}, options).catch(() => ({})),
      callLsRpcCached('RetrieveUserQuotaSummary', {}, options).catch(() => ({})),
      callLsRpcCached('GetUserStatus', {}, options).catch(() => ({})),
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
    ({ generatorMetadataList, steps } = await fetchConversationDetail(
      cascadeId,
      trajectoriesRes?.trajectorySummaries?.[cascadeId],
      options,
      options.nowMs ?? Date.now()
    ));
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
    newConversation: sessionState.newConversation,
    isExecuting: sessionState.isExecuting,
    sessions: sessionState.sessions,
    model: modelMeta,
    context,
    planUsage,
    turnInsights,
    mcpCatalog,
  };
}
