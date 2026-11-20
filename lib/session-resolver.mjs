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
  STATIC_MODEL_FALLBACKS,
  isCustomApiProvider,
  isCustomModelConfig,
  isCustomModelId,
} from './constants.mjs';
import { isGeminiFamily } from './plan-quota.mjs';
import {
  cleanModelBadgeLabel,
  ensureCatalogFromConfigData,
  extractThinkingEffort,
} from './model-catalog.mjs';

export { cleanModelBadgeLabel, extractThinkingEffort };

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

export function parseContextWindowOptions(rawOptions = []) {
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return [];
  const out = [];
  for (const raw of rawOptions) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').trim();
    const description = String(raw.description || '').trim();
    const expensive = Boolean(raw.expensive);
    const probe = `${name} ${description}`;
    let tokens = 0;
    const unitMatch = probe.match(/(\d+(?:\.\d+)?)\s*([km])\b/i);
    if (unitMatch) {
      const val = Number(unitMatch[1]);
      const unit = unitMatch[2].toLowerCase();
      tokens = Math.round(val * (unit === 'm' ? (val > 1 ? 1_048_576 : 1_000_000) : 1_000));
    } else {
      const numMatch = probe.replace(/,/g, '').match(/\b(\d{4,9})\b/);
      if (numMatch) tokens = Number(numMatch[1]);
    }
    if (!name && !tokens) continue;
    out.push({
      name: name || formatCeilingCount(tokens),
      description,
      expensive,
      tokens,
    });
  }
  return out;
}

export function buildModelConfigMap(modelConfigData = {}) {
  const byEnum = new Map();
  const byId = new Map();
  const catalog = ensureCatalogFromConfigData(modelConfigData);
  if (catalog) {
    for (const [slug, entry] of catalog.byId.entries()) {
      byId.set(slug, entry);
    }
    for (const [enumKey, entry] of catalog.byEnum.entries()) {
      byEnum.set(enumKey, entry);
    }
  }
  for (const c of modelConfigData?.clientModelConfigs || []) {
    const enumKey = c.modelOrAlias?.model;
    const catEntry = (c.modelId && catalog?.byId.get(c.modelId)) || (enumKey && catalog?.byEnum.get(enumKey)) || null;
    const merged = catEntry ? { ...catEntry, ...c, label: c.label || catEntry.label } : c;
    if (enumKey) byEnum.set(enumKey, merged);
    if (c.modelId) byId.set(c.modelId, merged);
  }
  return { byEnum, byId, catalog };
}

function extractSubagentSpecModel(spec = {}) {
  const opt = spec?.modelOption ?? spec?.model_option ?? null;
  let optStr = '';
  let optInherit = false;
  if (typeof opt === 'string') {
    optStr = opt.trim();
  } else if (opt && typeof opt === 'object') {
    optInherit = Boolean(opt.inherit === true || (opt.inherit && typeof opt.inherit === 'object'));
    optStr = String(
      opt.model || opt.namedModel || opt.named_model || opt.namedOption || opt.named_option || ''
    ).trim();
  }
  const rawModel = String(spec?.model || optStr || '').trim();
  const rawTier = String(spec?.modelTier || spec?.model_tier || '').trim();
  const inherit = Boolean(
    spec?.inherit ||
    optInherit ||
    /^inherit$/i.test(rawModel) ||
    /INHERIT/i.test(rawTier) ||
    (!rawModel && !rawTier)
  );
  return { rawModel, rawTier, inherit };
}

export function resolveModelMetadata(modelConfigData = {}, latestGen = null, steps = [], activeSummary = null) {
  const { byEnum, byId } = buildModelConfigMap(modelConfigData);
  const genObj = Array.isArray(latestGen) ? latestGen[latestGen.length - 1] || null : latestGen;

  let stepPlanModel = '';
  for (let i = steps.length - 1; i >= 0; i--) {
    const pm = steps[i]?.userInput?.userConfig?.plannerConfig?.planModel;
    if (pm) {
      stepPlanModel = pm;
      break;
    }
  }

  const { rawModel: subagentModel, inherit: subagentInherit } = extractSubagentSpecModel(
    activeSummary?.trajectoryMetadata?.subagentSpec
  );
  const validSubagentModel = subagentModel && !subagentInherit ? subagentModel : '';

  const genModelEnum =
    stepPlanModel ||
    genObj?.plannerConfig?.planModel ||
    genObj?.chatModel?.model ||
    genObj?.chatModel?.usage?.model ||
    validSubagentModel ||
    modelConfigData?.defaultOverrideModelConfig?.modelOrAlias?.model ||
    '';
  const genModelId = genObj?.plannerConfig?.modelName || validSubagentModel || '';
  const matched = byEnum.get(genModelEnum) || byId.get(genModelId) || byId.get(genModelEnum) || null;
  const staticFallback = STATIC_MODEL_FALLBACKS[genModelEnum] || null;

  const modelId = matched?.modelId || staticFallback?.modelId || genModelId || genModelEnum || 'gemini';
  const fullLabel = matched?.label || staticFallback?.label || cleanModelBadgeLabel('', modelId);
  const badgeLabel = cleanModelBadgeLabel(fullLabel, modelId);
  const thinkingEffort =
    matched?.thinkingEffort ||
    extractThinkingEffort(fullLabel, modelId) ||
    staticFallback?.thinkingEffort ||
    '';
  const apiProvider = genObj?.chatModel?.usage?.apiProvider || matched?.apiProvider || '';
  const isUnlistedByom = Boolean(!genModelEnum && genModelId && byEnum.size > 0 && !matched);
  const isCustom =
    Boolean(matched && isCustomModelConfig(matched)) ||
    isCustomModelId(modelId) ||
    isCustomApiProvider(apiProvider) ||
    isUnlistedByom;
  const isGemini = !isCustom && isGeminiFamily(modelId, apiProvider, fullLabel);

  const liveMax = Number(
    genObj?.chatModel?.chatStartMetadata?.contextWindowMetadata?.maxContextTokens || 0
  );
  const contextWindowOptions = isCustom ? [] : parseContextWindowOptions(matched?.contextWindowOptions);
  const optionTokens = contextWindowOptions.filter((o) => o.tokens > 0);
  const standardOpt = optionTokens.find((o) => !o.expensive) || optionTokens[0] || null;
  const maxOptTokens = optionTokens.reduce((mx, o) => Math.max(mx, o.tokens), 0);

  let fallbackCeiling =
    standardOpt?.tokens ||
    matched?.ceiling ||
    staticFallback?.ceiling ||
    (isGemini ? GEMINI_CONTEXT_CEILING : CLAUDE_CONTEXT_CEILING);
  if (isCustom) fallbackCeiling = DEFAULT_CONTEXT_CEILING;
  const ceiling = liveMax > 0 ? liveMax : fallbackCeiling;
  // A custom model's real window is set in its provider settings, which the LS doesn't report,
  // so claim no window beyond the ceiling Antigravity compacts at.
  let nativeCeiling =
    maxOptTokens ||
    matched?.maxTokens ||
    staticFallback?.nativeCeiling ||
    (isGemini ? GEMINI_NATIVE_CEILING : CLAUDE_CONTEXT_CEILING);
  if (isCustom) nativeCeiling = ceiling;
  else if (nativeCeiling < ceiling) nativeCeiling = ceiling;
  const contextWindowOptionsFormatted = contextWindowOptions
    .map((o) => `${o.name}${o.expensive ? ' (extended)' : ''}`)
    .join(' · ');
  const supportedMedia = formatSupportedMedia(matched?.supportedMimeTypes);
  const maxOutputTokens = Number(genObj?.plannerConfig?.maxOutputTokens || matched?.maxOutputTokens || 65536);

  return {
    modelEnum: genModelEnum || matched?.modelOrAlias?.model || matched?.modelEnum || '',
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
    contextWindowOptions,
    contextWindowOptionsFormatted,
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

export function collectSideQuestionIds(summaries = {}) {
  const ids = new Set();
  for (const [id, s] of Object.entries(summaries || {})) {
    const kind = String(
      s?.trajectoryType ||
      s?.conversationKind ||
      s?.trajectoryMetadata?.trajectoryType ||
      s?.trajectoryMetadata?.conversationKind ||
      ''
    );
    if (/SIDE_QUESTION/i.test(kind)) ids.add(id);
    const linked = s?.annotations?.sideQuestionCascadeIds;
    if (Array.isArray(linked)) {
      for (const sqId of linked) {
        if (sqId) ids.add(String(sqId).trim());
      }
    }
  }
  return ids;
}

const GENERIC_TIER_TOKENS = new Set([
  'model', 'tier', 'gemini', 'claude', 'google', 'anthropic', 'high', 'medium', 'med', 'low', 'minimal', 'xhigh', 'max', 'inherit',
]);

function resolveSubagentModelBadge(spec = {}, modelMap = { byEnum: new Map(), byId: new Map() }, configs = []) {
  const { rawModel, rawTier, inherit } = extractSubagentSpecModel(spec);
  const catalog = modelMap.catalog || null;

  if (rawModel && !inherit) {
    const matched =
      modelMap.byEnum.get(rawModel) ||
      modelMap.byId.get(rawModel) ||
      catalog?.byLabelLower?.get(rawModel.toLowerCase()) ||
      STATIC_MODEL_FALLBACKS[rawModel] ||
      configs.find((c) => String(c?.label || '').toLowerCase() === rawModel.toLowerCase());
    if (matched) return cleanModelBadgeLabel(matched.label, matched.modelId);
    if (/\s/.test(rawModel)) return cleanModelBadgeLabel(rawModel, rawModel);
  }

  const tierProbe = `${rawModel} ${rawTier}`.toLowerCase();
  if (tierProbe.includes('flash_lite') || tierProbe.includes('flash-lite')) {
    const flSlug = catalog?.tieredModelIds?.flashLite?.[0];
    const flEntry = flSlug && modelMap.byId.get(flSlug);
    return flEntry ? cleanModelBadgeLabel(flEntry.label, flEntry.modelId) : 'Flash Lite';
  }
  if (tierProbe.includes('orchestrator')) {
    const tokens = tierProbe.split(/[^a-z0-9]+/).filter((t) => t && t !== 'orchestrator' && !GENERIC_TIER_TOKENS.has(t));
    const variant = tokens[0] || 'carbon';
    const pool = [...configs, ...(catalog ? catalog.byId.values() : [])];
    const orchCfg = pool.find(
      (c) => /orchestrator/i.test(`${c.modelId || ''} ${c.label || ''}`) &&
        new RegExp(variant, 'i').test(`${c.modelId || ''} ${c.label || ''}`)
    );
    if (orchCfg) return cleanModelBadgeLabel(orchCfg.label, orchCfg.modelId);
    return `Orchestrator (${variant[0].toUpperCase()}${variant.slice(1)})`;
  }

  // Match any specific family token (e.g. xenon, helium, neon, carbon, argon, hydrogen, opus, sonnet) dynamically against catalog/configs
  const specificTokens = tierProbe
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length >= 3 && !GENERIC_TIER_TOKENS.has(t) && t !== 'pro' && t !== 'flash');
  if (specificTokens.length > 0) {
    const pool = [...configs, ...(catalog ? catalog.byId.values() : [])];
    for (const tok of specificTokens) {
      const hit = pool.find((c) => {
        const hay = `${c.modelId || ''} ${c.label || ''}`.toLowerCase();
        return hay.includes(tok) && !hay.includes('orchestrator');
      });
      if (hit) return cleanModelBadgeLabel(hit.label, hit.modelId);
    }
  }

  if (tierProbe.includes('flash')) {
    const flashCfg = configs.find((c) => /flash/i.test(`${c.modelId || ''} ${c.label || ''}`));
    if (flashCfg) return cleanModelBadgeLabel(flashCfg.label, flashCfg.modelId);
    const flSlug = catalog?.tieredModelIds?.flash?.[0];
    const flEntry = flSlug && modelMap.byId.get(flSlug);
    return flEntry ? cleanModelBadgeLabel(flEntry.label, flEntry.modelId) : 'Flash';
  }
  if (tierProbe.includes('pro')) {
    const proCfg = configs.find((c) => {
      const hay = `${c.modelId || ''} ${c.label || ''}`;
      return !/flash|lite|orchestrator|claude|opus|sonnet|haiku/i.test(hay) && /gemini|argon|carbon|neon|pro/i.test(hay);
    });
    if (proCfg) return cleanModelBadgeLabel(proCfg.label, proCfg.modelId);
    const defSlug = catalog?.defaultAgentModelId || catalog?.tieredModelIds?.pro?.[0];
    const defEntry = defSlug && modelMap.byId.get(defSlug);
    return defEntry ? cleanModelBadgeLabel(defEntry.label, defEntry.modelId) : 'Pro';
  }

  if (rawModel && !inherit) {
    return cleanModelBadgeLabel('', rawModel);
  }
  return inherit ? 'Inherited' : 'Gemini';
}

function classifySubagentStatus(summary = {}) {
  const swarmBadge = summary?.trajectoryMetadata?.swarmStatusBadge;
  if (swarmBadge) {
    return {
      statusBadge: swarmBadge,
      isRunning: swarmBadge === 'Running',
      isError: swarmBadge === 'Error',
    };
  }
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
  const sideQuestionIds = collectSideQuestionIds(summaries);
  const entries = Object.entries(summaries);
  const memberIds = new Set();

  // Pass 1: direct rootConversationId / parentConversationId match, plus transitive children
  let added = true;
  while (added) {
    added = false;
    for (const [id, s] of entries) {
      if (id === rootCascadeId || memberIds.has(id) || sideQuestionIds.has(id)) continue;
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
    const { inherit: specInherit } = extractSubagentSpecModel(spec);

    const rawInitialPrompt = String(tm.initialPrompt || spec.initialPrompt || '').trim();
    const cleanInit = rawInitialPrompt.replace(/\s+/g, ' ').trim();
    const initPreview = cleanInit.length > 72 ? `${cleanInit.slice(0, 71).trim()}…` : cleanInit;

    rawNodes.set(id, {
      cascadeId: id,
      parentConversationId: parentId,
      rootConversationId: tm.rootConversationId || rootCascadeId,
      nestingDepth: Number(tm.nestingDepth) || 0,
      typeName: String(spec.typeName || tm.agentScript?.name || 'subagent').trim(),
      role: String(spec.role || '').trim(),
      title: formatSubagentTitle(s, id),
      inherit: specInherit,
      modelBadge: resolveSubagentModelBadge(spec, modelMap, clientConfigs),
      swarmThreadTitle: String(tm.swarmThreadTitle || '').trim(),
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
      initialPrompt: rawInitialPrompt,
      promptPreview: initPreview,
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
  const sideQuestionIds = collectSideQuestionIds(summaries);
  const entries = Object.entries(summaries).filter(([id]) => !sideQuestionIds.has(id));

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
