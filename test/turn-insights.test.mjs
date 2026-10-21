import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTurnPerformanceAndBudgets } from '../lib/turn-insights.mjs';

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
  assert.equal(performance.sessionThinkingTokens, 353);
  assert.equal(performance.sessionResponseTokens, 247);
  assert.equal(performance.sessionThinkingEstimated, true);
});
