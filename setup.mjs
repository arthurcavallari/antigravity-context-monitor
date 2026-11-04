#!/usr/bin/env node
/**
 * @fileoverview Cross-machine setup and Language Server registration script for
 * Antigravity Context Monitor, backed by antigravity-sidecar-kit/setup.
 */

import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runSidecarSetup } from 'antigravity-sidecar-kit/setup';
import { REPO_ROOT, SIDECAR_ID } from './lib/constants.mjs';

function syncLocalSidecarKit() {
  if (process.env.ANTIGRAVITY_DEV_SYNC_KIT !== '1') return;
  const siblingKitLib = join(REPO_ROOT, '..', 'antigravity-sidecar-kit', 'lib');
  const localKitLib = join(REPO_ROOT, 'node_modules', 'antigravity-sidecar-kit', 'lib');
  if (existsSync(siblingKitLib) && existsSync(join(REPO_ROOT, 'node_modules', 'antigravity-sidecar-kit'))) {
    cpSync(siblingKitLib, localKitLib, { recursive: true });
    console.log(`[${SIDECAR_ID}] Synced sibling antigravity-sidecar-kit/lib -> ${localKitLib}`);
  }
}

runSidecarSetup({
  sidecarId: SIDECAR_ID,
  displayName: 'Antigravity Context Monitor',
  port: 52320,
  sidecarDir: REPO_ROOT,
  repoRoot: REPO_ROOT,
  entryScript: 'launch.mjs',
  requiredFiles: [
    'sidecar.json',
    'launch.mjs',
    'server.mjs',
    'ui/index.html',
    'ui/styles.css',
    'ui/components.css',
    'ui/core.js',
    'ui/app.js',
    'ui/components/context-tab.js',
    'ui/components/context-drawers.js',
    'ui/components/subagent-drawer.js',
    'ui/components/mcp-budgets-tab.js',
    'ui/components/diagnostics-tab.js',
  ],
  onBeforeSetup: async () => {
    syncLocalSidecarKit();
  },
}).catch((err) => {
  console.error(`[${SIDECAR_ID}] Setup failed: ${err.message}`);
  process.exit(1);
});
