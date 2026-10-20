/**
 * @fileoverview Shared constants, context ceilings, category metadata, and JSON config helpers.
 */

import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_STORAGE_PATH,
  CONFIG_JSON_PATH,
  DEFAULT_CONFIG_PATH,
  readJsonFile,
  readJsonSafe,
  writeJsonFile,
  writeJsonNoBom,
} from 'antigravity-sidecar-kit/config';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));

export {
  APP_STORAGE_PATH,
  CONFIG_JSON_PATH,
  DEFAULT_CONFIG_PATH,
  readJsonFile,
  readJsonSafe,
  writeJsonFile,
  writeJsonNoBom,
};

export const SIDECAR_ID = 'context-monitor';

export const REPO_ROOT = process.env.SIDECAR_REPO_ROOT
  ? resolve(process.env.SIDECAR_REPO_ROOT)
  : resolve(__dirname, '..');

export const GEMINI_CONTEXT_CEILING = 256_000;   // 256k Cortex harness autocompact ceiling
export const GEMINI_NATIVE_CEILING = 1_048_576;  // 1.0M native Gemini API window
export const CLAUDE_CONTEXT_CEILING = 200_000;   // 200k tokens
export const DEFAULT_CONTEXT_CEILING = 256_000;

export const COMPACT_WARN_PCT = 80;
export const COMPACT_DANGER_PCT = 92;

export const MCP_META_TOOL_NAMES = new Set([
  'call_mcp_tool',
  'list_resources',
  'read_resource',
]);

export const CATEGORY_META = Object.freeze({
  messages: {
    id: 'messages',
    label: 'Messages',
    color: 'var(--chart-blue, #4e9de0)',
    inActiveContext: true,
  },
  systemTools: {
    id: 'systemTools',
    label: 'System tools',
    color: 'var(--chart-purple, #9b59b6)',
    inActiveContext: true,
  },
  systemPrompt: {
    id: 'systemPrompt',
    label: 'System prompt',
    color: '#2ec4b6',
    inActiveContext: true,
  },
  skills: {
    id: 'skills',
    label: 'Skills',
    color: 'var(--chart-yellow, #b5a642)',
    inActiveContext: true,
  },
  mcpToolsActive: {
    id: 'mcpToolsActive',
    label: 'MCP tools',
    color: 'var(--chart-green, #388a34)',
    inActiveContext: true,
  },
  mcpToolsDeferred: {
    id: 'mcpToolsDeferred',
    label: 'MCP tools (deferred)',
    color: '#64748b',
    inActiveContext: false,
  },
  freeSpace: {
    id: 'freeSpace',
    label: 'Free space (to compact)',
    color: 'transparent',
    inActiveContext: false,
  },
});
