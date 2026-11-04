import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectSubagentTree,
  formatCeilingCount,
  formatDurationCompact,
  formatSubagentTitle,
  formatTokenCount,
  resolveModelMetadata,
  selectActiveTrajectory,
} from '../lib/session-resolver.mjs';
import {
  CONVERSATION_DETAIL_IDLE_MS,
  FULL_DETAIL_REFRESH_MS,
  clearConversationDetails,
  computeContextTelemetry,
  fetchFullTelemetry,
} from '../lib/context-telemetry.mjs';
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

test("selectActiveTrajectory follows the frame's own conversation, and shows nothing on a new-conversation pane", () => {
  // Switching from conv-prev to conv-open stamps both with the same lastUserViewTime, and conv-prev has
  // the newer input and the matching workspace, so any ranking would pick it
  const switched = {
    trajectorySummaries: {
      'conv-prev': {
        lastUserInputTime: '2026-10-17T10:17:00Z',
        annotations: { title: 'Prev', lastUserViewTime: '2026-10-17T10:18:00.000Z' },
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/repo' }],
      },
      'conv-open': {
        lastUserInputTime: '2026-10-17T09:00:00Z',
        annotations: { title: 'Open', lastUserViewTime: '2026-10-17T10:18:00.000Z' },
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/elsewhere' }],
      },
    },
  };
  const opts = { workspaceUris: ['file:///c:/repo'] };
  assert.equal(selectActiveTrajectory(switched, opts).activeSession.cascadeId, 'conv-prev');
  for (const id of ['conv-open', 'conv-prev', 'conv-open']) {
    assert.equal(selectActiveTrajectory(switched, { ...opts, hostCascadeId: id }).activeSession.cascadeId, id);
  }

  // A conversation the trajectory list doesn't include yet is still this frame's conversation
  const fresh = selectActiveTrajectory(switched, { ...opts, hostCascadeId: 'conv-just-created' });
  assert.equal(fresh.activeSession.cascadeId, 'conv-just-created');
  assert.equal(fresh.newConversation, false);

  // _new is Antigravity's new-conversation pane: no session, rather than another conversation's data
  const blank = selectActiveTrajectory(switched, { ...opts, hostCascadeId: '_new' });
  assert.equal(blank.activeSession, null);
  assert.equal(blank.newConversation, true);
  assert.equal(blank.sessions.length, 2);
  // ...unless the user pinned a session from the dropdown
  assert.equal(
    selectActiveTrajectory(switched, { hostCascadeId: '_new', requestedCascadeId: 'conv-prev' }).activeSession.cascadeId,
    'conv-prev'
  );
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


// Fake Language Server: counts calls per method and answers from a mutable conversation. Like the real
// one it honors stepOffset / generatorMetadataOffset and can cap how many items one response carries.
function fakeLs(lsAddress, cascadeIds = ['conv-1']) {
  const calls = {};
  let clock = 0;
  const step = (status = 'CORTEX_STEP_STATUS_DONE') => ({
    type: 'CORTEX_STEP_TYPE_USER_INPUT',
    status,
    metadata: { createdAt: `2026-10-21T10:${String(clock++).padStart(4, '0')}Z` },
  });
  const ls = {
    calls,
    requests: [],
    fail: new Set(),
    pageCap: Infinity,
    ignoreOffsets: false,
    step,
    steps: Array.from({ length: 10 }, () => step()),
    generators: [{ chatModel: { usage: { inputTokens: 1000 } } }],
    summary: { lastModifiedTime: '2026-10-21T10:00:00Z', status: 'CASCADE_RUN_STATUS_IDLE' },
    // Append a turn: new steps plus a generator entry whose usage tracks the step count
    grow(n = 1, status = 'CORTEX_STEP_STATUS_DONE') {
      for (let i = 0; i < n; i++) ls.steps.push(step(status));
      ls.generators.push({ chatModel: { usage: { inputTokens: ls.steps.length * 100 } } });
      ls.summary.lastModifiedTime = `2026-10-21T11:${String(clock++).padStart(4, '0')}Z`;
    },
    offsets: (method) => ls.requests.filter((r) => r.method === method).map((r) => r.offset),
    options: {
      lsAddress,
      csrfToken: 'mock-csrf',
      configPath: join(tmpdir(), 'nonexistent-agy-config.json'),
      hostCascadeId: 'conv-1',
      fetchFn: async (url, init) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        calls[method] = (calls[method] || 0) + 1;
        const req = JSON.parse(init?.body || '{}');
        if (ls.fail.has(method)) return { ok: false, status: 503, text: async () => '{}' };
        const page = (list, offset) => (ls.ignoreOffsets ? list : list.slice(offset)).slice(0, ls.pageCap);
        let body = {};
        if (method === 'GetAllCascadeTrajectories') {
          const summary = { ...ls.summary, stepCount: ls.steps.length };
          body = { trajectorySummaries: Object.fromEntries(cascadeIds.map((id) => [id, { summary: id, ...summary }])) };
        } else if (method === 'GetCascadeTrajectorySteps') {
          ls.requests.push({ method, offset: req.stepOffset });
          body = { steps: page(ls.steps, req.stepOffset || 0) };
        } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          ls.requests.push({ method, offset: req.generatorMetadataOffset });
          body = { generatorMetadata: page(ls.generators, req.generatorMetadataOffset || 0) };
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

test('concurrent telemetry polls from several iframes share one read of each RPC', async () => {
  const ls = fakeLs('127.0.0.1:59996');
  const results = await Promise.all([1, 2, 3].map(() => fetchFullTelemetry(ls.options)));
  assert.ok(Object.keys(ls.calls).length >= 8);
  // Generator metadata has no count in the summary, so its read ends on an empty page
  assert.deepEqual(ls.offsets('GetCascadeTrajectoryGeneratorMetadata'), [undefined, 1]);
  for (const [method, n] of Object.entries(ls.calls)) {
    if (method !== 'GetCascadeTrajectoryGeneratorMetadata') assert.equal(n, 1, method);
  }
  assert.equal(results[2].context.totalUsedTokens, 1000);
  assert.equal(results[0].session.cascadeId, 'conv-1');
});

test('steps and generator metadata are only re-read when the trajectory changes', async () => {
  const ls = fakeLs('127.0.0.1:59995');
  const first = await fetchFullTelemetry(ls.options);
  assert.equal(first.context.totalUsedTokens, 1000);

  // GetAllCascadeTrajectories refreshes (cache expired) but nothing changed: no detail re-read
  clearRpcCache();
  await fetchFullTelemetry(ls.options);
  assert.equal(ls.calls.GetAllCascadeTrajectories, 2);
  assert.equal(ls.calls.GetCascadeTrajectorySteps, 1);

  // Each of step count, last-modified time and status counts as a change
  const changes = [
    () => ls.grow(1),
    () => (ls.summary.lastModifiedTime = '2026-10-21T12:00:00Z'),
    () => (ls.summary.status = 'CASCADE_RUN_STATUS_RUNNING'),
  ];
  for (const [i, change] of changes.entries()) {
    change();
    clearRpcCache();
    const res = await fetchFullTelemetry(ls.options);
    assert.equal(ls.calls.GetCascadeTrajectorySteps, 2 + i);
    assert.equal(res.context.totalUsedTokens, 1100);
  }

  // A failed read keeps what it has and is retried on the next poll even though nothing changed
  ls.grow(1);
  ls.fail.add('GetCascadeTrajectorySteps');
  clearRpcCache();
  const failed = await fetchFullTelemetry(ls.options);
  assert.equal(failed.context.totalUsedTokens, 1200, 'generator metadata still updated');
  ls.fail.clear();
  const before = ls.calls.GetCascadeTrajectorySteps;
  await fetchFullTelemetry(ls.options);
  assert.ok(ls.calls.GetCascadeTrajectorySteps > before);
  clearConversationDetails();
});

test('after the first read only the steps that can still change are requested', async () => {
  const ls = fakeLs('127.0.0.1:59991');
  ls.grow(1, 'CORTEX_STEP_STATUS_RUNNING'); // steps 0-9 done, step 10 running
  let t = 5_000_000;
  const poll = () => {
    clearRpcCache();
    return fetchFullTelemetry({ ...ls.options, nowMs: (t += 2000) });
  };
  await poll();
  assert.deepEqual(ls.offsets('GetCascadeTrajectorySteps'), [undefined]);

  // Step 10 finishes and step 11 starts: re-read from step 9 (the settled overlap) onwards
  ls.steps[10].status = 'CORTEX_STEP_STATUS_DONE';
  ls.grow(1, 'CORTEX_STEP_STATUS_RUNNING');
  ls.requests.length = 0;
  const merged = await poll();
  assert.deepEqual(ls.offsets('GetCascadeTrajectorySteps'), [9]);
  // The last two generator entries may still be filling in, so they are read again
  assert.deepEqual(ls.offsets('GetCascadeTrajectoryGeneratorMetadata'), [undefined, 3]);
  assert.equal(merged.context.totalUsedTokens, 1200);

  // The merged result matches a fresh full read
  clearConversationDetails();
  const fresh = await poll();
  assert.deepEqual(merged.turnInsights, fresh.turnInsights);
  assert.deepEqual(merged.context, fresh.context);
  clearConversationDetails();
});

test('a rewritten history, a shrinking conversation or an old full read falls back to a full read', async () => {
  const ls = fakeLs('127.0.0.1:59990');
  let t = 6_000_000;
  const poll = () => {
    clearRpcCache();
    return fetchFullTelemetry({ ...ls.options, nowMs: (t += 2000) });
  };
  await poll();

  // Revert: steps from 5 on are replaced, then the agent adds more than were removed
  ls.steps.splice(5, Infinity, ...Array.from({ length: 7 }, () => ls.step()));
  ls.grow(0);
  ls.requests.length = 0;
  await poll();
  assert.deepEqual(ls.offsets('GetCascadeTrajectorySteps'), [9, undefined]);

  // Fewer steps than before
  ls.steps.length = 8;
  ls.grow(0);
  ls.requests.length = 0;
  await poll();
  assert.deepEqual(ls.offsets('GetCascadeTrajectorySteps'), [undefined]);

  // Long after the last full read, even a plain append is read in full once
  t += FULL_DETAIL_REFRESH_MS;
  ls.grow(1);
  ls.requests.length = 0;
  await poll();
  assert.deepEqual(ls.offsets('GetCascadeTrajectorySteps'), [undefined]);
  clearConversationDetails();
});

test('reads page through responses the server cut short, and stop if it ignores the offset', async () => {
  const ls = fakeLs('127.0.0.1:59989');
  ls.pageCap = 4;
  for (let i = 0; i < 5; i++) ls.grow(1);
  const res = await fetchFullTelemetry(ls.options);
  assert.deepEqual(ls.offsets('GetCascadeTrajectorySteps'), [undefined, 4, 8, 12]);
  assert.deepEqual(ls.offsets('GetCascadeTrajectoryGeneratorMetadata'), [undefined, 4, 6]);
  assert.equal(res.context.totalUsedTokens, 1500);
  clearConversationDetails();

  const old = fakeLs('127.0.0.1:59988');
  old.ignoreOffsets = true;
  await fetchFullTelemetry(old.options);
  assert.equal(old.calls.GetCascadeTrajectoryGeneratorMetadata, 2);
  clearConversationDetails();
});

test('frames on different conversations each keep their own details, and unpolled ones are dropped', async () => {
  const ids = ['conv-a', 'conv-b', 'conv-c'];
  const ls = fakeLs('127.0.0.1:59992', ids);
  const poll = (id, nowMs) => fetchFullTelemetry({ ...ls.options, hostCascadeId: id, nowMs });

  // Aux pane + two Hangar decks, each on its own conversation, polling round-robin
  let t = 1_000_000;
  for (let round = 0; round < 3; round++) {
    for (const id of ids) {
      const res = await poll(id, (t += 1000));
      assert.equal(res.session.cascadeId, id);
    }
  }
  assert.equal(ls.calls.GetCascadeTrajectorySteps, ids.length);

  // conv-c stops being shown; once it has gone unpolled for longer than the idle window it is dropped
  t += CONVERSATION_DETAIL_IDLE_MS / 2;
  await poll('conv-a', t);
  await poll('conv-b', t);
  t += CONVERSATION_DETAIL_IDLE_MS / 2 + 1;
  await poll('conv-a', t);
  assert.equal(ls.calls.GetCascadeTrajectorySteps, ids.length);
  await poll('conv-c', t);
  assert.equal(ls.calls.GetCascadeTrajectorySteps, ids.length + 1);
  clearConversationDetails();
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

test('collectSubagentTree and selectActiveTrajectory resolve L1/L2 hierarchy, models, durations, and subagent drill-down metadata', () => {
  const modelConfigData = {
    clientModelConfigs: [
      {
        label: 'Gemini 4 Argon (High)',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M73' },
        modelId: 'gemini-4-argon-high',
      },
      {
        label: 'Gemini 3.8 Flash (Low)',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M81' },
        modelId: 'gemini-3.8-flash-low',
      },
    ],
  };

  const nowMs = Date.parse('2026-11-02T10:05:00Z');
  const trajectoriesResponse = {
    trajectorySummaries: {
      'root-conv': {
        summary: 'Root Feature Task',
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 25,
        annotations: { title: 'Root Feature Task', lastUserViewTime: '2026-11-02T10:04:00Z' },
        trajectoryMetadata: { rootConversationId: 'root-conv' },
      },
      'sub-l1-b': {
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 8,
        createdTime: '2026-11-02T10:02:00Z',
        lastModifiedTime: '2026-11-02T10:02:45Z',
        latestExecutorTerminationReason: 'EXECUTOR_TERMINATION_REASON_ERROR',
        trajectoryMetadata: {
          parentConversationId: 'root-conv',
          rootConversationId: 'root-conv',
          nestingDepth: 1,
          subagentSpec: {
            typeName: 'code-reviewer',
            role: 'Security Reviewer',
            model: 'MODEL_PLACEHOLDER_M81',
          },
        },
      },
      'sub-l1-c': {
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 4,
        createdTime: '2026-11-02T10:03:00Z',
        lastModifiedTime: '2026-11-02T10:03:20Z',
        trajectoryMetadata: {
          parentConversationId: 'root-conv',
          rootConversationId: 'root-conv',
          nestingDepth: 1,
          subagentSpec: {
            typeName: 'research',
            role: 'Docs Checker',
            model: 'MODEL_PLACEHOLDER_M81',
          },
        },
      },
      'sub-l2-worker': {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        stepCount: 6,
        createdTime: '2026-11-02T10:01:30Z',
        lastModifiedTime: '2026-11-02T10:04:00Z',
        trajectoryMetadata: {
          parentConversationId: 'sub-l1-a',
          rootConversationId: 'root-conv',
          nestingDepth: 2,
          subagentSpec: {
            typeName: 'research',
            role: 'AST Scanner',
            inherit: true,
          },
        },
      },
      'sub-l1-a': {
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 14,
        createdTime: '2026-11-02T10:01:00Z',
        lastModifiedTime: '2026-11-02T10:04:12Z',
        trajectoryMetadata: {
          parentConversationId: 'root-conv',
          rootConversationId: 'root-conv',
          nestingDepth: 1,
          subagentSpec: {
            typeName: 'argon-840k',
            role: 'Architecture Coordinator',
            model: 'MODEL_PLACEHOLDER_M73',
          },
        },
      },
    },
  };

  assert.equal(formatDurationCompact('2026-11-02T10:00:00Z', '2026-11-02T10:00:42Z', false, nowMs), '42s');
  assert.equal(formatDurationCompact('2026-11-02T10:01:00Z', '2026-11-02T10:04:12Z', false, nowMs), '3m 12s');
  assert.equal(formatDurationCompact('2026-11-02T08:41:00Z', '2026-11-02T10:00:00Z', false, nowMs), '1h 19m');
  assert.equal(formatSubagentTitle(trajectoriesResponse.trajectorySummaries['sub-l1-a'], 'sub-l1-a'), 'Architecture Coordinator (argon-840k)');

  const tree = collectSubagentTree(trajectoriesResponse, 'root-conv', 'root-conv', modelConfigData, nowMs);
  assert.equal(tree.totalCount, 4);
  assert.equal(tree.runningCount, 1);
  assert.equal(tree.totalSteps, 32);
  assert.equal(tree.activeSubagentLabel, 'AST Scanner (research)');

  // Active L1 subtree first (sub-l1-a + running sub-l2-worker), then completed L1s newest-first (sub-l1-c @ 10:03, sub-l1-b @ 10:02)
  assert.deepEqual(
    tree.items.map((x) => x.cascadeId),
    ['sub-l1-a', 'sub-l2-worker', 'sub-l1-c', 'sub-l1-b']
  );
  assert.equal(tree.items[0].nestingDepth, 1);
  assert.equal(tree.items[0].modelBadge, 'Gemini 4 Argon (High)');
  assert.equal(tree.items[0].durationFormatted, '3m 12s');
  assert.equal(tree.items[0].statusBadge, 'Done');

  assert.equal(tree.items[1].nestingDepth, 2);
  assert.equal(tree.items[1].inherit, true);
  assert.equal(tree.items[1].modelBadge, 'Inherited');
  assert.equal(tree.items[1].isRunning, true);
  assert.equal(tree.items[1].statusBadge, 'Running');
  assert.equal(tree.items[1].durationFormatted, '3m 30s'); // live elapsed to nowMs (10:05:00 - 10:01:30)

  assert.equal(tree.items[2].cascadeId, 'sub-l1-c');
  assert.equal(tree.items[2].statusBadge, 'Done');

  assert.equal(tree.items[3].nestingDepth, 1);
  assert.equal(tree.items[3].modelBadge, 'Gemini 3.8 Flash (Low)');
  assert.equal(tree.items[3].isError, true);
  assert.equal(tree.items[3].statusBadge, 'Error');
  assert.equal(tree.items[3].durationFormatted, '45s');

  // Inspecting L2 subagent populates parent/root breadcrumb fields and keeps subagents anchored to root-conv
  const subSelected = selectActiveTrajectory(trajectoriesResponse, {
    requestedCascadeId: 'sub-l2-worker',
    hostCascadeId: 'root-conv',
    modelConfigData,
    nowMs,
  });
  assert.equal(subSelected.activeSession.cascadeId, 'sub-l2-worker');
  assert.equal(subSelected.activeSession.isSubagent, true);
  assert.equal(subSelected.activeSession.parentConversationId, 'sub-l1-a');
  assert.equal(subSelected.activeSession.parentTitle, 'Architecture Coordinator (argon-840k)');
  assert.equal(subSelected.activeSession.rootConversationId, 'root-conv');
  assert.equal(subSelected.activeSession.rootTitle, 'Root Feature Task');
  assert.equal(subSelected.activeSession.nestingDepth, 2);
  assert.equal(subSelected.activeSession.typeName, 'research');
  assert.equal(subSelected.activeSession.role, 'AST Scanner');
  assert.equal(subSelected.subagents.rootCascadeId, 'root-conv');
  assert.equal(subSelected.subagents.totalCount, 4);
  assert.equal(subSelected.subagents.items[1].isActive, true);
  // Root sessions list must never be polluted with subagent UUIDs
  assert.deepEqual(
    subSelected.sessions.map((s) => s.cascadeId),
    ['root-conv']
  );
});

test('fetchFullTelemetry enforces zero-RPC parent polling for subagents and loads subagent detail only on demand', async () => {
  const detailCalls = [];
  const options = {
    lsAddress: '127.0.0.1:59985',
    csrfToken: 'mock-csrf',
    configPath: join(tmpdir(), 'nonexistent-agy-config.json'),
    hostCascadeId: 'root-1',
    nowMs: Date.parse('2026-11-02T12:00:00Z'),
    fetchFn: async (url, init) => {
      const method = url.slice(url.lastIndexOf('/') + 1);
      const req = JSON.parse(init?.body || '{}');
      let body = {};
      if (method === 'GetAllCascadeTrajectories') {
        body = {
          trajectorySummaries: {
            'root-1': {
              summary: 'Main Task',
              status: 'CASCADE_RUN_STATUS_IDLE',
              stepCount: 3,
              lastModifiedTime: '2026-11-02T11:59:00Z',
              annotations: { title: 'Main Task', lastUserViewTime: '2026-11-02T11:59:00Z' },
              trajectoryMetadata: { rootConversationId: 'root-1' },
            },
            'sub-1': {
              status: 'CASCADE_RUN_STATUS_IDLE',
              stepCount: 5,
              createdTime: '2026-11-02T11:58:00Z',
              lastModifiedTime: '2026-11-02T11:58:50Z',
              trajectoryMetadata: {
                parentConversationId: 'root-1',
                rootConversationId: 'root-1',
                nestingDepth: 1,
                subagentSpec: { typeName: 'research', role: 'Codebase Researcher', inherit: true },
              },
            },
          },
        };
      } else if (method === 'GetCascadeTrajectorySteps') {
        detailCalls.push({ method, cascadeId: req.cascadeId });
        if (req.cascadeId === 'root-1') {
          body = {
            steps: [
              { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'audit repo' } },
              {
                type: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
                invokeSubagent: {
                  subagents: [{ typeName: 'research', role: 'Codebase Researcher', initialPrompt: 'Check all exports in lib/' }],
                  results: [{ conversationId: 'sub-1' }],
                },
              },
              {
                type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
                systemMessage: {
                  message: '[Message] timestamp=2026-11-02T11:58:50Z sender=sub-1 priority=NORMAL content=All exports verified.',
                },
              },
            ],
          };
        } else {
          body = {
            steps: [
              {
                type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
                metadata: { source: 'CORTEX_STEP_SOURCE_SYSTEM' },
                systemMessage: {
                  message: '[Message] timestamp=2026-11-02T11:58:00Z sender=root-1 priority=NORMAL content=Check all exports in lib/',
                },
              },
              { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'All exports verified.' } },
            ],
          };
        }
      } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        detailCalls.push({ method, cascadeId: req.cascadeId });
        body = {
          generatorMetadata:
            req.generatorMetadataOffset > 0
              ? []
              : [
                  {
                    stepIndices: [1],
                    chatModel: {
                      usage: { inputTokens: '8000', cacheReadTokens: '2000', outputTokens: '200' },
                      chatStartMetadata: {
                        contextWindowMetadata: {
                          tokenBreakdown: {
                            groups: [
                              {
                                type: 'TOKEN_TYPE_CHAT_MESSAGES',
                                numTokens: 3200,
                                children: [
                                  { name: 'Step 1 (INVOKE_SUBAGENT)', numTokens: 400 },
                                  { name: 'Step 2 (SYSTEM_MESSAGE)', numTokens: 2800 },
                                ],
                              },
                            ],
                          },
                        },
                      },
                    },
                  },
                ],
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  };

  clearRpcCache();
  clearConversationDetails();

  // 1. Polling parent conversation must NEVER fetch sub-1 steps or generatorMetadata
  const parentTelemetry = await fetchFullTelemetry(options);
  assert.ok(detailCalls.every((c) => c.cascadeId === 'root-1'));
  assert.equal(parentTelemetry.subagents.totalCount, 1);
  assert.equal(parentTelemetry.subagents.parentContextTokens, 3200);
  assert.equal(parentTelemetry.subagents.formattedParentContextTokens, '3.2k');
  assert.equal(parentTelemetry.subagents.items[0].spawnStepIndex, 1);
  assert.equal(parentTelemetry.subagents.items[0].promptPreview, 'Check all exports in lib/');
  assert.deepEqual(parentTelemetry.subagents.items[0].replyStepIndices, [2]);
  assert.equal(parentTelemetry.subagents.items[0].parentContextTokens, 3200);

  // 2. Drilling down into sub-1 fetches sub-1 on-demand and preserves parent enrichment from cache
  detailCalls.length = 0;
  const subTelemetry = await fetchFullTelemetry({ ...options, cascadeId: 'sub-1' });
  assert.ok(detailCalls.length > 0 && detailCalls.every((c) => c.cascadeId === 'sub-1'));
  assert.equal(subTelemetry.session.cascadeId, 'sub-1');
  assert.equal(subTelemetry.session.isSubagent, true);
  assert.equal(subTelemetry.subagents.items[0].promptPreview, 'Check all exports in lib/');
  assert.equal(subTelemetry.turnInsights.effortAdvisor.totalTurns, 1);
  assert.equal(subTelemetry.turnInsights.effortAdvisor.latestTurnFit.promptPreview, 'Check all exports in lib/');

  clearConversationDetails();
  clearRpcCache();
});

test('selectActiveTrajectory and collectSubagentTree handle self-parenting roots, cyclic parent links, and orphaned L2 subagents', () => {
  const trajectories = {
    trajectorySummaries: {
      'root-self': {
        summary: 'Root with self parentConversationId',
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 5,
        createdTime: '2026-11-02T10:00:00Z',
        lastModifiedTime: '2026-11-02T10:05:00Z',
        annotations: { lastUserViewTime: '2026-11-02T10:05:00Z' },
        trajectoryMetadata: {
          rootConversationId: 'root-self',
          parentConversationId: 'root-self',
        },
      },
      'orphan-l2': {
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 4,
        createdTime: '2026-11-02T10:01:00Z',
        lastModifiedTime: '2026-11-02T10:02:00Z',
        trajectoryMetadata: {
          rootConversationId: 'root-self',
          parentConversationId: 'evicted-l1',
          // nestingDepth omitted by LS
          subagentSpec: { typeName: 'research', role: 'Orphaned L2 Worker' },
        },
      },
      'cycle-a': {
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 2,
        createdTime: '2026-11-02T10:03:00Z',
        lastModifiedTime: '2026-11-02T10:04:00Z',
        trajectoryMetadata: {
          rootConversationId: 'root-self',
          parentConversationId: 'cycle-b',
          subagentSpec: { typeName: 'self', role: 'Cycle A' },
        },
      },
      'cycle-b': {
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 3,
        createdTime: '2026-11-02T10:03:30Z',
        lastModifiedTime: '2026-11-02T10:04:30Z',
        trajectoryMetadata: {
          parentConversationId: 'cycle-a',
          subagentSpec: { typeName: 'self', role: 'Cycle B' },
        },
      },
    },
  };

  const state = selectActiveTrajectory(trajectories, { hostCascadeId: 'root-self' });
  assert.equal(state.activeSession.cascadeId, 'root-self');
  assert.equal(state.activeSession.isSubagent, undefined);
  assert.deepEqual(
    state.sessions.map((s) => s.cascadeId),
    ['root-self']
  );

  // Orphaned L2 whose L1 parent ('evicted-l1') is missing from summaries still infers nestingDepth = 2
  const orphan = state.subagents.items.find((x) => x.cascadeId === 'orphan-l2');
  assert.ok(orphan);
  assert.equal(orphan.nestingDepth, 2);

  // Cyclic nodes are visited once without infinite recursion
  assert.equal(state.subagents.totalCount, 3);
  const cyclePinned = selectActiveTrajectory(trajectories, { requestedCascadeId: 'cycle-b' });
  assert.equal(cyclePinned.activeSession.isSubagent, true);
  assert.equal(cyclePinned.activeSession.rootConversationId, 'root-self');
});

test('fetchFullTelemetry preserves cached root/L1 enrichment across >60s idle & >4 subagent LRU drill-downs without sender collision', async () => {
  const detailCalls = [];
  const trajectories = {
    trajectorySummaries: {
      'root-1': {
        summary: 'Root Session',
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 4,
        lastModifiedTime: '2026-11-02T12:00:00Z',
      },
      'sub-l1': {
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 3,
        createdTime: '2026-11-02T11:58:00Z',
        lastModifiedTime: '2026-11-02T11:59:00Z',
        trajectoryMetadata: {
          parentConversationId: 'root-1',
          rootConversationId: 'root-1',
          nestingDepth: 1,
          subagentSpec: { typeName: 'argon-840k', role: 'L1 Coordinator' },
        },
      },
      'sub-l2': {
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 2,
        createdTime: '2026-11-02T11:58:10Z',
        lastModifiedTime: '2026-11-02T11:58:50Z',
        trajectoryMetadata: {
          parentConversationId: 'sub-l1',
          rootConversationId: 'root-1',
          nestingDepth: 2,
          subagentSpec: { typeName: 'research', role: 'L2 Auditor' },
        },
      },
      'sub-extra-1': {
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 1,
        trajectoryMetadata: { parentConversationId: 'root-1', rootConversationId: 'root-1', nestingDepth: 1 },
      },
      'sub-extra-2': {
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 1,
        trajectoryMetadata: { parentConversationId: 'root-1', rootConversationId: 'root-1', nestingDepth: 1 },
      },
      'sub-extra-3': {
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 1,
        trajectoryMetadata: { parentConversationId: 'root-1', rootConversationId: 'root-1', nestingDepth: 1 },
      },
    },
  };

  const makeOptions = (nowMs) => ({
    lsAddress: '127.0.0.1:42100',
    csrfToken: 'tok',
    configPath: 'C:/nonexistent/config.json',
    nowMs,
    fetchFn: async (url, init) => {
      const method = url.split('/').pop();
      const req = JSON.parse(init.body || '{}');
      let body = {};
      if (method === 'GetAllCascadeTrajectories') {
        body = trajectories;
      } else if (method === 'GetCascadeTrajectorySteps') {
        detailCalls.push({ method, cascadeId: req.cascadeId });
        if (req.cascadeId === 'root-1') {
          body = {
            steps: [
              { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'Run audit' } },
              {
                type: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
                invokeSubagent: {
                  subagents: [{ typeName: 'argon-840k', role: 'L1 Coordinator', initialPrompt: 'Coordinate L1 audit' }],
                  results: [{ conversationId: 'sub-l1' }],
                },
              },
              {
                type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
                systemMessage: {
                  message: '[Message] timestamp=2026-11-02T11:59:00Z sender=sub-l1 priority=NORMAL content=L1 report ready',
                },
              },
            ],
          };
        } else if (req.cascadeId === 'sub-l1') {
          body = {
            steps: [
              {
                type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
                metadata: { source: 'CORTEX_STEP_SOURCE_SYSTEM' },
                systemMessage: {
                  message: '[Message] timestamp=2026-11-02T11:58:00Z sender=root-1 priority=NORMAL content=Coordinate L1 audit',
                },
              },
              {
                type: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
                invokeSubagent: {
                  subagents: [{ typeName: 'research', role: 'L2 Auditor', initialPrompt: 'Inspect L2 target' }],
                  results: [{ conversationId: 'sub-l2' }],
                },
              },
              {
                type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
                systemMessage: {
                  message: '[Message] timestamp=2026-11-02T11:58:50Z sender=sub-l2 priority=NORMAL content=L2 findings',
                },
              },
            ],
          };
        } else if (req.cascadeId === 'sub-l2') {
          body = {
            steps: [
              {
                type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
                metadata: { source: 'CORTEX_STEP_SOURCE_SYSTEM' },
                systemMessage: {
                  message: '[Message] timestamp=2026-11-02T11:58:10Z sender=sub-l1 priority=NORMAL content=Inspect L2 target',
                },
              },
              { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'L2 findings' } },
            ],
          };
        } else {
          body = { steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'ok' } }] };
        }
      } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        detailCalls.push({ method, cascadeId: req.cascadeId });
        const childrenByCascade = {
          'root-1': [
            { name: 'Step 1 (INVOKE_SUBAGENT)', numTokens: 500 },
            { name: 'Step 2 (SYSTEM_MESSAGE)', numTokens: 3700 },
          ],
          'sub-l1': [
            { name: 'Step 0 (SYSTEM_MESSAGE)', numTokens: 300 },
            { name: 'Step 1 (INVOKE_SUBAGENT)', numTokens: 250 },
            { name: 'Step 2 (SYSTEM_MESSAGE)', numTokens: 1250 },
          ],
          'sub-l2': [{ name: 'Step 0 (SYSTEM_MESSAGE)', numTokens: 600 }],
        };
        body = {
          generatorMetadata: [
            {
              stepIndices: [1],
              chatModel: {
                usage: { inputTokens: '4000', cacheReadTokens: '1000', outputTokens: '100' },
                chatStartMetadata: {
                  contextWindowMetadata: {
                    tokenBreakdown: {
                      groups: [
                        {
                          type: 'TOKEN_TYPE_CHAT_MESSAGES',
                          numTokens: 2000,
                          children: childrenByCascade[req.cascadeId] || [],
                        },
                      ],
                    },
                  },
                },
              },
            },
          ],
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });

  clearRpcCache();
  clearConversationDetails();

  let t = 1_000_000;
  await fetchFullTelemetry({ ...makeOptions(t), hostCascadeId: 'root-1' });
  t += 30_000;
  await fetchFullTelemetry({ ...makeOptions(t), hostCascadeId: 'root-1', cascadeId: 'sub-l1' });
  // Advance past 60s from initial root-1 load while inspecting sub-l2; root-1 and sub-l1 must stay warm
  t += 40_000;
  const l2View = await fetchFullTelemetry({ ...makeOptions(t), hostCascadeId: 'root-1', cascadeId: 'sub-l2' });

  const l1Item = l2View.subagents.items.find((x) => x.cascadeId === 'sub-l1');
  const l2Item = l2View.subagents.items.find((x) => x.cascadeId === 'sub-l2');
  // sub-l2's step 0 (sender=sub-l1, 600 tokens) must NOT overwrite sub-l1's replyStepIndices ([2]) or parentContextTokens (4200)
  assert.deepEqual(l1Item.replyStepIndices, [2]);
  assert.equal(l1Item.parentContextTokens, 4200);
  assert.equal(l2Item.parentContextTokens, 1500);

  // In sub-l2's own Largest Items in Context, step 0 (sender=sub-l1) is labeled as Parent task, not Subagent reply
  const step0Culprit = l2View.turnInsights.culprits.topChatSteps[0];
  assert.equal(step0Culprit.label, 'Parent task: argon-840k');
  assert.equal(step0Culprit.badge, 'Prompt');
  assert.equal(step0Culprit.subagentId, 'sub-l1');

  // Inspecting additional subagents while drilling down touches root-1 so returning to root-1 requires 0 detail RPCs
  await fetchFullTelemetry({ ...makeOptions((t += 5_000)), hostCascadeId: 'root-1', cascadeId: 'sub-extra-1' });
  await fetchFullTelemetry({ ...makeOptions((t += 5_000)), hostCascadeId: 'root-1', cascadeId: 'sub-extra-2' });
  detailCalls.length = 0;
  await fetchFullTelemetry({ ...makeOptions((t += 5_000)), hostCascadeId: 'root-1' });
  assert.equal(detailCalls.length, 0);

  clearConversationDetails();
  clearRpcCache();
});
