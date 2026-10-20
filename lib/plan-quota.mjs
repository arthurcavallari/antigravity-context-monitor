/**
 * @fileoverview Official plan allowance, AI credits & reset cycle telemetry parser.
 */

import { callLsRpc } from 'antigravity-sidecar-kit/rpc';
import { DEFAULT_CONFIG_PATH, readJsonFile, writeJsonFile } from './constants.mjs';

export function readUserConfigFile(configPath = DEFAULT_CONFIG_PATH) {
  return readJsonFile(configPath);
}

export function readAiCreditsOverageSetting(
  fallbackVal = false,
  configOrPath = DEFAULT_CONFIG_PATH
) {
  const cfg =
    configOrPath && typeof configOrPath === 'object'
      ? configOrPath
      : readUserConfigFile(configOrPath);
  if (typeof cfg?.userSettings?.useAiCredits === 'boolean') {
    return cfg.userSettings.useAiCredits;
  }
  return Boolean(fallbackVal);
}

export async function setAiCreditsOverageSetting(enabled, options = {}) {
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;
  const nextVal = Boolean(enabled);
  const cfg = readJsonFile(configPath, { strict: true });
  cfg.userSettings = {
    ...(cfg.userSettings || {}),
    useAiCredits: nextVal,
  };

  writeJsonFile(configPath, cfg);

  try {
    await callLsRpc('JetboxWriteState', { userConfig: cfg }, options);
  } catch {
    // Config file is already persisted on disk if RPC is unavailable in tests
  }

  return { useAiCredits: nextVal };
}

export function formatResetCountdown(resetTimeIso, windowType = '5h', nowMs = Date.now()) {
  if (!resetTimeIso) return '—';
  const targetMs = Date.parse(resetTimeIso);
  if (Number.isNaN(targetMs)) return '—';

  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return 'now';

  const totalMinutes = Math.max(1, Math.floor(diffMs / 60_000));
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  const remMinutes = totalMinutes % 60;

  if (windowType === 'weekly' || days >= 1) {
    if (days > 0) return `${days}d ${remHours}h`;
    return `${remHours}h ${remMinutes}m`;
  }

  if (totalHours > 0) return `${totalHours}h ${remMinutes}m`;
  return `${remMinutes}m`;
}

export function isGeminiFamily(modelId = '', apiProvider = '', label = '') {
  const combined = `${modelId} ${apiProvider} ${label}`.toLowerCase();
  if (combined.includes('claude') || combined.includes('anthropic') || combined.includes('gpt')) {
    return false;
  }
  return true;
}

function normalizeBucket(bucket, fallbackWindow, nowMs) {
  if (!bucket) {
    return {
      window: fallbackWindow,
      remainingPct: 100,
      remainingFraction: 1,
      disabled: false,
      resetTime: null,
      resetLabel: '—',
      statusText: '100%',
    };
  }

  const rawFraction =
    typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : 0;
  const clamped = Math.max(0, Math.min(1, rawFraction));
  const remainingPct = Math.round(clamped * 100);
  const windowType = bucket.window || fallbackWindow;
  const resetLabel = formatResetCountdown(bucket.resetTime, windowType, nowMs);
  const disabled = Boolean(bucket.disabled);

  const statusText =
    resetLabel !== '—'
      ? `${remainingPct}% · resets ${resetLabel}`
      : `${remainingPct}%`;

  return {
    bucketId: bucket.bucketId || '',
    displayName: bucket.displayName || '',
    description: bucket.description || '',
    window: windowType,
    remainingPct,
    remainingFraction: clamped,
    disabled,
    resetTime: bucket.resetTime || null,
    resetLabel,
    statusText,
  };
}

export function extractAiCreditsTelemetry(userStatus = {}, generatorMetadataList = [], options = {}) {
  const us = userStatus?.userStatus || userStatus || {};
  const tier = us.userTier || {};
  const availList = Array.isArray(tier.availableCredits) ? tier.availableCredits : [];
  const g1Credit =
    availList.find((c) => c.creditType === 'GOOGLE_ONE_AI') || availList[0] || null;

  const available = g1Credit ? Number(g1Credit.creditAmount || 0) : null;
  const minForUsage = g1Credit ? Number(g1Credit.minimumCreditAmountForUsage || 0) : 0;

  let sessionUsed = 0;
  let lastTurnUsed = 0;
  for (let i = 0; i < generatorMetadataList.length; i++) {
    const consumed = generatorMetadataList[i]?.chatModel?.consumedCredits || [];
    let turnSum = 0;
    for (const c of consumed) {
      turnSum += Number(c.creditAmount || 0);
    }
    sessionUsed += turnSum;
    if (turnSum > 0) lastTurnUsed = turnSum;
  }

  const latestGen = generatorMetadataList[generatorMetadataList.length - 1];
  const fallbackOverage = latestGen?.plannerConfig?.useAiCredits ?? false;
  const useAiCredits = readAiCreditsOverageSetting(
    fallbackOverage,
    options.userConfig || options.configPath
  );

  return {
    tierName: tier.name || us?.planStatus?.planInfo?.planName || 'Pro',
    available,
    formattedAvailable: available !== null ? available.toLocaleString('en-US') : '—',
    minForUsage,
    useAiCredits,
    sessionUsed,
    formattedSessionUsed: sessionUsed.toLocaleString('en-US'),
    lastTurnUsed,
    promptCredits: us?.planStatus?.availablePromptCredits ?? us.availablePromptCredits ?? null,
    flowCredits: us?.planStatus?.availableFlowCredits ?? us.availableFlowCredits ?? null,
  };
}

export function extractPlanUsage(
  quotaSummaryResponse,
  modelInfo = {},
  userStatus = {},
  nowMs = Date.now(),
  generatorMetadataList = [],
  options = {}
) {
  const groups = quotaSummaryResponse?.response?.groups || quotaSummaryResponse?.groups || [];
  const wantGemini = isGeminiFamily(modelInfo.modelId, modelInfo.apiProvider, modelInfo.label);
  const aiCredits = extractAiCreditsTelemetry(userStatus, generatorMetadataList, options);

  const parsedGroups = groups.map((group) => {
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    const fiveHourRaw = buckets.find((b) => b.window === '5h' || String(b.bucketId).endsWith('-5h'));
    const weeklyRaw = buckets.find((b) => b.window === 'weekly' || String(b.bucketId).endsWith('-weekly'));

    const weekly = normalizeBucket(weeklyRaw, 'weekly', nowMs);
    let fiveHour = normalizeBucket(fiveHourRaw, '5h', nowMs);

    if (fiveHour.disabled && weekly.remainingPct === 0) {
      fiveHour = {
        ...fiveHour,
        effectivePct: 0,
        statusText: aiCredits.useAiCredits
          ? `Using AI Credits · resets ${weekly.resetLabel}`
          : `Paused · weekly resets ${weekly.resetLabel}`,
      };
    } else {
      fiveHour = {
        ...fiveHour,
        effectivePct: fiveHour.remainingPct,
      };
    }

    const isGeminiGroup = String(group.displayName || '').toLowerCase().includes('gemini');
    return {
      id: isGeminiGroup ? 'gemini' : 'claude_gpt',
      displayName: group.displayName || (isGeminiGroup ? 'Gemini Models' : 'Claude & GPT Models'),
      description: group.description || '',
      fiveHour,
      weekly,
    };
  });

  const targetId = wantGemini ? 'gemini' : 'claude_gpt';
  const activeGroup =
    parsedGroups.find((g) => g.id === targetId) ||
    parsedGroups[0] || {
      id: targetId,
      displayName: wantGemini ? 'Gemini Models' : 'Claude & GPT Models',
      fiveHour: normalizeBucket(null, '5h', nowMs),
      weekly: normalizeBucket(null, 'weekly', nowMs),
    };

  return {
    activeGroupId: activeGroup.id,
    groupName: activeGroup.displayName,
    fiveHour: activeGroup.fiveHour,
    weekly: activeGroup.weekly,
    groups: parsedGroups,
    aiCredits,
  };
}
