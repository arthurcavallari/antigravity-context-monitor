/**
 * @fileoverview Model & Thinking Effort Fit Advisor for per-turn trajectory telemetry.
 */

import {
  formatTokenCount,
  cleanModelBadgeLabel,
  extractThinkingEffort,
  buildModelConfigMap,
  normalizeWorkspacePath,
} from './session-resolver.mjs';
import {
  STATIC_MODEL_FALLBACKS,
  isCustomApiProvider,
  isCustomModelConfig,
  isCustomModelId,
} from './constants.mjs';
import { parseInterAgentMessage } from './context-inspector.mjs';
import { stripModelSuffixAndVendor } from './model-catalog.mjs';
import { parseDurationSeconds } from './turn-insights.mjs';

const READ_LOOP_STEP_TYPES = new Set([
  'CORTEX_STEP_TYPE_VIEW_FILE', 'CORTEX_STEP_TYPE_GREP_SEARCH', 'CORTEX_STEP_TYPE_FIND_BY_NAME',
  'CORTEX_STEP_TYPE_LIST_DIR', 'CORTEX_STEP_TYPE_READ_URL_CONTENT', 'CORTEX_STEP_TYPE_SEARCH_WEB',
  'CORTEX_STEP_TYPE_COMMAND_STATUS',
]);

export const EDIT_STEP_TYPES = new Set([
  'CORTEX_STEP_TYPE_CODE_ACTION', 'CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT',
  'CORTEX_STEP_TYPE_MULTI_REPLACE_FILE_CONTENT', 'CORTEX_STEP_TYPE_WRITE_TO_FILE',
]);

export function toNonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// Calibrated on Claude turns without a thinking block, where outputTokens covers only
// plannerResponse.response plus the stored toolCalls JSON (median chars per token)
export const OUTPUT_CHARS_PER_TOKEN = 1.82;
// Physical upper bound on chars per thinking token when unredacted thinking text is present
export const THINKING_CHARS_MAX_PER_TOKEN = 4.2;
// Estimation error on those calibration turns (10th–90th percentile residual)
export const THINKING_ESTIMATE_MARGIN = 20;

export const MODEL_CALIBRATION_PROFILES = Object.freeze({
  geminiFlagship: Object.freeze({
    highUnusedPeakCutoff: 240,
    medUnusedPeakCutoff: 75,
    housekeepingThinkCutoff: 350,
    housekeepingRespCutoff: 450,
    loopShareCutoffPct: 65,
    loopAvgTtftCutoffSec: 3.5,
    targetLowTtftSec: 1.5,
    targetFastTtftSec: 1.2,
  }),
  geminiFast: Object.freeze({
    highUnusedPeakCutoff: 200,
    medUnusedPeakCutoff: 65,
    housekeepingThinkCutoff: 300,
    housekeepingRespCutoff: 400,
    loopShareCutoffPct: 65,
    loopAvgTtftCutoffSec: 2.8,
    targetLowTtftSec: 1.1,
    targetFastTtftSec: 1.0,
  }),
  claudeFlagship: Object.freeze({
    highUnusedPeakCutoff: 240,
    medUnusedPeakCutoff: 75,
    housekeepingThinkCutoff: 350,
    housekeepingRespCutoff: 450,
    loopShareCutoffPct: 65,
    loopAvgTtftCutoffSec: 3.5,
    targetLowTtftSec: 1.6,
    targetFastTtftSec: 1.3,
  }),
  claudeFast: Object.freeze({
    highUnusedPeakCutoff: 220,
    medUnusedPeakCutoff: 70,
    housekeepingThinkCutoff: 320,
    housekeepingRespCutoff: 420,
    loopShareCutoffPct: 65,
    loopAvgTtftCutoffSec: 3.0,
    targetLowTtftSec: 1.3,
    targetFastTtftSec: 1.2,
  }),
});

const ABORTED_STEP_STATUSES = new Set([
  'CORTEX_STEP_STATUS_CANCELED',
  'CORTEX_STEP_STATUS_INTERRUPTED',
]);

/** Formats a thinking count, marking estimates and showing sub-margin estimates as "<20". */
export function formatThinkingTokens(tokens, estimated = false) {
  if (!estimated) return formatTokenCount(tokens);
  return tokens < THINKING_ESTIMATE_MARGIN ? `<${THINKING_ESTIMATE_MARGIN}` : `~${formatTokenCount(tokens)}`;
}

/**
 * Extracts character and duration metrics from plannerResponse objects while stripping
 * base64 thinkingSignature fields embedded inside toolCalls.
 */
export function extractInvocationCharMetrics(responses = []) {
  let responseChars = 0;
  let visibleToolChars = 0;
  let toolCallsCount = 0;
  let thinkingChars = 0;
  let thinkingSigChars = 0;
  let thinkingDurationSec = 0;
  let hasThinkingBlock = false;

  for (const pr of responses) {
    if (!pr) continue;
    responseChars += String(pr.response || '').length;
    const tLen = String(pr.thinking || '').length;
    const sLen = String(pr.thinkingSignature || '').length;
    const dSec = parseDurationSeconds(pr.thinkingDuration);
    thinkingChars += tLen;
    thinkingSigChars += sLen;
    thinkingDurationSec += dSec;
    if (tLen > 0 || sLen > 0 || dSec > 0) hasThinkingBlock = true;

    const rawCalls = Array.isArray(pr.toolCalls) ? pr.toolCalls : [];
    if (rawCalls.length > 0) {
      const stripped = rawCalls.map((tc) => {
        if (!tc || typeof tc !== 'object') return tc;
        toolCallsCount++;
        if (tc.thinkingSignature) {
          hasThinkingBlock = true;
          thinkingSigChars += String(tc.thinkingSignature).length;
        }
        const { thinkingSignature: _sig, ...rest } = tc;
        return rest;
      });
      visibleToolChars += JSON.stringify(stripped).length;
    } else {
      visibleToolChars += 2;
    }
  }

  return {
    responseChars,
    visibleToolChars,
    visibleChars: responseChars + visibleToolChars,
    toolCallsCount,
    thinkingChars,
    thinkingSigChars,
    thinkingDurationSec: Number(thinkingDurationSec.toFixed(2)),
    hasThinkingBlock,
  };
}

/**
 * Thinking tokens for one invocation. Exact from thinkingOutputTokens (the LS omits zero-valued
 * fields, so absent means 0) for every provider except Anthropic Vertex, which never reports it:
 * there it is zero without a thinking block, or estimated as outputTokens minus visible output.
 */
export function measureInvocationThinking(gen, steps = []) {
  const stepList = Array.isArray(steps) ? steps : [];
  const u = gen?.chatModel?.usage || {};
  if (u.thinkingOutputTokens != null || u.apiProvider !== 'API_PROVIDER_ANTHROPIC_VERTEX') {
    return { tokens: toNonNegInt(u.thinkingOutputTokens), estimated: false, known: true };
  }
  const indices = Array.isArray(gen?.stepIndices) ? gen.stepIndices : [];
  const responses = indices.map((idx) => stepList[idx]?.plannerResponse).filter(Boolean);
  if (responses.length === 0) return { tokens: 0, estimated: false, known: false };

  const metrics = extractInvocationCharMetrics(responses);
  if (!metrics.hasThinkingBlock) {
    return { tokens: 0, estimated: false, known: true };
  }
  const out = toNonNegInt(u.outputTokens);
  const residualEstimate = Math.round(out - metrics.visibleChars / OUTPUT_CHARS_PER_TOKEN);
  const minVisibleTokens = Math.ceil(metrics.visibleChars / THINKING_CHARS_MAX_PER_TOKEN);
  const maxPossibleThinking = Math.max(0, out - minVisibleTokens);
  const textLowerBound =
    metrics.thinkingChars > 0
      ? Math.min(maxPossibleThinking, Math.floor(metrics.thinkingChars / THINKING_CHARS_MAX_PER_TOKEN))
      : 0;
  return {
    tokens: Math.min(maxPossibleThinking, Math.max(0, residualEstimate, textLowerBound)),
    estimated: true,
    known: true,
  };
}

export function countInvocationRetries(chatModel = {}) {
  const retryInfos = Array.isArray(chatModel?.retryInfos) ? chatModel.retryInfos : null;
  if (!retryInfos) {
    const legacy = toNonNegInt(chatModel?.retries);
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

function shortenModelName(label = '', effort = 'Low') {
  const shortBase = stripModelSuffixAndVendor(label);
  if (/^Orchestrator\b/i.test(shortBase)) return shortBase;
  return `${shortBase || label} (${effort === 'Medium' ? 'Med' : effort})`;
}

export function buildModelLookup(modelConfigData = {}) {
  const { byEnum, byId, catalog } = buildModelConfigMap(modelConfigData);
  const families = catalog?.families
    ? { ...catalog.families }
    : {
        geminiFlagship: '4 Argon',
        geminiFast: '3.8 Flash',
        claudeFlagship: 'Opus 5.5',
        claudeFast: 'Sonnet 5.5',
        geminiTopEffort: 'High',
        claudeTopEffort: 'High',
      };
  return { byEnum, byId, catalog, families };
}

export function resolveInvocationModel(gen, lookup, fallbackEnum = '', stepModel = '') {
  const enumId =
    gen?.chatModel?.model ||
    gen?.chatModel?.usage?.model ||
    stepModel ||
    gen?.plannerConfig?.planModel ||
    fallbackEnum ||
    '';
  const modelName = gen?.plannerConfig?.modelName || '';
  const matched = lookup.byEnum.get(enumId) || lookup.byId.get(modelName) || lookup.byId.get(enumId) || null;
  const staticFallback = STATIC_MODEL_FALLBACKS[enumId] || null;
  const modelId = matched?.modelId || staticFallback?.modelId || modelName || enumId || 'gemini';
  const rawLabel = matched?.label || staticFallback?.label || '';
  const label = cleanModelBadgeLabel(rawLabel, modelId);
  const effort =
    matched?.thinkingEffort ||
    extractThinkingEffort(rawLabel, modelId) ||
    staticFallback?.thinkingEffort ||
    'Low';
  const lower = `${modelId} ${label}`.toLowerCase();
  const isClaude =
    typeof matched?.isClaude === 'boolean'
      ? matched.isClaude
      : /\b(?:claude|opus|sonnet|haiku)\b/.test(lower);
  const isOpenAi = Boolean(matched?.isOpenAi || /^gpt-/i.test(modelId));
  const isFastFallback =
    /\b(?:flash|lite|haiku|mini|nano|hydrogen)\b|-worker-/.test(lower) ||
    (isClaude && /\bsonnet\b/.test(lower));
  const isFlagship =
    typeof matched?.isFlagship === 'boolean'
      ? matched.isFlagship
      : !isOpenAi && !isFastFallback && (isClaude || /^gemini-/i.test(modelId) || /\borchestrator\b/.test(lower));

  const shortBase = stripModelSuffixAndVendor(label);
  if (lookup.byEnum.size === 0 && shortBase) {
    if (!isClaude && isFlagship && !/\borchestrator\b/.test(lower) && lookup.families.geminiFlagship === '4 Argon') {
      lookup.families.geminiFlagship = shortBase;
    } else if (!isClaude && !isFlagship && !isOpenAi && !/\blite\b/.test(lower) && lookup.families.geminiFast === '3.8 Flash') {
      lookup.families.geminiFast = shortBase;
    }
  }

  let defaultFamily = lookup.families.geminiFast;
  let profileKey = 'geminiFast';
  if (isClaude) {
    defaultFamily = isFlagship ? lookup.families.claudeFlagship : lookup.families.claudeFast;
    profileKey = isFlagship ? 'claudeFlagship' : 'claudeFast';
  } else if (isFlagship) {
    defaultFamily = lookup.families.geminiFlagship;
    profileKey = 'geminiFlagship';
  }

  const apiProvider = gen?.chatModel?.usage?.apiProvider || matched?.apiProvider || '';
  const isUnlistedByom = Boolean(!enumId && modelName && lookup.byEnum.size > 0 && !matched);
  const resolvedEnum = /^MODEL_/i.test(enumId) ? enumId : matched?.modelEnum || matched?.modelOrAlias?.model || '';

  return {
    modelEnum: resolvedEnum,
    modelId, label, shortLabel: shortenModelName(label, effort),
    baseFamily: shortBase || defaultFamily,
    effort, isFlagship, isClaude, apiProvider, profileKey,
    profile: MODEL_CALIBRATION_PROFILES[profileKey],
    isCustom: Boolean(
      (matched && isCustomModelConfig(matched)) ||
      isCustomModelId(modelId) ||
      isCustomApiProvider(apiProvider) ||
      isUnlistedByom
    ),
  };
}

function isArtifactPath(normPath = '') {
  return Boolean(normPath && normPath.includes('/.gemini/antigravity/brain/'));
}

function hasArtifactMetadataJson(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') return false;
  try {
    const obj = JSON.parse(jsonStr);
    return obj?.ArtifactMetadata != null;
  } catch {
    return false;
  }
}

function parseTargetFileFromJson(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') return '';
  try {
    const obj = JSON.parse(jsonStr);
    if (obj?.ArtifactMetadata != null) return '';
    return String(
      obj?.TargetFile ||
        obj?.AbsolutePath ||
        obj?.Path ||
        obj?.targetFile ||
        obj?.absolutePath ||
        obj?.path ||
        obj?.file_path ||
        ''
    ).trim();
  } catch {
    return '';
  }
}

function extractDirectStepTargetFile(s) {
  if (!s || s.codeAction?.isArtifactFile === true) return '';
  const actionSpec = s.codeAction?.actionSpec;
  return (
    actionSpec?.command?.file?.absoluteUri ||
    actionSpec?.createFile?.path?.absoluteUri ||
    actionSpec?.modifyFile?.path?.absoluteUri ||
    actionSpec?.deleteFile?.path?.absoluteUri ||
    s.replaceFileContent?.targetFile ||
    s.replaceFileContent?.targetFileUri ||
    s.multiReplaceFileContent?.targetFile ||
    s.multiReplaceFileContent?.targetFileUri ||
    s.writeToFile?.targetFile ||
    s.writeToFile?.targetFileUri ||
    s.codeAction?.targetFile ||
    s.codeAction?.targetFileUri ||
    parseTargetFileFromJson(s.metadata?.toolCall?.argumentsJson) ||
    ''
  );
}

export function isCodeEditStep(s) {
  if (!s || !EDIT_STEP_TYPES.has(s.type)) return false;
  if (s.codeAction?.isArtifactFile === true) return false;
  if (hasArtifactMetadataJson(s.metadata?.toolCall?.argumentsJson)) return false;
  const direct = extractDirectStepTargetFile(s);
  if (direct && isArtifactPath(normalizeWorkspacePath(direct))) return false;
  return true;
}

export function extractEditedFilesFromStepObjs(stepObjs = []) {
  const files = new Set();
  const addFile = (raw) => {
    const norm = normalizeWorkspacePath(raw);
    if (norm && !isArtifactPath(norm)) files.add(norm);
  };
  for (const s of stepObjs) {
    if (!s) continue;
    if (EDIT_STEP_TYPES.has(s.type) && s.codeAction?.isArtifactFile !== true) {
      const direct = extractDirectStepTargetFile(s);
      if (direct) addFile(direct);
    }
    if (Array.isArray(s.plannerResponse?.toolCalls)) {
      for (const tc of s.plannerResponse.toolCalls) {
        if (/write_to_file|replace_file_content|edit_file|write_file|code_action/i.test(tc?.name || '')) {
          const target = parseTargetFileFromJson(tc.argumentsJson);
          if (target) addFile(target);
        }
      }
    }
  }
  return [...files];
}

function stepDownEffort(effort) {
  if (effort === 'Max' || effort === 'XHigh') return 'High';
  if (effort === 'High') return 'Med';
  return 'Low';
}

function recommendTargetModel(modelInfo, lookup, status, editCount, isDualTurn = false) {
  const { isClaude, isFlagship, effort, baseFamily, shortLabel } = modelInfo;
  const fastFam = isClaude ? lookup.families.claudeFast : lookup.families.geminiFast;
  const flagFam = isClaude ? lookup.families.claudeFlagship : lookup.families.geminiFlagship;
  const topEffort = (isClaude ? lookup.families.claudeTopEffort : lookup.families.geminiTopEffort) || 'High';
  if (status === 'optimal') return shortLabel;
  if (status === 'housekeeping') return `${fastFam} (Low)`;
  if (status === 'unused_effort') return editCount === 0 && isFlagship ? `${fastFam} (Low)` : `${baseFamily} (Low)`;
  if (status === 'loop_tax') {
    if (!isDualTurn && isFlagship) return `${flagFam} → ${fastFam}`;
    return `${baseFamily} (${stepDownEffort(effort)})`;
  }
  if (status === 'thrashing') {
    if (!isFlagship) {
      if (effort === 'Low' || effort === 'Minimal') return `${flagFam} (Med)`;
      if (effort === 'Medium' || effort === 'High') return `${flagFam} (High)`;
      return `${flagFam} (${topEffort})`;
    }
    if (effort === 'XHigh' || effort === 'Max') return `${flagFam} (${effort})`;
    if (effort === 'High' && topEffort !== 'High') return `${flagFam} (${topEffort})`;
    return `${flagFam} (High)`;
  }
  return shortLabel;
}

function isSubagentTaskMessageStep(step, spawnedChildIds = null) {
  if (step?.type !== 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE') return false;
  const src = step?.metadata?.source;
  if (src && src !== 'CORTEX_STEP_SOURCE_SYSTEM') return false;
  const parsed = parseInterAgentMessage(step?.systemMessage?.message || step?.systemMessage?.content || '');
  if (!parsed) return false;
  if (spawnedChildIds instanceof Set && parsed.sender && spawnedChildIds.has(parsed.sender)) {
    return false;
  }
  return true;
}

export function extractPromptSnippet(step = {}) {
  const itemsText = Array.isArray(step?.userInput?.items)
    ? step.userInput.items.map((x) => x?.text || '').join(' ')
    : '';
  let raw = String(step?.userInput?.userResponse || itemsText || '');
  if (!raw && step?.type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE') {
    const parsed = parseInterAgentMessage(step?.systemMessage?.message || step?.systemMessage?.content || '');
    raw = parsed?.content || String(step?.systemMessage?.message || '');
  }
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Prompt';
  return clean.length > 34 ? `${clean.slice(0, 33).trim()}…` : clean;
}

export function groupIntoUserTurns(generatorMetadataList = [], steps = []) {
  const userIndices = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]?.type === 'CORTEX_STEP_TYPE_USER_INPUT') userIndices.push(i);
  }
  if (userIndices.length === 0) {
    const spawnedChildIds = new Set();
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (st?.type !== 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT') continue;
      const results = Array.isArray(st.invokeSubagent?.results)
        ? st.invokeSubagent.results
        : st.invokeSubagent?.result
        ? [st.invokeSubagent.result]
        : [];
      for (const r of results) {
        if (r?.conversationId) spawnedChildIds.add(String(r.conversationId).trim());
      }
      if (st.invokeSubagent?.conversationId) {
        spawnedChildIds.add(String(st.invokeSubagent.conversationId).trim());
      }
    }
    for (let i = 0; i < steps.length; i++) {
      if (isSubagentTaskMessageStep(steps[i], spawnedChildIds)) userIndices.push(i);
    }
  }
  if (userIndices.length === 0 || !generatorMetadataList.some((g) => Array.isArray(g?.stepIndices))) {
    return generatorMetadataList.length > 0
      ? [{ turnNumber: 1, startStepIdx: 0, endStepIdx: steps.length, invocations: generatorMetadataList }]
      : [];
  }
  const boundaries =
    userIndices[0] > 0 &&
    generatorMetadataList.some((g) => typeof g?.stepIndices?.[0] === 'number' && g.stepIndices[0] < userIndices[0])
      ? [0, ...userIndices]
      : userIndices;
  const turns = [];
  for (let t = 0; t < boundaries.length; t++) {
    const startStepIdx = boundaries[t];
    const endStepIdx = t + 1 < boundaries.length ? boundaries[t + 1] : steps.length;
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

function classifySingleTurn(turn, steps, lookup, lastKnownEnum, lastKnownExecEnum = '') {
  const { turnNumber, startStepIdx, endStepIdx, invocations } = turn;
  const userStep = steps[startStepIdx];
  const userPlannerCfg = userStep?.userInput?.userConfig?.plannerConfig;
  const stepPlanModel = userPlannerCfg?.planModel || lastKnownEnum;
  const explicitPlanModel =
    userPlannerCfg?.planModel ||
    invocations[0]?.plannerConfig?.planModel ||
    (lastKnownExecEnum ? lastKnownEnum : '') ||
    '';
  const firstStepIndices = Array.isArray(invocations[0]?.stepIndices) ? invocations[0].stepIndices : [];
  const firstInvStepModel = firstStepIndices.map((idx) => steps[idx]?.model).find(Boolean) || '';
  const modelInfo = explicitPlanModel
    ? resolveInvocationModel(
        {
          plannerConfig: {
            planModel: explicitPlanModel,
            modelName: invocations[0]?.plannerConfig?.modelName,
          },
          chatModel: { usage: invocations[0]?.chatModel?.usage },
        },
        lookup,
        stepPlanModel,
      )
    : resolveInvocationModel(invocations[0], lookup, stepPlanModel, firstInvStepModel);
  // The profiles are calibrated on Antigravity's built-in models, and a custom provider may not
  // report thinking tokens at all, so any verdict on a custom model's turn would be a guess.
  if (modelInfo.isCustom) return null;
  const promptPreview = extractPromptSnippet(userStep);
  const editFileCounts = new Map();
  const invModels = [];

  let wasAborted = false;
  for (let sIdx = startStepIdx; sIdx < endStepIdx; sIdx++) {
    if (ABORTED_STEP_STATUSES.has(steps[sIdx]?.status)) {
      wasAborted = true;
      break;
    }
  }

  const tally = {
    planThink: 0, loopThink: 0, editThink: 0,
    planTtft: 0, loopTtft: 0, editTtft: 0,
    loopCount: 0, editCount: 0, cmdCount: 0, failedCmds: 0,
    flagshipLoopThink: 0, flagshipLoopTtft: 0, flagshipLoopCount: 0,
    peakThink: 0, totalResp: 0, totalUncachedInput: 0,
    modelCorrectableRetries: 0, thinkKnown: false, thinkEstimated: false,
    editAfterFailedCmd: false, sawFailedCmdAfterEdit: false, sawEdit: false,
    sameFileMaxEdits: 0, hotEditFile: '', wasAborted,
  };

  for (let i = 0; i < invocations.length; i++) {
    const g = invocations[i];
    const u = g?.chatModel?.usage || {};
    const out = toNonNegInt(u.outputTokens);
    const measured = measureInvocationThinking(g, steps);
    const think = measured.tokens;
    // Claude reports responseOutputTokens == outputTokens, so estimated turns derive it
    const resp = measured.estimated
      ? Math.max(0, out - think)
      : toNonNegInt(u.responseOutputTokens ?? Math.max(0, out - think));
    const ttft = parseDurationSeconds(g?.chatModel?.timeToFirstToken);
    if (think > tally.peakThink) tally.peakThink = think;
    if (measured.known) tally.thinkKnown = true;
    if (measured.estimated) tally.thinkEstimated = true;
    tally.totalResp += resp;
    tally.totalUncachedInput += toNonNegInt(u.inputTokens);
    tally.modelCorrectableRetries += countInvocationRetries(g?.chatModel).modelCorrectable;

    const indices = Array.isArray(g?.stepIndices) ? g.stepIndices : [];
    const stepObjs = indices.map((idx) => steps[idx]).filter(Boolean);
    const invStepModel = stepObjs.map((s) => s?.model).find(Boolean) || '';
    const invModel = resolveInvocationModel(g, lookup, stepPlanModel, invStepModel);
    invModels.push(invModel);
    if (stepObjs.some((s) => ABORTED_STEP_STATUSES.has(s.status))) {
      tally.wasAborted = true;
    }
    const editedFiles = extractEditedFilesFromStepObjs(stepObjs);
    const hasEdit = stepObjs.some((s) => isCodeEditStep(s)) || editedFiles.length > 0;
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
          (s.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' && !hasFailedCmd) ||
          (EDIT_STEP_TYPES.has(s.type) && !isCodeEditStep(s))
      );

    if (hasEdit) {
      tally.editCount++;
      if (tally.sawFailedCmdAfterEdit) tally.editAfterFailedCmd = true;
      tally.sawEdit = true;
      for (const f of editedFiles) {
        const nextCount = (editFileCounts.get(f) || 0) + 1;
        editFileCounts.set(f, nextCount);
        if (nextCount > tally.sameFileMaxEdits) {
          tally.sameFileMaxEdits = nextCount;
          tally.hotEditFile = f.split('/').pop() || f;
        }
      }
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
      if (invModel.isFlagship) {
        tally.flagshipLoopThink += think;
        tally.flagshipLoopTtft += ttft;
        tally.flagshipLoopCount++;
      }
    }
  }

  const execCfgEnum =
    userPlannerCfg?.planExecuteConfig?.executionModel ||
    invocations.map((g) => g?.plannerConfig?.planExecuteConfig?.executionModel).find(Boolean) ||
    lastKnownExecEnum ||
    '';
  let plannerInfo = modelInfo;
  let execInfo = execCfgEnum ? resolveInvocationModel({ chatModel: { model: execCfgEnum } }, lookup) : null;
  if (execInfo && (execInfo.isCustom || execInfo.modelId === modelInfo.modelId)) {
    execInfo = null;
  }
  if (!execInfo) {
    const flagInv = invModels.find((m) => m.isFlagship && !m.isCustom);
    const fastInv = invModels.find((m) => !m.isFlagship && !m.isCustom);
    if (flagInv && fastInv && flagInv.modelId !== fastInv.modelId) {
      plannerInfo = flagInv;
      execInfo = fastInv;
    }
  }
  const isDualTurn = Boolean(execInfo);
  const effectiveModelInfo = isDualTurn
    ? { ...plannerInfo, shortLabel: `${plannerInfo.baseFamily} → ${execInfo.baseFamily}` }
    : plannerInfo;
  const profile = plannerInfo.profile || MODEL_CALIBRATION_PROFILES.geminiFlagship;

  const totalThink = tally.planThink + tally.loopThink + tally.editThink;
  const totalTtft = tally.planTtft + tally.loopTtft + tally.editTtft;
  const loopSharePct = totalThink > 0 ? Math.round((tally.loopThink / totalThink) * 100) : 0;
  const effectiveLoopCount = isDualTurn ? tally.flagshipLoopCount : tally.loopCount;
  const effectiveLoopThink = isDualTurn ? tally.flagshipLoopThink : tally.loopThink;
  const effectiveLoopTtft = isDualTurn ? tally.flagshipLoopTtft : tally.loopTtft;
  const effectiveLoopSharePct = totalThink > 0 ? Math.round((effectiveLoopThink / totalThink) * 100) : 0;
  const effectiveAvgLoopTtft = effectiveLoopCount > 0 ? effectiveLoopTtft / effectiveLoopCount : 0;
  const isHigh = plannerInfo.effort === 'High' || plannerInfo.effort === 'XHigh' || plannerInfo.effort === 'Max';
  const isMed = plannerInfo.effort === 'Medium';
  // Cold-cache prefill above 30k uncached input tokens/step adds latency even on fast/low tiers
  const avgUncachedPerStep = invocations.length > 0 ? tally.totalUncachedInput / invocations.length : 0;
  const prefillPenaltyPerStep = Math.min(3.0, Math.max(0, avgUncachedPerStep - 30_000) / 60_000);
  const targetLowFloor = profile.targetLowTtftSec + prefillPenaltyPerStep;
  const targetFastFloor = profile.targetFastTtftSec + prefillPenaltyPerStep;

  let status = 'optimal';
  let badge = 'Good fit';
  let savableThink = 0;
  let savableTtft = 0;
  const fmtThink = (n) => formatThinkingTokens(n, tally.thinkEstimated);
  // Estimated turns only get "Lower effort" when the estimate plus its error is still under the cut-off
  const peakForCutoff = tally.peakThink + (tally.thinkEstimated ? THINKING_ESTIMATE_MARGIN : 0);
  let reason = `Used ${fmtThink(totalThink)} thinking tokens across ${invocations.length} step${invocations.length === 1 ? '' : 's'}`;

  const hasSameFileThrashing =
    !isHigh &&
    (tally.sameFileMaxEdits >= 5 || (tally.sameFileMaxEdits >= 3 && tally.failedCmds > 0));

  if (
    tally.modelCorrectableRetries > 0 ||
    hasSameFileThrashing ||
    (tally.editAfterFailedCmd && !isHigh) ||
    (tally.wasAborted && !isHigh && (tally.editCount > 0 || tally.failedCmds > 0))
  ) {
    status = 'thrashing';
    badge = 'Upgrade tier';
    if (tally.modelCorrectableRetries > 0) {
      reason = `Hit ${tally.modelCorrectableRetries} tool/edit retry error(s) on ${plannerInfo.effort} effort`;
    } else if (hasSameFileThrashing) {
      reason = `Re-edited ${tally.hotEditFile || 'same file'} ${tally.sameFileMaxEdits}x in one turn on ${plannerInfo.effort} effort`;
    } else if (tally.editAfterFailedCmd) {
      reason = `Edited code → test command failed → had to re-edit to fix it`;
    } else {
      reason = `Turn interrupted after incomplete edit/command on ${plannerInfo.effort} effort`;
    }
  } else if (
    // Without any measurable invocation, missing thinking would read as 0; aborted turns are never flagged as unused effort
    tally.thinkKnown && !tally.wasAborted &&
    ((isHigh && peakForCutoff < profile.highUnusedPeakCutoff) ||
      (isMed && peakForCutoff < profile.medUnusedPeakCutoff && invocations.length <= 2))
  ) {
    status = 'unused_effort';
    badge = 'Lower effort';
    reason = `Only needed ${fmtThink(tally.peakThink)} thinking tokens across ${invocations.length} step${invocations.length === 1 ? '' : 's'}`;
    savableTtft = Math.max(0, totalTtft - invocations.length * targetLowFloor);
  } else if (
    (isHigh || isMed) &&
    invocations.length >= 3 &&
    effectiveLoopCount >= 2 &&
    effectiveLoopSharePct >= profile.loopShareCutoffPct &&
    effectiveAvgLoopTtft >= profile.loopAvgTtftCutoffSec
  ) {
    status = 'loop_tax';
    badge = 'Lower effort';
    reason = `Spent ${effectiveLoopSharePct}% of thinking (${fmtThink(effectiveLoopThink)} tokens) on ${effectiveLoopCount} routine file/cmd steps`;
    savableThink = Math.round(effectiveLoopThink * 0.7);
    savableTtft = Math.max(0, effectiveLoopTtft - effectiveLoopCount * targetLowFloor);
  } else if (
    !tally.wasAborted &&
    !isDualTurn &&
    plannerInfo.isFlagship &&
    invocations.length <= 3 &&
    tally.editCount <= 1 &&
    totalThink < profile.housekeepingThinkCutoff &&
    tally.totalResp < profile.housekeepingRespCutoff &&
    (tally.cmdCount > 0 || tally.editCount === 1) &&
    tally.failedCmds === 0
  ) {
    status = 'housekeeping';
    badge = 'Lighter model';
    reason = `Routine ${tally.editCount ? '1-file edit' : 'command'} turn that only needed ${fmtThink(totalThink)} thinking tokens`;
    savableTtft = Math.max(0, totalTtft - invocations.length * targetFastFloor);
  }

  return {
    turnNumber, startStepIdx, endStepIdx, invocationsCount: invocations.length,
    promptPreview, modelId: plannerInfo.modelId, modelLabel: plannerInfo.label, shortModelLabel: effectiveModelInfo.shortLabel,
    recommendedModel: recommendTargetModel(effectiveModelInfo, lookup, status, tally.editCount, isDualTurn),
    effort: plannerInfo.effort, status, badge, reason, savableThink, thinkEstimated: tally.thinkEstimated,
    savableTtft: Number(savableTtft.toFixed(1)),
    sameFileMaxEdits: tally.sameFileMaxEdits,
    wasAborted: tally.wasAborted,
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
  let lastKnownExecEnum = '';
  const evaluated = [];
  let customTurns = 0;

  for (const t of rawTurns) {
    const firstGen = t.invocations[0];
    const userPcfg = steps[t.startStepIdx]?.userInput?.userConfig?.plannerConfig;
    const stepPm = userPcfg?.planModel;
    const stepExec = userPcfg?.planExecuteConfig?.executionModel;
    const genPm = firstGen?.plannerConfig?.planModel;
    const genExec = firstGen?.plannerConfig?.planExecuteConfig?.executionModel;
    if (stepPm || genPm) {
      lastKnownEnum = stepPm || genPm;
      lastKnownExecEnum = stepExec || genExec || '';
    } else {
      const firstStepIdx = firstGen?.stepIndices?.[0];
      const firstStepModel = typeof firstStepIdx === 'number' ? steps[firstStepIdx]?.model : '';
      const enumCandidate =
        firstGen?.chatModel?.model || firstGen?.chatModel?.usage?.model || firstStepModel;
      if (enumCandidate && !lastKnownExecEnum) lastKnownEnum = enumCandidate;
      if (stepExec || genExec) lastKnownExecEnum = stepExec || genExec;
    }
    const fit = classifySingleTurn(t, steps, lookup, lastKnownEnum, lastKnownExecEnum);
    if (fit) evaluated.push(fit);
    else customTurns++;
  }

  const totalTurns = evaluated.length;
  const flagged = evaluated.filter((t) => t.status !== 'optimal');
  const optimalTurns = totalTurns - flagged.length;
  const savableThinkingTokens = evaluated.reduce((s, t) => s + t.savableThink, 0);
  const savableTtftSec = Number(evaluated.reduce((s, t) => s + t.savableTtft, 0).toFixed(1));

  const result = {
    totalTurns, optimalTurns, flaggedTurnsCount: flagged.length, customTurns,
    savableThinkingTokens, formattedSavableThinking: formatTokenCount(savableThinkingTokens),
    savableTtftSec, savableTtftFormatted: savableTtftSec > 0 ? `~${Math.round(savableTtftSec)}s` : '0s',
    latestTurnFit: evaluated[evaluated.length - 1] || null,
    recentFlaggedTurns: flagged.slice(-5).reverse(),
  };
  Object.defineProperty(result, 'evaluatedTurns', { value: evaluated, enumerable: false });
  return result;
}
