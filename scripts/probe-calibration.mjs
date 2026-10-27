#!/usr/bin/env node
/**
 * @fileoverview Read-only calibration probe across all Language Server trajectories.
 *
 *   node scripts/probe-calibration.mjs
 *
 * Scans trajectories via GetAllCascadeTrajectories, computes visible char-to-token ratios
 * (with toolCalls[].thinkingSignature stripped), and prints per-(modelId, effort) thinking
 * token, TTFT, and recommendation distributions.
 */

import { callLsRpc } from 'antigravity-sidecar-kit/rpc';
import {
  analyzeModelAndEffortFit,
  buildModelLookup,
  extractInvocationCharMetrics,
  groupIntoUserTurns,
  measureInvocationThinking,
  resolveInvocationModel,
  toNonNegInt,
} from '../lib/effort-advisor.mjs';
import { parseDurationSeconds } from '../lib/turn-insights.mjs';

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[idx];
}

function summarizeDistribution(values = []) {
  if (values.length === 0) return { count: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p10: Number(quantile(sorted, 0.1).toFixed(2)),
    p25: Number(quantile(sorted, 0.25).toFixed(2)),
    p50: Number(quantile(sorted, 0.5).toFixed(2)),
    p75: Number(quantile(sorted, 0.75).toFixed(2)),
    p90: Number(quantile(sorted, 0.9).toFixed(2)),
  };
}

const RPC_TIMEOUT_MS = 30_000;
const MAX_PAGES = 64;

async function fetchAllPages(method, listField, offsetField, cascadeId, target = 0) {
  const items = [];
  let lastFirst = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = items.length;
    const body = offset > 0 ? { cascadeId, [offsetField]: offset } : { cascadeId };
    const res = await callLsRpc(method, body, { timeoutMs: RPC_TIMEOUT_MS }).catch(() => null);
    const got = res?.[listField] || [];
    const first = got.length > 0 ? JSON.stringify(got[0]) : null;
    if (got.length === 0 || first === lastFirst) break;
    lastFirst = first;
    for (const item of got) items.push(item);
    if (target > 0 && items.length >= target) break;
  }
  return items;
}

const [trajectoriesRes, modelConfigRes, userStatusRes] = await Promise.all([
  callLsRpc('GetAllCascadeTrajectories', {}, { timeoutMs: RPC_TIMEOUT_MS }),
  callLsRpc('GetCascadeModelConfigData', {}, { timeoutMs: RPC_TIMEOUT_MS }).catch(() => ({})),
  callLsRpc('GetUserStatus', {}, { timeoutMs: RPC_TIMEOUT_MS }).catch(() => ({})),
]);

const effectiveModelConfig = modelConfigRes?.clientModelConfigs?.length
  ? modelConfigRes
  : userStatusRes?.userStatus?.cascadeModelConfigData || {};
const lookup = buildModelLookup(effectiveModelConfig);
const summaries = trajectoriesRes?.trajectorySummaries || {};
const cascadeIds = Object.keys(summaries);

const charToTokenSamples = { gemini: [], claudeNoThink: [] };
const modelBuckets = new Map();

for (const cascadeId of cascadeIds) {
  const stepTarget = Number(summaries[cascadeId]?.stepCount) || 0;
  const [generators, steps] = await Promise.all([
    fetchAllPages('GetCascadeTrajectoryGeneratorMetadata', 'generatorMetadata', 'generatorMetadataOffset', cascadeId, 0),
    fetchAllPages('GetCascadeTrajectorySteps', 'steps', 'stepOffset', cascadeId, stepTarget),
  ]);
  if (generators.length === 0) continue;

  const fit = analyzeModelAndEffortFit(generators, steps, effectiveModelConfig);
  const rawTurns = groupIntoUserTurns(generators, steps);
  let lastKnownEnum = '';

  for (const turn of rawTurns) {
    const firstGen = turn.invocations[0];
    const stepPm = steps[turn.startStepIdx]?.userInput?.userConfig?.plannerConfig?.planModel;
    const enumCandidate = stepPm || firstGen?.plannerConfig?.planModel || firstGen?.chatModel?.model;
    if (enumCandidate) lastKnownEnum = enumCandidate;
    const modelInfo = resolveInvocationModel(firstGen, lookup, lastKnownEnum);
    const key = `${modelInfo.modelId} (${modelInfo.effort})`;

    if (!modelBuckets.has(key)) {
      modelBuckets.set(key, {
        invocations: 0,
        thinkTokens: [],
        respTokens: [],
        ttftSec: [],
        thinkDurSec: [],
        turnStatuses: {},
      });
    }
    const bucket = modelBuckets.get(key);

    for (const g of turn.invocations) {
      const u = g?.chatModel?.usage || {};
      const indices = Array.isArray(g?.stepIndices) ? g.stepIndices : [];
      const responses = indices.map((idx) => steps[idx]?.plannerResponse).filter(Boolean);
      const charMetrics = extractInvocationCharMetrics(responses);
      const measured = measureInvocationThinking(g, steps);
      const out = toNonNegInt(u.outputTokens);
      const respTok = measured.estimated
        ? Math.max(0, out - measured.tokens)
        : toNonNegInt(u.responseOutputTokens ?? Math.max(0, out - measured.tokens));
      const ttftSec = parseDurationSeconds(g?.chatModel?.timeToFirstToken);

      bucket.invocations++;
      bucket.thinkTokens.push(measured.tokens);
      bucket.respTokens.push(respTok);
      if (ttftSec > 0) bucket.ttftSec.push(ttftSec);
      if (charMetrics.thinkingDurationSec > 0) bucket.thinkDurSec.push(charMetrics.thinkingDurationSec);

      if (u.apiProvider === 'API_PROVIDER_ANTHROPIC_VERTEX') {
        if (!charMetrics.hasThinkingBlock && out >= 20 && charMetrics.visibleChars > 0) {
          charToTokenSamples.claudeNoThink.push(charMetrics.visibleChars / out);
        }
      } else if (respTok >= 20 && charMetrics.visibleChars > 0) {
        charToTokenSamples.gemini.push(charMetrics.visibleChars / respTok);
      }
    }
  }

  for (const t of fit.evaluatedTurns || []) {
    const key = `${t.modelId || t.modelLabel} (${t.effort})`;
    const bucket = modelBuckets.get(key);
    if (bucket) {
      bucket.turnStatuses[t.status] = (bucket.turnStatuses[t.status] || 0) + 1;
    }
  }
}

const report = {
  trajectoriesScanned: cascadeIds.length,
  visibleCharsPerToken: {
    claudeNonThinking: summarizeDistribution(charToTokenSamples.claudeNoThink),
    geminiExactResponse: summarizeDistribution(charToTokenSamples.gemini),
  },
  models: Object.fromEntries(
    [...modelBuckets.entries()].map(([key, b]) => [
      key,
      {
        invocations: b.invocations,
        thinkingTokens: summarizeDistribution(b.thinkTokens),
        responseTokens: summarizeDistribution(b.respTokens),
        ttftSec: summarizeDistribution(b.ttftSec),
        thinkingDurationSec: summarizeDistribution(b.thinkDurSec),
        turnStatuses: b.turnStatuses,
      },
    ])
  ),
};

console.log(JSON.stringify(report, null, 2));
