#!/usr/bin/env node
/**
 * @fileoverview Cross-machine setup and Language Server registration script for
 * Antigravity Context Monitor, backed by antigravity-sidecar-kit/setup.
 */

import { runSidecarSetup } from 'antigravity-sidecar-kit/setup';
import { REPO_ROOT, SIDECAR_ID } from './lib/constants.mjs';

runSidecarSetup({
  sidecarId: SIDECAR_ID,
  repoRoot: REPO_ROOT,
  requiredFiles: [
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
  ],
}).catch((err) => {
  console.error(`[${SIDECAR_ID}] Setup failed: ${err.message}`);
  process.exit(1);
});
