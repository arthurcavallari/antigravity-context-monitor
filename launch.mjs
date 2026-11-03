/**
 * @fileoverview Self-healing launcher for Antigravity Context Monitor.
 */
import { existsSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = realpathSync(fileURLToPath(import.meta.url)), __dirname = dirname(__filename);
const isMain = (() => { try { return realpathSync(resolve(process.argv[1])) === __filename; } catch { return false; } })();

export const LAUNCHER_CONFIG = Object.freeze({
  sidecarId: 'context-monitor',
  sidecarName: 'Antigravity Context Monitor',
  sidecarDir: __dirname,
  repoRoot: __dirname,
  entryScript: 'server.mjs',
  targetPath: join(__dirname, 'server.mjs'),
  port: 52320,
  healthPath: '/api/telemetry',
  requiredPaths: [join(__dirname, 'node_modules', 'antigravity-sidecar-kit', 'package.json'), join(__dirname, 'ui', 'index.html')],
  remediationCommand: 'npm install && npm run setup',
  registerSignalHandlers: true,
});

export async function startContextMonitorLauncher(overrides = {}) {
  const run = overrides.runLauncher || (await import('antigravity-sidecar-kit/launcher')).runSidecarLauncher;
  const env = overrides.env || process.env, port = Number(overrides.port || env.ANTIGRAVITY_SIDECAR_WEB_PORT || LAUNCHER_CONFIG.port);
  return run({ ...LAUNCHER_CONFIG, ...overrides, port, env: { ...env, ANTIGRAVITY_SIDECAR_WEB_PORT: String(port) } });
}

if (isMain) {
  try {
    process.exit((await startContextMonitorLauncher()) ?? 0);
  } catch (err) {
    const port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || LAUNCHER_CONFIG.port);
    if (!port || existsSync(join(__dirname, 'node_modules', 'antigravity-sidecar-kit', 'lib', 'launcher.mjs'))) {
      console.error('[context-monitor] Launcher failed:', err?.message || err); process.exit(1);
    }
    const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const loopbackRe = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
    const srv = createServer((req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/__launcher/retry')) {
        if (req.headers.origin && !loopbackRe.test(req.headers.origin)) {
          res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"Forbidden origin"}');
          return;
        }
        const expectedTok = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
        if (expectedTok) {
          const reqTok = req.headers['x-sidecar-token'] || new URL(req.url, 'http://127.0.0.1').searchParams.get('token');
          if (reqTok !== expectedTok) {
            res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"Unauthorized"}');
            return;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
        return void srv.close(() => process.exit(1));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><body style="font-family:system-ui;padding:24px"><h1>Context Monitor dependencies missing</h1><p>Run <code>npm install &amp;&amp; npm run setup</code> in <code>${escHtml(__dirname)}</code>, then click Retry.</p><button onclick="fetch('/__launcher/retry'+(location.search||''),{method:'POST'}).then(()=>setTimeout(()=>location.reload(),800))">Retry</button></body></html>`);
    }).listen(port, '127.0.0.1');
  }
}
