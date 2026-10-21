/**
 * @fileoverview Model & Thinking Effort Fit Advisor for per-turn trajectory telemetry.
 */

import { formatTokenCount, cleanModelBadgeLabel, extractThinkingEffort, buildModelConfigMap } from './session-resolver.mjs';
import { parseDurationSeconds } from './turn-insights.mjs';

const READ_LOOP_STEP_TYPES = new Set([
  'CORTEX_STEP_TYPE_VIEW_FILE', 'CORTEX_STEP_TYPE_GREP_SEARCH', 'CORTEX_STEP_TYPE_FIND_BY_NAME',
  'CORTEX_STEP_TYPE_LIST_DIR', 'CORTEX_STEP_TYPE_READ_URL_CONTENT', 'CORTEX_STEP_TYPE_SEARCH_WEB',
  'CORTEX_STEP_TYPE_COMMAND_STATUS',
]);

const EDIT_STEP_TYPES = new Set([
  'CORTEX_STEP_TYPE_CODE_ACTION', 'CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT',
  'CORTEX_STEP_TYPE_MULTI_REPLACE_FILE_CONTENT', 'CORTEX_STEP_TYPE_WRITE_TO_FILE',
]);

// Calibrated on Claude turns without a thinking block, where outputTokens covers only
// plannerResponse.response plus the stored toolCalls JSON (median chars per token)
const OUTPUT_CHARS_PER_TOKEN = 1.82;

/**
 * Thinking tokens for one invocation. Exact from thinkingOutputTokens (the LS omits zero-valued
 * fields, so absent means 0) for every provider except Anthropic Vertex, which never reports it:
 * there it is zero without a thinking block, or estimated as outputTokens minus visible output.
 */
export function measureInvocationThinking(gen, steps = []) {
  const u = gen?.chatModel?.usage || {};
  if (u.thinkingOutputTokens != null || u.apiProvider !== 'API_PROVIDER_ANTHROPIC_VERTEX') {
    return { tokens: Number(u.thinkingOutputTokens) || 0, estimated: false, known: true };
  }
  const indices = Array.isArray(gen?.stepIndices) ? gen.stepIndices : [];
  const responses = indices.map((idx) => steps[idx]?.plannerResponse).filter(Boolean);
  if (responses.length === 0) return { tokens: 0, estimated: false, known: false };
  if (!responses.some((pr) => pr.thinking || pr.thinkingSignature)) {
    return { tokens: 0, estimated: false, known: true };
  }
  const visibleChars = responses.reduce(
    (sum, pr) => sum + String(pr.response || '').length + JSON.stringify(pr.toolCalls || []).length,
    0
  );
  const out = Number(u.outputTokens || 0);
  return {
    tokens: Math.max(0, Math.round(out - visibleChars / OUTPUT_CHARS_PER_TOKEN)),
    estimated: true,
    known: true,
  };
}

export function countInvocationRetries(chatModel = {}) {
  const retryInfos = Array.isArray(chatModel?.retryInfos) ? chatModel.retryInfos : null;
  if (!retryInfos) {
    const legacy = Number(chatModel?.retries || 0);
    return { total: legacy, apiRetries: legacy, modelCorrectable: 0 };
  }
  let apiRetries = 0;
  let modelCorrectable = 0;
  for (const r of retryInfos) {
    if (!r || (!r.error && !r.retryReason)) continue;
    if (r.retryReason === 'RETRY_REASON_MODEL_CORRECTABLE') modelCorrectable++;
    else apiRetries++;
  }
  const explicitTotal = apiRetries + modelCorrectable;
  const fallbackExtra = Math.max(0, retryInfos.length - 1);
  return {
    total: Math.max(explicitTotal, fallbackExtra),
    apiRetries: explicitTotal >= fallbackExtra ? apiRetries : fallbackExtra - modelCorrectable,
    modelCorrectable,
  };
}

function stripModelSuffixAndVendor(raw = '') {
  return String(raw || '').replace(/\s*\((High|Medium|Low)\)\s*$/i, '').replace(/^(Gemini|Claude)\s+/i, '').trim();
}

function shortenModelName(label = '', effort = 'Low') {
  const shortBase = stripModelSuffixAndVendor(label);
  return `${shortBase || label} (${effort === 'Medium' ? 'Med' : effort})`;
}

function buildModelLookup(modelConfigData = {}) {
  const { byEnum, byId } = buildModelConfigMap(modelConfigData);
  const families = { geminiFlagship: '4 Argon', geminiFast: '3.8 Flash', claudeFlagship: 'Opus 5.5', claudeFast: 'Sonnet 5.5' };

  for (const c of modelConfigData?.clientModelConfigs || []) {
    const base = stripModelSuffixAndVendor(c.label);
    const low = `${c.modelId || ''} ${c.label || ''}`.toLowerCase();
    if (low.includes('argon') || (low.includes('gemini') && low.includes('pro'))) {
      families.geminiFlagship = base || families.geminiFlagship;
    } else if (low.includes('flash')) {
      families.geminiFast = base || families.geminiFast;
    } else if (low.includes('opus')) {
      families.claudeFlagship = base || families.claudeFlagship;
    } else if (low.includes('sonnet')) {
      families.claudeFast = base || families.claudeFast;
    }
  }
  return { byEnum, byId, families };
}

function resolveInvocationModel(gen, lookup, fallbackEnum = '') {
  const enumId =
    fallbackEnum || gen?.plannerConfig?.planModel || gen?.chatModel?.model || gen?.chatModel?.usage?.model || '';
  const modelName = gen?.plannerConfig?.modelName || '';
  const matched = lookup.byEnum.get(enumId) || lookup.byId.get(modelName) || null;
  const modelId = matched?.modelId || modelName || enumId || 'gemini';
  const rawLabel = matched?.label || '';
  const label = cleanModelBadgeLabel(rawLabel, modelId);
  const effort = extractThinkingEffort(rawLabel, modelId) || 'Low';
  const lower = `${modelId} ${label}`.toLowerCase();
  const isClaude = lower.includes('claude') || lower.includes('opus') || lower.includes('sonnet');
  const isFlagship = lower.includes('argon') || lower.includes('opus') || lower.includes('pro');

  let defaultFamily = lookup.families.geminiFast;
  if (isClaude) defaultFamily = isFlagship ? lookup.families.claudeFlagship : lookup.families.claudeFast;
  else if (isFlagship) defaultFamily = lookup.families.geminiFlagship;

  return {
    modelId, label, shortLabel: shortenModelName(label, effort),
    baseFamily: stripModelSuffixAndVendor(label) || defaultFamily,
    effort, isFlagship, isClaude,
  };
}

function recommendTargetModel(modelInfo, lookup, status, editCount) {
  const { isClaude, isFlagship, effort, baseFamily, shortLabel } = modelInfo;
  const fastFam = isClaude ? lookup.families.claudeFast : lookup.families.geminiFast;
  const flagFam = isClaude ? lookup.families.claudeFlagship : lookup.families.geminiFlagship;
  if (status === 'optimal') return shortLabel;
  if (status === 'housekeeping') return `${fastFam} (Low)`;
  if (status === 'unused_effort') return editCount === 0 && isFlagship ? `${fastFam} (Low)` : `${baseFamily} (Low)`;
  if (status === 'loop_tax') return effort === 'High' ? `${baseFamily} (Med)` : `${baseFamily} (Low)`;
  if (status === 'thrashing') {
    if (!isFlagship) return effort === 'Low' ? `${flagFam} (Med)` : `${flagFam} (High)`;
    return `${flagFam} (High)`;
  }
  return shortLabel;
}

function extractPromptSnippet(step = {}) {
  const itemsText = Array.isArray(step?.userInput?.items)
    ? step.userInput.items.map((x) => x?.text || '').join(' ')
    : '';
  const clean = String(step?.userInput?.userResponse || itemsText || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Prompt';
  return clean.length > 34 ? `${clean.slice(0, 33).trim()}…` : clean;
}

function groupIntoUserTurns(generatorMetadataList = [], steps = []) {
  const userIndices = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]?.type === 'CORTEX_STEP_TYPE_USER_INPUT') userIndices.push(i);
  }
  if (userIndices.length === 0 || !generatorMetadataList.some((g) => Array.isArray(g?.stepIndices))) {
    return generatorMetadataList.length > 0
      ? [{ turnNumber: 1, startStepIdx: 0, endStepIdx: steps.length, invocations: generatorMetadataList }]
      : [];
  }
  const turns = [];
  for (let t = 0; t < userIndices.length; t++) {
    const startStepIdx = userIndices[t];
    const endStepIdx = t + 1 < userIndices.length ? userIndices[t + 1] : steps.length;
    const invocations = generatorMetadataList.filter((g) => {
      const firstIdx = g?.stepIndices?.[0];
      return typeof firstIdx === 'number' && firstIdx >= startStepIdx && firstIdx < endStepIdx;
    });
    if (invocations.length > 0) {
      turns.push({ turnNumber: turns.length + 1, startStepIdx, endStepIdx, invocations });
    }
  }
  return turns;
}

function classifySingleTurn(turn, steps, lookup, lastKnownEnum) {
  const { turnNumber, startStepIdx, endStepIdx, invocations } = turn;
  const userStep = steps[startStepIdx];
  const stepPlanModel = userStep?.userInput?.userConfig?.plannerConfig?.planModel || lastKnownEnum;
  const modelInfo = resolveInvocationModel(invocations[0], lookup, stepPlanModel);
  const promptPreview = extractPromptSnippet(userStep);

  const tally = {
    planThink: 0, loopThink: 0, editThink: 0,
    planTtft: 0, loopTtft: 0, editTtft: 0,
    loopCount: 0, editCount: 0, cmdCount: 0, failedCmds: 0,
    peakThink: 0, totalResp: 0, modelCorrectableRetries: 0, thinkKnown: false, thinkEstimated: false,
    editAfterFailedCmd: false, sawFailedCmdAfterEdit: false, sawEdit: false,
  };

  for (let i = 0; i < invocations.length; i++) {
    const g = invocations[i];
    const u = g?.chatModel?.usage || {};
    const out = Number(u.outputTokens || 0);
    const measured = measureInvocationThinking(g, steps);
    const think = measured.tokens;
    // Claude reports responseOutputTokens == outputTokens, so estimated turns derive it
    const resp = measured.estimated
      ? Math.max(0, out - think)
      : Number(u.responseOutputTokens ?? Math.max(0, out - think));
    const ttft = parseDurationSeconds(g?.chatModel?.timeToFirstToken);
    if (think > tally.peakThink) tally.peakThink = think;
    if (measured.known) tally.thinkKnown = true;
    if (measured.estimated) tally.thinkEstimated = true;
    tally.totalResp += resp;
    tally.modelCorrectableRetries += countInvocationRetries(g?.chatModel).modelCorrectable;

    const indices = Array.isArray(g?.stepIndices) ? g.stepIndices : [];
    const stepObjs = indices.map((idx) => steps[idx]).filter(Boolean);
    const hasEdit = stepObjs.some((s) => EDIT_STEP_TYPES.has(s.type));
    const hasCmd = stepObjs.some((s) => s.type === 'CORTEX_STEP_TYPE_RUN_COMMAND');
    const hasFailedCmd = stepObjs.some(
      (s) => s.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' &&
        (s.status === 'CORTEX_STEP_STATUS_ERROR' || Number(s.runCommand?.exitCode || 0) !== 0)
    );
    const isReadOnly =
      stepObjs.length > 0 && !hasEdit &&
      stepObjs.every(
        (s) => s.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' ||
          READ_LOOP_STEP_TYPES.has(s.type) ||
          (s.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' && !hasFailedCmd)
      );

    if (hasEdit) {
      tally.editCount++;
      if (tally.sawFailedCmdAfterEdit) tally.editAfterFailedCmd = true;
      tally.sawEdit = true;
    }
    if (hasCmd) tally.cmdCount++;
    if (hasFailedCmd) {
      tally.failedCmds++;
      if (tally.sawEdit) tally.sawFailedCmdAfterEdit = true;
    }

    if (i === 0) {
      tally.planThink += think;
      tally.planTtft += ttft;
    } else if (hasEdit || i === invocations.length - 1 || !isReadOnly) {
      tally.editThink += think;
      tally.editTtft += ttft;
    } else {
      tally.loopThink += think;
      tally.loopTtft += ttft;
      tally.loopCount++;
    }
  }

  const totalThink = tally.planThink + tally.loopThink + tally.editThink;
  const totalTtft = tally.planTtft + tally.loopTtft + tally.editTtft;
  const loopSharePct = totalThink > 0 ? Math.round((tally.loopThink / totalThink) * 100) : 0;
  const avgLoopTtft = tally.loopCount > 0 ? tally.loopTtft / tally.loopCount : 0;
  const isHigh = modelInfo.effort === 'High';
  const isMed = modelInfo.effort === 'Medium';

  let status = 'optimal';
  let badge = 'Good fit';
  let savableThink = 0;
  let savableTtft = 0;
  const approx = tally.thinkEstimated ? '~' : '';
  let reason = `Used ${approx}${formatTokenCount(totalThink)} thinking tokens across ${invocations.length} step${invocations.length === 1 ? '' : 's'}`;

  if (tally.modelCorrectableRetries > 0 || (tally.editAfterFailedCmd && !isHigh)) {
    status = 'thrashing';
    badge = 'Upgrade tier';
    reason = tally.modelCorrectableRetries > 0
      ? `Hit ${tally.modelCorrectableRetries} tool/edit retry error(s) on ${modelInfo.effort} effort`
      : `Edited code → test command failed → had to re-edit to fix it`;
  } else if (
    // Without any measurable invocation, missing thinking would read as 0
    tally.thinkKnown &&
    ((isHigh && tally.peakThink < 240) || (isMed && tally.peakThink < 75 && invocations.length <= 2))
  ) {
    status = 'unused_effort';
    badge = 'Lower effort';
    reason = `Only needed ${approx}${tally.peakThink} thinking tokens across ${invocations.length} step${invocations.length === 1 ? '' : 's'}`;
    savableTtft = Math.max(0, totalTtft - invocations.length * 1.5);
  } else if ((isHigh || isMed) && invocations.length >= 3 && tally.loopCount >= 2 && loopSharePct >= 65 && avgLoopTtft >= 3.5) {
    status = 'loop_tax';
    badge = 'Lower effort';
    reason = `Spent ${loopSharePct}% of thinking (${approx}${formatTokenCount(tally.loopThink)} tokens) on ${tally.loopCount} routine file/cmd steps`;
    savableThink = Math.round(tally.loopThink * 0.7);
    savableTtft = Math.max(0, tally.loopTtft - tally.loopCount * 1.5);
  } else if (
    modelInfo.isFlagship && invocations.length <= 3 && tally.editCount <= 1 &&
    totalThink < 350 && tally.totalResp < 450 && (tally.cmdCount > 0 || tally.editCount === 1) && tally.failedCmds === 0
  ) {
    status = 'housekeeping';
    badge = 'Lighter model';
    reason = `Routine ${tally.editCount ? '1-file edit' : 'command'} turn that only needed ${approx}${formatTokenCount(totalThink)} thinking tokens`;
    savableTtft = Math.max(0, totalTtft - invocations.length * 1.2);
  }

  return {
    turnNumber, startStepIdx, endStepIdx, invocationsCount: invocations.length,
    promptPreview, modelLabel: modelInfo.label, shortModelLabel: modelInfo.shortLabel,
    recommendedModel: recommendTargetModel(modelInfo, lookup, status, tally.editCount),
    effort: modelInfo.effort, status, badge, reason, savableThink, thinkEstimated: tally.thinkEstimated,
    savableTtft: Number(savableTtft.toFixed(1)),
    phaseSplit: {
      planThink: tally.planThink, loopThink: tally.loopThink, editThink: tally.editThink, totalThink,
      formattedPlanThink: formatTokenCount(tally.planThink), formattedLoopThink: formatTokenCount(tally.loopThink),
      formattedEditThink: formatTokenCount(tally.editThink), planTtftSec: Number(tally.planTtft.toFixed(1)),
      loopTtftSec: Number(tally.loopTtft.toFixed(1)), editTtftSec: Number(tally.editTtft.toFixed(1)),
      loopCount: tally.loopCount, loopSharePct, planAndEditSharePct: totalThink > 0 ? Math.max(0, 100 - loopSharePct) : 100,
    },
  };
}

export function analyzeModelAndEffortFit(generatorMetadataList = [], steps = [], modelConfigData = {}) {
  const lookup = buildModelLookup(modelConfigData);
  const rawTurns = groupIntoUserTurns(generatorMetadataList, steps);
  let lastKnownEnum = '';
  const evaluated = [];

  for (const t of rawTurns) {
    const firstGen = t.invocations[0];
    const stepPm = steps[t.startStepIdx]?.userInput?.userConfig?.plannerConfig?.planModel;
    const enumCandidate = stepPm || firstGen?.plannerConfig?.planModel || firstGen?.chatModel?.model;
    if (enumCandidate) lastKnownEnum = enumCandidate;
    evaluated.push(classifySingleTurn(t, steps, lookup, lastKnownEnum));
  }

  const totalTurns = evaluated.length;
  const flagged = evaluated.filter((t) => t.status !== 'optimal');
  const optimalTurns = totalTurns - flagged.length;
  const savableThinkingTokens = evaluated.reduce((s, t) => s + t.savableThink, 0);
  const savableTtftSec = Number(evaluated.reduce((s, t) => s + t.savableTtft, 0).toFixed(1));

  return {
    totalTurns, optimalTurns, flaggedTurnsCount: flagged.length,
    savableThinkingTokens, formattedSavableThinking: formatTokenCount(savableThinkingTokens),
    savableTtftSec, savableTtftFormatted: savableTtftSec > 0 ? `~${Math.round(savableTtftSec)}s` : '0s',
    latestTurnFit: evaluated[evaluated.length - 1] || null,
    recentFlaggedTurns: flagged.slice(-5).reverse(),
  };
}
