#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SIDECAR_ID,
  REPO_ROOT,
  DEFAULT_CONFIG_PATH,
  readJsonFile,
  writeJsonFile,
} from './lib/constants.mjs';
import { callLsRpc, getLsConfig, killSidecarProcessByPortOrPid } from './lib/rpc-client.mjs';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));
const SIDECAR_DIR = __dirname;

const GLOBAL_CONFIG_DIR = dirname(DEFAULT_CONFIG_PATH);
const GLOBAL_SIDECARS_DIR = join(GLOBAL_CONFIG_DIR, 'sidecars');
const JUNCTION_PATH = join(GLOBAL_SIDECARS_DIR, SIDECAR_ID);
const HANGAR_PACKAGES_DIR = join(homedir(), '.gemini', 'hangar', 'packages');

const args = new Set(process.argv.slice(2));
const isUninstall = args.has('--uninstall');
const skipTests = args.has('--skip-tests');

function resolvePermanentLinkSource(sourceDir) {
  if (!/[\\/]_npx[\\/]|[\\/]node_modules[\\/]/i.test(sourceDir)) {
    return sourceDir;
  }
  const pkgJson = readJsonFile(join(sourceDir, 'package.json'));
  const ver = String(pkgJson.version || '1.0.0').replace(/[^a-z0-9._-]+/gi, '');
  const destDir = join(HANGAR_PACKAGES_DIR, `${SIDECAR_ID}@${ver}`);
  mkdirSync(HANGAR_PACKAGES_DIR, { recursive: true });
  rmSync(destDir, { recursive: true, force: true });
  cpSync(sourceDir, destDir, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(sourceDir.length);
      return !/[\\/]\.git([\\/]|$)|[\\/]node_modules([\\/]|$)/.test(rel);
    },
  });
  return realpathSync(destDir);
}

function removeLinkOrDir(targetPath) {
  let stat;
  try {
    stat = lstatSync(targetPath);
  } catch {
    return false;
  }
  try {
    if (stat.isSymbolicLink()) {
      unlinkSync(targetPath);
    } else {
      rmSync(targetPath, { recursive: true, force: true });
    }
  } catch {
    rmSync(targetPath, { recursive: true, force: true });
  }
  return true;
}

async function callManageSidecar(action) {
  const { lsAddress, csrfToken } = getLsConfig();
  if (!lsAddress || !csrfToken) {
    return {
      notified: false,
      reason: 'linked & enabled in config.json — select Context Monitor in the Antigravity Auxiliary Pane',
    };
  }
  const body = await callLsRpc('ManageSidecar', { action, sidecarId: SIDECAR_ID });
  return { notified: true, body };
}

async function main() {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 20) {
    throw new Error(
      `Node.js >= 20.0.0 is required (current: ${process.version}). Switch Node versions (e.g. "nvm use 22") and try again.`
    );
  }
  console.log(`[${SIDECAR_ID}] Sidecar directory : ${SIDECAR_DIR}`);
  console.log(`[${SIDECAR_ID}] Repository root   : ${REPO_ROOT}`);

  if (isUninstall) {
    const isInPlaceCheckout =
      existsSync(JUNCTION_PATH) &&
      realpathSync(JUNCTION_PATH) === SIDECAR_DIR &&
      !lstatSync(JUNCTION_PATH).isSymbolicLink();
    if (isInPlaceCheckout) {
      console.log(`[${SIDECAR_ID}] Preserving in-place repository directory at ${JUNCTION_PATH}.`);
    } else {
      removeLinkOrDir(JUNCTION_PATH);
    }
    if (existsSync(DEFAULT_CONFIG_PATH)) {
      const cfg = readJsonFile(DEFAULT_CONFIG_PATH);
      if (cfg.sidecars && typeof cfg.sidecars === 'object' && cfg.sidecars[SIDECAR_ID]) {
        cfg.sidecars[SIDECAR_ID].enabled = false;
      }
      writeJsonFile(DEFAULT_CONFIG_PATH, cfg);
    }
    await callManageSidecar('SIDECAR_ACTION_DISABLE').catch(() => {});
    console.log(`[${SIDECAR_ID}] Uninstalled cleanly.`);
    return;
  }

  const requiredFiles = [
    'sidecar.json',
    'server.mjs',
    'ui/index.html',
    'ui/styles.css',
    'ui/components.css',
    'ui/core.js',
    'ui/app.js',
    'ui/components/context-tab.js',
    'ui/components/context-drawers.js',
    'ui/components/mcp-budgets-tab.js',
    'ui/components/diagnostics-tab.js',
  ];
  for (const rel of requiredFiles) {
    const full = join(SIDECAR_DIR, rel);
    if (!existsSync(full)) {
      throw new Error(`Missing required file: ${full}`);
    }
  }

  if (!skipTests) {
    console.log(`[${SIDECAR_ID}] Running unit tests...`);
    execFileSync(
      process.execPath,
      [
        '--test',
        join(SIDECAR_DIR, 'test', 'context-telemetry.test.mjs'),
        join(SIDECAR_DIR, 'test', 'plan-quota.test.mjs'),
        join(SIDECAR_DIR, 'test', 'turn-insights.test.mjs'),
        join(SIDECAR_DIR, 'test', 'effort-advisor.test.mjs'),
        join(SIDECAR_DIR, 'test', 'mcp-diagnostics.test.mjs'),
        join(SIDECAR_DIR, 'test', 'theme.test.mjs'),
      ],
      { cwd: SIDECAR_DIR, stdio: 'inherit' }
    );
  }

  const targetSourceDir = resolvePermanentLinkSource(SIDECAR_DIR);
  mkdirSync(GLOBAL_SIDECARS_DIR, { recursive: true });
  const alreadyLinked =
    existsSync(JUNCTION_PATH) && realpathSync(JUNCTION_PATH) === targetSourceDir;
  if (!alreadyLinked) {
    removeLinkOrDir(JUNCTION_PATH);
    symlinkSync(targetSourceDir, JUNCTION_PATH, process.platform === 'win32' ? 'junction' : 'dir');
  }
  console.log(`[${SIDECAR_ID}] Linked ${JUNCTION_PATH} -> ${realpathSync(JUNCTION_PATH)}`);

  const cfg = readJsonFile(DEFAULT_CONFIG_PATH);
  if (!cfg.sidecars || typeof cfg.sidecars !== 'object') {
    cfg.sidecars = {};
  }
  const existingEntry = cfg.sidecars[SIDECAR_ID] || {};
  if (existingEntry.enabled !== true) {
    cfg.sidecars[SIDECAR_ID] = {
      ...existingEntry,
      enabled: true,
    };
    writeJsonFile(DEFAULT_CONFIG_PATH, cfg);
  }

  let rpcRes = await callManageSidecar('SIDECAR_ACTION_RESTART').catch((err) => ({
    notified: false,
    reason: err.message,
  }));
  if (!rpcRes.notified) {
    rpcRes = await callManageSidecar('SIDECAR_ACTION_ENABLE').catch((err) => ({
      notified: false,
      reason: err.message,
    }));
  }
  if (!rpcRes.notified) {
    const killed = killSidecarProcessByPortOrPid(SIDECAR_ID);
    if (killed.restarted) {
      rpcRes = { notified: true, viaProcessRestart: killed.method };
    }
  }
  console.log(
    rpcRes.notified
      ? `[${SIDECAR_ID}] Enabled and restarted (${rpcRes.viaProcessRestart || 'Language Server RPC'}).`
      : `[${SIDECAR_ID}] Setup complete (${rpcRes.reason || 'ready'}).`
  );
}

main().catch((err) => {
  console.error(`[${SIDECAR_ID}] Setup failed: ${err.message}`);
  process.exit(1);
});
