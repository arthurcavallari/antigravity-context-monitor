/**
 * @fileoverview Per-turn performance (TTFT, TPS, thinking ratio, retries, cache hit %)
 * and customization token budgets.
 */

import { formatTokenCount, formatPct } from './session-resolver.mjs';
import {
  countInvocationRetries,
  analyzeModelAndEffortFit,
  measureInvocationThinking,
} from './effort-advisor.mjs';
import {
  formatPromptSectionLabel,
  describeChatStep,
  extractCompactionHistory,
  extractTopCulprits,
} from './context-inspector.mjs';

export { formatPromptSectionLabel, describeChatStep, extractCompactionHistory };

export function parseDurationSeconds(durationStr) {
  if (!durationStr || typeof durationStr !== 'string') return 0;
  const match = durationStr.trim().match(/^([0-9.]+)s$/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  return Number.isFinite(val) ? val : 0;
}

function splitOutputTokens(item, steps) {
  const u = item?.chatModel?.usage || {};
  const out = Number(u.outputTokens || 0);
  const { tokens: think, estimated } = measureInvocationThinking(item, steps);
  // Claude reports responseOutputTokens == outputTokens, so estimated turns derive it
  const resp = estimated ? Math.max(0, out - think) : Number(u.responseOutputTokens ?? Math.max(0, out - think));
  return { out, think, resp, estimated };
}

export function extractTurnPerformanceAndBudgets(
  generatorMetadataList = [],
  userStatus = {},
  steps = [],
  modelConfigData = null
) {
  let latestWithUsage = null;
  let latestWithBreakdown = null;
  let sessionRetries = 0;
  let sessionInputTokens = 0;
  let sessionCacheReadTokens = 0;
  let sessionOutputTokens = 0;
  let sessionThinkingTokens = 0;
  let sessionResponseTokens = 0;
  let sessionThinkingEstimated = false;

  for (let i = 0; i < generatorMetadataList.length; i++) {
    const item = generatorMetadataList[i];
    sessionRetries += countInvocationRetries(item?.chatModel).total;
    const u = item?.chatModel?.usage;
    if (u) {
      sessionInputTokens += Number(u.inputTokens || 0);
      sessionCacheReadTokens += Number(u.cacheReadTokens || 0);
      const { out, think, resp, estimated } = splitOutputTokens(item, steps);
      sessionOutputTokens += out;
      sessionThinkingTokens += think;
      sessionResponseTokens += resp;
      if (estimated) sessionThinkingEstimated = true;
    }
  }

  for (let i = generatorMetadataList.length - 1; i >= 0; i--) {
    const item = generatorMetadataList[i];
    const u = item?.chatModel?.usage;
    if (!latestWithUsage && u && (u.inputTokens || u.cacheReadTokens || u.outputTokens)) {
      latestWithUsage = item;
    }
    const groups = item?.chatModel?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups;
    if (!latestWithBreakdown && Array.isArray(groups) && groups.length > 0) {
      latestWithBreakdown = item;
    }
    if (latestWithUsage && latestWithBreakdown) break;
  }

  const latestItem = generatorMetadataList[generatorMetadataList.length - 1] || null;
  const cm = latestWithUsage?.chatModel || {};
  const usage = cm.usage || {};
  const ttftSec = parseDurationSeconds(cm.timeToFirstToken);
  const streamSec = parseDurationSeconds(cm.streamingDuration);
  const turnInput = Number(usage.inputTokens || 0);
  const turnCache = Number(usage.cacheReadTokens || 0);
  const turnPromptTotal = turnInput + turnCache;
  const sessionPromptTotal = sessionInputTokens + sessionCacheReadTokens;
  const turnCacheHitPct = turnPromptTotal > 0 ? Math.round((turnCache / turnPromptTotal) * 100) : 0;
  const sessionCacheHitPct =
    sessionPromptTotal > 0 ? Math.round((sessionCacheReadTokens / sessionPromptTotal) * 100) : 0;

  const {
    out: outputTokens,
    think: thinkingTokens,
    resp: responseTokens,
    estimated: thinkingEstimated,
  } = splitOutputTokens(latestWithUsage, steps);
  const tokensPerSec = streamSec > 0 ? Math.round(outputTokens / streamSec) : 0;
  const thinkingRatioPct = outputTokens > 0 ? Math.round((thinkingTokens / outputTokens) * 100) : 0;
  const lastTurnRetries = countInvocationRetries(cm).total;

  const groups =
    latestWithBreakdown?.chatModel?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups || [];
  const { skillsUsedTokens, rulesUsedTokens, culprits } = extractTopCulprits(groups, steps);

  const plannerCfg = latestItem?.plannerConfig || {};
  const skillsBudget = Number(plannerCfg.customizationTokenBudget || 20000);
  const rulesBudget = Number(plannerCfg.rulesTokenBudget || 20000);
  const us = userStatus?.userStatus || userStatus || {};
  const maxChatInputTokens = Number(us?.planStatus?.planInfo?.maxNumChatInputTokens || 16384);

  return {
    performance: {
      ttftSec: Number(ttftSec.toFixed(2)),
      ttftFormatted: ttftSec > 0 ? `${ttftSec.toFixed(1)}s` : '—',
      streamSec: Number(streamSec.toFixed(2)),
      tokensPerSec,
      tpsFormatted: tokensPerSec > 0 ? `${tokensPerSec} tok/s` : '—',
      outputTokens,
      thinkingTokens,
      thinkingEstimated,
      responseTokens,
      formattedThinking: formatTokenCount(thinkingTokens),
      formattedResponse: formatTokenCount(responseTokens),
      thinkingRatioPct,
      sessionOutputTokens,
      sessionThinkingTokens,
      sessionResponseTokens,
      sessionThinkingEstimated,
      formattedSessionThinking: formatTokenCount(sessionThinkingTokens),
      formattedSessionResponse: formatTokenCount(sessionResponseTokens),
      sessionThinkingRatioPct:
        sessionOutputTokens > 0 ? Math.round((sessionThinkingTokens / sessionOutputTokens) * 100) : 0,
      turnCacheHitPct,
      sessionCacheHitPct,
      lastTurnRetries,
      sessionRetries,
    },
    compaction: extractCompactionHistory(generatorMetadataList, steps),
    effortAdvisor: analyzeModelAndEffortFit(
      generatorMetadataList,
      steps,
      modelConfigData || us?.cascadeModelConfigData
    ),
    culprits,
    budgets: {
      skills: {
        used: skillsUsedTokens,
        formattedUsed: formatTokenCount(skillsUsedTokens),
        limit: skillsBudget,
        formattedLimit: formatTokenCount(skillsBudget),
        pct: skillsBudget > 0 ? Math.min(100, (skillsUsedTokens / skillsBudget) * 100) : 0,
        formattedPct: formatPct(skillsUsedTokens, skillsBudget),
      },
      rules: {
        used: rulesUsedTokens,
        formattedUsed: formatTokenCount(rulesUsedTokens),
        limit: rulesBudget,
        formattedLimit: formatTokenCount(rulesBudget),
        pct: rulesBudget > 0 ? Math.min(100, (rulesUsedTokens / rulesBudget) * 100) : 0,
        formattedPct: formatPct(rulesUsedTokens, rulesBudget),
      },
      maxChatInputTokens,
      formattedMaxChatInput: formatTokenCount(maxChatInputTokens),
    },
  };
}
