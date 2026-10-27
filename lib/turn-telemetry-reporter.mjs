/**
 * @fileoverview Privacy-preserving, opt-in numerical turn telemetry reporter for model & effort calibration.
 * Sends only numerical token/character/timing counters for settled turns when Hangar telemetry is enabled.
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG_PATH, readJsonFile, writeJsonFile } from './constants.mjs';
import {
  EDIT_STEP_TYPES,
  analyzeModelAndEffortFit,
  buildModelLookup,
  countInvocationRetries,
  extractEditedFilesFromStepObjs,
  extractInvocationCharMetrics,
  groupIntoUserTurns,
  isCodeEditStep,
  measureInvocationThinking,
  resolveInvocationModel,
  toNonNegInt,
} from './effort-advisor.mjs';
import { parseDurationSeconds } from './turn-insights.mjs';

export const DEFAULT_HANGAR_CONFIG_PATH = join(homedir(), '.gemini', 'config', 'hangar.json');
export const DEFAULT_TELEMETRY_BASE_URL = 'https://hangar.arthurcavallari.dev';
export const MAX_REPORTED_TURN_KEYS = 2_000;
export const MAX_RECORDS_PER_POST = 25;

const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SETTLED_STEP_STATUSES = new Set([
  'CORTEX_STEP_STATUS_DONE',
  'CORTEX_STEP_STATUS_INVALID',
  'CORTEX_STEP_STATUS_CLEARED',
  'CORTEX_STEP_STATUS_CANCELED',
  'CORTEX_STEP_STATUS_ERROR',
  'CORTEX_STEP_STATUS_INTERRUPTED',
]);

const READ_LOOP_STEP_TYPES = new Set([
  'CORTEX_STEP_TYPE_VIEW_FILE',
  'CORTEX_STEP_TYPE_GREP_SEARCH',
  'CORTEX_STEP_TYPE_FIND_BY_NAME',
  'CORTEX_STEP_TYPE_LIST_DIR',
  'CORTEX_STEP_TYPE_READ_URL_CONTENT',
  'CORTEX_STEP_TYPE_SEARCH_WEB',
  'CORTEX_STEP_TYPE_COMMAND_STATUS',
]);

const reportedTurnKeys = new Set();
const inFlightTurnKeys = new Set();
let loadedStatePath = '';

export function clearReportedTurnKeys() {
  reportedTurnKeys.clear();
  inFlightTurnKeys.clear();
  loadedStatePath = '';
}

function recordDedupKey(dedupSet, key) {
  if (!dedupSet || !key) return;
  dedupSet.add(key);
  while (dedupSet.size > MAX_REPORTED_TURN_KEYS) {
    dedupSet.delete(dedupSet.keys().next().value);
  }
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function computeTurnDedupKey(cascadeId, turn = {}, steps = []) {
  const stepList = Array.isArray(steps) ? steps : [];
  const { turnNumber = 0, startStepIdx = 0, invocations = [] } = turn || {};
  const invList = Array.isArray(invocations) ? invocations : [];
  const lastGen = invList[invList.length - 1];
  const lastGenStepIdx = lastGen?.stepIndices?.length
    ? lastGen.stepIndices[lastGen.stepIndices.length - 1]
    : -1;
  const startStep = stepList[startStepIdx];
  const createdAtMs = Date.parse(startStep?.metadata?.createdAt || '') || 0;
  const itemsText = Array.isArray(startStep?.userInput?.items)
    ? startStep.userInput.items.map((x) => x?.text || '').join(' ')
    : '';
  let totalOut = 0;
  let totalRespChars = 0;
  let hashInput = String(startStep?.userInput?.userResponse || itemsText || '');
  for (const g of invList) {
    totalOut += toNonNegInt(g?.chatModel?.usage?.outputTokens);
    for (const idx of g?.stepIndices || []) {
      const resp = String(stepList[idx]?.plannerResponse?.response || '');
      totalRespChars += resp.length;
      hashInput += `\0${resp.slice(0, 64)}`;
    }
  }
  return `${cascadeId}|${turnNumber}|${startStepIdx}:${lastGenStepIdx}:${invList.length}:${totalOut}:${totalRespChars}:${createdAtMs}:${fnv1a32(hashInput)}`;
}

function resolveHangarConfigPath(options = {}) {
  return (
    options.hangarConfigPath ||
    (options.configPath && options.configPath !== DEFAULT_CONFIG_PATH
      ? join(dirname(options.configPath), 'hangar.json')
      : DEFAULT_HANGAR_CONFIG_PATH)
  );
}

function resolveTelemetryStatePath(options = {}) {
  if (options.telemetryStatePath) return options.telemetryStatePath;
  return join(dirname(resolveHangarConfigPath(options)), 'turn-telemetry-state.json');
}

function ensurePersistedStateLoaded(statePath) {
  if (!statePath || loadedStatePath === statePath) return;
  if (loadedStatePath) reportedTurnKeys.clear();
  loadedStatePath = statePath;
  const saved = readJsonFile(statePath) || {};
  if (Array.isArray(saved.keys)) {
    for (const k of saved.keys) {
      if (typeof k === 'string' && k) recordDedupKey(reportedTurnKeys, k);
    }
  }
}

function persistReportedTurnKeys(statePath) {
  if (!statePath) return;
  try {
    writeJsonFile(statePath, {
      version: 1,
      keys: [...reportedTurnKeys],
    });
  } catch {
    // Non-blocking telemetry state persistence
  }
}

export function resolveTelemetryOptIn(options = {}) {
  const env = options.env || process.env;
  const dnt = String(env?.DO_NOT_TRACK || '').trim().toLowerCase();
  if (dnt === '1' || dnt === 'true') return { enabled: false, installId: '', baseUrl: '' };
  const hangarTel = String(env?.HANGAR_TELEMETRY || '').trim().toLowerCase();
  if (hangarTel === '0' || hangarTel === 'false') return { enabled: false, installId: '', baseUrl: '' };

  // Isolate tests that override configPath from the host machine's ~/.gemini/config/hangar.json
  const hangarConfigPath = resolveHangarConfigPath(options);

  const cfg = readJsonFile(hangarConfigPath) || {};
  if (cfg.telemetry === false) return { enabled: false, installId: '', baseUrl: '' };
  const installId = String(cfg.installId || '').trim();
  if (!INSTALL_ID_PATTERN.test(installId)) return { enabled: false, installId: '', baseUrl: '' };

  const rawBase = String(cfg.registryUrl || DEFAULT_TELEMETRY_BASE_URL)
    .trim()
    .replace(/\/registry\.json\/?$/i, '')
    .replace(/\/+$/, '');
  return {
    enabled: true,
    installId: installId.toLowerCase(),
    baseUrl: rawBase || DEFAULT_TELEMETRY_BASE_URL,
  };
}

export function extractSettledTurnTelemetryRecords({
  cascadeId = '',
  generatorMetadataList = [],
  steps = [],
  modelConfigData = {},
  effortAdvisor = null,
  isExecuting = false,
  dedupSet = reportedTurnKeys,
  commitDedup = true,
} = {}) {
  if (!cascadeId || generatorMetadataList.length === 0 || steps.length === 0) return [];

  const lookup = buildModelLookup(modelConfigData);
  const rawTurns = groupIntoUserTurns(generatorMetadataList, steps);
  const resolvedAdvisor =
    Array.isArray(effortAdvisor?.evaluatedTurns)
      ? effortAdvisor
      : analyzeModelAndEffortFit(generatorMetadataList, steps, modelConfigData);

  const fitByTurn = new Map();
  for (const ft of resolvedAdvisor?.evaluatedTurns || []) {
    if (ft?.turnNumber) fitByTurn.set(ft.turnNumber, ft);
  }

  let lastKnownEnum = '';
  const records = [];

  for (let tIdx = 0; tIdx < rawTurns.length; tIdx++) {
    const turn = rawTurns[tIdx];
    const { turnNumber, startStepIdx, endStepIdx, invocations } = turn;
    const firstGen = invocations[0];
    const stepPm = steps[startStepIdx]?.userInput?.userConfig?.plannerConfig?.planModel;
    const enumCandidate = stepPm || firstGen?.plannerConfig?.planModel || firstGen?.chatModel?.model;
    if (enumCandidate) lastKnownEnum = enumCandidate;

    // While the conversation is actively executing, the latest turn may still be between tool steps
    if (isExecuting && tIdx === rawTurns.length - 1) continue;

    // Only harvest turns whose steps (and all generator-referenced stepIndices) have settled
    let allSettled = endStepIdx > startStepIdx && invocations.length > 0;
    for (let s = startStepIdx; allSettled && s < endStepIdx; s++) {
      if (!SETTLED_STEP_STATUSES.has(steps[s]?.status)) {
        allSettled = false;
      }
    }
    for (let i = 0; allSettled && i < invocations.length; i++) {
      const indices = invocations[i]?.stepIndices;
      if (!Array.isArray(indices) || indices.length === 0) {
        allSettled = false;
        break;
      }
      for (const idx of indices) {
        if (
          !Number.isInteger(idx) ||
          idx < startStepIdx ||
          idx >= steps.length ||
          !SETTLED_STEP_STATUSES.has(steps[idx]?.status)
        ) {
          allSettled = false;
          break;
        }
      }
    }
    if (!allSettled) break;

    const dedupKey = computeTurnDedupKey(cascadeId, turn, steps);
    if ((dedupSet && dedupSet.has(dedupKey)) || inFlightTurnKeys.has(dedupKey)) continue;
    if (commitDedup) {
      recordDedupKey(dedupSet, dedupKey);
    }

    const modelInfo = resolveInvocationModel(firstGen, lookup, lastKnownEnum);
    const turnFit = fitByTurn.get(turnNumber) || null;
    const turnStatus = turnFit?.status || 'optimal';

    let turnInput = 0;
    let turnCache = 0;
    let turnOut = 0;
    let turnResp = 0;
    let turnThink = 0;
    let turnRespChars = 0;
    let turnToolChars = 0;
    let turnToolCalls = 0;
    let turnThinkChars = 0;
    let turnSigChars = 0;
    let turnHasThinking = 0;
    let turnTtftMs = 0;
    let turnThinkDurMs = 0;
    let turnStreamMs = 0;
    let loopCount = 0;
    let editCount = 0;
    let failedCmds = 0;
    let modelRetries = 0;

    for (let i = 0; i < invocations.length; i++) {
      const g = invocations[i];
      const u = g?.chatModel?.usage || {};
      const apiProvider =
        u.apiProvider || (modelInfo.isClaude ? 'API_PROVIDER_ANTHROPIC_VERTEX' : 'API_PROVIDER_GOOGLE_GEMINI');
      const inTok = toNonNegInt(u.inputTokens);
      const cacheTok = toNonNegInt(u.cacheReadTokens);
      const outTok = toNonNegInt(u.outputTokens);
      const measured = measureInvocationThinking(g, steps);
      const thinkTok = measured.tokens;
      const respTok = measured.estimated
        ? Math.max(0, outTok - thinkTok)
        : toNonNegInt(u.responseOutputTokens ?? Math.max(0, outTok - thinkTok));

      const indices = Array.isArray(g?.stepIndices) ? g.stepIndices : [];
      const stepObjs = indices.map((idx) => steps[idx]).filter(Boolean);
      const responses = stepObjs.map((s) => s.plannerResponse).filter(Boolean);
      const charMetrics = extractInvocationCharMetrics(responses);

      const ttftMs = Math.round(parseDurationSeconds(g?.chatModel?.timeToFirstToken) * 1000);
      const thinkDurMs = Math.round(charMetrics.thinkingDurationSec * 1000);
      const streamMs = Math.round(parseDurationSeconds(g?.chatModel?.streamingDuration) * 1000);
      const invRetries = countInvocationRetries(g?.chatModel).modelCorrectable;

      const editedFiles = extractEditedFilesFromStepObjs(stepObjs);
      const hasEdit = stepObjs.some((s) => isCodeEditStep(s)) || editedFiles.length > 0;
      const hasFailedCmd = stepObjs.some(
        (s) =>
          s.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' &&
          (s.status === 'CORTEX_STEP_STATUS_ERROR' || Number(s.runCommand?.exitCode || 0) !== 0)
      );
      const isReadOnly =
        stepObjs.length > 0 &&
        !hasEdit &&
        stepObjs.every(
          (s) =>
            s.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' ||
            READ_LOOP_STEP_TYPES.has(s.type) ||
            (s.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' && !hasFailedCmd) ||
            (EDIT_STEP_TYPES.has(s.type) && !isCodeEditStep(s))
        );

      let phase = 'edit';
      if (i === 0) {
        phase = 'plan';
      } else if (!hasEdit && i < invocations.length - 1 && isReadOnly) {
        phase = 'loop';
        loopCount++;
      }
      if (hasEdit) editCount++;
      if (hasFailedCmd) failedCmds++;
      modelRetries += invRetries;

      turnInput += inTok;
      turnCache += cacheTok;
      turnOut += outTok;
      turnResp += respTok;
      turnThink += thinkTok;
      turnRespChars += charMetrics.responseChars;
      turnToolChars += charMetrics.visibleToolChars;
      turnToolCalls += charMetrics.toolCallsCount;
      turnThinkChars += charMetrics.thinkingChars;
      turnSigChars += charMetrics.thinkingSigChars;
      if (charMetrics.hasThinkingBlock) turnHasThinking = 1;
      turnTtftMs += ttftMs;
      turnThinkDurMs += thinkDurMs;
      turnStreamMs += streamMs;

      const invRec = {
        apiProvider,
        modelId: modelInfo.modelId,
        effort: modelInfo.effort,
        phase,
        status: turnStatus,
        inputTokens: inTok,
        cacheReadTokens: cacheTok,
        outputTokens: outTok,
        responseOutputTokens: respTok,
        thinkingOutputTokens: thinkTok,
        responseChars: charMetrics.responseChars,
        visibleToolChars: charMetrics.visibleToolChars,
        toolCallsCount: charMetrics.toolCallsCount,
        thinkingChars: charMetrics.thinkingChars,
        thinkingSigChars: charMetrics.thinkingSigChars,
        hasThinkingBlock: charMetrics.hasThinkingBlock ? 1 : 0,
        ttftMs,
        thinkingDurationMs: thinkDurMs,
        streamDurationMs: streamMs,
        invocationsCount: 1,
        loopCount: phase === 'loop' ? 1 : 0,
        editCount: hasEdit ? 1 : 0,
        sameFileMaxEdits: turnFit?.sameFileMaxEdits || (hasEdit ? 1 : 0),
        failedCmds: hasFailedCmd ? 1 : 0,
        modelCorrectableRetries: invRetries,
      };
      Object.defineProperty(invRec, '_dedupKey', { value: dedupKey, enumerable: false });
      records.push(invRec);
    }

    const firstProvider =
      firstGen?.chatModel?.usage?.apiProvider ||
      (modelInfo.isClaude ? 'API_PROVIDER_ANTHROPIC_VERTEX' : 'API_PROVIDER_GOOGLE_GEMINI');

    const turnRec = {
      apiProvider: firstProvider,
      modelId: modelInfo.modelId,
      effort: modelInfo.effort,
      phase: 'turn',
      status: turnStatus,
      inputTokens: turnInput,
      cacheReadTokens: turnCache,
      outputTokens: turnOut,
      responseOutputTokens: turnResp,
      thinkingOutputTokens: turnThink,
      responseChars: turnRespChars,
      visibleToolChars: turnToolChars,
      toolCallsCount: turnToolCalls,
      thinkingChars: turnThinkChars,
      thinkingSigChars: turnSigChars,
      hasThinkingBlock: turnHasThinking,
      ttftMs: turnTtftMs,
      thinkingDurationMs: turnThinkDurMs,
      streamDurationMs: turnStreamMs,
      invocationsCount: invocations.length,
      loopCount,
      editCount,
      sameFileMaxEdits: turnFit?.sameFileMaxEdits || (editCount > 0 ? 1 : 0),
      failedCmds,
      modelCorrectableRetries: modelRetries,
    };
    Object.defineProperty(turnRec, '_dedupKey', { value: dedupKey, enumerable: false });
    records.push(turnRec);
  }

  return records;
}

export async function reportSettledTurnTelemetry({
  cascadeId = '',
  generatorMetadataList = [],
  steps = [],
  modelConfigData = {},
  effortAdvisor = null,
  isExecuting = false,
  options = {},
} = {}) {
  const optIn = resolveTelemetryOptIn(options);
  if (!optIn.enabled) return { sent: 0 };

  const fetchFn = options.telemetryFetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') return { sent: 0 };

  const statePath = resolveTelemetryStatePath(options);
  ensurePersistedStateLoaded(statePath);

  const records = extractSettledTurnTelemetryRecords({
    cascadeId,
    generatorMetadataList,
    steps,
    modelConfigData,
    effortAdvisor,
    isExecuting,
    commitDedup: false,
  });
  if (records.length === 0) return { sent: 0 };

  // Group records by turn (_dedupKey) so a turn's records are never split across batches
  const byTurn = new Map();
  for (const r of records) {
    const key = r._dedupKey || '';
    if (!key || inFlightTurnKeys.has(key) || reportedTurnKeys.has(key)) continue;
    if (!byTurn.has(key)) byTurn.set(key, []);
    byTurn.get(key).push(r);
  }

  const batch = [];
  const batchKeys = [];
  for (const [key, turnRecords] of byTurn.entries()) {
    const slice =
      turnRecords.length > MAX_RECORDS_PER_POST
        ? turnRecords
            .slice(0, MAX_RECORDS_PER_POST - 1)
            .concat(turnRecords[turnRecords.length - 1])
        : turnRecords;
    if (batch.length > 0 && batch.length + slice.length > MAX_RECORDS_PER_POST) break;
    batch.push(...slice);
    batchKeys.push(key);
  }
  if (batch.length === 0) return { sent: 0 };

  for (const key of batchKeys) {
    inFlightTurnKeys.add(key);
  }

  try {
    const res = await fetchFn(`${optIn.baseUrl}/api/v1/telemetry/turns`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hangar-Install-Id': optIn.installId,
      },
      body: JSON.stringify({ records: batch }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!res?.ok) return { sent: 0 };
    for (const key of batchKeys) {
      recordDedupKey(reportedTurnKeys, key);
    }
    persistReportedTurnKeys(statePath);
    return { sent: batch.length };
  } catch {
    return { sent: 0 };
  } finally {
    for (const key of batchKeys) {
      inFlightTurnKeys.delete(key);
    }
  }
}
