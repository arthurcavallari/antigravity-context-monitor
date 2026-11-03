import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeChatStep,
  enrichSubagentsFromParentSteps,
  extractTurnPerformanceAndBudgets,
  parseInterAgentMessage,
} from '../lib/turn-insights.mjs';
import { extractSkillInjectionMetrics } from '../lib/context-inspector.mjs';
import {
  analyzeModelAndEffortFit,
  extractPromptSnippet,
  groupIntoUserTurns,
} from '../lib/effort-advisor.mjs';

test('extractTurnPerformanceAndBudgets computes TTFT, TPS, cache hit %, compactions, top steps, and budgets', () => {
  const generatorMetadataList = [
    {
      chatModel: {
        usage: {
          inputTokens: '50000',
          cacheReadTokens: '200000',
          outputTokens: '400',
        },
        chatStartMetadata: {
          startStepIndex: 0,
          contextWindowMetadata: { estimatedTokensUsed: 256000 },
        },
      },
    },
    {
      plannerConfig: { customizationTokenBudget: 20000, rulesTokenBudget: 20000 },
      chatModel: {
        timeToFirstToken: '1.2s',
        streamingDuration: '2.0s',
        retries: 1,
        usage: {
          inputTokens: '12000',
          cacheReadTokens: '33000',
          outputTokens: '300',
          thinkingOutputTokens: '90',
          responseOutputTokens: '210',
        },
        chatStartMetadata: {
          startStepIndex: 3,
          contextWindowMetadata: {
            truncationReason: 'TRUNCATION_REASON_MAX_TOKEN_LIMIT',
            estimatedTokensUsed: 48000,
            tokenBreakdown: {
              groups: [
                {
                  type: 'TOKEN_TYPE_SYSTEM_PROMPT',
                  children: [
                    { name: 'identity', numTokens: 1200 },
                    { name: 'skills', numTokens: 2948 },
                    { name: 'user_rules', numTokens: 662 },
                    { name: 'mcp_servers', numTokens: 4100 },
                  ],
                },
                {
                  type: 'TOKEN_TYPE_CHAT_MESSAGES',
                  children: [
                    { name: 'Step 1 (USER_INPUT)', numTokens: 450 },
                    { name: 'Step 5 (VIEW_FILE)', numTokens: 9200 },
                    { name: 'Step 8 (RUN_COMMAND)', numTokens: 6100 },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  ];

  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT' },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' },
    { type: 'CORTEX_STEP_TYPE_VIEW_FILE' },
    {
      type: 'CORTEX_STEP_TYPE_CHECKPOINT',
      checkpoint: {
        includedStepIndexStart: 0,
        includedStepIndexEnd: 3,
        sessionSummary: '<summary>\nCompacted initial audit steps.\n</summary>',
      },
    },
  ];

  const userStatus = {
    userStatus: {
      planStatus: {
        planInfo: {
          maxNumChatInputTokens: 16384,
        },
      },
    },
  };

  const insights = extractTurnPerformanceAndBudgets(generatorMetadataList, userStatus, steps);

  assert.equal(insights.performance.ttftSec, 1.2);
  assert.equal(insights.performance.ttftFormatted, '1.2s');
  assert.equal(insights.performance.streamSec, 2);
  assert.equal(insights.performance.tokensPerSec, 150);
  assert.equal(insights.performance.outputTokens, 300);
  assert.equal(insights.performance.thinkingTokens, 90);
  assert.equal(insights.performance.responseTokens, 210);
  assert.equal(insights.performance.thinkingRatioPct, 30);
  assert.equal(insights.performance.turnCacheHitPct, 73);
  assert.equal(insights.performance.sessionCacheHitPct, 79);
  assert.equal(insights.performance.lastTurnRetries, 1);

  assert.equal(insights.compaction.count, 1);
  assert.equal(insights.compaction.justCompacted, true);
  assert.equal(insights.compaction.activeStartStepIndex, 3);
  assert.equal(insights.compaction.checkpoints[0].stepIndex, 3);
  assert.equal(insights.compaction.checkpoints[0].stepRange, '0–3');
  assert.equal(insights.compaction.checkpoints[0].beforeTokens, 256000);
  assert.equal(insights.compaction.checkpoints[0].afterTokens, 45000);
  assert.equal(insights.compaction.checkpoints[0].tokensSaved, 211000);
  assert.equal(insights.compaction.checkpoints[0].summary, 'Compacted initial audit steps.');

  assert.equal(insights.culprits.topChatSteps.length, 3);
  assert.equal(insights.culprits.topChatSteps[0].name, 'Step 5 (VIEW_FILE)');
  assert.equal(insights.culprits.topChatSteps[0].badge, 'Read');
  assert.equal(insights.culprits.topChatSteps[0].barPct, 100);
  assert.equal(insights.culprits.topChatSteps[0].tokens, 9200);
  assert.equal(insights.culprits.formattedTopStepsTokens, '15.8k top 3');
  assert.equal(insights.culprits.promptSections[0].label, 'MCP Server Instructions');

  assert.equal(insights.budgets.skills.used, 2948);
  assert.equal(insights.budgets.skills.limit, 20000);
  assert.equal(insights.budgets.rules.used, 662);
  assert.equal(insights.budgets.rules.limit, 20000);
  assert.equal(insights.budgets.maxChatInputTokens, 16384);
});

test('extractTurnPerformanceAndBudgets estimates Claude thinking and derives response tokens', () => {
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'go' } },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      // 448 + '[]' = 450 visible chars ≈ 247 tokens
      plannerResponse: { response: 'x'.repeat(448), thinking: 'plan', thinkingSignature: 'c2ln' },
    },
  ];
  const generatorMetadataList = [
    {
      stepIndices: [1],
      chatModel: {
        usage: {
          inputTokens: '1000',
          outputTokens: '600',
          responseOutputTokens: '600',
          apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX',
        },
      },
    },
  ];
  const { performance } = extractTurnPerformanceAndBudgets(generatorMetadataList, {}, steps);
  assert.equal(performance.thinkingTokens, 353);
  assert.equal(performance.responseTokens, 247);
  assert.equal(performance.thinkingEstimated, true);
  assert.equal(performance.formattedThinking, '~353');
  assert.equal(performance.sessionThinkingTokens, 353);
  assert.equal(performance.sessionResponseTokens, 247);
  assert.equal(performance.sessionThinkingEstimated, true);
});

test('describeChatStep and enrichSubagentsFromParentSteps attribute INVOKE_SUBAGENT and SYSTEM_MESSAGE replies', () => {
  const subUuid = 'b8d05534-e0b4-4ef2-b302-078279236fd1';
  const rawMsg = `[Message] timestamp=2026-11-02T10:12:00Z sender=${subUuid} priority=HIGH content=Completed static AST scan\nFound 0 regressions.`;

  const parsed = parseInterAgentMessage(rawMsg);
  assert.deepEqual(parsed, {
    timestamp: '2026-11-02T10:12:00Z',
    sender: subUuid,
    priority: 'HIGH',
    content: 'Completed static AST scan\nFound 0 regressions.',
  });
  assert.equal(parseInterAgentMessage('normal system text'), null);

  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'run audit' } },
    {
      type: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
      invokeSubagent: {
        subagents: [
          {
            typeName: 'argon-840k',
            role: 'Deep Auditor',
            initialPrompt: 'Inspect all files in lib/ and verify RPC caching invariants.',
          },
        ],
        results: [{ conversationId: subUuid }],
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      systemMessage: { message: rawMsg },
    },
  ];

  const spawnDesc = describeChatStep('Step 1 (INVOKE_SUBAGENT)', steps);
  assert.deepEqual(spawnDesc, {
    name: 'Step 1 (INVOKE_SUBAGENT)',
    label: 'Spawned argon-840k (Deep Auditor)',
    stepRef: '#1',
    badge: 'Subagent',
    subagentId: subUuid,
  });

  const replyDesc = describeChatStep('Step 2 (SYSTEM_MESSAGE)', steps);
  assert.deepEqual(replyDesc, {
    name: 'Step 2 (SYSTEM_MESSAGE)',
    label: 'Subagent reply: argon-840k',
    stepRef: '#2',
    badge: 'Subagent',
    subagentId: subUuid,
  });

  const breakdownGroups = [
    {
      type: 'TOKEN_TYPE_CHAT_MESSAGES',
      children: [
        { name: 'Step 0 (USER_INPUT)', numTokens: 120 },
        { name: 'Step 1 (INVOKE_SUBAGENT)', numTokens: 350 },
        { name: 'Step 2 (SYSTEM_MESSAGE)', numTokens: 4650 },
      ],
    },
  ];

  const enriched = enrichSubagentsFromParentSteps(
    {
      totalCount: 1,
      runningCount: 0,
      items: [{ cascadeId: subUuid, typeName: 'argon-840k', role: 'Deep Auditor' }],
    },
    steps,
    breakdownGroups
  );

  assert.equal(enriched.parentContextTokens, 5000);
  assert.equal(enriched.formattedParentContextTokens, '5.0k');
  assert.equal(enriched.items[0].spawnStepIndex, 1);
  assert.equal(enriched.items[0].spawnStepRef, '#1');
  assert.equal(
    enriched.items[0].initialPrompt,
    'Inspect all files in lib/ and verify RPC caching invariants.'
  );
  assert.equal(
    enriched.items[0].promptPreview,
    'Inspect all files in lib/ and verify RPC caching invariants.'
  );
  assert.deepEqual(enriched.items[0].replyStepIndices, [2]);
  assert.equal(enriched.items[0].parentContextTokens, 5000);
  assert.equal(enriched.items[0].formattedParentContextTokens, '5.0k');
});

test('groupIntoUserTurns and extractPromptSnippet segment subagent turns on incoming [Message] system steps', () => {
  const parentUuid = '646cfcd4-6510-4dfb-b489-b53e697dfc1e';
  const subagentSteps = [
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      metadata: { source: 'CORTEX_STEP_SOURCE_SYSTEM' },
      systemMessage: {
        message: `[Message] timestamp=2026-11-02T10:00:00Z sender=${parentUuid} priority=NORMAL content=Scan lib/session-resolver.mjs for subagent fields`,
      },
    },
    { type: 'CORTEX_STEP_TYPE_VIEW_FILE', viewFile: { absolutePathUri: 'file:///repo/lib/session-resolver.mjs' } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'Done first task.' } },
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      metadata: { source: 'CORTEX_STEP_SOURCE_SYSTEM' },
      systemMessage: {
        message: `[Message] timestamp=2026-11-02T10:02:00Z sender=${parentUuid} priority=NORMAL content=Verify UI escaping now`,
      },
    },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'Verified.' } },
  ];

  assert.equal(
    extractPromptSnippet(subagentSteps[0]),
    'Scan lib/session-resolver.mjs for…'
  );
  assert.equal(extractPromptSnippet(subagentSteps[3]), 'Verify UI escaping now');

  const genMeta = [
    {
      stepIndices: [1, 2],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M73',
        timeToFirstToken: '2.0s',
        usage: { inputTokens: '12000', outputTokens: '300', thinkingOutputTokens: '450' },
      },
    },
    {
      stepIndices: [4],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M73',
        timeToFirstToken: '1.8s',
        usage: { inputTokens: '14000', outputTokens: '100', thinkingOutputTokens: '50' },
      },
    },
  ];

  const turns = groupIntoUserTurns(genMeta, subagentSteps);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].startStepIdx, 0);
  assert.equal(turns[0].endStepIdx, 3);
  assert.equal(turns[1].startStepIdx, 3);
  assert.equal(turns[1].endStepIdx, 5);

  const advisor = analyzeModelAndEffortFit(genMeta, subagentSteps, {
    clientModelConfigs: [
      {
        label: 'Gemini 4 Argon (High)',
        modelId: 'gemini-4-argon-high',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M73' },
      },
    ],
  });
  assert.equal(advisor.totalTurns, 2);
  assert.equal(advisor.latestTurnFit.promptPreview, 'Verify UI escaping now');
  assert.equal(advisor.latestTurnFit.status, 'unused_effort');
});

test('groupIntoUserTurns keeps L2 child subagent replies inside L1 coordinator turn and preserves pre-prompt invocations', () => {
  const l1Steps = [
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'Warmup' } },
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      metadata: { source: 'CORTEX_STEP_SOURCE_SYSTEM' },
      systemMessage: {
        message: '[Message] timestamp=2026-11-02T10:00:00Z sender=root-uuid priority=NORMAL content=Coordinate L2 workers',
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
      invokeSubagent: {
        subagents: [{ typeName: 'research', role: 'L2 Worker' }],
        results: [{ conversationId: 'sub-l2-uuid' }],
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      metadata: { source: 'CORTEX_STEP_SOURCE_SYSTEM' },
      systemMessage: {
        message: '[Message] timestamp=2026-11-02T10:01:00Z sender=sub-l2-uuid priority=NORMAL content=L2 worker completed scan',
      },
    },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'Synthesized L2 result.' } },
  ];

  const genMeta = [
    { stepIndices: [0] },
    { stepIndices: [2] },
    { stepIndices: [4] },
  ];

  const turns = groupIntoUserTurns(genMeta, l1Steps);
  assert.equal(turns.length, 2);
  // Pre-prompt invocation at index 0 is preserved in turn 1
  assert.equal(turns[0].startStepIdx, 0);
  assert.equal(turns[0].endStepIdx, 1);
  // L1 task prompt at index 1 includes the L2 child reply at index 3 without splitting into a 3rd turn
  assert.equal(turns[1].startStepIdx, 1);
  assert.equal(turns[1].endStepIdx, 5);
  assert.equal(turns[1].invocations.length, 2);
});

test('extractSkillInjectionMetrics parses <!-- skillInjection: {...} --> markers and estimates tokens', () => {
  const steps = [
    {
      stepIndex: 4,
      content:
        '<!-- skillInjection: {"version":1,"hookEvent":"PreToolUse","injectedSkills":["nextjs","ai-sdk"],"droppedByCap":["geist"],"droppedByBudget":[],"totalBytes":12400} -->\n<skill_content>...</skill_content>',
    },
    {
      stepIndex: 5,
      content: '<!-- skillInjection: {malformed-json-should-never-throw} -->',
    },
  ];
  const res = extractSkillInjectionMetrics(steps);
  assert.equal(res.injections.length, 1);
  assert.equal(res.injections[0].stepIndex, 4);
  assert.equal(res.injections[0].hookEvent, 'PreToolUse');
  assert.deepEqual(res.injections[0].injectedSkills, ['nextjs', 'ai-sdk']);
  assert.deepEqual(res.injections[0].droppedByCap, ['geist']);
  assert.deepEqual(res.injections[0].droppedByBudget, []);
  assert.equal(res.injections[0].bytes, 12400);
  assert.equal(res.totalInjectedBytes, 12400);
  assert.ok(res.estimatedTokens > 3000);

  const insights = extractTurnPerformanceAndBudgets([], {}, steps);
  assert.deepEqual(insights.culprits.skillInjections, res);

  // CM-AUD-06 & XREPO-03: >64KB step text with trailing marker, antigravity-skill-router alias,
  // escaped --\u003e in JSON, and no fallback double-counting when multiple comments lack totalBytes
  const largeStep = {
    stepIndex: 7,
    content:
      'x'.repeat(70000) +
      '\n<!-- antigravity-skill-router: {"hookEvent":"UserPromptSubmit","routedSkills":["skill-a--\\u003etest"],"bytesInjected":2500} -->',
  };
  const largeRes = extractSkillInjectionMetrics([largeStep]);
  assert.equal(largeRes.injections.length, 1);
  assert.deepEqual(largeRes.injections[0].injectedSkills, ['skill-a-->test']);
  assert.equal(largeRes.totalInjectedBytes, 2500);

  const multiFallbackStep = {
    stepIndex: 8,
    content:
      '<!-- skillInjection: {"skills":["s1"]} -->\n<!-- skillInjection: {"skills":["s2"]} -->\n' +
      'y'.repeat(1000),
  };
  const multiRes = extractSkillInjectionMetrics([multiFallbackStep]);
  assert.equal(multiRes.injections.length, 2);
  assert.equal(multiRes.totalInjectedBytes, 1000);

  // CM-AUD-06: deduplicates identical candidate strings on a single step, scans userInput.items,
  // coerces numeric string totalBytes, and includes dynamic skill injections in budgets.skills.used
  const mirroredComment =
    '<!-- skillInjection: {"hookEvent":"UserPromptSubmit","injectedSkills":["s-dedup"],"droppedByCap":["cap1"],"droppedByBudget":["bud1"],"totalBytes":"5000"} -->';
  const dedupStep = {
    stepIndex: 9,
    content: mirroredComment,
    additionalContext: mirroredComment,
    userInput: {
      items: [{ text: '<!-- skillInjection: {"hookEvent":"UserPromptSubmit","injectedSkills":["s-item"],"totalBytes":2000} -->' }],
    },
  };
  const dedupRes = extractSkillInjectionMetrics([dedupStep]);
  assert.equal(dedupRes.injections.length, 2);
  assert.equal(dedupRes.totalInjectedBytes, 7000);
  const dedupInsights = extractTurnPerformanceAndBudgets([], {}, [dedupStep]);
  assert.equal(dedupInsights.budgets.skills.used, dedupRes.estimatedTokens);
  assert.ok(dedupInsights.budgets.skills.pct > 0);
});


