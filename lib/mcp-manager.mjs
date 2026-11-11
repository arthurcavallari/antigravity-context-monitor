/**
 * @fileoverview MCP server lifecycle controls (standalone + plugin mcp_config.json)
 * and customization state aggregation (GetCustomizationStates).
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLsRpc } from 'antigravity-sidecar-kit/rpc';
import { readJsonFile, writeJsonFile } from './constants.mjs';
import { clearRpcCache } from './rpc-cache.mjs';
import { formatTokenCount } from './session-resolver.mjs';

const SAFE_SERVER_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const DEFAULT_APP_DATA_DIR = join(homedir(), '.gemini', 'antigravity');

const isSafeDirSlug = (val) => (
  typeof val === 'string' &&
  SAFE_SERVER_NAME_RE.test(val) &&
  !val.includes('..') &&
  val !== '.'
);

function fileUriToPath(uri = '') {
  if (!/^file:/i.test(uri)) return uri;
  try {
    return fileURLToPath(uri, { windows: /^file:\/\/\/[a-z](?::|%3a)/i.test(uri) });
  } catch {
    return uri;
  }
}

export function extractPluginDir(spec = {}, custEntry = null) {
  const hasPluginMeta = Boolean(
    spec?.pluginName ||
      custEntry?.pluginName ||
      spec?.pluginId ||
      custEntry?.pluginId ||
      spec?.pluginRoot ||
      custEntry?.pluginRoot ||
      spec?.pluginVersion ||
      custEntry?.pluginVersion
  );
  const cfgPath = fileUriToPath(String(spec?.configPath || custEntry?.path || '').trim()).replace(/[\\/]+$/, '');
  const cfgMatch = cfgPath.match(/(?:^|[\\/])plugins[\\/]([^\\/]+)[\\/][^\\/]+$/);
  if (cfgMatch && isSafeDirSlug(cfgMatch[1])) {
    return cfgMatch[1];
  }
  if (!hasPluginMeta) return '';

  const rootPath = fileUriToPath(String(spec?.pluginRoot || custEntry?.pluginRoot || '').trim()).replace(/[\\/]+$/, '');
  const rootPluginsMatch = rootPath.match(/(?:^|[\\/])plugins[\\/]([^\\/]+)$/);
  if (rootPluginsMatch && isSafeDirSlug(rootPluginsMatch[1])) {
    return rootPluginsMatch[1];
  }

  const orig = String(spec?.originalServerName || '').trim();
  const full = String(spec?.serverName || '').trim();
  if (orig && full.length > orig.length + 1 && full.endsWith(`_${orig}`)) {
    const prefix = full.slice(0, -(orig.length + 1));
    if (isSafeDirSlug(prefix)) {
      return prefix;
    }
  }

  if (rootPath) {
    const base = rootPath.split(/[\\/]/).filter(Boolean).at(-1) || '';
    if (isSafeDirSlug(base)) {
      return base;
    }
  }
  return '';
}

export function estimateToolTokens(tool = {}, tokensPerChar = 0.28) {
  const rawLen =
    (tool.name || '').length +
    (tool.description || '').length +
    (tool.jsonSchemaString || '').length;
  return Math.round(rawLen * tokensPerChar);
}

export function estimateDiskMcpSchemaTokens(appDataDir, serverName, tokensPerChar = 0.28) {
  if (!appDataDir || !serverName || typeof appDataDir !== 'string' || typeof serverName !== 'string') {
    return { toolCount: 0, schemaBytes: 0, estimatedTokens: 0 };
  }
  const trimmedName = serverName.trim();
  if (!SAFE_SERVER_NAME_RE.test(trimmedName) || trimmedName.includes('..') || trimmedName === '.') {
    return { toolCount: 0, schemaBytes: 0, estimatedTokens: 0 };
  }
  let mcpRootReal;
  let serverDirReal;
  try {
    mcpRootReal = realpathSync(join(appDataDir, 'mcp'));
    serverDirReal = realpathSync(join(mcpRootReal, trimmedName));
  } catch {
    return { toolCount: 0, schemaBytes: 0, estimatedTokens: 0 };
  }
  if (!serverDirReal.startsWith(mcpRootReal + sep)) {
    return { toolCount: 0, schemaBytes: 0, estimatedTokens: 0 };
  }
  let entries;
  try {
    entries = readdirSync(serverDirReal);
  } catch {
    return { toolCount: 0, schemaBytes: 0, estimatedTokens: 0 };
  }

  let toolCount = 0;
  let schemaBytes = 0;
  for (const name of entries) {
    if (!String(name).toLowerCase().endsWith('.json')) continue;
    const filePath = join(serverDirReal, name);
    try {
      const st = lstatSync(filePath);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      toolCount += 1;
      schemaBytes += st.size;
    } catch {
      continue;
    }
  }

  const estimatedTokens =
    schemaBytes > 0
      ? typeof tokensPerChar === 'number' && tokensPerChar > 0
        ? Math.round(schemaBytes * tokensPerChar)
        : Math.ceil(schemaBytes / 3.8)
      : 0;
  return {
    toolCount,
    schemaBytes,
    estimatedTokens,
  };
}

export const estimateServerSchemaTokens = estimateDiskMcpSchemaTokens;

export function buildMcpAndCustomizationsCatalog(
  mcpStatesResponse = {},
  customizationStatesResponse = {},
  tokensPerChar = 0.28,
  options = {}
) {
  const resolvedOpts =
    tokensPerChar && typeof tokensPerChar === 'object' ? tokensPerChar : options || {};
  const rate =
    typeof tokensPerChar === 'number'
      ? tokensPerChar
      : typeof resolvedOpts.tokensPerChar === 'number'
      ? resolvedOpts.tokensPerChar
      : 0.28;
  const appDataDir =
    resolvedOpts.appDataDir !== undefined
      ? String(resolvedOpts.appDataDir || '')
      : DEFAULT_APP_DATA_DIR;
  const custStates = customizationStatesResponse?.states || [];
  const mcpCustMap = new Map();
  let enabledSkills = 0;
  let totalSkills = 0;
  let enabledRules = 0;

  for (const cs of custStates) {
    const type = String(cs.type || '');
    const isEnabled = cs.status === 'STATUS_ENABLED';
    if (type.includes('SKILL')) {
      totalSkills++;
      if (isEnabled) enabledSkills++;
    } else if (type.includes('RULE')) {
      if (isEnabled) enabledRules++;
    } else if (type.includes('MCP') && cs.name) {
      mcpCustMap.set(cs.name, cs);
    }
  }

  const states = mcpStatesResponse?.states || [];
  const allServers = states.map((st) => {
    const tools = Array.isArray(st.tools) ? st.tools : [];
    const toolConfig = st.spec?.toolConfig || {};
    const serverName = st.spec?.originalServerName || st.spec?.serverName || 'mcp-server';
    const fullServerName = st.spec?.serverName || serverName;
    const status = st.status || 'MCP_SERVER_STATUS_UNKNOWN';
    const custEntry = mcpCustMap.get(fullServerName) || mcpCustMap.get(serverName);

    let eagerCount = 0;
    let deferredCount = 0;
    let estTokens = 0;

    for (const tool of tools) {
      const isEager = Boolean(toolConfig?.[tool.name]?.eager);
      if (isEager) eagerCount++;
      else deferredCount++;
      estTokens += estimateToolTokens(tool, rate);
    }

    let totalToolCount = tools.length;
    if (totalToolCount === 0 && (appDataDir || st.spec?.appDataDir)) {
      const baseDir = appDataDir || st.spec?.appDataDir;
      let diskEst = estimateDiskMcpSchemaTokens(baseDir, fullServerName, rate);
      if (diskEst.toolCount === 0 && serverName !== fullServerName) {
        diskEst = estimateDiskMcpSchemaTokens(baseDir, serverName, rate);
      }
      if (diskEst.toolCount > 0) {
        totalToolCount = diskEst.toolCount;
        deferredCount = diskEst.toolCount;
        estTokens = diskEst.estimatedTokens;
      }
    }

    const isDisabled =
      Boolean(st.spec?.disabled) ||
      status.includes('DISABLED') ||
      st.enabled === false ||
      custEntry?.status === 'STATUS_DISABLED';
    const isError = !isDisabled && status.includes('ERROR');
    const isReady = !isDisabled && status === 'MCP_SERVER_STATUS_READY';
    const errorMessage = String(st.error || st.errorMessage || '').trim();

    const resolvedPluginName = st.spec?.pluginName || custEntry?.pluginName || '';
    const resolvedPluginDir = extractPluginDir(st.spec, custEntry);
    const resolvedPluginId =
      st.spec?.pluginId || custEntry?.pluginId || resolvedPluginDir || resolvedPluginName || '';
    return {
      serverName,
      fullServerName,
      pluginId: resolvedPluginId,
      pluginDir: resolvedPluginDir,
      pluginName: resolvedPluginName,
      configPath: st.spec?.configPath || custEntry?.path || '',
      status,
      statusBadge: isDisabled
        ? 'OFF'
        : isError
        ? 'ERROR'
        : isReady
        ? 'READY'
        : status.replace('MCP_SERVER_STATUS_', ''),
      enabled: !isDisabled,
      isError,
      errorMessage,
      toolCount: totalToolCount,
      eagerCount,
      deferredCount,
      estTokens,
      formattedTokens: formatTokenCount(estTokens),
    };
  });

  allServers.sort((a, b) =>
    a.serverName.localeCompare(b.serverName, undefined, { sensitivity: 'base' })
  );

  return {
    servers: allServers,
    counts: {
      enabledSkills,
      totalSkills,
      enabledRules,
    },
  };
}

function updateMcpConfigFile(configPath, keyCandidates, enabled) {
  if (!configPath || !existsSync(configPath)) return false;
  const parsed = readJsonFile(configPath, { strict: true });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const isWrapped =
    (parsed.mcpServers && typeof parsed.mcpServers === 'object') ||
    (parsed.servers && typeof parsed.servers === 'object');
  const serversObj = isWrapped ? parsed.mcpServers || parsed.servers : parsed;
  if (!serversObj || typeof serversObj !== 'object') return false;

  const reservedKeys = new Set(['$schema', 'version', 'description']);
  const targetKey = keyCandidates.find(
    (k) => k && (isWrapped || !reservedKeys.has(k)) && Object.hasOwn(serversObj, k)
  );
  if (!targetKey) return false;
  const entry = serversObj[targetKey];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;

  if (enabled) {
    delete entry.disabled;
  } else {
    entry.disabled = true;
  }
  writeJsonFile(configPath, parsed);
  return true;
}

export async function toggleMcpServerState(serverName, enabled, options = {}) {
  if (!serverName) throw new Error('serverName is required');
  const nextEnabled = Boolean(enabled);

  const mcpStates = await callLsRpc('GetMcpServerStates', {}, options).catch(() => ({}));
  const match = (mcpStates?.states || []).find(
    (s) => s.spec?.serverName === serverName || s.spec?.originalServerName === serverName
  );

  const configPath = match?.spec?.configPath || '';
  if (configPath) {
    const updated = updateMcpConfigFile(
      configPath,
      [match?.spec?.originalServerName, match?.spec?.serverName, serverName],
      nextEnabled
    );
    if (!updated) {
      throw new Error(`Could not update MCP server "${serverName}" in ${configPath}`);
    }
    await callLsRpc('RefreshMcpServers', { shallow: false }, { timeoutMs: 15_000, ...options }).catch(() => {});
    // Cached GetCustomizationStates carries MCP enabled/disabled status
    clearRpcCache();
    return { serverName, enabled: nextEnabled, source: 'plugin-config' };
  }

  await callLsRpc(
    'ToggleMcpServer',
    { serverName: String(serverName), enabled: nextEnabled },
    options
  );
  await callLsRpc('RefreshMcpServers', { shallow: false }, { timeoutMs: 15_000, ...options }).catch(() => {});
  clearRpcCache();
  return { serverName, enabled: nextEnabled, source: 'ls-rpc' };
}

export async function refreshMcpServerState(serverName = '', options = {}) {
  const payload = serverName
    ? { shallow: false, serverName: String(serverName) }
    : { shallow: false };
  await callLsRpc('RefreshMcpServers', payload, { timeoutMs: 15_000, ...options });
  clearRpcCache();
  return { refreshed: true, serverName: serverName || 'all' };
}
