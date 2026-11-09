/**
 * @fileoverview Session synchronization and model metadata resolution.
 */

import {
  NEW_CONVERSATION_ID,
  isRealConversationId,
  normalizeWorkspacePath as kitNormalizeWorkspacePath,
} from 'antigravity-sidecar-kit/workspace';
import {
  GEMINI_CONTEXT_CEILING,
  GEMINI_NATIVE_CEILING,
  CLAUDE_CONTEXT_CEILING,
  DEFAULT_CONTEXT_CEILING,
  isCustomModelId,
} from './constants.mjs';
import { isGeminiFamily } from './plan-quota.mjs';

// Promote to M once the k value would round to 1000.0k
const MEGA_THRESHOLD = 999_950;

export function formatTokenCount(tokens) {
  const n = Math.max(0, Number(tokens) || 0);
  if (n >= MEGA_THRESHOLD) return `${(n / 1_048_576).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCeilingCount(tokens) {
  const n = Math.max(0, Number(tokens) || 0);
  if (n >= MEGA_THRESHOLD) return `${(n / 1_048_576).toFixed(1)}M`;
  if (n >= 1_000) {
    const k = n / 1_000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return String(Math.round(n));
}

export function formatPct(tokens, ceiling) {
  if (!ceiling || ceiling <= 0) return '0.0%';
  const pct = (Math.max(0, Number(tokens) || 0) / ceiling) * 100;
  return `${pct.toFixed(1)}%`;
}

export function formatSupportedMedia(mimeTypes = {}) {
  const keys = Object.keys(mimeTypes || {});
  if (keys.length === 0) return 'Code · Text';
  const tags = [];
  if (keys.some((k) => k.startsWith('video/'))) tags.push('Video');
  if (keys.some((k) => k.startsWith('audio/'))) tags.push('Audio');
  if (keys.includes('application/pdf')) tags.push('PDF');
  if (keys.some((k) => k.startsWith('image/'))) tags.push('Images');
  tags.push('Code');
  return tags.join(' · ');
}

export function extractThinkingEffort(rawLabel = '', modelId = '') {
  const labelMatch = String(rawLabel || '').match(/\s*\((High|Medium|Low)\)\s*$/i);
  if (labelMatch) {
    const raw = labelMatch[1].toLowerCase();
    return raw[0].toUpperCase() + raw.slice(1);
  }
  const idMatch = String(modelId || '').match(/-(high|medium|low)$/i);
  if (idMatch) {
    const raw = idMatch[1].toLowerCase();
    return raw[0].toUpperCase() + raw.slice(1);
  }
  return '';
}

export function cleanModelBadgeLabel(rawLabel = '', modelId = '') {
  if (rawLabel) return String(rawLabel).trim();
  if (!modelId) return 'Gemini';
  const effort = extractThinkingEffort('', modelId);
  const base = String(modelId)
    .replace(/-(high|medium|low)$/i, '')
    .replace(/^MODEL_PLACEHOLDER_/i, 'Model ')
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ')
    .trim() || 'Gemini';
  return effort ? `${base} (${effort})` : base;
}

export function buildModelConfigMap(modelConfigData = {}) {
  const byEnum = new Map();
  const byId = new Map();
  for (const c of modelConfigData?.clientModelConfigs || []) {
    const enumKey = c.modelOrAlias?.model;
    if (enumKey) byEnum.set(enumKey, c);
    if (c.modelId) byId.set(c.modelId, c);
  }
  return { byEnum, byId };
}

export function resolveModelMetadata(modelConfigData = {}, latestGen = null, steps = [], activeSummary = null) {
  const { byEnum, byId } = buildModelConfigMap(modelConfigData);

  let stepPlanModel = '';
  for (let i = steps.length - 1; i >= 0; i--) {
    const pm = steps[i]?.userInput?.userConfig?.plannerConfig?.planModel;
    if (pm) {
      stepPlanModel = pm;
      break;
    }
  }

  const subagentModel = String(activeSummary?.trajectoryMetadata?.subagentSpec?.model || '').trim();
  const validSubagentModel = subagentModel && !/^inherit$/i.test(subagentModel) ? subagentModel : '';

  const genModelEnum =
    stepPlanModel ||
    latestGen?.plannerConfig?.planModel ||
    latestGen?.chatModel?.model ||
    validSubagentModel ||
    modelConfigData?.defaultOverrideModelConfig?.modelOrAlias?.model ||
    '';
  const genModelId = latestGen?.plannerConfig?.modelName || validSubagentModel || '';
  const matched = byEnum.get(genModelEnum) || byId.get(genModelId) || null;

  const modelId = matched?.modelId || genModelId || genModelEnum || 'gemini';
  const fullLabel = matched?.label || cleanModelBadgeLabel('', modelId);
  const badgeLabel = cleanModelBadgeLabel(fullLabel, modelId);
  const thinkingEffort = extractThinkingEffort(fullLabel, modelId);
  const apiProvider = latestGen?.chatModel?.usage?.apiProvider || '';
  const isCustom = isCustomModelId(modelId);
  const isGemini = !isCustom && isGeminiFamily(modelId, apiProvider, fullLabel);

  const liveMax = Number(
    latestGen?.chatModel?.chatStartMetadata?.contextWindowMetadata?.maxContextTokens || 0
  );
  let fallbackCeiling = isGemini ? GEMINI_CONTEXT_CEILING : CLAUDE_CONTEXT_CEILING;
  if (isCustom) fallbackCeiling = DEFAULT_CONTEXT_CEILING;
  const ceiling = liveMax > 0 ? liveMax : fallbackCeiling;
  // A custom model's real window is set in its provider settings, which the LS doesn't report,
  // so claim no window beyond the ceiling Antigravity compacts at.
  let nativeCeiling = isGemini ? GEMINI_NATIVE_CEILING : CLAUDE_CONTEXT_CEILING;
  if (isCustom) nativeCeiling = ceiling;
  const supportedMedia = formatSupportedMedia(matched?.supportedMimeTypes);
  const maxOutputTokens = Number(latestGen?.plannerConfig?.maxOutputTokens || 65536);

  return {
    modelEnum: genModelEnum || matched?.modelOrAlias?.model || '',
    modelId,
    label: fullLabel,
    badgeLabel,
    thinkingEffort,
    apiProvider: apiProvider || (isGemini ? 'API_PROVIDER_GOOGLE_GEMINI' : 'API_PROVIDER_ANTHROPIC'),
    isGemini,
    isCustom,
    ceiling,
    ceilingFormatted: formatCeilingCount(ceiling),
    nativeCeiling,
    nativeCeilingFormatted: formatCeilingCount(nativeCeiling),
    supportedMedia,
    maxOutputTokens,
    maxOutputFormatted: formatCeilingCount(maxOutputTokens),
  };
}

export function normalizeWorkspacePath(uriOrPath = '') {
  return kitNormalizeWorkspacePath(uriOrPath, { lowercase: true });
}

function extractSessionWorkspaces(summary = {}) {
  const paths = new Set();
  const wsList = summary?.workspaces || summary?.trajectoryMetadata?.workspaces || [];
  for (const ws of wsList) {
    const uri = ws?.workspaceFolderAbsoluteUri || ws?.gitRootAbsoluteUri;
    const norm = normalizeWorkspacePath(uri);
    if (norm) paths.add(norm);
  }
  const metaUris = summary?.trajectoryMetadata?.workspaceUris || [];
  for (const uri of metaUris) {
    const norm = normalizeWorkspacePath(uri);
    if (norm) paths.add(norm);
  }
  return [...paths];
}

function parseTimeMs(iso = '') {
  if (!iso || typeof iso !== 'string') return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export function formatSubagentTitle(summary = {}, id = '') {
  const explicit = summary?.annotations?.title || summary?.summary;
  if (explicit) return String(explicit).trim();
  const spec = summary?.trajectoryMetadata?.subagentSpec || {};
  const role = String(spec.role || '').trim();
  const typeName = String(spec.typeName || summary?.trajectoryMetadata?.agentScript?.name || '').trim();
  if (role && typeName && role.toLowerCase() !== typeName.toLowerCase()) {
    return `${role} (${typeName})`;
  }
  if (role || typeName) return role || typeName;
  return id ? `Subagent ${String(id).slice(0, 8)}` : 'Subagent';
}

export function formatDurationCompact(startIso = '', endIso = '', isRunning = false, nowMs = Date.now()) {
  const startMs = parseTimeMs(startIso);
  if (!startMs) return '—';
  const endMs = isRunning ? nowMs : (parseTimeMs(endIso) || nowMs);
  const totalSec = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function isSubagentSummary(id, s = {}) {
  const tm = s?.trajectoryMetadata || {};
  return Boolean(
    (tm.parentConversationId && tm.parentConversationId !== id) ||
    (tm.rootConversationId && tm.rootConversationId !== id) ||
    Number(tm.nestingDepth) > 0 ||
    tm.subagentSpec
  );
}

function resolveSubagentModelBadge(spec = {}, modelMap = { byEnum: new Map(), byId: new Map() }, configs = []) {
  const rawModel = String(spec.model || '').trim();
  const rawTier = String(spec.modelTier || '').trim();
  const inherit = Boolean(
    spec.inherit ||
    /^inherit$/i.test(rawModel) ||
    /INHERIT/i.test(rawTier) ||
    (!rawModel && !rawTier)
  );

  if (rawModel && !/^inherit$/i.test(rawModel)) {
    const matched = modelMap.byEnum.get(rawModel) || modelMap.byId.get(rawModel);
    if (matched) return cleanModelBadgeLabel(matched.label, matched.modelId);
  }

  const tierProbe = `${rawModel} ${rawTier}`.toLowerCase();
  if (tierProbe.includes('flash_lite') || tierProbe.includes('flash-lite')) return 'Flash Lite';
  if (tierProbe.includes('flash')) {
    const flashCfg = configs.find((c) => /flash/i.test(`${c.modelId || ''} ${c.label || ''}`));
    return flashCfg ? cleanModelBadgeLabel(flashCfg.label, flashCfg.modelId) : 'Flash';
  }
  if (tierProbe.includes('pro') || tierProbe.includes('argon')) {
    const proCfg = configs.find((c) => /argon|pro/i.test(`${c.modelId || ''} ${c.label || ''}`));
    return proCfg ? cleanModelBadgeLabel(proCfg.label, proCfg.modelId) : 'Pro';
  }

  if (rawModel && !/^inherit$/i.test(rawModel)) {
    return cleanModelBadgeLabel('', rawModel);
  }
  return inherit ? 'Inherited' : 'Gemini';
}

function classifySubagentStatus(summary = {}) {
  const status = summary.status || 'CASCADE_RUN_STATUS_IDLE';
  if (status === 'CASCADE_RUN_STATUS_RUNNING') {
    return { statusBadge: 'Running', isRunning: true, isError: false };
  }
  const term = String(summary.latestExecutorTerminationReason || '');
  if (/ERROR|FAILED|ABORT|EXCEEDED|MAX_STEPS/i.test(term) || /ERROR/i.test(status)) {
    return { statusBadge: 'Error', isRunning: false, isError: true };
  }
  if (/CANCEL|INTERRUPT|STOP/i.test(term) || /CANCEL/i.test(status)) {
    return { statusBadge: 'Stopped', isRunning: false, isError: false };
  }
  return { statusBadge: 'Done', isRunning: false, isError: false };
}

export function collectSubagentTree(
  trajectoriesResponse = {},
  rootCascadeId = '',
  activeCascadeId = '',
  modelConfigData = {},
  nowMs = Date.now()
) {
  const emptyTree = {
    rootCascadeId: rootCascadeId || '',
    totalCount: 0,
    runningCount: 0,
    totalSteps: 0,
    activeSubagentLabel: '',
    parentContextTokens: 0,
    formattedParentContextTokens: '',
    items: [],
  };
  if (!rootCascadeId) return emptyTree;

  const summaries = trajectoriesResponse?.trajectorySummaries || {};
  const entries = Object.entries(summaries);
  const memberIds = new Set();

  // Pass 1: direct rootConversationId / parentConversationId match, plus transitive children
  let added = true;
  while (added) {
    added = false;
    for (const [id, s] of entries) {
      if (id === rootCascadeId || memberIds.has(id)) continue;
      const tm = s?.trajectoryMetadata || {};
      if (
        tm.rootConversationId === rootCascadeId ||
        tm.parentConversationId === rootCascadeId ||
        (tm.parentConversationId && memberIds.has(tm.parentConversationId))
      ) {
        memberIds.add(id);
        added = true;
      }
    }
  }

  if (memberIds.size === 0) return emptyTree;

  const modelMap = buildModelConfigMap(modelConfigData);
  const clientConfigs = modelConfigData?.clientModelConfigs || [];
  const rawNodes = new Map();

  for (const id of memberIds) {
    const s = summaries[id] || {};
    const tm = s.trajectoryMetadata || {};
    const spec = tm.subagentSpec || {};
    const parentId = tm.parentConversationId || rootCascadeId;
    const createdTime = s.createdTime || '';
    const lastModifiedTime = s.lastModifiedTime || createdTime || '';
    const createdMs = parseTimeMs(createdTime);
    const modMs = parseTimeMs(lastModifiedTime);
    const { statusBadge, isRunning, isError } = classifySubagentStatus(s);
    const endMs = isRunning ? nowMs : (modMs || nowMs);
    const durationSec = createdMs > 0 ? Math.max(0, Math.round((endMs - createdMs) / 1000)) : 0;
    const rawModel = String(spec.model || '').trim();
    const rawTier = String(spec.modelTier || '').trim();

    rawNodes.set(id, {
      cascadeId: id,
      parentConversationId: parentId,
      rootConversationId: tm.rootConversationId || rootCascadeId,
      nestingDepth: Number(tm.nestingDepth) || 0,
      typeName: String(spec.typeName || tm.agentScript?.name || 'subagent').trim(),
      role: String(spec.role || '').trim(),
      title: formatSubagentTitle(s, id),
      inherit: Boolean(
        spec.inherit ||
        /^inherit$/i.test(rawModel) ||
        /INHERIT/i.test(rawTier) ||
        (!rawModel && !rawTier)
      ),
      modelBadge: resolveSubagentModelBadge(spec, modelMap, clientConfigs),
      status: s.status || 'CASCADE_RUN_STATUS_IDLE',
      statusBadge,
      isRunning,
      isError,
      terminationReason: s.latestExecutorTerminationReason || '',
      stepCount: Number(s.stepCount || 0),
      createdTime,
      lastModifiedTime,
      durationSec,
      durationFormatted: formatDurationCompact(createdTime, lastModifiedTime, isRunning, nowMs),
      isActive: id === activeCascadeId,
      spawnStepIndex: null,
      spawnStepRef: '',
      initialPrompt: '',
      promptPreview: '',
      replyStepIndices: [],
      parentContextTokens: 0,
      formattedParentContextTokens: '',
      _createdMs: createdMs,
      _modMs: modMs,
    });
  }

  const sortChronologically = (a, b) => {
    const tA = a._createdMs || a._modMs;
    const tB = b._createdMs || b._modMs;
    if (tA !== tB) return tA - tB;
    return a.cascadeId.localeCompare(b.cascadeId);
  };

  const topLevel = [];
  const childrenByParent = new Map();
  for (const node of rawNodes.values()) {
    const pId = node.parentConversationId;
    if (pId && pId !== node.cascadeId && rawNodes.has(pId)) {
      if (!childrenByParent.has(pId)) childrenByParent.set(pId, []);
      childrenByParent.get(pId).push(node);
    } else {
      topLevel.push(node);
    }
  }

  const hasRunningInSubtree = (node, seen = new Set()) => {
    if (!node || seen.has(node.cascadeId)) return false;
    if (node.isRunning) return true;
    seen.add(node.cascadeId);
    for (const ch of childrenByParent.get(node.cascadeId) || []) {
      if (hasRunningInSubtree(ch, seen)) return true;
    }
    return false;
  };

  // Active L1 subtrees first, then newest-first so recent/active work stays at the top
  const sortTopLevel = (a, b) => {
    const actA = hasRunningInSubtree(a) ? 1 : 0;
    const actB = hasRunningInSubtree(b) ? 1 : 0;
    if (actA !== actB) return actB - actA;
    const tA = a._createdMs || a._modMs;
    const tB = b._createdMs || b._modMs;
    if (tA !== tB) return tB - tA;
    return a.cascadeId.localeCompare(b.cascadeId);
  };

  const sortChildren = (a, b) => {
    const actA = hasRunningInSubtree(a) ? 1 : 0;
    const actB = hasRunningInSubtree(b) ? 1 : 0;
    if (actA !== actB) return actB - actA;
    return sortChronologically(a, b);
  };

  topLevel.sort(sortTopLevel);
  for (const list of childrenByParent.values()) list.sort(sortChildren);

  const ordered = [];
  const visited = new Set();
  const visit = (node, inferredDepth) => {
    if (!node || visited.has(node.cascadeId)) return;
    visited.add(node.cascadeId);
    const resolvedDepth = node.nestingDepth > 0 ? node.nestingDepth : inferredDepth;
    const { _createdMs, _modMs, ...cleanNode } = node;
    cleanNode.nestingDepth = Math.max(1, resolvedDepth);
    ordered.push(cleanNode);
    for (const child of childrenByParent.get(node.cascadeId) || []) {
      visit(child, cleanNode.nestingDepth + 1);
    }
  };

  const inferInitialDepth = (node) =>
    node.parentConversationId && node.parentConversationId !== rootCascadeId ? 2 : 1;

  for (const rootChild of topLevel) visit(rootChild, inferInitialDepth(rootChild));
  for (const node of [...rawNodes.values()].sort(sortTopLevel)) {
    if (!visited.has(node.cascadeId)) visit(node, inferInitialDepth(node));
  }

  const runningItems = ordered.filter((x) => x.isRunning);
  const totalSteps = ordered.reduce((sum, x) => sum + x.stepCount, 0);
  let activeSubagentLabel = '';
  if (runningItems.length === 1) {
    activeSubagentLabel = runningItems[0].title;
  } else if (runningItems.length > 1) {
    activeSubagentLabel = `${runningItems[0].title} (+${runningItems.length - 1} more)`;
  }

  return {
    rootCascadeId,
    totalCount: ordered.length,
    runningCount: runningItems.length,
    totalSteps,
    activeSubagentLabel,
    parentContextTokens: 0,
    formattedParentContextTokens: '',
    items: ordered,
  };
}

function resolveRootId(id, summaries = {}) {
  let curr = id;
  const visited = new Set([curr]);
  for (let hop = 0; hop < 8; hop++) {
    const tm = summaries[curr]?.trajectoryMetadata;
    if (!tm) break;
    const rootCandidate = tm.rootConversationId && tm.rootConversationId !== curr ? tm.rootConversationId : '';
    const parentCandidate = tm.parentConversationId && tm.parentConversationId !== curr ? tm.parentConversationId : '';
    if (rootCandidate && !isSubagentSummary(rootCandidate, summaries[rootCandidate])) {
      return rootCandidate;
    }
    const next = parentCandidate && (summaries[parentCandidate] || !rootCandidate) ? parentCandidate : rootCandidate;
    if (!next || visited.has(next)) break;
    visited.add(next);
    curr = next;
  }
  return curr;
}

function resolveSessionTitle(id, summaries = {}) {
  if (!id) return '';
  const s = summaries[id];
  if (!s) return `Session ${String(id).slice(0, 8)}`;
  if (isSubagentSummary(id, s)) return formatSubagentTitle(s, id);
  return s.annotations?.title || s.summary || `Session ${String(id).slice(0, 8)}`;
}

export function selectActiveTrajectory(trajectoriesResponse = {}, syncOptions = '') {
  const opts =
    typeof syncOptions === 'string'
      ? { requestedCascadeId: syncOptions }
      : syncOptions || {};
  const requestedCascadeId = opts.requestedCascadeId || '';
  const hostCascadeId = opts.hostCascadeId || '';
  const clientWorkspaces = (Array.isArray(opts.workspaceUris) ? opts.workspaceUris : [])
    .map(normalizeWorkspacePath)
    .filter(Boolean);

  const summaries = trajectoriesResponse?.trajectorySummaries || {};
  const entries = Object.entries(summaries);

  const rootSessions = entries
    .filter(([id, s]) => {
      const rootId = s.trajectoryMetadata?.rootConversationId;
      return !isSubagentSummary(id, s) && (Boolean(s.annotations?.lastUserViewTime) || !rootId || rootId === id);
    })
    .map(([id, s]) => {
      const lastUserViewTime = s.annotations?.lastUserViewTime || '';
      const lastUserInputTime = s.lastUserInputTime || '';
      const lastModifiedTime = s.lastModifiedTime || s.createdTime || '';
      return {
        cascadeId: id,
        title: s.annotations?.title || s.summary || `Session ${id.slice(0, 8)}`,
        status: s.status || 'CASCADE_RUN_STATUS_IDLE',
        stepCount: s.stepCount || 0,
        lastUserViewTime,
        lastUserInputTime,
        lastModifiedTime,
        workspaces: extractSessionWorkspaces(s),
        _viewMs: parseTimeMs(lastUserViewTime),
        _inputMs: parseTimeMs(lastUserInputTime),
        _modMs: parseTimeMs(lastModifiedTime),
      };
    })
    .sort((a, b) => {
      const primaryA = a._viewMs || a._modMs;
      const primaryB = b._viewMs || b._modMs;
      if (primaryA !== primaryB) return primaryB - primaryA;
      if (a._inputMs !== b._inputMs) return b._inputMs - a._inputMs;
      if (a._modMs !== b._modMs) return b._modMs - a._modMs;
      return a.cascadeId.localeCompare(b.cascadeId);
    });

  const stripInternal = (s) => {
    if (!s) return null;
    const { _viewMs, _inputMs, _modMs, ...pub } = s;
    return pub;
  };

  // A session that may not be in the trajectory list yet (just created, pinned from an old list, or a subagent)
  const sessionById = (id) => {
    const rootHit = rootSessions.find((s) => s.cascadeId === id);
    if (rootHit) return rootHit;
    const s = summaries[id];
    const isSub = isSubagentSummary(id, s);
    return {
      cascadeId: id,
      title: isSub
        ? formatSubagentTitle(s, id)
        : (s?.annotations?.title || s?.summary || `Session ${id.slice(0, 8)}`),
      status: s?.status || 'CASCADE_RUN_STATUS_IDLE',
      stepCount: s?.stepCount || 0,
      lastUserViewTime: s?.annotations?.lastUserViewTime || '',
      lastUserInputTime: s?.lastUserInputTime || '',
      lastModifiedTime: s?.lastModifiedTime || s?.createdTime || '',
      workspaces: extractSessionWorkspaces(s),
    };
  };

  // Antigravity gives each conversation its own frame and puts that conversation in the frame's
  // ?conversationId=, so the host id is this frame's conversation. Only a frame opened without one
  // guesses below: lastUserViewTime can't tell the previous conversation from the next, since a
  // switch stamps both with the same time.
  const newConversation = !requestedCascadeId && hostCascadeId === NEW_CONVERSATION_ID;
  let active = null;
  if (requestedCascadeId) {
    active = sessionById(requestedCascadeId);
  } else if (isRealConversationId(hostCascadeId)) {
    active = sessionById(hostCascadeId);
  }
  if (newConversation) {
    // A new-conversation pane has nothing to show yet; never fall back to another conversation
  } else if (!active && clientWorkspaces.length > 0) {
    active =
      rootSessions.find((s) =>
        s.workspaces.some((ws) =>
          clientWorkspaces.some(
            (cw) => ws === cw || ws.startsWith(`${cw}/`) || cw.startsWith(`${ws}/`)
          )
        )
      ) || null;
  }
  if (!active && !newConversation) {
    active = rootSessions[0] || null;
  }

  if (!active && !newConversation && entries.length > 0) {
    const [id] = entries[0];
    active = sessionById(id);
  }

  const cleanActive = stripInternal(active);
  const activeId = cleanActive?.cascadeId || '';
  if (cleanActive && isSubagentSummary(activeId, summaries[activeId])) {
    const s = summaries[activeId] || {};
    const tm = s.trajectoryMetadata || {};
    const spec = tm.subagentSpec || {};
    const rootId = resolveRootId(activeId, summaries);
    const parentId = tm.parentConversationId || rootId;
    const explicitDepth = Number(tm.nestingDepth) || 0;
    const inferredDepth = parentId && parentId !== rootId ? 2 : 1;
    cleanActive.isSubagent = true;
    cleanActive.parentConversationId = parentId;
    cleanActive.parentTitle = resolveSessionTitle(parentId, summaries);
    cleanActive.rootConversationId = rootId;
    cleanActive.rootTitle = resolveSessionTitle(rootId, summaries);
    cleanActive.nestingDepth = Math.max(1, explicitDepth || inferredDepth);
    cleanActive.typeName = String(spec.typeName || tm.agentScript?.name || 'subagent').trim();
    cleanActive.role = String(spec.role || '').trim();
  }

  const treeRootId = cleanActive?.rootConversationId || activeId;
  const subagents = collectSubagentTree(
    trajectoriesResponse,
    treeRootId,
    activeId,
    opts.modelConfigData || {},
    opts.nowMs ?? Date.now()
  );

  const isTreeRunning =
    subagents.runningCount > 0 ||
    entries.some(([id, s]) => {
      const rootId = s.trajectoryMetadata?.rootConversationId;
      const parentId = s.trajectoryMetadata?.parentConversationId;
      return (
        (id === treeRootId || rootId === treeRootId || parentId === treeRootId) &&
        s.status === 'CASCADE_RUN_STATUS_RUNNING'
      );
    });

  return {
    activeSession: cleanActive,
    newConversation,
    isExecuting: Boolean(isTreeRunning || cleanActive?.status === 'CASCADE_RUN_STATUS_RUNNING'),
    sessions: rootSessions.slice(0, 15).map(stripInternal),
    subagents,
  };
}
