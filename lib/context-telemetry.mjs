/**
 * @fileoverview Core context window telemetry calculation & RPC orchestration.
 */

import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  callLsRpc,
  createConnectFrameAccumulator,
  encodeConnectFrame,
  getLsConfig,
  parseConnectFrames,
} from 'antigravity-sidecar-kit/rpc';
import { resolveHostTheme } from 'antigravity-sidecar-kit/theme';
import {
  CONVERSATION_RPC_TTL_MS,
  callLsRpcCached,
  registerRpcCacheClearHook,
} from './rpc-cache.mjs';
import {
  APP_STORAGE_PATH,
  COMPACT_WARN_PCT,
  COMPACT_DANGER_PCT,
  MCP_META_TOOL_NAMES,
  CATEGORY_META,
  DEFAULT_CONFIG_PATH,
  readJsonFile,
} from './constants.mjs';
import { extractPlanUsage } from './plan-quota.mjs';
import { extractTurnPerformanceAndBudgets } from './turn-insights.mjs';
import {
  enrichSubagentsFromParentSteps,
  extractInvokeSubagentEntries,
} from './context-inspector.mjs';
import { buildMcpAndCustomizationsCatalog, estimateDiskMcpSchemaTokens, estimateToolTokens } from './mcp-manager.mjs';
import { reportSettledTurnTelemetry } from './turn-telemetry-reporter.mjs';
import {
  collectSideQuestionIds,
  collectSubagentTree,
  formatTokenCount,
  formatCeilingCount,
  formatPct,
  resolveModelMetadata,
  selectActiveTrajectory,
} from './session-resolver.mjs';

export function computeMcpSummary(mcpStatesResponse = {}, tokensPerChar = 0.28, options = {}) {
  const states = mcpStatesResponse?.states || [];
  const servers = [];
  let deferredTokens = 0;
  let totalToolCount = 0;

  for (const st of states) {
    const status = String(st.status || 'MCP_SERVER_STATUS_READY');
    if (st.spec?.disabled || st.enabled === false || status.includes('DISABLED')) continue;
    const tools = Array.isArray(st.tools) ? st.tools : [];
    const serverName = st.spec?.originalServerName || st.spec?.serverName || 'mcp-server';
    const fullServerName = st.spec?.serverName || serverName;
    const baseDir = options?.appDataDir ?? st.spec?.appDataDir ?? '';
    let serverDeferredTokens = 0;
    let toolCount = tools.length;

    if (toolCount === 0) {
      if (baseDir) {
        let diskEst = estimateDiskMcpSchemaTokens(baseDir, fullServerName, tokensPerChar);
        if (diskEst.toolCount === 0 && serverName !== fullServerName) {
          diskEst = estimateDiskMcpSchemaTokens(baseDir, serverName, tokensPerChar);
        }
        toolCount = diskEst.toolCount;
        serverDeferredTokens = diskEst.estimatedTokens;
      }
      if (toolCount === 0) continue;
    } else {
      const toolConfig = st.spec?.toolConfig || {};
      for (const tool of tools) {
        if (!toolConfig?.[tool.name]?.eager) {
          serverDeferredTokens += estimateToolTokens(tool, tokensPerChar);
        }
      }
    }

    deferredTokens += serverDeferredTokens;
    totalToolCount += toolCount;
    servers.push({
      serverName,
      fullServerName,
      status,
      toolCount,
      deferredTokens: serverDeferredTokens,
    });
  }

  servers.sort((a, b) => a.serverName.localeCompare(b.serverName, undefined, { sensitivity: 'base' }));
  return { servers, deferredTokens, totalToolCount };
}

export function computeContextTelemetry(generatorMetadataList = [], mcpStates = {}, modelMeta = {}, options = {}) {
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

  const mcpSummary = computeMcpSummary(mcpStates, modelMeta.tokensPerChar || 0.28, options);
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

export function getLatestConversationSteps(cascadeId = '', options = {}) {
  const trimmed = String(cascadeId || '').trim();
  if (trimmed === '_new') return [];
  if (trimmed) {
    const key = `${getLsConfig(options).lsAddress}|${trimmed}`;
    const exact = conversationDetails.get(key)?.data?.steps;
    if (Array.isArray(exact)) return exact;
    for (const [k, v] of conversationDetails) {
      if (k.endsWith(`|${trimmed}`) && Array.isArray(v?.data?.steps)) return v.data.steps;
    }
    return null;
  }
  let latestSteps = null;
  let latestUsedAt = -1;
  for (const v of conversationDetails.values()) {
    if (Array.isArray(v?.data?.steps) && (v.usedAt ?? 0) >= latestUsedAt) {
      latestUsedAt = v.usedAt ?? 0;
      latestSteps = v.data.steps;
    }
  }
  return latestSteps;
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

function touchConversationDetail(key, nowMs) {
  const hit = conversationDetails.get(key);
  if (!hit) return null;
  hit.usedAt = nowMs;
  conversationDetails.delete(key);
  conversationDetails.set(key, hit);
  return hit.data || null;
}

function findLatestBreakdownGroups(generatorMetadataList = []) {
  for (let i = generatorMetadataList.length - 1; i >= 0; i--) {
    const groups =
      generatorMetadataList[i]?.chatModel?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups;
    if (Array.isArray(groups) && groups.length > 0) return groups;
  }
  return [];
}

const subscribedSummaryCache = new Map();
registerRpcCacheClearHook(() => subscribedSummaryCache.clear());

function extractSummaryMapFromFrame(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.summaries?.summaries && typeof data.summaries.summaries === 'object') {
    return data.summaries.summaries;
  }
  if (data.trajectorySummaries && typeof data.trajectorySummaries === 'object') {
    return data.trajectorySummaries;
  }
  if (data.summaries && typeof data.summaries === 'object' && !Array.isArray(data.summaries)) {
    return data.summaries;
  }
  return null;
}

export async function fetchSubscribedSummaries(options = {}) {
  const { lsAddress, csrfToken } = getLsConfig(options);
  if (!lsAddress || !csrfToken) return {};
  const nowMs = options.nowMs ?? Date.now();
  const hit = subscribedSummaryCache.get(lsAddress);
  if (hit && (hit.pending || nowMs < hit.expiresAt)) return hit.promise;

  const entry = { pending: true, expiresAt: 0, promise: null };
  entry.promise = (async () => {
    const fetchImpl = options.fetchFn || globalThis.fetch;
    if (typeof fetchImpl !== 'function') return {};
    const timeoutMs = Math.min(options.timeoutMs ?? 2_500, 4_000);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    const url = `http://${lsAddress}/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries`;
    const merged = {};
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Connect-Protocol-Version': '1',
          'Content-Type': 'application/connect+json',
          'x-codeium-csrf-token': csrfToken,
        },
        body: encodeConnectFrame({}),
        signal: ac.signal,
      });
      if (!res?.ok) return {};

      const applyFrame = (frame) => {
        if (!frame || frame.flags & 0x02) return Boolean(frame && frame.flags & 0x02);
        const map = extractSummaryMapFromFrame(frame.data);
        if (map) Object.assign(merged, map);
        return false;
      };

      if (typeof res.body?.getReader === 'function') {
        const reader = res.body.getReader();
        const acc = createConnectFrameAccumulator();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const frames = acc.push(value);
            let gotSnapshot = false;
            let sawEnd = false;
            for (const f of frames) {
              if (applyFrame(f)) sawEnd = true;
              else if (f.flags === 0) gotSnapshot = true;
            }
            // JetboxSubscribeToSummaries pushes the full snapshot immediately and then holds the stream open
            if (sawEnd || gotSnapshot) {
              ac.abort();
              await reader.cancel().catch(() => {});
              break;
            }
          }
        } finally {
          reader.releaseLock?.();
        }
      } else if (typeof res.arrayBuffer === 'function') {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 0 && buf[0] === 0x7b) {
          const map = extractSummaryMapFromFrame(JSON.parse(buf.toString('utf8')));
          if (map) Object.assign(merged, map);
        } else {
          for (const f of parseConnectFrames(buf).frames) applyFrame(f);
        }
      } else if (typeof res.text === 'function') {
        const txt = await res.text();
        if (txt?.trim()) {
          const raw = Buffer.from(txt, 'utf8');
          if (raw[0] === 0x7b) {
            const map = extractSummaryMapFromFrame(JSON.parse(txt));
            if (map) Object.assign(merged, map);
          } else {
            for (const f of parseConnectFrames(raw).frames) applyFrame(f);
          }
        }
      }
    } catch {
      // Fall back cleanly to resident GetAllCascadeTrajectories if streaming is unsupported or aborted
    } finally {
      clearTimeout(timer);
    }
    return merged;
  })().then((result) => {
    if (subscribedSummaryCache.get(lsAddress) === entry) {
      entry.pending = false;
      entry.expiresAt = (options.nowMs ?? Date.now()) + CONVERSATION_RPC_TTL_MS;
    }
    return result;
  });

  subscribedSummaryCache.set(lsAddress, entry);
  return entry.promise;
}

export function mergeTrajectorySummaries(residentRes = {}, subscribedMap = {}) {
  const residentMap = residentRes?.trajectorySummaries || {};
  const ids = new Set([...Object.keys(subscribedMap || {}), ...Object.keys(residentMap)]);
  const merged = {};
  for (const id of ids) {
    const sub = subscribedMap?.[id];
    const res = residentMap[id];
    if (sub && res) {
      merged[id] = {
        ...sub,
        ...res,
        annotations: { ...sub.annotations, ...res.annotations },
        trajectoryMetadata: { ...sub.trajectoryMetadata, ...res.trajectoryMetadata },
      };
    } else {
      merged[id] = res || sub;
    }
  }
  return { ...residentRes, trajectorySummaries: merged };
}

const SAFE_SWARM_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_BOARD_READ_BYTES = 262_144;

function normalizeSwarmTime(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return `${s.replace(' ', 'T')}Z`;
  return s;
}

function readSwarmBoardIndex(boardPath) {
  const briefs = new Map();
  const postCounts = new Map();
  const lastTimes = new Map();
  if (!existsSync(boardPath)) return { briefs, postCounts, lastTimes };
  let fd;
  try {
    fd = openSync(boardPath, 'r');
    const buf = Buffer.allocUnsafe(MAX_BOARD_READ_BYTES);
    const bytesRead = readSync(fd, buf, 0, MAX_BOARD_READ_BYTES, 0);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const agent = String(msg?.agent || '').replace(/^@/, '').trim();
      const ts = normalizeSwarmTime(msg?.time);
      if (agent) {
        postCounts.set(agent, (postCounts.get(agent) || 0) + 1);
        if (ts) lastTimes.set(agent, ts);
      }
      const text = String(msg?.text || '').trim();
      const mention = text.match(/^@([a-zA-Z0-9_-]+)\s+([\s\S]+)$/);
      if (mention && (msg?.kind === 'brief' || agent === 'coordinator' || !briefs.has(mention[1]))) {
        const target = mention[1];
        if (!briefs.has(target)) {
          briefs.set(target, { text: mention[2].trim(), time: ts });
        }
      }
    }
  } catch {
    // Ignore unreadable or concurrently truncated board.jsonl
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  return { briefs, postCounts, lastTimes };
}

export function hydrateSwarmSummaries(trajectoriesRes, options = {}) {
  const summaries = trajectoriesRes?.trajectorySummaries || {};
  const ids = Object.keys(summaries);
  if (ids.length === 0) return trajectoriesRes;
  const appDataDir = options.appDataDir ?? join(homedir(), '.gemini', 'antigravity');
  if (!appDataDir) return trajectoriesRes;

  let nextSummaries = null;
  for (const coordId of ids) {
    if (!SAFE_SWARM_ID_RE.test(coordId)) continue;
    const swarmDir = join(appDataDir, 'brain', coordId, '.system_generated', 'swarm');
    const membersPath = join(swarmDir, 'members.json');
    if (!existsSync(membersPath)) continue;

    const membersDoc = readJsonFile(membersPath);
    const rawMembers = membersDoc?.members;
    if (!rawMembers || typeof rawMembers !== 'object') continue;
    const entries = Array.isArray(rawMembers)
      ? rawMembers.map((m) => [m?.name || '', m])
      : Object.entries(rawMembers);
    if (entries.length === 0) continue;

    const swarmDoc = readJsonFile(join(swarmDir, 'swarm.json'));
    const swarmCreated = normalizeSwarmTime(swarmDoc?.created_at);
    const { briefs, postCounts, lastTimes } = readSwarmBoardIndex(join(swarmDir, 'board.jsonl'));

    const workerIdByName = new Map();
    for (const [key, m] of entries) {
      const name = String(m?.name || key || '').replace(/^@/, '').trim();
      if (!name || m?.role === 'coordinator' || name === 'coordinator' || m?.conversation_id === coordId) continue;
      workerIdByName.set(name, String(m?.conversation_id || `swarm:${coordId}:${name}`).trim());
    }

    for (const [key, m] of entries) {
      const name = String(m?.name || key || '').replace(/^@/, '').trim();
      if (!name || !workerIdByName.has(name)) continue;
      const workerId = workerIdByName.get(name);
      const existing = (nextSummaries || summaries)[workerId] || {};
      const phase = String(m?.phase || '').toUpperCase();
      const desired = String(m?.desired_state || '').toUpperCase();
      const wake = String(m?.wake_mode || '').toLowerCase();

      let swarmStatusBadge = 'Done';
      let fallbackStatus = 'CASCADE_RUN_STATUS_IDLE';
      if (m?.killed || phase.includes('KILL') || desired.includes('KILL') || phase === 'STOPPED') {
        swarmStatusBadge = 'Stopped';
        fallbackStatus = 'CASCADE_RUN_STATUS_CANCELED';
      } else if (phase.includes('ERR') || phase.includes('FAIL')) {
        swarmStatusBadge = 'Error';
        fallbackStatus = 'CASCADE_RUN_STATUS_ERROR';
      } else if (
        existing.status === 'CASCADE_RUN_STATUS_RUNNING' ||
        wake === 'working' ||
        (phase === 'RUNNING' && !wake)
      ) {
        swarmStatusBadge = 'Running';
        fallbackStatus = 'CASCADE_RUN_STATUS_RUNNING';
      } else if (phase === 'RUNNING') {
        swarmStatusBadge = 'Waiting';
      }

      const parentName = String(m?.added_by || m?.parent || '').replace(/^@/, '').trim();
      const helperParentId = parentName && workerIdByName.get(parentName);
      const parentConversationId = helperParentId || coordId;
      const nestingDepth = helperParentId ? 2 : 1;
      const briefInfo = briefs.get(name);
      const boardPosts = postCounts.get(name) || 0;

      if (!nextSummaries) nextSummaries = { ...summaries };
      nextSummaries[workerId] = {
        ...existing,
        status: swarmStatusBadge === 'Running' ? 'CASCADE_RUN_STATUS_RUNNING' : (existing.status || fallbackStatus),
        stepCount: Number(existing.stepCount || boardPosts || 0),
        createdTime: existing.createdTime || briefInfo?.time || swarmCreated || '',
        lastModifiedTime: existing.lastModifiedTime || lastTimes.get(name) || briefInfo?.time || swarmCreated || '',
        annotations: {
          ...existing.annotations,
          title: existing.annotations?.title || `@${name}`,
        },
        trajectoryMetadata: {
          ...existing.trajectoryMetadata,
          parentConversationId,
          rootConversationId: coordId,
          nestingDepth,
          swarmStatusBadge,
          initialPrompt: existing.trajectoryMetadata?.initialPrompt || briefInfo?.text || '',
          subagentSpec: {
            ...existing.trajectoryMetadata?.subagentSpec,
            typeName: 'swarm',
            role: `@${name}`,
            modelOption: String(m?.model || existing.trajectoryMetadata?.subagentSpec?.modelOption || ''),
          },
        },
      };
    }
  }

  return nextSummaries ? { ...trajectoriesRes, trajectorySummaries: nextSummaries } : trajectoriesRes;
}

export async function fetchMergedCascadeTrajectories(options = {}) {
  const [residentRes, subscribedMap] = await Promise.all([
    callLsRpcCached('GetAllCascadeTrajectories', {}, options),
    fetchSubscribedSummaries(options),
  ]);
  const merged = mergeTrajectorySummaries(residentRes, subscribedMap);
  const sideQuestionIds = collectSideQuestionIds(merged.trajectorySummaries);
  if (sideQuestionIds.size > 0) {
    const filtered = {};
    for (const [id, s] of Object.entries(merged.trajectorySummaries)) {
      if (!sideQuestionIds.has(id)) filtered[id] = s;
    }
    return { ...merged, trajectorySummaries: filtered };
  }
  return merged;
}

function backfillUnloadedSubagentSummaries(trajectoriesRes, parentCascadeId, rootCascadeId, steps = []) {
  if (!parentCascadeId || !Array.isArray(steps) || steps.length === 0) return trajectoriesRes;
  const summaries = trajectoriesRes?.trajectorySummaries || {};
  let added = null;
  for (let idx = 0; idx < steps.length; idx++) {
    const st = steps[idx];
    if (st?.type !== 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT') continue;
    const rawSpecs = Array.isArray(st.invokeSubagent?.subagents)
      ? st.invokeSubagent.subagents
      : st.invokeSubagent?.subagent
      ? [st.invokeSubagent.subagent]
      : [];
    const rawResults = Array.isArray(st.invokeSubagent?.results)
      ? st.invokeSubagent.results
      : st.invokeSubagent?.result
      ? [st.invokeSubagent.result]
      : [];
    const entries = extractInvokeSubagentEntries(st, idx);
    for (let i = 0; i < entries.length; i++) {
      const childId = entries[i]?.conversationId;
      if (!childId || summaries[childId] || added?.[childId]) continue;
      if (!added) added = { ...summaries };
      const spec = rawSpecs[i] || rawResults[i]?.spec || rawSpecs[0] || {};
      added[childId] = {
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 0,
        createdTime: st.metadata?.createdAt || '',
        lastModifiedTime: st.metadata?.completedAt || st.metadata?.createdAt || '',
        trajectoryMetadata: {
          parentConversationId: parentCascadeId,
          rootConversationId: rootCascadeId || parentCascadeId,
          nestingDepth: parentCascadeId === (rootCascadeId || parentCascadeId) ? 1 : 2,
          subagentSpec: {
            ...spec,
            typeName: entries[i].typeName || spec.typeName || 'subagent',
            role: entries[i].role || spec.role || '',
          },
        },
      };
    }
  }
  return added ? { ...trajectoriesRes, trajectorySummaries: added } : trajectoriesRes;
}

const HOST_CHART_PALETTES = Object.freeze({
  dark: Object.freeze({
    '--chart-1': '#60a5fa',
    '--chart-2': '#fbbf24',
    '--chart-3': '#34d399',
    '--chart-4': '#c084fc',
    '--chart-5': '#fb7185',
    '--chart-6': '#38bdf8',
  }),
  light: Object.freeze({
    '--chart-1': '#1d4ed8',
    '--chart-2': '#b45309',
    '--chart-3': '#15803d',
    '--chart-4': '#7e22ce',
    '--chart-5': '#be123c',
    '--chart-6': '#0369a1',
  }),
});

export function readHostFontSize(storagePath) {
  const candidates = storagePath
    ? [storagePath]
    : [APP_STORAGE_PATH, join(dirname(APP_STORAGE_PATH), 'User', 'globalStorage', 'storage.json')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const data = readJsonFile(candidate);
    const raw = data?.['jetski.fontSize'];
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(num) && num >= 8 && num <= 36) return num;
  }
  return 14;
}

export function resolveTelemetryTheme(userConfig, options = {}) {
  const theme = resolveHostTheme(userConfig, options.storagePath);
  const mode = theme?.mode === 'light' || theme?.themeType === 'light' ? 'light' : 'dark';
  const palette = HOST_CHART_PALETTES[mode];
  const fontSize = readHostFontSize(options.storagePath);
  const scale = fontSize !== 14 ? String(Number((fontSize / 14).toFixed(4))) : '1';
  const extraVars = {
    ...palette,
    ...(theme?.cssVariables || {}),
    '--app-font-scale': scale,
    '--font-size': `${fontSize}px`,
  };
  return {
    ...theme,
    cssVariables: extraVars,
    vars: {
      ...palette,
      ...(theme?.vars || {}),
      '--app-font-scale': scale,
      '--font-size': `${fontSize}px`,
    },
  };
}

export async function fetchFullTelemetry(options = {}) {
  const requestedCascadeId = options.cascadeId || '';
  const hostCascadeId = options.hostCascadeId || '';
  const workspaceUris = Array.isArray(options.workspaceUris) ? options.workspaceUris : [];
  const [rawTrajectoriesRes, subscribedSummaries, modelConfigRes, mcpStatesRes, custStatesRes, quotaRes, userStatusRes] =
    await Promise.all([
      callLsRpcCached('GetAllCascadeTrajectories', {}, options),
      fetchSubscribedSummaries(options),
      callLsRpcCached('GetCascadeModelConfigData', {}, options).catch(() => ({})),
      callLsRpcCached('GetMcpServerStates', {}, options).catch(() => ({})),
      callLsRpcCached('GetCustomizationStates', {}, options).catch(() => ({})),
      callLsRpcCached('RetrieveUserQuotaSummary', {}, options).catch(() => ({})),
      callLsRpcCached('GetUserStatus', {}, options).catch(() => ({})),
    ]);
  let trajectoriesRes = hydrateSwarmSummaries(
    mergeTrajectorySummaries(rawTrajectoriesRes, subscribedSummaries),
    options
  );

  const nowMs = options.nowMs ?? Date.now();
  const effectiveModelConfig = modelConfigRes?.clientModelConfigs?.length
    ? modelConfigRes
    : userStatusRes?.userStatus?.cascadeModelConfigData || modelConfigRes;

  const sessionState = selectActiveTrajectory(trajectoriesRes, {
    requestedCascadeId,
    hostCascadeId,
    workspaceUris,
    modelConfigData: effectiveModelConfig,
    nowMs,
  });
  const cascadeId = sessionState.activeSession?.cascadeId || '';
  const lsAddr = getLsConfig(options).lsAddress;
  const rootId = sessionState.activeSession?.rootConversationId || '';
  const parentId = sessionState.activeSession?.parentConversationId || '';

  // Touch cached ancestor details before fetchConversationDetail runs idle/LRU eviction
  if (sessionState.activeSession?.isSubagent) {
    if (rootId) touchConversationDetail(`${lsAddr}|${rootId}`, nowMs);
    if (parentId && parentId !== rootId) touchConversationDetail(`${lsAddr}|${parentId}`, nowMs);
  }

  let generatorMetadataList = [];
  let steps = [];
  if (cascadeId) {
    ({ generatorMetadataList, steps } = await fetchConversationDetail(
      cascadeId,
      trajectoriesRes?.trajectorySummaries?.[cascadeId],
      options,
      nowMs
    ));
  }

  let subagents = sessionState.subagents;
  if (steps.length > 0 && cascadeId) {
    const hydratedTrajs = backfillUnloadedSubagentSummaries(
      trajectoriesRes,
      cascadeId,
      rootId || cascadeId,
      steps
    );
    if (hydratedTrajs !== trajectoriesRes) {
      trajectoriesRes = hydratedTrajs;
      subagents = collectSubagentTree(
        trajectoriesRes,
        rootId || cascadeId,
        cascadeId,
        effectiveModelConfig,
        nowMs
      );
    }
  }
  if (subagents?.totalCount > 0) {
    // If inspecting a subagent and the root/parent detail is already in the bounded memory cache,
    // enrich L1/L2 subagents from that cached ancestor without issuing any extra RPCs
    if (sessionState.activeSession?.isSubagent) {
      const cachedRoot = rootId ? conversationDetails.get(`${lsAddr}|${rootId}`)?.data : null;
      if (cachedRoot) {
        subagents = enrichSubagentsFromParentSteps(
          subagents,
          cachedRoot.steps,
          findLatestBreakdownGroups(cachedRoot.generatorMetadataList),
          rootId
        );
      }
      if (parentId && parentId !== rootId) {
        const cachedParent = conversationDetails.get(`${lsAddr}|${parentId}`)?.data;
        if (cachedParent) {
          subagents = enrichSubagentsFromParentSteps(
            subagents,
            cachedParent.steps,
            findLatestBreakdownGroups(cachedParent.generatorMetadataList),
            parentId
          );
        }
      }
    }
    if (steps.length > 0) {
      subagents = enrichSubagentsFromParentSteps(
        subagents,
        steps,
        findLatestBreakdownGroups(generatorMetadataList),
        cascadeId
      );
    }
  }

  const userConfig = readJsonFile(options.configPath || DEFAULT_CONFIG_PATH);
  const latestGen = generatorMetadataList[generatorMetadataList.length - 1] || null;
  const activeSummary = cascadeId ? trajectoriesRes?.trajectorySummaries?.[cascadeId] : null;
  const modelMeta = resolveModelMetadata(effectiveModelConfig, latestGen, steps, activeSummary);
  const context = computeContextTelemetry(generatorMetadataList, mcpStatesRes, modelMeta, options);
  const planUsage = extractPlanUsage(quotaRes, modelMeta, userStatusRes, Date.now(), generatorMetadataList, {
    ...options,
    userConfig,
  });
  const turnInsights = extractTurnPerformanceAndBudgets(
    generatorMetadataList,
    userStatusRes,
    steps,
    modelConfigRes,
    subagents
  );
  const mcpCatalog = buildMcpAndCustomizationsCatalog(
    mcpStatesRes,
    custStatesRes,
    modelMeta.tokensPerChar || 0.28,
    options
  );

  if (cascadeId && generatorMetadataList.length > 0) {
    const isActiveTrajectoryExecuting = sessionState.activeSession?.isSubagent
      ? Boolean(
          sessionState.activeSession.status === 'CASCADE_RUN_STATUS_RUNNING' ||
          subagents?.items?.some((x) => x.parentConversationId === cascadeId && x.isRunning)
        )
      : sessionState.isExecuting;
    void reportSettledTurnTelemetry({
      cascadeId,
      generatorMetadataList,
      steps,
      modelConfigData: effectiveModelConfig,
      effortAdvisor: turnInsights.effortAdvisor,
      isExecuting: isActiveTrajectoryExecuting,
      options,
    }).catch(() => {});
  }

  return {
    timestamp: new Date().toISOString(),
    theme: resolveTelemetryTheme(userConfig, options),
    session: sessionState.activeSession,
    newConversation: sessionState.newConversation,
    isExecuting: sessionState.isExecuting,
    sessions: sessionState.sessions,
    subagents,
    model: modelMeta,
    context,
    planUsage,
    turnInsights,
    skillInjectionMetrics: turnInsights?.culprits?.skillInjections || {
      totalInjectedBytes: 0,
      estimatedTokens: 0,
      injections: [],
    },
    mcpCatalog,
  };
}
