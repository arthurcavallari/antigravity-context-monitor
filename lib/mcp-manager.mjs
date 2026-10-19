/**
 * @fileoverview MCP server lifecycle controls (standalone + plugin mcp_config.json)
 * and customization state aggregation (GetCustomizationStates).
 */

import { existsSync } from 'node:fs';
import { readJsonFile, writeJsonFile } from './constants.mjs';
import { callLsRpc } from './rpc-client.mjs';
import { formatTokenCount } from './session-resolver.mjs';

export function estimateToolTokens(tool = {}, tokensPerChar = 0.28) {
  const rawLen =
    (tool.name || '').length +
    (tool.description || '').length +
    (tool.jsonSchemaString || '').length;
  return Math.round(rawLen * tokensPerChar);
}

export function buildMcpAndCustomizationsCatalog(
  mcpStatesResponse = {},
  customizationStatesResponse = {},
  tokensPerChar = 0.28
) {
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
      estTokens += estimateToolTokens(tool, tokensPerChar);
    }

    const isDisabled =
      Boolean(st.spec?.disabled) ||
      status.includes('DISABLED') ||
      st.enabled === false ||
      custEntry?.status === 'STATUS_DISABLED';
    const isError = !isDisabled && status.includes('ERROR');
    const isReady = !isDisabled && status === 'MCP_SERVER_STATUS_READY';
    const errorMessage = String(st.error || st.errorMessage || '').trim();

    return {
      serverName,
      fullServerName,
      pluginName: st.spec?.pluginName || custEntry?.pluginName || '',
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
      toolCount: tools.length,
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
  const serversObj = parsed?.mcpServers;
  if (!serversObj || typeof serversObj !== 'object') return false;

  const targetKey = keyCandidates.find((k) => k && Object.hasOwn(serversObj, k));
  if (!targetKey) return false;

  if (enabled) {
    delete serversObj[targetKey].disabled;
  } else {
    serversObj[targetKey].disabled = true;
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
    await callLsRpc('RefreshMcpServers', { shallow: false }, options);
    return { serverName, enabled: nextEnabled, source: 'plugin-config' };
  }

  await callLsRpc(
    'ToggleMcpServer',
    { serverName: String(serverName), enabled: nextEnabled },
    options
  );
  await callLsRpc('RefreshMcpServers', { shallow: false }, options).catch(() => {});
  return { serverName, enabled: nextEnabled, source: 'ls-rpc' };
}

export async function refreshMcpServerState(serverName = '', options = {}) {
  const payload = serverName
    ? { shallow: false, serverName: String(serverName) }
    : { shallow: false };
  await callLsRpc('RefreshMcpServers', payload, options);
  return { refreshed: true, serverName: serverName || 'all' };
}
