import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatCeilingCount,
  formatTokenCount,
  resolveModelMetadata,
  selectActiveTrajectory,
} from '../lib/session-resolver.mjs';
import { computeContextTelemetry, fetchFullTelemetry } from '../lib/context-telemetry.mjs';
import { clearRpcCache } from '../lib/rpc-cache.mjs';
import { setAiCreditsOverageSetting } from '../lib/plan-quota.mjs';
import {
  GEMINI_CONTEXT_CEILING,
  GEMINI_NATIVE_CEILING,
  CLAUDE_CONTEXT_CEILING,
} from '../lib/constants.mjs';

test('resolveModelMetadata sets 256k harness ceiling (1.0M native) for Gemini, 200k for Claude, and honors live maxContextTokens', () => {
  const modelConfigData = {
    clientModelConfigs: [
      {
        label: 'Gemini 3.8 Flash (High)',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
        modelId: 'gemini-3.8-flash-high',
      },
      {
        label: 'Claude Sonnet 5.5 (High)',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M405' },
        modelId: 'claude-sonnet-5-5-high',
      },
    ],
  };

  const geminiMeta = resolveModelMetadata(modelConfigData, {
    plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M318' },
  });
  assert.equal(geminiMeta.ceiling, GEMINI_CONTEXT_CEILING);
  assert.equal(geminiMeta.ceilingFormatted, '256k');
  assert.equal(geminiMeta.nativeCeiling, GEMINI_NATIVE_CEILING);
  assert.equal(geminiMeta.nativeCeilingFormatted, '1.0M');
  assert.equal(geminiMeta.badgeLabel, 'Gemini 3.8 Flash (High)');
  assert.equal(geminiMeta.thinkingEffort, 'High');

  const liveOverrideMeta = resolveModelMetadata(modelConfigData, {
    plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M318' },
    chatModel: {
      chatStartMetadata: {
        contextWindowMetadata: { maxContextTokens: 512000 },
      },
    },
  });
  assert.equal(liveOverrideMeta.ceiling, 512000);
  assert.equal(liveOverrideMeta.ceilingFormatted, '512k');
  assert.equal(liveOverrideMeta.nativeCeiling, GEMINI_NATIVE_CEILING);

  const claudeMeta = resolveModelMetadata(modelConfigData, {
    plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M405' },
  });
  assert.equal(claudeMeta.ceiling, CLAUDE_CONTEXT_CEILING);
  assert.equal(claudeMeta.ceilingFormatted, '200k');
  assert.equal(claudeMeta.nativeCeiling, CLAUDE_CONTEXT_CEILING);
  assert.equal(claudeMeta.badgeLabel, 'Claude Sonnet 5.5 (High)');
  assert.equal(claudeMeta.thinkingEffort, 'High');
});

test('selectActiveTrajectory prioritizes most recently viewed root conversation tab', () => {
  const mockTrajs = {
    trajectorySummaries: {
      'conv-old': {
        summary: 'Older Tab',
        status: 'CASCADE_RUN_STATUS_IDLE',
        annotations: { title: 'Older Tab', lastUserViewTime: '2026-10-15T10:00:00Z' },
        trajectoryMetadata: { rootConversationId: 'conv-old' },
      },
      'conv-active': {
        summary: 'Active Tab',
        status: 'CASCADE_RUN_STATUS_IDLE',
        annotations: { title: 'Active Tab', lastUserViewTime: '2026-10-15T16:55:00Z' },
        trajectoryMetadata: { rootConversationId: 'conv-active' },
      },
      'subagent-1': {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        trajectoryMetadata: { rootConversationId: 'conv-active' },
      },
    },
  };

  const result = selectActiveTrajectory(mockTrajs);
  assert.equal(result.activeSession.cascadeId, 'conv-active');
  assert.equal(result.isExecuting, true);
  assert.equal(result.sessions.length, 2);
});

test('selectActiveTrajectory resolves workspaceUris and breaks lastUserViewTime ties via lastUserInputTime', () => {
  const mockTrajs = {
    trajectorySummaries: {
      'conv-a': {
        summary: 'Project A',
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastUserInputTime: '2026-10-17T10:12:00.000000000Z',
        lastModifiedTime: '2026-10-17T10:16:00.000000000Z',
        annotations: { title: 'Project A', lastUserViewTime: '2026-10-17T10:15:23.021Z' },
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/Users/dev/project-alpha' }],
        trajectoryMetadata: { rootConversationId: 'conv-a' },
      },
      'conv-b': {
        summary: 'Project B',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        lastUserInputTime: '2026-10-17T10:15:20.000000000Z',
        lastModifiedTime: '2026-10-17T10:16:08.000000000Z',
        annotations: { title: 'Project B', lastUserViewTime: '2026-10-17T10:15:23.021Z' },
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///d%3A/workspace/service-beta' }],
        trajectoryMetadata: { rootConversationId: 'conv-b' },
      },
      'conv-c': {
        summary: 'Context Monitor',
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastUserInputTime: '2026-10-17T10:10:00.000000000Z',
        lastModifiedTime: '2026-10-17T10:11:00.000000000Z',
        annotations: { title: 'Context Monitor', lastUserViewTime: '2026-10-17T10:14:00.000Z' },
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///C:/Users/dev/projects/antigravity-context-monitor' }],
        trajectoryMetadata: { rootConversationId: 'conv-c' },
      },
    },
  };

  // 1. Tie-breaker on identical lastUserViewTime selects conv-b (newer lastUserInputTime) over conv-a
  const tieResult = selectActiveTrajectory(mockTrajs);
  assert.equal(tieResult.activeSession.cascadeId, 'conv-b');

  // 2. Live workspaceUris from window.sidecar.onWorkspaceChange selects matching workspace session even if lastUserViewTime wasn't updated (e.g. unfocused window)
  const wsResult = selectActiveTrajectory(mockTrajs, {
    workspaceUris: ['file:///c%3A/Users/dev/projects/antigravity-context-monitor'],
  });
  assert.equal(wsResult.activeSession.cascadeId, 'conv-c');

  // 3. Explicit user pin overrides workspaceUris and hostCascadeId
  const pinResult = selectActiveTrajectory(mockTrajs, {
    requestedCascadeId: 'conv-a',
    hostCascadeId: 'conv-b',
    workspaceUris: ['file:///d:/workspace/service-beta'],
  });
  assert.equal(pinResult.activeSession.cascadeId, 'conv-a');
});

test('computeContextTelemetry derives exact working memory against 256k ceiling and computes compactionRisk', () => {
  const generatorMetadataList = [
    {
      chatModel: {
        usage: {
          inputTokens: '10891',
          cacheReadTokens: '130000',
          outputTokens: '512',
        },
        chatStartMetadata: {
          contextWindowMetadata: {
            maxContextTokens: 256000,
            estimatedTokensUsed: 135000,
            tokenBreakdown: {
              groups: [
                {
                  type: 'TOKEN_TYPE_SYSTEM_PROMPT',
                  numTokens: 8400,
                  children: [
                    { name: 'identity', numTokens: 5000 },
                    { name: 'skills', numTokens: 2900 },
                    { name: 'mcp_servers', numTokens: 500 },
                  ],
                },
                {
                  type: 'TOKEN_TYPE_TOOLS',
                  numTokens: 9400,
                  children: [
                    { name: 'view_file', numTokens: 8400 },
                    { name: 'mcp_test_tool', numTokens: 1000 },
                  ],
                },
                {
                  type: 'TOKEN_TYPE_CHAT_MESSAGES',
                  numTokens: 115000,
                },
              ],
            },
          },
        },
      },
    },
  ];

  const mcpStates = {
    states: [
      {
        spec: { serverName: 'code-index', toolConfig: {} },
        tools: [{ name: 'search_symbols', description: 'Search workspace symbols', jsonSchemaString: '{}' }],
      },
    ],
  };

  const telemetry = computeContextTelemetry(generatorMetadataList, mcpStates, {
    ceiling: GEMINI_CONTEXT_CEILING,
    ceilingFormatted: '256k',
    nativeCeiling: GEMINI_NATIVE_CEILING,
    nativeCeilingFormatted: '1.0M',
  });

  // 10,891 + 130,000 = 140,891 exact tokens out of 256,000 (55.0%)
  assert.equal(telemetry.totalUsedTokens, 140891);
  assert.equal(telemetry.formattedUsed, '140.9k');
  assert.equal(telemetry.formattedCeiling, '256k');
  assert.equal(telemetry.formattedNativeCeiling, '1.0M');
  assert.equal(telemetry.formattedUsedPct, '55.0%');
  assert.equal(telemetry.compactionRisk, 'normal');

  const byId = Object.fromEntries(telemetry.categories.map((c) => [c.id, c]));
  assert.equal(byId.autocompactBuffer, undefined);
  assert.equal(byId.systemPrompt.tokens, 5000);
  assert.equal(byId.skills.tokens, 2900);
  assert.equal(byId.systemTools.tokens, 8400);
  assert.equal(byId.mcpToolsActive.tokens, 1500);
  assert.equal(byId.messages.tokens, 123091);
  assert.equal(byId.freeSpace.tokens, GEMINI_CONTEXT_CEILING - 140891);

  const warnTelemetry = computeContextTelemetry(
    [{ chatModel: { usage: { inputTokens: '10000', cacheReadTokens: '200000' } } }],
    {},
    { ceiling: 256000, ceilingFormatted: '256k' }
  );
  assert.equal(warnTelemetry.compactionRisk, 'warn');

  const dangerTelemetry = computeContextTelemetry(
    [{ chatModel: { usage: { inputTokens: '10000', cacheReadTokens: '230000' } } }],
    {},
    { ceiling: 256000, ceilingFormatted: '256k' }
  );
  assert.equal(dangerTelemetry.compactionRisk, 'danger');

  // When realWorkingMemoryTokens < staticTokens, mcpToolsActiveTokens is scaled proportionally so active categories never exceed totalUsedTokens
  const scaledTelemetry = computeContextTelemetry(
    [
      {
        chatModel: {
          usage: { inputTokens: '4000', cacheReadTokens: '0' },
          chatStartMetadata: {
            contextWindowMetadata: {
              tokenBreakdown: {
                groups: [
                  {
                    type: 'TOKEN_TYPE_SYSTEM_PROMPT',
                    children: [
                      { name: 'identity', numTokens: 4000 },
                      { name: 'mcp_servers', numTokens: 2000 },
                    ],
                  },
                  {
                    type: 'TOKEN_TYPE_TOOLS',
                    children: [
                      { name: 'view_file', numTokens: 2000 },
                      { name: 'mcp_eager_tool', numTokens: 2000 },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    ],
    {},
    { ceiling: 256000, ceilingFormatted: '256k' }
  );
  const activeSum = scaledTelemetry.categories
    .filter((c) => c.inActiveContext)
    .reduce((sum, c) => sum + c.tokens, 0);
  assert.equal(activeSum, scaledTelemetry.totalUsedTokens);
});

test('fetchFullTelemetry orchestrates all RPCs and resolves theme and planUsage without error', async () => {
  const full = await fetchFullTelemetry({
    lsAddress: '127.0.0.1:59999',
    csrfToken: 'mock-csrf',
    configPath: join(tmpdir(), 'nonexistent-agy-config.json'),
    fetchFn: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    }),
  });
  assert.equal(typeof full.timestamp, 'string');
  assert.equal(typeof full.theme.mode, 'string');
  assert.equal(typeof full.context.totalUsedTokens, 'number');
  assert.equal(typeof full.planUsage.aiCredits.useAiCredits, 'boolean');
});


// Fake Language Server: counts calls per method and answers from a mutable trajectory state
function fakeLs(lsAddress) {
  const calls = {};
  const ls = {
    calls,
    fail: new Set(),
    summary: { stepCount: 10, lastModifiedTime: '2026-10-21T10:00:00Z', status: 'CASCADE_RUN_STATUS_IDLE' },
    options: {
      lsAddress,
      csrfToken: 'mock-csrf',
      configPath: join(tmpdir(), 'nonexistent-agy-config.json'),
      hostCascadeId: 'conv-1',
      fetchFn: async (url) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        calls[method] = (calls[method] || 0) + 1;
        if (ls.fail.has(method)) return { ok: false, status: 503, text: async () => '{}' };
        let body = {};
        if (method === 'GetAllCascadeTrajectories') {
          body = { trajectorySummaries: { 'conv-1': { summary: 'Conv 1', ...ls.summary } } };
        } else if (method === 'GetCascadeTrajectorySteps') {
          body = { steps: Array.from({ length: ls.summary.stepCount }, () => ({ type: 'CORTEX_STEP_TYPE_USER_INPUT' })) };
        } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          body = { generatorMetadata: [{ chatModel: { usage: { inputTokens: ls.summary.stepCount * 100 } } }] };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      },
    },
  };
  return ls;
}

test('fetchFullTelemetry serves reads from the shared TTL cache without caching failures', async () => {
  const ls = fakeLs('127.0.0.1:59997');
  ls.fail.add('GetUserStatus');
  await fetchFullTelemetry(ls.options);
  ls.fail.clear();
  await fetchFullTelemetry(ls.options);
  for (const m of [
    'GetAllCascadeTrajectories',
    'GetMcpServerStates',
    'GetCascadeModelConfigData',
    'GetCustomizationStates',
    'RetrieveUserQuotaSummary',
  ]) {
    assert.equal(ls.calls[m], 1, m);
  }
  assert.equal(ls.calls.GetUserStatus, 2);

  clearRpcCache();
  await fetchFullTelemetry(ls.options);
  assert.equal(ls.calls.GetCustomizationStates, 2);
  assert.equal(ls.calls.GetUserStatus, 3);
});

test('concurrent telemetry polls from several iframes share one request per RPC', async () => {
  const ls = fakeLs('127.0.0.1:59996');
  const results = await Promise.all([1, 2, 3].map(() => fetchFullTelemetry(ls.options)));
  assert.ok(Object.keys(ls.calls).length >= 8);
  for (const [method, n] of Object.entries(ls.calls)) assert.equal(n, 1, method);
  assert.equal(results[2].context.totalUsedTokens, 1000);
  assert.equal(results[0].session.cascadeId, 'conv-1');
});

test('steps and generator metadata are only re-fetched when the trajectory changes', async () => {
  const ls = fakeLs('127.0.0.1:59995');
  const first = await fetchFullTelemetry(ls.options);
  assert.equal(first.context.totalUsedTokens, 1000);

  // GetAllCascadeTrajectories refreshes (cache expired) but nothing changed: no detail re-fetch
  clearRpcCache();
  await fetchFullTelemetry(ls.options);
  assert.equal(ls.calls.GetAllCascadeTrajectories, 2);
  assert.equal(ls.calls.GetCascadeTrajectorySteps, 1);
  assert.equal(ls.calls.GetCascadeTrajectoryGeneratorMetadata, 1);

  // Each of step count, last-modified time and status counts as a change
  const changes = [
    { stepCount: 11 },
    { lastModifiedTime: '2026-10-21T10:00:05Z' },
    { status: 'CASCADE_RUN_STATUS_RUNNING' },
  ];
  for (const [i, change] of changes.entries()) {
    Object.assign(ls.summary, change);
    clearRpcCache();
    const res = await fetchFullTelemetry(ls.options);
    assert.equal(ls.calls.GetCascadeTrajectorySteps, 2 + i);
    assert.equal(res.context.totalUsedTokens, ls.summary.stepCount * 100);
  }
  assert.equal(ls.calls.GetCascadeTrajectoryGeneratorMetadata, 4);

  // A failed detail fetch is retried on the next poll even though the trajectory did not change
  ls.summary.stepCount = 12;
  ls.fail.add('GetCascadeTrajectorySteps');
  clearRpcCache();
  await fetchFullTelemetry(ls.options);
  ls.fail.clear();
  const retried = await fetchFullTelemetry(ls.options);
  assert.equal(ls.calls.GetCascadeTrajectorySteps, 6);
  assert.equal(retried.context.totalUsedTokens, 1200);
});

test('toggling AI credits invalidates the cached quota and user status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-credits-'));
  try {
    const ls = fakeLs('127.0.0.1:59994');
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, '{}', 'utf8');
    await fetchFullTelemetry(ls.options);
    await setAiCreditsOverageSetting(true, { ...ls.options, configPath });
    await fetchFullTelemetry(ls.options);
    assert.equal(ls.calls.GetUserStatus, 2);
    assert.equal(ls.calls.RetrieveUserQuotaSummary, 2);
    assert.equal(ls.calls.JetboxWriteState, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatTokenCount and formatCeilingCount roll over to M instead of 1000.0k', () => {
  assert.equal(formatTokenCount(999_949), '999.9k');
  assert.equal(formatTokenCount(999_999), '1.0M');
  assert.equal(formatCeilingCount(999_999), '1.0M');
  assert.equal(formatCeilingCount(200_000), '200k');
  assert.equal(formatCeilingCount(1_048_576), '1.0M');
});
