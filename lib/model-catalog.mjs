/**
 * @fileoverview Dynamic model catalog for Context Monitor.
 * Normalizes `GetAvailableModels` and `GetCascadeModelConfigData` into a compact,
 * additive disk-backed catalog (`model-catalog-cache.json`) with structural
 * flagship/fast auto-classification, dynamic checkpointer ceilings, and
 * cooldown-guarded reactive cache-miss refresh for mid-session model rollouts.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isCustomApiProvider,
  isCustomModelConfig,
  isCustomModelId,
  readJsonFile,
  writeJsonAtomic,
} from './constants.mjs';

export const MODEL_CATALOG_FILENAME = 'model-catalog-cache.json';
export const UNKNOWN_MODEL_REFRESH_COOLDOWN_MS = 60_000;
const MIN_CATALOG_AGE_FOR_REACTIVE_REFRESH_MS = 1_000;
const MAX_COOLDOWN_KEYS = 256;

export const CANONICAL_THINKING_EFFORTS = Object.freeze({
  minimal: 'Minimal',
  low: 'Low',
  med: 'Medium',
  medium: 'Medium',
  high: 'High',
  extra_high: 'XHigh',
  xhigh: 'XHigh',
  max: 'Max',
});

export const EFFORT_RANK = Object.freeze({
  Minimal: 1,
  Low: 2,
  Medium: 3,
  High: 4,
  XHigh: 5,
  Max: 6,
});

const SUFFIX_EFFORT_RE = /\s*\((Max|XHigh|High|Medium|Med|Low|Minimal)\)\s*$/i;
const SLUG_EFFORT_RE = /-(max|xhigh|high|medium|med|low|minimal)$/i;

export function extractExplicitEffort(rawLabel = '', modelId = '') {
  const labelMatch = String(rawLabel || '').match(SUFFIX_EFFORT_RE);
  if (labelMatch) {
    return CANONICAL_THINKING_EFFORTS[labelMatch[1].toLowerCase()] || '';
  }
  const idMatch = String(modelId || '').match(SLUG_EFFORT_RE);
  if (idMatch) {
    return CANONICAL_THINKING_EFFORTS[idMatch[1].toLowerCase()] || '';
  }
  return '';
}

export function extractThinkingEffort(rawLabel = '', modelId = '') {
  const explicit = extractExplicitEffort(rawLabel, modelId);
  if (explicit) return explicit;
  if (!isCustomModelId(modelId) && /\borchestrator\b/i.test(`${rawLabel} ${modelId}`)) {
    return 'High';
  }
  return '';
}

export function mapThinkingLevel(level, rawLabel = '', modelId = '') {
  const explicit = extractExplicitEffort(rawLabel, modelId);
  if (explicit === 'Max') return 'Max';
  if (typeof level === 'number') {
    if (level === 1) return 'Low';
    if (level === 2) return 'Medium';
    if (level === 3) return 'High';
    if (level === 4) return 'Minimal';
    if (level === 5 || level >= 100) return 'XHigh';
    return '';
  }
  if (typeof level === 'string' && level.trim()) {
    const key = level.trim().toLowerCase().replace(/^thinking_level_/, '');
    if (Object.prototype.hasOwnProperty.call(CANONICAL_THINKING_EFFORTS, key)) {
      return CANONICAL_THINKING_EFFORTS[key];
    }
  }
  return '';
}

export function cleanModelBadgeLabel(rawLabel = '', modelId = '') {
  if (rawLabel) return String(rawLabel).trim();
  if (!modelId) return 'Gemini';
  const effort = extractExplicitEffort('', modelId);
  const base =
    String(modelId)
      .replace(SLUG_EFFORT_RE, '')
      .replace(/^MODEL_PLACEHOLDER_/i, 'Model ')
      .split(/[-_]/)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
      .join(' ')
      .trim() || 'Gemini';
  return effort ? `${base} (${effort})` : base;
}

export function stripModelSuffixAndVendor(raw = '') {
  return String(raw || '')
    .replace(SUFFIX_EFFORT_RE, '')
    .replace(/^(Gemini|Claude)\s+/i, '')
    .trim();
}

export function stripModelFamilySlug(modelId = '') {
  return String(modelId || '')
    .trim()
    .toLowerCase()
    .replace(/-tiered(?:-[a-z0-9._-]+)?$/i, '')
    .replace(SLUG_EFFORT_RE, '');
}

function extractVersionNumber(slugOrLabel = '') {
  const m = String(slugOrLabel || '').match(/(?:gemini|claude[\s-]+[a-z]+)[\s-]+(\d+(?:[.-]\d+)?)/i);
  if (!m) return 0;
  const n = Number(m[1].replace('-', '.'));
  return Number.isFinite(n) ? n : 0;
}

function parseCheckpointerLimit(rawModel) {
  const ckptStr = rawModel?.modelExperiments?.experiments?.CASCADE_USE_EXPERIMENT_CHECKPOINTER?.stringValue;
  if (typeof ckptStr !== 'string' || !ckptStr) return 0;
  try {
    const parsed = JSON.parse(ckptStr);
    const n = Number(parsed?.max_token_limit);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  } catch {
    return 0;
  }
}

function compactSupportedMimeTypes(m) {
  const raw = m?.supportedMimeTypes;
  const keys = raw && typeof raw === 'object' ? Object.keys(raw).filter((k) => Boolean(raw[k])) : [];
  const out = {};
  if (m?.supportsVideo || keys.some((k) => k.startsWith('video/'))) out['video/mp4'] = true;
  if (keys.some((k) => k.startsWith('audio/'))) out['audio/wav'] = true;
  if (m?.supportsPdf || keys.includes('application/pdf')) out['application/pdf'] = true;
  if (m?.supportsImages || keys.some((k) => k.startsWith('image/'))) out['image/png'] = true;
  if (keys.length > 0 && Object.keys(out).length === 0) out['text/plain'] = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

function isStructuralFastName(slug = '', label = '', hasExplicitTiered = false) {
  const probe = `${slug} ${label}`;
  if (/\b(?:flash|lite|haiku|mini|nano)\b|-worker-/i.test(probe)) return true;
  // Fallback when GetAvailableModels.tieredModelIds is absent in synthetic clientModelConfigs tests
  if (!hasExplicitTiered && /\bhydrogen\b/i.test(probe)) return true;
  return false;
}

function extractOrderedSortIds(agentModelSorts = [], clientModelSorts = [], clientConfigs = []) {
  const out = [];
  const seen = new Set();
  const push = (id) => {
    const s = String(id || '').trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  for (const sort of Array.isArray(agentModelSorts) ? agentModelSorts : []) {
    for (const grp of Array.isArray(sort?.groups) ? sort.groups : []) {
      for (const id of Array.isArray(grp?.modelIds) ? grp.modelIds : []) push(id);
    }
  }
  if (out.length === 0 && Array.isArray(clientModelSorts) && Array.isArray(clientConfigs)) {
    const byLabel = new Map();
    for (const c of clientConfigs) {
      if (c?.label && c?.modelId) byLabel.set(String(c.label).trim(), String(c.modelId).trim());
    }
    for (const sort of clientModelSorts) {
      for (const grp of Array.isArray(sort?.groups) ? sort.groups : []) {
        for (const lbl of Array.isArray(grp?.modelLabels) ? grp.modelLabels : []) {
          const mapped = byLabel.get(String(lbl || '').trim());
          if (mapped) push(mapped);
        }
      }
    }
  }
  return out;
}

export function hydrateCatalogFromSnapshot(snapshot = {}) {
  const modelsBySlug = snapshot?.modelsBySlug && typeof snapshot.modelsBySlug === 'object' ? snapshot.modelsBySlug : {};
  const tiered = snapshot?.tieredModelIds && typeof snapshot.tieredModelIds === 'object' ? snapshot.tieredModelIds : {};
  const defaultAgentModelId = String(snapshot?.defaultAgentModelId || '').trim();
  const sortIds = Array.isArray(snapshot?.orderedModelIds) ? snapshot.orderedModelIds : [];
  const hasAuthoritativeOrder = Boolean(defaultAgentModelId || sortIds.length > 0);

  const fastFamilySlugs = new Set();
  for (const tierKey of ['flashLite', 'flash']) {
    for (const id of Array.isArray(tiered[tierKey]) ? tiered[tierKey] : []) {
      const fam = stripModelFamilySlug(id);
      if (fam) fastFamilySlugs.add(fam);
    }
  }
  const hasExplicitTiered = fastFamilySlugs.size > 0;

  const anthropicOrderedFamilies = [];
  for (const id of [...sortIds, ...Object.keys(modelsBySlug)]) {
    const entry = modelsBySlug[id];
    if (!entry || entry.retired) continue;
    const isAnth =
      entry.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' ||
      String(entry.apiProvider || '').includes('ANTHROPIC') ||
      /^claude-/i.test(id);
    if (!isAnth) continue;
    const fam = stripModelFamilySlug(id);
    if (fam && !anthropicOrderedFamilies.includes(fam)) {
      anthropicOrderedFamilies.push(fam);
    }
  }
  const anthropicFastSlugs = new Set(
    anthropicOrderedFamilies.length > 1
      ? anthropicOrderedFamilies.slice(1)
      : anthropicOrderedFamilies.filter((f) => /\b(?:sonnet|haiku)\b/i.test(f))
  );

  const byId = new Map();
  const byEnum = new Map();
  const byLabelLower = new Map();
  const sortSet = new Set(sortIds);

  for (const [slug, raw] of Object.entries(modelsBySlug)) {
    if (!raw || typeof raw !== 'object') continue;
    if (isCustomModelId(slug) || isCustomApiProvider(raw.apiProvider)) continue;
    const famSlug = stripModelFamilySlug(slug);
    const isClaude =
      raw.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' ||
      String(raw.apiProvider || '').includes('ANTHROPIC') ||
      /\b(?:claude|opus|sonnet|haiku)\b/i.test(`${slug} ${raw.label || ''}`);
    const isOpenAi =
      raw.modelProvider === 'MODEL_PROVIDER_OPENAI' ||
      String(raw.apiProvider || '').includes('OPENAI') ||
      /^gpt-/i.test(slug);
    const isGemini =
      !isClaude &&
      !isOpenAi &&
      (raw.modelProvider === 'MODEL_PROVIDER_GOOGLE' ||
        String(raw.apiProvider || '').includes('GEMINI') ||
        /^gemini-/i.test(slug));
    const isFast = isClaude
      ? anthropicFastSlugs.has(famSlug) || isStructuralFastName(slug, raw.label, hasExplicitTiered)
      : fastFamilySlugs.has(famSlug) || isStructuralFastName(slug, raw.label, hasExplicitTiered);
    const isFlagship = (isGemini || isClaude) && !isFast;
    const entry = {
      ...raw,
      modelId: slug,
      familySlug: famSlug,
      shortFamily: stripModelSuffixAndVendor(raw.label || cleanModelBadgeLabel('', slug)),
      versionNum: extractVersionNumber(`${slug} ${raw.label || ''}`),
      isClaude,
      isGemini,
      isOpenAi,
      isFast,
      isFlagship,
    };
    byId.set(slug, entry);
    if (entry.label) {
      const lk = entry.label.toLowerCase();
      if (!byLabelLower.has(lk) || sortSet.has(slug)) byLabelLower.set(lk, entry);
    }
    if (entry.modelEnum) {
      const existing = byEnum.get(entry.modelEnum);
      const preferNew =
        !existing ||
        (existing.retired && !entry.retired) ||
        (!sortSet.has(existing.modelId) && sortSet.has(slug)) ||
        (!existing.hasExplicitDisplayName && entry.hasExplicitDisplayName);
      if (preferNew) byEnum.set(entry.modelEnum, entry);
    }
  }

  const families = {
    geminiFlagship: '4 Argon',
    geminiFast: '3.8 Flash',
    claudeFlagship: 'Opus 5.5',
    claudeFast: 'Sonnet 5.5',
    geminiTopEffort: 'High',
    claudeTopEffort: 'High',
  };

  let pickedGeminiFlagshipSlug = '';
  let pickedGeminiFlagshipVer = -1;
  let pickedGeminiFastVer = -1;
  let pickedGeminiFast = false;
  let pickedClaudeFlagshipSlug = '';
  let pickedClaudeFast = false;

  const candidateOrder = [
    ...(defaultAgentModelId ? [defaultAgentModelId] : []),
    ...sortIds,
    ...byId.keys(),
  ];

  for (const id of candidateOrder) {
    const e = byId.get(id);
    if (!e || e.retired || !e.shortFamily) continue;
    const isOrch = /\borchestrator\b/i.test(`${e.modelId} ${e.label}`);
    if (e.isGemini) {
      if (e.isFlagship && !isOrch) {
        if (!pickedGeminiFlagshipSlug || (!hasAuthoritativeOrder && e.versionNum > pickedGeminiFlagshipVer)) {
          families.geminiFlagship = e.shortFamily;
          pickedGeminiFlagshipSlug = e.familySlug;
          pickedGeminiFlagshipVer = e.versionNum;
        }
      } else if (e.isFast && !/\blite\b|-worker-|sonar/i.test(`${e.modelId} ${e.label}`)) {
        if (!pickedGeminiFast || (!hasAuthoritativeOrder && e.versionNum > pickedGeminiFastVer)) {
          families.geminiFast = e.shortFamily;
          pickedGeminiFast = true;
          pickedGeminiFastVer = e.versionNum;
        }
      }
      if (
        e.familySlug === pickedGeminiFlagshipSlug &&
        (EFFORT_RANK[e.thinkingEffort] || 0) > (EFFORT_RANK[families.geminiTopEffort] || 0)
      ) {
        families.geminiTopEffort = e.thinkingEffort;
      }
    } else if (e.isClaude) {
      if (e.isFlagship && !pickedClaudeFlagshipSlug) {
        families.claudeFlagship = e.shortFamily;
        pickedClaudeFlagshipSlug = e.familySlug;
      } else if (e.isFast && !pickedClaudeFast) {
        families.claudeFast = e.shortFamily;
        pickedClaudeFast = true;
      }
      if (
        e.familySlug === pickedClaudeFlagshipSlug &&
        (EFFORT_RANK[e.thinkingEffort] || 0) > (EFFORT_RANK[families.claudeTopEffort] || 0)
      ) {
        families.claudeTopEffort = e.thinkingEffort;
      }
    }
  }

  return {
    snapshot,
    byId,
    byEnum,
    byLabelLower,
    fastFamilySlugs,
    tieredModelIds: tiered,
    defaultAgentModelId,
    orderedModelIds: sortIds,
    families,
  };
}

export function parseAvailableModelsCatalog(availRes = {}, modelConfigData = {}, nowIso = new Date().toISOString()) {
  const resp = availRes?.response || availRes || {};
  const rawModels = resp?.models && typeof resp.models === 'object' ? resp.models : {};
  const clientConfigs = Array.isArray(modelConfigData?.clientModelConfigs) ? modelConfigData.clientModelConfigs : [];
  const orderedModelIds = extractOrderedSortIds(resp?.agentModelSorts, modelConfigData?.clientModelSorts, clientConfigs);
  const modelsBySlug = {};
  const enumsToSlug = {};

  for (const [slug, m] of Object.entries(rawModels)) {
    if (!m || typeof m !== 'object' || isCustomModelId(slug) || isCustomApiProvider(m.apiProvider)) continue;
    const hasExplicitDisplayName = typeof m.displayName === 'string' && m.displayName.trim().length > 0;
    const label = hasExplicitDisplayName ? m.displayName.trim() : cleanModelBadgeLabel('', slug);
    const thinkingEffort =
      mapThinkingLevel(m.thinkingLevel, label, slug) || extractThinkingEffort(label, slug);
    const supportedMimeTypes = compactSupportedMimeTypes(m);
    const modelEnum = typeof m.model === 'string' ? m.model.trim() : '';
    modelsBySlug[slug] = {
      modelId: slug,
      modelEnum,
      label,
      hasExplicitDisplayName,
      modelProvider: typeof m.modelProvider === 'string' ? m.modelProvider : '',
      apiProvider: typeof m.apiProvider === 'string' ? m.apiProvider : '',
      thinkingLevel: typeof m.thinkingLevel === 'number' ? m.thinkingLevel : 0,
      thinkingEffort,
      maxTokens: Number(m.maxTokens) || 0,
      maxOutputTokens: Number(m.maxOutputTokens) || 0,
      ceiling: parseCheckpointerLimit(m),
      recommended: Boolean(m.recommended),
      ...(supportedMimeTypes && Object.keys(supportedMimeTypes).length > 0 ? { supportedMimeTypes } : {}),
      lastSeenAt: nowIso,
    };
    if (modelEnum && (!enumsToSlug[modelEnum] || orderedModelIds.includes(slug))) {
      enumsToSlug[modelEnum] = slug;
    }
  }

  for (const c of clientConfigs) {
    if (!c || typeof c !== 'object' || isCustomModelConfig(c)) continue;
    const slug = typeof c.modelId === 'string' ? c.modelId.trim() : '';
    const modelEnum = typeof c.modelOrAlias?.model === 'string' ? c.modelOrAlias.model.trim() : '';
    if (!slug || !modelEnum) continue;
    const existing = modelsBySlug[slug];
    const label =
      typeof c.label === 'string' && c.label.trim()
        ? c.label.trim()
        : existing?.label || cleanModelBadgeLabel('', slug);
    const clientMime = compactSupportedMimeTypes(c);
    modelsBySlug[slug] = {
      modelId: slug,
      modelEnum,
      label,
      hasExplicitDisplayName: Boolean(c.label) || Boolean(existing?.hasExplicitDisplayName),
      modelProvider: existing?.modelProvider || '',
      apiProvider: existing?.apiProvider || '',
      thinkingLevel: existing?.thinkingLevel || 0,
      thinkingEffort: existing?.thinkingEffort || extractThinkingEffort(label, slug),
      maxTokens: existing?.maxTokens || 0,
      maxOutputTokens: existing?.maxOutputTokens || 0,
      ceiling: existing?.ceiling || 0,
      recommended: existing?.recommended ?? true,
      ...(clientMime || existing?.supportedMimeTypes
        ? { supportedMimeTypes: existing?.supportedMimeTypes || clientMime }
        : {}),
      lastSeenAt: nowIso,
    };
    if (!enumsToSlug[modelEnum]) enumsToSlug[modelEnum] = slug;
  }

  const defaultOverrideEnum = modelConfigData?.defaultOverrideModelConfig?.modelOrAlias?.model || '';
  const defaultAgentModelId =
    (typeof resp.defaultAgentModelId === 'string' && resp.defaultAgentModelId.trim()) ||
    (defaultOverrideEnum && enumsToSlug[defaultOverrideEnum]) ||
    '';

  const snapshot = {
    version: 1,
    updatedAt: nowIso,
    defaultAgentModelId,
    tieredModelIds: resp.tieredModelIds && typeof resp.tieredModelIds === 'object' ? resp.tieredModelIds : {},
    orderedModelIds,
    modelsBySlug,
    enumsToSlug,
  };
  return hydrateCatalogFromSnapshot(snapshot);
}

export function mergeModelCatalogSnapshots(prevSnap = null, nextSnap = null) {
  if (!prevSnap || typeof prevSnap !== 'object' || !prevSnap.modelsBySlug) return nextSnap;
  if (!nextSnap || typeof nextSnap !== 'object' || !nextSnap.modelsBySlug) return prevSnap;
  const nextSlugs = Object.keys(nextSnap.modelsBySlug);
  if (nextSlugs.length === 0) return prevSnap;

  const isAuthoritativeNext = Boolean(nextSnap.defaultAgentModelId || nextSnap.orderedModelIds?.length);
  const mergedModels = {};
  for (const [slug, prevEntry] of Object.entries(prevSnap.modelsBySlug)) {
    if (!Object.prototype.hasOwnProperty.call(nextSnap.modelsBySlug, slug)) {
      mergedModels[slug] = isAuthoritativeNext ? { ...prevEntry, retired: true } : { ...prevEntry };
    }
  }
  for (const [slug, nextEntry] of Object.entries(nextSnap.modelsBySlug)) {
    const prevEntry = prevSnap.modelsBySlug[slug];
    mergedModels[slug] = {
      ...(prevEntry || {}),
      ...nextEntry,
      ceiling: nextEntry.ceiling || prevEntry?.ceiling || 0,
      maxTokens: nextEntry.maxTokens || prevEntry?.maxTokens || 0,
      maxOutputTokens: nextEntry.maxOutputTokens || prevEntry?.maxOutputTokens || 0,
      modelProvider: nextEntry.modelProvider || prevEntry?.modelProvider || '',
      apiProvider: nextEntry.apiProvider || prevEntry?.apiProvider || '',
      thinkingEffort: nextEntry.thinkingEffort || prevEntry?.thinkingEffort || '',
      retired: false,
    };
  }
  const mergedEnums = { ...(prevSnap.enumsToSlug || {}), ...(nextSnap.enumsToSlug || {}) };
  return {
    version: 1,
    updatedAt: nextSnap.updatedAt || prevSnap.updatedAt || new Date().toISOString(),
    defaultAgentModelId: nextSnap.defaultAgentModelId || prevSnap.defaultAgentModelId || '',
    tieredModelIds:
      nextSnap.tieredModelIds && Object.keys(nextSnap.tieredModelIds).length > 0
        ? nextSnap.tieredModelIds
        : prevSnap.tieredModelIds || {},
    orderedModelIds:
      nextSnap.orderedModelIds?.length > 0 ? nextSnap.orderedModelIds : prevSnap.orderedModelIds || [],
    modelsBySlug: mergedModels,
    enumsToSlug: mergedEnums,
  };
}

function computeSnapshotFingerprint(snap) {
  if (!snap?.modelsBySlug) return '';
  const { updatedAt: _u, ...stable } = snap;
  const cleanModels = {};
  for (const k of Object.keys(stable.modelsBySlug).sort()) {
    const { lastSeenAt: _l, ...rest } = stable.modelsBySlug[k];
    cleanModels[k] = rest;
  }
  return JSON.stringify({ ...stable, modelsBySlug: cleanModels });
}

export function defaultModelCatalogPath(env = process.env) {
  const pluginData = env?.PLUGIN_DATA?.trim();
  if (pluginData) return join(pluginData, MODEL_CATALOG_FILENAME);
  return join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'context-monitor', 'data', MODEL_CATALOG_FILENAME);
}

export function resolveModelCatalogPath(options = {}) {
  if (options.modelCatalogPath === false) return '';
  if (typeof options.modelCatalogPath === 'string' && options.modelCatalogPath.trim()) {
    return options.modelCatalogPath.trim();
  }
  // Keep injected-mock unit tests hermetic unless they explicitly opt into a temp modelCatalogPath
  if (typeof options.fetchFn === 'function' || typeof options.rpcFn === 'function') {
    return '';
  }
  return defaultModelCatalogPath(options.env || process.env);
}

const memorySnapshotsByKey = new Map();
const diskFingerprintsByPath = new Map();
const lastLiveCatalogFetchMsByLs = new Map();
const unknownModelRefreshCooldowns = new Map();
const inFlightReactiveRefreshByLs = new Map();

export function clearModelCatalogState() {
  memorySnapshotsByKey.clear();
  diskFingerprintsByPath.clear();
  lastLiveCatalogFetchMsByLs.clear();
  unknownModelRefreshCooldowns.clear();
  inFlightReactiveRefreshByLs.clear();
}

export function recordLiveCatalogFetch(lsAddress, nowMs = Date.now()) {
  if (lsAddress) lastLiveCatalogFetchMsByLs.set(lsAddress, nowMs);
}

export function getLastLiveCatalogFetchMs(lsAddress) {
  return (lsAddress && lastLiveCatalogFetchMsByLs.get(lsAddress)) || 0;
}

export function loadPersistedCatalog(options = {}) {
  const path = resolveModelCatalogPath(options);
  if (!path) return null;
  if (memorySnapshotsByKey.has(path)) {
    return hydrateCatalogFromSnapshot(memorySnapshotsByKey.get(path));
  }
  const disk = readJsonFile(path);
  if (disk && typeof disk === 'object' && disk.modelsBySlug) {
    memorySnapshotsByKey.set(path, disk);
    diskFingerprintsByPath.set(path, computeSnapshotFingerprint(disk));
    return hydrateCatalogFromSnapshot(disk);
  }
  return null;
}

export function syncModelCatalog(availRes, modelConfigData, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const path = resolveModelCatalogPath(options);
  const storeKey = path || `mem:${options.lsAddress || 'default'}`;

  let prevSnap = memorySnapshotsByKey.get(storeKey) || null;
  if (!prevSnap && path) {
    const disk = readJsonFile(path);
    if (disk && typeof disk === 'object' && disk.modelsBySlug) {
      prevSnap = disk;
      diskFingerprintsByPath.set(path, computeSnapshotFingerprint(disk));
    }
  }

  const parsed = parseAvailableModelsCatalog(availRes, modelConfigData, nowIso);
  const mergedSnap = mergeModelCatalogSnapshots(prevSnap, parsed.snapshot);
  if (mergedSnap && Object.keys(mergedSnap.modelsBySlug || {}).length > 0) {
    memorySnapshotsByKey.set(storeKey, mergedSnap);
    if (path) {
      const nextFp = computeSnapshotFingerprint(mergedSnap);
      if (nextFp !== diskFingerprintsByPath.get(path)) {
        try {
          writeJsonAtomic(path, mergedSnap);
          diskFingerprintsByPath.set(path, nextFp);
        } catch {
          // Best-effort cache persistence
        }
      }
    }
    return hydrateCatalogFromSnapshot(mergedSnap);
  }
  return prevSnap ? hydrateCatalogFromSnapshot(prevSnap) : parsed;
}

export function attachModelCatalog(modelConfigData, modelCatalog) {
  const base = modelConfigData && typeof modelConfigData === 'object' ? { ...modelConfigData } : {};
  if (modelCatalog) {
    Object.defineProperty(base, 'modelCatalog', {
      value: modelCatalog,
      enumerable: false,
      configurable: true,
    });
  }
  return base;
}

export function ensureCatalogFromConfigData(modelConfigData = {}) {
  if (modelConfigData?.modelCatalog) return modelConfigData.modelCatalog;
  if (modelConfigData?.response?.models || modelConfigData?.models) {
    return parseAvailableModelsCatalog(modelConfigData, {});
  }
  if (Array.isArray(modelConfigData?.clientModelConfigs) && modelConfigData.clientModelConfigs.length > 0) {
    return parseAvailableModelsCatalog({}, modelConfigData);
  }
  return null;
}

export function collectReferencedModelKeys(steps = [], generatorMetadataList = [], activeSummary = null, subagents = null) {
  const keys = new Set();
  const add = (k, provider = '') => {
    const clean = String(k || '').trim();
    if (!clean || /^inherit$/i.test(clean) || clean === 'gemini') return;
    if (isCustomModelId(clean) || isCustomApiProvider(provider)) return;
    keys.add(clean);
  };
  for (let i = Math.max(0, steps.length - 10); i < steps.length; i++) {
    add(steps[i]?.userInput?.userConfig?.plannerConfig?.planModel);
  }
  for (let i = Math.max(0, generatorMetadataList.length - 6); i < generatorMetadataList.length; i++) {
    const g = generatorMetadataList[i];
    const apiProv = g?.chatModel?.usage?.apiProvider || '';
    add(g?.plannerConfig?.planModel, apiProv);
    add(g?.plannerConfig?.modelName, apiProv);
    add(g?.chatModel?.model, apiProv);
    add(g?.chatModel?.usage?.model, apiProv);
  }
  const activeSpec = activeSummary?.trajectoryMetadata?.subagentSpec;
  if (activeSpec?.model) add(activeSpec.model);
  for (const item of subagents?.items || []) {
    if (item?.rawModel) add(item.rawModel);
  }
  return [...keys];
}

export async function maybeRefreshCatalogOnMiss({
  lsAddress = 'default',
  catalog,
  referencedKeys = [],
  nowMs = Date.now(),
  refreshFn,
}) {
  if (!catalog || typeof refreshFn !== 'function' || referencedKeys.length === 0) return null;
  const lastFetchMs = getLastLiveCatalogFetchMs(lsAddress);
  // Skip if GetAvailableModels just ran live within the last second on this exact poll
  if (lastFetchMs > 0 && nowMs - lastFetchMs < MIN_CATALOG_AGE_FOR_REACTIVE_REFRESH_MS) {
    return null;
  }

  const missingEligible = [];
  for (const key of referencedKeys) {
    const hit =
      catalog.byEnum.has(key) ||
      catalog.byId.has(key) ||
      catalog.byLabelLower.has(key.toLowerCase());
    if (hit) continue;
    const cdKey = `${lsAddress}|${key}`;
    const lastTry = unknownModelRefreshCooldowns.get(cdKey) || 0;
    if (lastTry > 0 && nowMs - lastTry < UNKNOWN_MODEL_REFRESH_COOLDOWN_MS) continue;
    missingEligible.push(cdKey);
  }
  if (missingEligible.length === 0) return null;

  for (const cdKey of missingEligible) {
    if (unknownModelRefreshCooldowns.size >= MAX_COOLDOWN_KEYS) {
      unknownModelRefreshCooldowns.delete(unknownModelRefreshCooldowns.keys().next().value);
    }
    unknownModelRefreshCooldowns.set(cdKey, nowMs);
  }

  if (inFlightReactiveRefreshByLs.has(lsAddress)) {
    return inFlightReactiveRefreshByLs.get(lsAddress);
  }
  const p = Promise.resolve()
    .then(() => refreshFn())
    .finally(() => {
      if (inFlightReactiveRefreshByLs.get(lsAddress) === p) {
        inFlightReactiveRefreshByLs.delete(lsAddress);
      }
    });
  inFlightReactiveRefreshByLs.set(lsAddress, p);
  return p;
}
