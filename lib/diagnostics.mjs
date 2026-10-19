/**
 * @fileoverview Memory-safe opt-in diagnostics log tailer (80-line ring buffer),
 * active background terminal manager, and sidecar process controller.
 */

import { callLsRpc } from './rpc-client.mjs';

export const MAX_DIAGNOSTIC_LOG_LINES = 80;

export function classifyLogLine(line = '') {
  const text = String(line).trim();
  const lower = text.toLowerCase();
  let level = 'info';
  if (
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('error') ||
    lower.includes('failed') ||
    text.startsWith('E') ||
    text.startsWith('F')
  ) {
    level = 'error';
  } else if (lower.includes('retry') || lower.includes('warn') || text.startsWith('W')) {
    level = 'warn';
  }
  return { text, level };
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
    workspaceUri: (t.workspaceUri || '').replace(/^file:\/\/\/?/i, ''),
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
