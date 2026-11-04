/**
 * @fileoverview MCP tool definitions and StateSync mutator wiring for Context Monitor (<= 80 lines).
 */
import { fetchFullTelemetry } from './context-telemetry.mjs';
import { setAiCreditsOverageSetting } from './plan-quota.mjs';
import { toggleMcpServerState, refreshMcpServerState } from './mcp-manager.mjs';
import { closeTerminalById, restartSidecarById } from './diagnostics.mjs';

const defTool = (name, description, properties, required) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, ...(required ? { required } : {}) },
});

export const MCP_TOOLS = [
  defTool('get_context_telemetry', 'Fetch context window breakdown, prompt fit advisor, MCP catalog, and quota telemetry.', {
    cascadeId: { type: 'string' },
    hostCascadeId: { type: 'string' },
    workspaceUris: { type: 'array', items: { type: 'string' } },
  }),
  defTool(
    'toggle_mcp_server',
    'Enable or disable an MCP server.',
    { serverName: { type: 'string' }, enabled: { type: 'boolean' } },
    ['serverName', 'enabled']
  ),
  defTool('refresh_mcp_servers', 'Reload MCP server definitions.', { serverName: { type: 'string' } }),
  defTool('set_ai_credits_overage', 'Toggle AI credit overages setting.', { enabled: { type: 'boolean' } }, ['enabled']),
  defTool('restart_sidecar', 'Restart a sidecar process by ID.', { id: { type: 'string' }, sidecarId: { type: 'string' } }),
  defTool('close_terminal', 'Terminate a background terminal by ID.', { id: { type: 'string' }, terminalId: { type: 'string' } }),
];

export function createMonitorMutators(rpcOpts = {}, overrides = {}) {
  return {
    'mcp-toggle': (p) => toggleMcpServerState(String(p?.serverName || ''), Boolean(p?.enabled), rpcOpts),
    'mcp-refresh': (p) => refreshMcpServerState(String(p?.serverName || ''), rpcOpts),
    'ai-credits-toggle': (p) => setAiCreditsOverageSetting(Boolean(p?.enabled), rpcOpts),
    'restart-sidecar': (p) => restartSidecarById(String(p?.id || p?.sidecarId || ''), rpcOpts),
    'close-terminal': (p) => closeTerminalById(String(p?.id || p?.terminalId || ''), rpcOpts),
    ...overrides,
  };
}

export async function handleToolCall(name, args = {}, ctx = {}, deps = {}) {
  const { getSync, rpcOpts = {}, fetchTelemetry = fetchFullTelemetry, onCascadeId } = deps;
  if (name === 'get_context_telemetry') {
    const res = await fetchTelemetry({
      ...rpcOpts,
      cascadeId: String(args?.cascadeId || ''),
      hostCascadeId: String(args?.hostCascadeId || ctx?.conversationId || ''),
      workspaceUris: Array.isArray(args?.workspaceUris) ? args.workspaceUris : [],
    });
    if (res?.session?.cascadeId) onCascadeId?.(res.session.cascadeId);
    return res;
  }
  const map = {
    toggle_mcp_server: ['mcp-toggle', { serverName: String(args?.serverName || ''), enabled: Boolean(args?.enabled) }],
    refresh_mcp_servers: ['mcp-refresh', { serverName: String(args?.serverName || '') }],
    set_ai_credits_overage: ['ai-credits-toggle', { enabled: Boolean(args?.enabled) }],
    restart_sidecar: ['restart-sidecar', { id: String(args?.id || args?.sidecarId || '') }],
    close_terminal: ['close-terminal', { id: String(args?.id || args?.terminalId || '') }],
  };
  if (!map[name]) throw new Error(`Unknown MCP tool: ${name}`);
  return getSync().mutate(map[name][0], map[name][1]);
}

export const buildMcpTools = (deps) => MCP_TOOLS.map((t) => ({ ...t, handler: (a, c) => handleToolCall(t.name, a, c, deps) }));

export const checkMonitorAuth = (sync, d, ctx = {}) => sync.checkAuth(d, ctx);
