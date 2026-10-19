/**
 * @fileoverview Connect RPC client for the local Antigravity Language Server.
 */

const DEFAULT_TIMEOUT_MS = 4000;

export function getLsConfig(overrides = {}) {
  const lsAddress = overrides.lsAddress ?? process.env.ANTIGRAVITY_LS_ADDRESS ?? '';
  const csrfToken = overrides.csrfToken ?? process.env.ANTIGRAVITY_CSRF_TOKEN ?? '';
  return { lsAddress, csrfToken };
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
