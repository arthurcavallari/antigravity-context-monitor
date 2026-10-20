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
  testFiles: [
    'test/context-telemetry.test.mjs',
    'test/plan-quota.test.mjs',
    'test/turn-insights.test.mjs',
    'test/effort-advisor.test.mjs',
    'test/mcp-diagnostics.test.mjs',
  ],
}).catch((err) => {
  console.error(`[${SIDECAR_ID}] Setup failed: ${err.message}`);
  process.exit(1);
});
