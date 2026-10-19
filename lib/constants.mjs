/**
 * @fileoverview Shared constants, context ceilings, category metadata, and JSON config helpers.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));

export const SIDECAR_ID = 'context-monitor';
export const DEFAULT_CONFIG_PATH = join(homedir(), '.gemini', 'config', 'config.json');
export const APP_STORAGE_PATH =
  process.platform === 'win32'
    ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'app_storage.json')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Antigravity', 'app_storage.json')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity', 'app_storage.json');

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

export function readJsonFile(filePath, { strict = false } = {}) {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
    const parsed = raw ? JSON.parse(raw) : {};
    if (strict && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new Error(`Invalid JSON object in ${filePath}`);
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (strict) throw err;
    return {};
  }
}

export function writeJsonFile(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
