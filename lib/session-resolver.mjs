/**
 * @fileoverview Session synchronization and model metadata resolution.
 */

import {
  GEMINI_CONTEXT_CEILING,
  GEMINI_NATIVE_CEILING,
  CLAUDE_CONTEXT_CEILING,
} from './constants.mjs';
import { isGeminiFamily } from './plan-quota.mjs';

export function formatTokenCount(tokens) {
  const n = Math.max(0, Number(tokens) || 0);
  if (n >= 1_000_000) return `${(n / 1_048_576).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCeilingCount(tokens) {
  const n = Math.max(0, Number(tokens) || 0);
  if (n >= 1_000_000) return `${(n / 1_048_576).toFixed(1)}M`;
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

export function resolveModelMetadata(modelConfigData = {}, latestGen = null, steps = []) {
  const { byEnum, byId } = buildModelConfigMap(modelConfigData);

  let stepPlanModel = '';
  for (let i = steps.length - 1; i >= 0; i--) {
    const pm = steps[i]?.userInput?.userConfig?.plannerConfig?.planModel;
    if (pm) {
      stepPlanModel = pm;
      break;
    }
  }

  const genModelEnum =
    stepPlanModel ||
    latestGen?.plannerConfig?.planModel ||
    latestGen?.chatModel?.model ||
    modelConfigData?.defaultOverrideModelConfig?.modelOrAlias?.model ||
    '';
  const genModelId = latestGen?.plannerConfig?.modelName || '';
  const matched = byEnum.get(genModelEnum) || byId.get(genModelId) || null;

  const modelId = matched?.modelId || genModelId || genModelEnum || 'gemini';
  const fullLabel = matched?.label || cleanModelBadgeLabel('', modelId);
  const badgeLabel = cleanModelBadgeLabel(fullLabel, modelId);
  const thinkingEffort = extractThinkingEffort(fullLabel, modelId);
  const apiProvider = latestGen?.chatModel?.usage?.apiProvider || '';
  const isGemini = isGeminiFamily(modelId, apiProvider, fullLabel);

  const liveMax = Number(
    latestGen?.chatModel?.chatStartMetadata?.contextWindowMetadata?.maxContextTokens || 0
  );
  const fallbackCeiling = isGemini ? GEMINI_CONTEXT_CEILING : CLAUDE_CONTEXT_CEILING;
  const ceiling = liveMax > 0 ? liveMax : fallbackCeiling;
  const nativeCeiling = isGemini ? GEMINI_NATIVE_CEILING : CLAUDE_CONTEXT_CEILING;
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
  if (!uriOrPath || typeof uriOrPath !== 'string') return '';
  let clean = uriOrPath.trim();
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // Keep original if percent-decoding fails
  }
  return clean
    .replace(/^file:\/\/\/?/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
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
      return Boolean(s.annotations?.lastUserViewTime) || !rootId || rootId === id;
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

  let active = null;
  if (requestedCascadeId) {
    active =
      rootSessions.find((s) => s.cascadeId === requestedCascadeId) || {
        cascadeId: requestedCascadeId,
        title:
          summaries[requestedCascadeId]?.annotations?.title ||
          summaries[requestedCascadeId]?.summary ||
          `Session ${requestedCascadeId.slice(0, 8)}`,
        status: summaries[requestedCascadeId]?.status || 'CASCADE_RUN_STATUS_IDLE',
        stepCount: summaries[requestedCascadeId]?.stepCount || 0,
        lastUserViewTime: '',
        lastUserInputTime: '',
        lastModifiedTime: '',
        workspaces: [],
      };
  }
  if (!active && hostCascadeId) {
    active = rootSessions.find((s) => s.cascadeId === hostCascadeId) || null;
  }
  if (!active && clientWorkspaces.length > 0) {
    active =
      rootSessions.find((s) =>
        s.workspaces.some((ws) =>
          clientWorkspaces.some(
            (cw) => ws === cw || ws.startsWith(`${cw}/`) || cw.startsWith(`${ws}/`)
          )
        )
      ) || null;
  }
  if (!active) {
    active = rootSessions[0] || null;
  }

  if (!active && entries.length > 0) {
    const [id, s] = entries[0];
    active = {
      cascadeId: id,
      title: s.summary || `Session ${id.slice(0, 8)}`,
      status: s.status || 'CASCADE_RUN_STATUS_IDLE',
      stepCount: s.stepCount || 0,
      lastUserViewTime: '',
      lastUserInputTime: s.lastUserInputTime || '',
      lastModifiedTime: s.lastModifiedTime || '',
      workspaces: extractSessionWorkspaces(s),
    };
  }

  const cleanActive = stripInternal(active);
  const activeId = cleanActive?.cascadeId || '';
  const isTreeRunning = entries.some(([id, s]) => {
    const rootId = s.trajectoryMetadata?.rootConversationId;
    return (id === activeId || rootId === activeId) && s.status === 'CASCADE_RUN_STATUS_RUNNING';
  });

  return {
    activeSession: cleanActive,
    isExecuting: Boolean(isTreeRunning || cleanActive?.status === 'CASCADE_RUN_STATUS_RUNNING'),
    sessions: rootSessions.slice(0, 15).map(stripInternal),
  };
}
