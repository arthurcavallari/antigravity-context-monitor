/**
 * @fileoverview Compaction checkpoint history and top context culprit extraction.
 */

import { formatTokenCount } from './session-resolver.mjs';

const PROMPT_SECTION_LABELS = {
  skills: 'Installed Skills Catalog',
  mcp_servers: 'MCP Server Instructions',
  artifacts: 'Artifact Guidelines',
  user_rules: 'Global & Workspace Rules',
  subagents: 'Subagent Definitions',
  conversation_transcript: 'Transcript Log Pointers',
  identity: 'Core Agent Identity',
  communication_style: 'Communication Style',
  slash_commands: 'Slash Commands Guide',
  user_information: 'Workspace & User Info',
};

function getTurnWorkingTokens(item) {
  const u = item?.chatModel?.usage || {};
  const billed = Number(u.inputTokens || 0) + Number(u.cacheReadTokens || 0);
  const est = Number(item?.chatModel?.chatStartMetadata?.contextWindowMetadata?.estimatedTokensUsed || 0);
  return billed > 0 ? billed : est;
}

function getTurnPeakTokens(item) {
  const u = item?.chatModel?.usage || {};
  const billed = Number(u.inputTokens || 0) + Number(u.cacheReadTokens || 0);
  const est = Number(item?.chatModel?.chatStartMetadata?.contextWindowMetadata?.estimatedTokensUsed || 0);
  return Math.max(billed, est);
}

function cleanSummaryText(raw = '') {
  return String(raw || '')
    .replace(/^\s*<summary>\s*/i, '')
    .replace(/\s*<\/summary>\s*$/i, '')
    .trim();
}

function extractBasename(rawPath = '') {
  const clean = String(rawPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1] || '';
}

function safeJsonArg(jsonStr, keys) {
  if (!jsonStr || typeof jsonStr !== 'string') return '';
  try {
    const obj = JSON.parse(jsonStr);
    for (const k of keys) {
      if (typeof obj?.[k] === 'string' && obj[k]) return obj[k];
    }
  } catch {
    // Ignore malformed or partial JSON arguments
  }
  return '';
}

export function formatPromptSectionLabel(rawName = '') {
  const key = String(rawName || '').trim();
  if (PROMPT_SECTION_LABELS[key]) return PROMPT_SECTION_LABELS[key];
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'System Prompt';
}

function classifyStepFallbackBadge(kind) {
  if (/VIEW_FILE|READ/i.test(kind)) return 'Read';
  if (/COMMAND/i.test(kind)) return 'Cmd';
  if (/EDIT|REPLACE|WRITE/i.test(kind)) return 'Edit';
  if (/USER/i.test(kind)) return 'Prompt';
  return 'Step';
}

export function describeChatStep(rawName = '', steps = []) {
  const raw = String(rawName || 'Step').trim();
  const match = raw.match(/^(\d+):\s*(.+)$/) || raw.match(/^Step\s+(\d+)\s*\((.+)\)$/i);
  if (!match) return { name: raw, label: raw, stepRef: '', badge: 'Step' };

  const idx = Number(match[1]);
  const kind = match[2].trim();
  const stepRef = `#${idx}`;
  const st = steps[idx];
  if (!st) {
    return { name: raw, label: raw, stepRef, badge: classifyStepFallbackBadge(kind) };
  }

  const type = String(st.type || '');
  const tcArgs = st.metadata?.toolCall?.argumentsJson || '';

  if (type === 'CORTEX_STEP_TYPE_VIEW_FILE') {
    const file = extractBasename(st.viewFile?.absolutePathUri || safeJsonArg(tcArgs, ['AbsolutePath', 'TargetFile']));
    return { name: raw, label: file ? `Viewed ${file}` : 'Viewed file', stepRef, badge: 'Read' };
  }
  if (type === 'CORTEX_STEP_TYPE_RUN_COMMAND') {
    const cmd = (st.runCommand?.commandLine || safeJsonArg(tcArgs, ['CommandLine']) || '')
      .replace(/\s+/g, ' ')
      .trim();
    const shortCmd = cmd.length > 28 ? `${cmd.slice(0, 27)}…` : cmd;
    return { name: raw, label: shortCmd ? `Ran: ${shortCmd}` : 'Ran command', stepRef, badge: 'Cmd' };
  }
  if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
    const calls = Array.isArray(st.plannerResponse?.toolCalls) ? st.plannerResponse.toolCalls : [];
    const editFiles = [];
    const readFiles = [];
    for (const c of calls) {
      const f = extractBasename(safeJsonArg(c?.argumentsJson, ['TargetFile', 'AbsolutePath']));
      if (/write_to_file|replace_file_content|code_action/i.test(c?.name || '')) {
        if (f && !editFiles.includes(f)) editFiles.push(f);
      } else if (/view_file/i.test(c?.name || '')) {
        if (f && !readFiles.includes(f)) readFiles.push(f);
      }
    }
    if (editFiles.length > 0) {
      const extra = editFiles.length > 1 ? ` (+${editFiles.length - 1} file${editFiles.length > 2 ? 's' : ''})` : '';
      return { name: raw, label: `Edited ${editFiles[0]}${extra}`, stepRef, badge: 'Edit' };
    }
    if (readFiles.length > 0) {
      const extra = readFiles.length > 1 ? ` (+${readFiles.length - 1})` : '';
      return { name: raw, label: `Read ${readFiles[0]}${extra}`, stepRef, badge: 'Read' };
    }
    if (calls.length > 0) return { name: raw, label: `Tool call: ${calls[0].name}`, stepRef, badge: 'Tool' };
    return { name: raw, label: 'Agent response', stepRef, badge: 'Reply' };
  }
  if (type === 'CORTEX_STEP_TYPE_USER_INPUT') {
    return { name: raw, label: 'User prompt', stepRef, badge: 'Prompt' };
  }
  if (type === 'CORTEX_STEP_TYPE_CHECKPOINT' || st.checkpoint) {
    return { name: raw, label: 'Compaction checkpoint summary', stepRef, badge: 'Summary' };
  }

  const file = extractBasename(safeJsonArg(tcArgs, ['TargetFile', 'AbsolutePath', 'SearchPath']));
  if (/REPLACE|WRITE|CODE_ACTION/.test(type)) {
    return { name: raw, label: file ? `Edited ${file}` : 'Code edit', stepRef, badge: 'Edit' };
  }
  if (/GREP|FIND|LIST_DIR/.test(type)) {
    return { name: raw, label: file ? `Searched ${file}` : 'Search results', stepRef, badge: 'Search' };
  }
  return { name: raw, label: `Step ${stepRef}`, stepRef, badge: 'Step' };
}

export function extractCompactionHistory(generatorMetadataList = [], steps = []) {
  const checkpoints = [];
  const seenStepIndices = new Set();
  let prevStartStep = 0;
  let prevPeakTokens = 0;

  for (let i = 0; i < generatorMetadataList.length; i++) {
    const item = generatorMetadataList[i];
    const csm = item?.chatModel?.chatStartMetadata || {};
    const cw = csm.contextWindowMetadata || {};
    const startStepIndex = Number(csm.startStepIndex || 0);
    const truncationReason = cw.truncationReason || '';
    const currTokens = getTurnWorkingTokens(item);
    const estTokens = Number(cw.estimatedTokensUsed || 0);

    if (truncationReason || (startStepIndex > 0 && startStepIndex > prevStartStep)) {
      const stepIndex = startStepIndex > 0 ? startStepIndex : prevStartStep;
      const afterTokens = currTokens > 0 ? currTokens : estTokens;
      const preCompactEst = afterTokens > 0 && estTokens > afterTokens * 2 ? estTokens : 0;
      const beforeTokens = Math.max(prevPeakTokens, preCompactEst);
      const tokensSaved = beforeTokens > afterTokens ? beforeTokens - afterTokens : 0;
      const cp = (stepIndex > 0 && steps[stepIndex]?.checkpoint) || null;
      if (stepIndex > 0) seenStepIndices.add(stepIndex);

      checkpoints.push({
        index: checkpoints.length + 1,
        stepIndex,
        stepRange: `${cp?.includedStepIndexStart ?? prevStartStep ?? 0}–${cp?.includedStepIndexEnd ?? stepIndex}`,
        beforeTokens,
        afterTokens,
        tokensSaved,
        formattedBefore: formatTokenCount(beforeTokens),
        formattedAfter: formatTokenCount(afterTokens),
        formattedSaved: formatTokenCount(tokensSaved),
        truncationReason: truncationReason || 'TRUNCATION_REASON_MAX_TOKEN_LIMIT',
        summary: cleanSummaryText(cp?.sessionSummary || cp?.summary || cp?.userIntent || ''),
      });
    }
    if (startStepIndex > prevStartStep) prevStartStep = startStepIndex;
    const turnPeak = getTurnPeakTokens(item);
    if (turnPeak > 0) prevPeakTokens = turnPeak;
  }

  for (let idx = 0; idx < steps.length; idx++) {
    const st = steps[idx];
    if ((st?.type === 'CORTEX_STEP_TYPE_CHECKPOINT' || st?.checkpoint) && !seenStepIndices.has(idx)) {
      const cp = st.checkpoint || {};
      checkpoints.push({
        index: checkpoints.length + 1,
        stepIndex: idx,
        stepRange: `${cp.includedStepIndexStart ?? 0}–${cp.includedStepIndexEnd ?? idx}`,
        beforeTokens: 0,
        afterTokens: 0,
        tokensSaved: 0,
        formattedBefore: '—',
        formattedAfter: '—',
        formattedSaved: '—',
        truncationReason: 'CORTEX_STEP_TYPE_CHECKPOINT',
        summary: cleanSummaryText(cp.sessionSummary || cp.summary || cp.userIntent || ''),
      });
    }
  }

  const latestCsm = generatorMetadataList[generatorMetadataList.length - 1]?.chatModel?.chatStartMetadata || {};
  return {
    count: checkpoints.length,
    justCompacted: Boolean(latestCsm.contextWindowMetadata?.truncationReason),
    activeStartStepIndex: Number(latestCsm.startStepIndex || prevStartStep || 0),
    checkpoints: checkpoints.reverse(),
  };
}

export function extractTopCulprits(groups = [], steps = []) {
  const promptSections = [];
  const chatSteps = [];
  let skillsUsedTokens = 0;
  let rulesUsedTokens = 0;
  let promptTotalTokens = 0;

  for (const grp of groups) {
    const children = Array.isArray(grp.children) ? grp.children : [];
    if (grp.type === 'TOKEN_TYPE_SYSTEM_PROMPT') {
      for (const ch of children) {
        const tokens = Number(ch.numTokens || 0);
        const name = String(ch.name || '');
        if (name === 'skills') skillsUsedTokens = tokens;
        if (name === 'user_rules') rulesUsedTokens = tokens;
        if (tokens > 0) {
          promptTotalTokens += tokens;
          promptSections.push({
            name,
            label: formatPromptSectionLabel(name),
            tokens,
            formattedTokens: formatTokenCount(tokens),
          });
        }
      }
    } else if (grp.type === 'TOKEN_TYPE_CHAT_MESSAGES') {
      for (const ch of children) {
        const tokens = Number(ch.numTokens || 0);
        if (tokens > 0) {
          const desc = describeChatStep(String(ch.name || 'Step'), steps);
          chatSteps.push({
            ...desc,
            tokens,
            formattedTokens: formatTokenCount(tokens),
          });
        }
      }
    }
  }

  promptSections.sort((a, b) => b.tokens - a.tokens);
  chatSteps.sort((a, b) => b.tokens - a.tokens);
  const topStepsSlice = chatSteps.slice(0, 5);
  const topPromptSlice = promptSections.slice(0, 6);
  const maxStepTok = topStepsSlice[0]?.tokens || 1;
  const maxPromptTok = topPromptSlice[0]?.tokens || 1;
  const topStepsTokens = topStepsSlice.reduce((s, x) => s + x.tokens, 0);

  return {
    skillsUsedTokens,
    rulesUsedTokens,
    culprits: {
      topStepsTokens,
      formattedTopStepsTokens: topStepsTokens > 0 ? `${formatTokenCount(topStepsTokens)} top ${topStepsSlice.length}` : '',
      promptTotalTokens,
      formattedPromptTotalTokens: formatTokenCount(promptTotalTokens),
      topChatSteps: topStepsSlice.map((s) => ({
        ...s,
        barPct: Math.max(4, Math.round((s.tokens / maxStepTok) * 100)),
      })),
      promptSections: topPromptSlice.map((p) => ({
        ...p,
        barPct: Math.max(4, Math.round((p.tokens / maxPromptTok) * 100)),
      })),
    },
  };
}
