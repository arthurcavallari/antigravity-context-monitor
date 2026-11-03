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

export function parseInterAgentMessage(rawMessage = '') {
  const text = String(rawMessage || '');
  const match = text.match(
    /^\s*\[Message\]\s+timestamp=(\S+)\s+sender=(\S+)\s+priority=(\S+)\s+content=([\s\S]*)$/
  );
  if (!match) return null;
  return {
    timestamp: match[1],
    sender: match[2],
    priority: match[3],
    content: match[4].trim(),
  };
}

function formatPromptPreview(rawPrompt = '', maxChars = 72) {
  const clean = String(rawPrompt || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1).trim()}…` : clean;
}

function extractInvokeSubagentEntries(st = {}, stepIdx = null) {
  const invoke = st?.invokeSubagent || {};
  const tcArgs = st?.metadata?.toolCall?.argumentsJson || '';
  const rawSpecs = Array.isArray(invoke.subagents)
    ? invoke.subagents
    : invoke.subagent
    ? [invoke.subagent]
    : [];
  const rawResults = Array.isArray(invoke.results)
    ? invoke.results
    : invoke.result
    ? [invoke.result]
    : [];
  const count = Math.max(1, rawSpecs.length, rawResults.length);
  const entries = [];

  for (let i = 0; i < count; i++) {
    const spec = rawSpecs[i] || (i === 0 ? rawSpecs[0] : null) || {};
    const res = rawResults[i] || {};
    const conversationId = String(
      res.conversationId || (i === 0 ? invoke.conversationId : '') || ''
    ).trim();
    const rawTypeName = String(
      spec.typeName || (i === 0 ? safeJsonArg(tcArgs, ['TypeName', 'typeName']) : '') || ''
    ).trim();
    const typeName = rawTypeName || 'subagent';
    const role = String(
      spec.role || (i === 0 ? safeJsonArg(tcArgs, ['Role', 'role']) : '') || ''
    ).trim();
    const initialPrompt = String(
      spec.initialPrompt || (i === 0 ? safeJsonArg(tcArgs, ['Prompt', 'initialPrompt']) : '') || ''
    ).trim();
    if (!conversationId && !rawTypeName && !role && !initialPrompt && rawSpecs.length === 0 && rawResults.length === 0) {
      continue;
    }
    entries.push({
      conversationId,
      typeName,
      role,
      initialPrompt,
      spawnStepIndex: stepIdx,
    });
  }
  return entries;
}

function buildSpawnedSubagentLookup(steps = [], subagents = null) {
  if (subagents instanceof Map) return subagents;
  const byId = new Map();
  const isTreeObj = subagents && !Array.isArray(subagents) && Array.isArray(subagents.items);
  const subList = Array.isArray(subagents)
    ? subagents
    : isTreeObj
    ? subagents.items
    : [];
  let activeParentId = '';
  for (const sa of subList) {
    if (sa?.cascadeId) {
      if (sa.isActive && sa.parentConversationId) {
        activeParentId = sa.parentConversationId;
      }
      byId.set(sa.cascadeId, {
        typeName: String(sa.typeName || '').trim(),
        role: String(sa.role || '').trim(),
        parentConversationId: String(sa.parentConversationId || '').trim(),
      });
    }
  }
  let hasUserInputSteps = false;
  for (let idx = 0; idx < steps.length; idx++) {
    const st = steps[idx];
    if (st?.type === 'CORTEX_STEP_TYPE_USER_INPUT') hasUserInputSteps = true;
    if (st?.type !== 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT') continue;
    for (const entry of extractInvokeSubagentEntries(st, idx)) {
      if (entry.conversationId) {
        const prev = byId.get(entry.conversationId);
        byId.set(entry.conversationId, {
          ...prev,
          ...entry,
          spawnedInSteps: true,
        });
      }
    }
  }
  byId._rootCascadeId = isTreeObj ? String(subagents.rootCascadeId || '') : '';
  byId._activeParentId = activeParentId;
  byId._hasUserInputSteps = hasUserInputSteps;
  return byId;
}

function classifyStepFallbackBadge(kind) {
  if (/SUBAGENT/i.test(kind)) return 'Subagent';
  if (/VIEW_FILE|READ/i.test(kind)) return 'Read';
  if (/COMMAND/i.test(kind)) return 'Cmd';
  if (/EDIT|REPLACE|WRITE/i.test(kind)) return 'Edit';
  if (/USER/i.test(kind)) return 'Prompt';
  return 'Step';
}

export function describeChatStep(rawName = '', steps = [], subagents = null) {
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

  if (type === 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT') {
    const spawned = extractInvokeSubagentEntries(st, idx);
    const first = spawned[0] || { typeName: 'subagent', role: '', conversationId: '' };
    const roleSuffix =
      first.role && first.role.toLowerCase() !== first.typeName.toLowerCase()
        ? ` (${first.role})`
        : '';
    const extra = spawned.length > 1 ? ` (+${spawned.length - 1})` : '';
    const out = {
      name: raw,
      label: `Spawned ${first.typeName}${roleSuffix}${extra}`,
      stepRef,
      badge: 'Subagent',
    };
    if (first.conversationId) out.subagentId = first.conversationId;
    return out;
  }

  if (type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE') {
    const msg = parseInterAgentMessage(st.systemMessage?.message || st.systemMessage?.content || '');
    if (msg?.sender) {
      const lookup = buildSpawnedSubagentLookup(steps, subagents);
      const info = lookup.get(msg.sender);
      const isParentPrompt =
        (lookup._rootCascadeId && msg.sender === lookup._rootCascadeId) ||
        (lookup._activeParentId && msg.sender === lookup._activeParentId) ||
        (!lookup._hasUserInputSteps && !info && idx === 0);
      if (isParentPrompt) {
        const parentName = info?.typeName || info?.role || '';
        return {
          name: raw,
          label: parentName ? `Parent task: ${parentName}` : 'Parent task prompt',
          stepRef,
          badge: 'Prompt',
          subagentId: msg.sender,
        };
      }
      const targetName = info?.typeName || info?.role || msg.sender.slice(0, 8);
      return {
        name: raw,
        label: `Subagent reply: ${targetName}`,
        stepRef,
        badge: 'Subagent',
        subagentId: msg.sender,
      };
    }
  }

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

export function enrichSubagentsFromParentSteps(
  subagents = [],
  steps = [],
  breakdownGroups = [],
  parentCascadeId = ''
) {
  const isTreeObj = subagents && !Array.isArray(subagents) && Array.isArray(subagents.items);
  const items = isTreeObj ? subagents.items : Array.isArray(subagents) ? subagents : [];
  if (items.length === 0) return subagents;

  const stepTokensByIndex = new Map();
  for (const grp of Array.isArray(breakdownGroups) ? breakdownGroups : []) {
    if (grp?.type !== 'TOKEN_TYPE_CHAT_MESSAGES') continue;
    for (const ch of Array.isArray(grp.children) ? grp.children : []) {
      const m =
        String(ch?.name || '')
          .trim()
          .match(/^(\d+):/) ||
        String(ch?.name || '')
          .trim()
          .match(/^Step\s+(\d+)\b/i);
      if (m) {
        const idx = Number(m[1]);
        stepTokensByIndex.set(idx, (stepTokensByIndex.get(idx) || 0) + Number(ch.numTokens || 0));
      }
    }
  }

  const hasUserInput = steps.some((st) => st?.type === 'CORTEX_STEP_TYPE_USER_INPUT');
  const spawnById = new Map();
  const unlinkedSpawns = [];
  const repliesById = new Map();

  for (let idx = 0; idx < steps.length; idx++) {
    const st = steps[idx];
    if (!st) continue;
    if (st.type === 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT') {
      const entries = extractInvokeSubagentEntries(st, idx);
      const stepTok = stepTokensByIndex.get(idx) || 0;
      const perEntrySpawnTok = entries.length > 0 ? Math.round(stepTok / entries.length) : 0;
      for (const entry of entries) {
        const record = { ...entry, spawnTokens: perEntrySpawnTok };
        if (entry.conversationId) {
          spawnById.set(entry.conversationId, record);
        } else {
          unlinkedSpawns.push(record);
        }
      }
    } else if (st.type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE') {
      // In a subagent trajectory (no USER_INPUT), step 0 is the incoming task prompt from its parent, not a child reply
      if (!hasUserInput && idx === 0) continue;
      const msg = parseInterAgentMessage(st.systemMessage?.message || st.systemMessage?.content || '');
      if (msg?.sender) {
        if (!repliesById.has(msg.sender)) {
          repliesById.set(msg.sender, { indices: [], tokens: 0 });
        }
        const bucket = repliesById.get(msg.sender);
        bucket.indices.push(idx);
        bucket.tokens += stepTokensByIndex.get(idx) || 0;
      }
    }
  }

  const enrichedItems = items.map((sa) => {
    const id = sa?.cascadeId || '';
    const belongsToParent =
      !parentCascadeId || !sa?.parentConversationId || sa.parentConversationId === parentCascadeId;
    if (!belongsToParent) return sa;

    let spawn = spawnById.get(id) || null;
    if (!spawn && sa?.spawnStepIndex == null && unlinkedSpawns.length > 0) {
      const matchIdx = unlinkedSpawns.findIndex(
        (u) =>
          u.typeName.toLowerCase() === String(sa?.typeName || '').toLowerCase() &&
          (!u.role || u.role.toLowerCase() === String(sa?.role || '').toLowerCase())
      );
      if (matchIdx >= 0) {
        spawn = unlinkedSpawns.splice(matchIdx, 1)[0];
      }
    }
    const replies = repliesById.get(id);
    const spawnStepIndex = spawn?.spawnStepIndex ?? sa?.spawnStepIndex ?? null;
    const initialPrompt = spawn?.initialPrompt || sa?.initialPrompt || '';
    const replyStepIndices = replies?.indices?.length
      ? replies.indices
      : Array.isArray(sa?.replyStepIndices)
      ? sa.replyStepIndices
      : [];
    const computedTokens = (spawn?.spawnTokens || 0) + (replies?.tokens || 0);
    const parentContextTokens = computedTokens > 0 ? computedTokens : Number(sa?.parentContextTokens || 0);

    return {
      ...sa,
      spawnStepIndex,
      spawnStepRef: spawnStepIndex != null ? `#${spawnStepIndex}` : sa?.spawnStepRef || '',
      initialPrompt,
      promptPreview: formatPromptPreview(initialPrompt) || sa?.promptPreview || '',
      replyStepIndices,
      parentContextTokens,
      formattedParentContextTokens:
        parentContextTokens > 0 ? formatTokenCount(parentContextTokens) : '',
    };
  });

  if (!isTreeObj) return enrichedItems;

  const totalParentTokens = enrichedItems.reduce(
    (sum, item) => sum + (Number(item.parentContextTokens) || 0),
    0
  );
  return {
    ...subagents,
    parentContextTokens: totalParentTokens,
    formattedParentContextTokens:
      totalParentTokens > 0 ? formatTokenCount(totalParentTokens) : '',
    items: enrichedItems,
  };
}

const SKILL_INJECTION_COMMENT_RE =
  /<!--\s*(?:skillInjection|antigravity-skill-router|skill-router-telemetry):\s*(\{[\s\S]{1,4096}?\})\s*-->/g;
const SKILL_MARKER_HINT_RE = /skillInjection|antigravity-skill-router|skill-router-telemetry/;
const MAX_SKILL_SCAN_CHARS = 65536;

function collectStepTextCandidates(st) {
  if (!st) return [];
  if (typeof st === 'string') return SKILL_MARKER_HINT_RE.test(st) ? [st] : [];
  if (typeof st !== 'object') return [];
  const itemTexts = Array.isArray(st.userInput?.items)
    ? st.userInput.items.map((it) => it?.text).filter((t) => typeof t === 'string')
    : [];
  const rawList = [
    st.content,
    st.additionalContext,
    st.hookSpecificOutput?.additionalContext,
    st.metadata?.hookSpecificOutput?.additionalContext,
    st.userInput?.userResponse,
    st.userInput?.content,
    ...itemTexts,
    st.systemMessage?.message,
    st.systemMessage?.content,
    st.toolResult?.content,
  ].filter((val) => typeof val === 'string' && SKILL_MARKER_HINT_RE.test(val));
  return [...new Set(rawList)];
}

export function extractSkillInjectionMetrics(steps = []) {
  const injections = [];
  let totalInjectedBytes = 0;
  const list = Array.isArray(steps) ? steps : [];

  for (let idx = 0; idx < list.length; idx++) {
    const st = list[idx];
    const stepIndex = typeof st?.stepIndex === 'number' ? st.stepIndex : idx;
    const candidates = collectStepTextCandidates(st);
    for (const rawText of candidates) {
      const bounded =
        rawText.length <= MAX_SKILL_SCAN_CHARS * 2
          ? rawText
          : `${rawText.slice(0, MAX_SKILL_SCAN_CHARS)}\n${rawText.slice(-MAX_SKILL_SCAN_CHARS)}`;
      const matcher = new RegExp(SKILL_INJECTION_COMMENT_RE.source, 'g');
      let match;
      let fallbackBytes = null;
      while ((match = matcher.exec(bounded)) !== null) {
        let parsed;
        try {
          parsed = JSON.parse(match[1]);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const hookEvent =
          typeof parsed.hookEvent === 'string' && parsed.hookEvent.trim()
            ? parsed.hookEvent.trim()
            : 'PreToolUse';
        const injectedSkills = Array.isArray(parsed.injectedSkills)
          ? parsed.injectedSkills.map(String)
          : Array.isArray(parsed.routedSkills)
          ? parsed.routedSkills.map(String)
          : Array.isArray(parsed.skills)
          ? parsed.skills.map(String)
          : [];
        const droppedByCap = Array.isArray(parsed.droppedByCap) ? parsed.droppedByCap.map(String) : [];
        const droppedByBudget = Array.isArray(parsed.droppedByBudget) ? parsed.droppedByBudget.map(String) : [];
        const rawBytes = parsed.totalBytes ?? parsed.bytes ?? parsed.bytesInjected;
        const numBytes =
          typeof rawBytes === 'number' || (typeof rawBytes === 'string' && rawBytes.trim() !== '')
            ? Number(rawBytes)
            : NaN;
        const bytes =
          Number.isFinite(numBytes) && numBytes >= 0
            ? Math.round(numBytes)
            : fallbackBytes === null
            ? (fallbackBytes = Buffer.byteLength(
                bounded.replace(SKILL_INJECTION_COMMENT_RE, '').trim(),
                'utf8'
              ))
            : 0;
        totalInjectedBytes += bytes;
        injections.push({
          stepIndex,
          hookEvent,
          injectedSkills,
          droppedByCap,
          droppedByBudget,
          bytes,
        });
      }
    }
  }

  const estimatedTokens = totalInjectedBytes > 0 ? Math.round(totalInjectedBytes * 0.28) : 0;
  return {
    totalInjectedBytes,
    estimatedTokens,
    injections,
  };
}

export function extractTopCulprits(groups = [], steps = [], subagents = null) {
  const promptSections = [];
  const chatSteps = [];
  let skillsUsedTokens = 0;
  let rulesUsedTokens = 0;
  let promptTotalTokens = 0;
  const subagentLookup = buildSpawnedSubagentLookup(steps, subagents);
  const skillInjections = extractSkillInjectionMetrics(steps);

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
          const desc = describeChatStep(String(ch.name || 'Step'), steps, subagentLookup);
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
    skillInjections,
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
      skillInjections,
    },
  };
}
