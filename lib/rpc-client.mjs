/**
 * @fileoverview Connect RPC client and process restart helper for the local Antigravity Language Server.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SIDECAR_ID } from './constants.mjs';

const DEFAULT_TIMEOUT_MS = 4000;
const SIDECAR_DATA_ROOT = join(homedir(), '.gemini', 'antigravity', 'sidecar_data');

function persistSidecarRuntime() {
  if (!process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || !process.env.ANTIGRAVITY_LS_ADDRESS) return;
  try {
    const dir = join(SIDECAR_DATA_ROOT, SIDECAR_ID, 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'runtime.json'),
      JSON.stringify({
        pid: process.pid,
        webPort: Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) || 0,
        lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS,
        csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN || '',
      }) + '\n',
      'utf8'
    );
  } catch {
    // Non-fatal if sidecar_data is read-only
  }
}

persistSidecarRuntime();

function readCachedLsCredentials() {
  const candidates = [SIDECAR_ID, 'hangar', 'context-monitor'];
  try {
    if (existsSync(SIDECAR_DATA_ROOT)) {
      for (const entry of readdirSync(SIDECAR_DATA_ROOT)) {
        if (!candidates.includes(entry)) candidates.push(entry);
      }
    }
  } catch {
    // ignore
  }
  for (const id of candidates) {
    try {
      const p = join(SIDECAR_DATA_ROOT, id, 'data', 'runtime.json');
      if (!existsSync(p)) continue;
      const data = JSON.parse(readFileSync(p, 'utf8'));
      if (data?.lsAddress && data?.csrfToken) {
        return { lsAddress: String(data.lsAddress), csrfToken: String(data.csrfToken) };
      }
    } catch {
      // ignore
    }
  }
  return { lsAddress: '', csrfToken: '' };
}

export function getLsConfig(overrides = {}) {
  let lsAddress = overrides.lsAddress ?? process.env.ANTIGRAVITY_LS_ADDRESS ?? '';
  let csrfToken = overrides.csrfToken ?? process.env.ANTIGRAVITY_CSRF_TOKEN ?? '';
  if ((!lsAddress || !csrfToken) && overrides.lsAddress === undefined) {
    const cached = readCachedLsCredentials();
    if (!lsAddress) lsAddress = cached.lsAddress;
    if (!csrfToken) csrfToken = cached.csrfToken;
  }
  return { lsAddress, csrfToken };
}

export function killSidecarProcessByPortOrPid(sidecarId = SIDECAR_ID) {
  let port = 0;
  try {
    const rtPath = join(SIDECAR_DATA_ROOT, sidecarId, 'data', 'runtime.json');
    if (existsSync(rtPath)) {
      const rt = JSON.parse(readFileSync(rtPath, 'utf8'));
      if (rt?.pid && Number(rt.pid) > 0 && Number(rt.pid) !== process.pid) {
        try {
          process.kill(Number(rt.pid), 'SIGTERM');
          return { restarted: true, method: `pid:${rt.pid}` };
        } catch {
          // Process already exited; fall through to log port check
        }
      }
      if (rt?.webPort) port = Number(rt.webPort);
    }
  } catch {
    // ignore
  }

  if (!port) {
    try {
      const logPath = join(SIDECAR_DATA_ROOT, sidecarId, 'logs', 'sidecar.log');
      if (existsSync(logPath)) {
        const text = readFileSync(logPath, 'utf8');
        const matches = [...text.matchAll(/listening on 127\.0\.0\.1:(\d+)/g)];
        if (matches.length > 0) {
          port = Number(matches[matches.length - 1][1]);
        }
      }
    } catch {
      // ignore
    }
  }

  if (!port) return { restarted: false };

  try {
    const rawOut =
      process.platform === 'win32'
        ? execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
          )
        : execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
    const pids = rawOut
      .split(/\r?\n/)
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    if (pids.length > 0) {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // ignore
        }
      }
      return { restarted: true, method: `port:${port}->pid:${pids.join(',')}` };
    }
  } catch {
    // ignore
  }
  return { restarted: false };
}

export async function callLsRpc(method, body = {}, options = {}) {
  const { lsAddress, csrfToken } = getLsConfig(options);
  if (!lsAddress || !csrfToken) {
    throw new Error('Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN');
  }

  const fetchImpl = options.fetchFn || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `http://${lsAddress}/exa.language_server_pb.LanguageServerService/${method}`;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': csrfToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  let parsed = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from LanguageServerService/${method} (HTTP ${res.status})`);
    }
  }

  if (!res.ok) {
    const msg = parsed?.message || parsed?.error || `HTTP ${res.status}`;
    throw new Error(`LanguageServerService/${method} failed: ${msg}`);
  }

  return parsed;
}
