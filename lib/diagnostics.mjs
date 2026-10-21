/**
 * @fileoverview Memory-safe opt-in diagnostics log tailer (80-line ring buffer),
 * active background terminal manager, and sidecar process controller.
 */

import { fileURLToPath } from 'node:url';
import { callLsRpc } from 'antigravity-sidecar-kit/rpc';

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

export function normalizeSidecars(sidecarsResponse = {}) {
  const list = sidecarsResponse?.sidecars || [];
  return list.map((s) => {
    const status = s.status || 'SIDECAR_STATUS_UNKNOWN';
    const isRunning = status === 'SIDECAR_STATUS_RUNNING';
    const isErrored = status === 'SIDECAR_STATUS_ERRORED';
    return {
      sidecarId: s.sidecarId || '',
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

  return {
    timestamp: new Date().toISOString(),
    logsEnabled: includeLogs,
    logs: includeLogs && diagRes ? extractDiagnosticLogs(diagRes) : [],
    terminals: normalizeTerminals(terminalsRes),
    sidecars: normalizeSidecars(sidecarsRes),
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
