/**
 * @fileoverview Memory-safe opt-in diagnostics log tailer (80-line ring buffer),
 * active background terminal manager, and sidecar process controller.
 */

import { fileURLToPath } from 'node:url';
import { callLsRpc } from 'antigravity-sidecar-kit/rpc';
import { DEFAULT_CONTEXT_CEILING } from './constants.mjs';

export const MAX_DIAGNOSTIC_LOG_LINES = 80;

const GLOG_PREFIX_RE = /^([IWEF])\d{4}\s/;
// "Lmmdd hh:mm:ss.uuuuuu threadid file:line] " — stripped so timestamps and line numbers can't match 429
const GLOG_HEADER_RE = /^[IWEF]\d{4}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+(?:\d+\s+)?(?:[^\s\]]+\]\s*)?/;
const RATE_LIMIT_RE = /RESOURCE_EXHAUSTED|\b(?:HTTP|status|code)\W{0,3}429\b|\b429 Too Many Requests\b/i;
const GLOG_LEVELS = { I: 'info', W: 'warn', E: 'error', F: 'error' };

export function classifyLogLine(line = '') {
  const text = String(line).trim();
  const prefix = text.match(GLOG_PREFIX_RE)?.[1];
  const message = prefix ? text.replace(GLOG_HEADER_RE, '') : text;
  const level = RATE_LIMIT_RE.test(message) ? 'error' : GLOG_LEVELS[prefix] || 'info';
  return { text, level };
}

function fileUriToPath(uri = '') {
  if (!/^file:/i.test(uri)) return uri;
  try {
    // Infer the path flavor from the URI so a POSIX/WSL workspace still renders on a Windows host
    return fileURLToPath(uri, { windows: /^file:\/\/\/[a-z](?::|%3a)/i.test(uri) });
  } catch {
    return uri;
  }
}

export function extractDiagnosticLogs(diagResponse = {}, maxLines = MAX_DIAGNOSTIC_LOG_LINES) {
  const rawLogs = diagResponse?.languageServerDiagnostics?.logs || [];
  const flatLines = [];

  for (const entry of rawLogs) {
    const parts = String(entry || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      flatLines.push(p);
    }
  }

  const tail = flatLines.slice(-Math.max(1, maxLines));
  return tail.map(classifyLogLine);
}

export function normalizeTerminals(terminalsResponse = {}) {
  const list = terminalsResponse?.terminals || [];
  return list.map((t) => ({
    terminalId: t.terminalId || '',
    pid: t.pid || 0,
    title: t.title || 'terminal',
    conversationId: t.conversationId || '',
    workspaceUri: fileUriToPath(t.workspaceUri || ''),
    createdAt: t.createdAt || '',
  }));
}

const SAFE_DIR_SLUG_RE = /^[a-zA-Z0-9._-]+$/;
const isSafeDirSlug = (val) => (
  typeof val === 'string' && SAFE_DIR_SLUG_RE.test(val) && !val.includes('..') && val !== '.'
);

function extractSidecarPluginDir(s = {}) {
  const rawPath = String(
    s.pluginPath || s.config?.pluginPath || s.pluginRoot || s.config?.pluginRoot || ''
  ).trim();
  if (rawPath) {
    const clean = fileUriToPath(rawPath).replace(/[\\/]+$/, '');
    const pluginsMatch = clean.match(/(?:^|[\\/])plugins[\\/]([^\\/]+)(?:[\\/]|$)/);
    if (pluginsMatch && isSafeDirSlug(pluginsMatch[1])) {
      return pluginsMatch[1];
    }
    const base = clean.split(/[\\/]/).filter(Boolean).at(-1) || '';
    if (isSafeDirSlug(base)) {
      return base;
    }
  }
  const scId = String(s.sidecarId || '').trim();
  if (scId.includes('/')) {
    const prefix = scId.split('/')[0];
    if (isSafeDirSlug(prefix)) return prefix;
  }
  return '';
}

export function normalizeSidecars(sidecarsResponse = {}) {
  const list = sidecarsResponse?.sidecars || [];
  return list.map((s) => {
    const status = s.status || 'SIDECAR_STATUS_UNKNOWN';
    const isRunning = status === 'SIDECAR_STATUS_RUNNING';
    const isErrored = status === 'SIDECAR_STATUS_ERRORED';
    return {
      sidecarId: s.sidecarId || '',
      pluginId: s.pluginId || s.config?.pluginId || '',
      pluginDir: extractSidecarPluginDir(s),
      pluginName: s.pluginName || s.config?.pluginName || '',
      displayName: s.config?.displayName || s.sidecarId || 'Sidecar',
      status,
      statusBadge: isRunning ? 'RUNNING' : isErrored ? 'ERRORED' : status.replace('SIDECAR_STATUS_', ''),
      isRunning,
      isErrored,
      webPort: s.webPort || 0,
      lastError: s.lastError || '',
    };
  });
}

export function detectToolOutputBloat(
  steps = [],
  { tokenThreshold = 8000, contextCeiling = DEFAULT_CONTEXT_CEILING } = {}
) {
  if (!Array.isArray(steps)) return [];
  const threshold =
    typeof tokenThreshold === 'number' && Number.isFinite(tokenThreshold) && tokenThreshold >= 0
      ? tokenThreshold
      : 8000;
  const numCeiling = Number(contextCeiling);
  const ceiling = Number.isFinite(numCeiling) && numCeiling > 0 ? numCeiling : DEFAULT_CONTEXT_CEILING;
  const results = [];

  for (let idx = 0; idx < steps.length; idx++) {
    const st = steps[idx];
    if (!st || typeof st !== 'object') continue;
    const type = String(st.type || '');
    if (/USER_INPUT|PLANNER_RESPONSE|CHECKPOINT/i.test(type)) continue;
    const isToolLike =
      Boolean(st.toolName || st.mcpTool || st.toolResult || st.runCommand || st.viewFile) ||
      /TOOL|COMMAND|VIEW_FILE|GREP|FIND|LIST_DIR|READ_URL|SEARCH/i.test(type);
    if (!isToolLike) continue;

    const stepIndex = typeof st.stepIndex === 'number' ? st.stepIndex : idx;
    const toolName = String(
      st.toolName ||
        st.mcpTool?.toolName ||
        st.mcpTool?.name ||
        st.metadata?.toolCall?.name ||
        st.toolCall?.name ||
        type ||
        'tool'
    ).trim();

    let estimatedTokens = 0;
    if (typeof st.estimatedTokens === 'number' && Number.isFinite(st.estimatedTokens)) {
      estimatedTokens = Math.round(st.estimatedTokens);
    } else {
      const rawPayload =
        st.content ??
        st.output ??
        st.result ??
        st.mcpTool?.result ??
        st.mcpTool?.output ??
        st.mcpTool?.content ??
        st.toolResult?.content ??
        st.runCommand?.output ??
        st.runCommand?.stdout ??
        st.commandStatus?.output ??
        st.commandStatus?.delta ??
        st.viewFile?.content ??
        st.readUrlContent?.content ??
        st.grepSearch?.results ??
        st.grepSearch ??
        st.find?.results ??
        st.findByName?.results ??
        st.listDirectory?.entries ??
        st.listDir?.entries ??
        '';
      let strPayload = '';
      if (typeof rawPayload === 'string') {
        strPayload = rawPayload;
      } else if (rawPayload && typeof rawPayload === 'object') {
        try {
          strPayload = JSON.stringify(rawPayload, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
        } catch {
          strPayload = String(rawPayload);
        }
      } else {
        strPayload = String(rawPayload || '');
      }
      estimatedTokens = Math.round(strPayload.length * 0.28);
    }

    const pctOfCeiling = Number(((estimatedTokens / ceiling) * 100).toFixed(1));
    if (estimatedTokens > threshold || pctOfCeiling > 15) {
      const pluginId = String(st.pluginId || st.mcpTool?.pluginId || '').trim();
      results.push({
        stepIndex,
        toolName,
        estimatedTokens,
        pctOfCeiling,
        ...(pluginId ? { pluginId } : {}),
      });
    }
  }

  return results;
}

export function analyzeTrajectoryHealth(stepsOrInput = [], options = {}) {
  const steps = Array.isArray(stepsOrInput)
    ? stepsOrInput
    : Array.isArray(stepsOrInput?.steps)
    ? stepsOrInput.steps
    : [];
  const opts = Array.isArray(stepsOrInput) ? options : { ...stepsOrInput, ...options };
  const bloatedSteps = detectToolOutputBloat(steps, opts);
  const advisories = bloatedSteps.map((b) => ({
    code: 'TOOL_OUTPUT_BLOAT',
    type: 'TOOL_OUTPUT_BLOAT',
    severity: b.pctOfCeiling >= 15 ? 'error' : 'warn',
    stepIndex: b.stepIndex,
    toolName: b.toolName,
    estimatedTokens: b.estimatedTokens,
    pctOfCeiling: b.pctOfCeiling,
    ...(b.pluginId ? { pluginId: b.pluginId } : {}),
    message: `Step #${b.stepIndex} (${b.toolName}) produced ~${b.estimatedTokens} tokens (${b.pctOfCeiling}% of context ceiling).`,
  }));

  return {
    healthy: advisories.length === 0,
    bloatedSteps,
    advisories,
    warnings: advisories,
  };
}

export async function fetchDiagnosticsSnapshot(options = {}) {
  const includeLogs = Boolean(options.includeLogs);

  const [terminalsRes, sidecarsRes, remoteRes, diagRes] = await Promise.all([
    callLsRpc('ListTerminals', {}, options).catch(() => ({})),
    callLsRpc('GetSidecars', {}, options).catch(() => ({})),
    callLsRpc('GetRemoteControlInfo', {}, options).catch(() => ({})),
    includeLogs
      ? callLsRpc('GetDebugDiagnostics', {}, options).catch(() => ({}))
      : Promise.resolve(null),
  ]);

  const health = Array.isArray(options.steps) ? analyzeTrajectoryHealth(options.steps, options) : null;

  return {
    timestamp: new Date().toISOString(),
    logsEnabled: includeLogs,
    logs: includeLogs && diagRes ? extractDiagnosticLogs(diagRes) : [],
    terminals: normalizeTerminals(terminalsRes),
    sidecars: normalizeSidecars(sidecarsRes),
    ...(health ? { advisories: health.advisories, warnings: health.warnings } : {}),
    remoteControl: {
      enabled: Boolean(remoteRes?.enabled),
      hostname: remoteRes?.remoteControlHostname || '',
      companionOrigin: remoteRes?.companionOrigin || '',
    },
  };
}

export async function closeTerminalById(terminalId, options = {}) {
  if (!terminalId) throw new Error('terminalId is required');
  await callLsRpc('CloseTerminal', { terminalId: String(terminalId) }, options);
  return { closed: true, terminalId };
}

export async function restartSidecarById(sidecarId, options = {}) {
  if (!sidecarId) throw new Error('sidecarId is required');
  await callLsRpc(
    'ManageSidecar',
    { action: 'SIDECAR_ACTION_RESTART', sidecarId: String(sidecarId) },
    options
  );
  return { restarted: true, sidecarId };
}
