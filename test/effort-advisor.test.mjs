import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeModelAndEffortFit, countInvocationRetries } from '../lib/effort-advisor.mjs';

const MOCK_MODEL_CONFIG = {
  clientModelConfigs: [
    {
      label: 'Gemini 4 Argon (High)',
      modelId: 'gemini-4-argon-high',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M73' },
    },
    {
      label: 'Gemini 4 Argon (Medium)',
      modelId: 'gemini-4-argon-medium',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M72' },
    },
    {
      label: 'Gemini 4 Argon (Low)',
      modelId: 'gemini-4-argon-low',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M74' },
    },
    {
      label: 'Gemini 3.8 Flash (Medium)',
      modelId: 'gemini-3.8-flash-medium',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M80' },
    },
    {
      label: 'Gemini 3.8 Flash (Low)',
      modelId: 'gemini-3.8-flash-low',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M81' },
    },
  ],
};

test('countInvocationRetries: 1 normal retryInfos entry without error is 0 retries', () => {
  const cm = {
    retryInfos: [
      {
        usage: { inputTokens: '1000', outputTokens: '100' },
        traceId: '0x123',
        consumedCredits: [],
      },
    ],
  };
  assert.deepEqual(countInvocationRetries(cm), {
    total: 0,
    apiRetries: 0,
    modelCorrectable: 0,
  });
});

test('countInvocationRetries: counts multi-attempt retryInfos and explicit retryReason/error', () => {
  assert.deepEqual(
    countInvocationRetries({
      retryInfos: [
        { retryReason: 'RETRY_REASON_API_RETRYABLE', error: { userErrorMessage: '429' } },
        { usage: { inputTokens: '1000', outputTokens: '100' } },
      ],
    }),
    { total: 1, apiRetries: 1, modelCorrectable: 0 }
  );
  assert.deepEqual(
    countInvocationRetries({
      retryInfos: [{ retryReason: 'RETRY_REASON_MODEL_CORRECTABLE' }],
    }),
    { total: 1, apiRetries: 0, modelCorrectable: 1 }
  );
  assert.deepEqual(countInvocationRetries({ retries: 2 }), {
    total: 2,
    apiRetries: 2,
    modelCorrectable: 0,
  });
});

test('analyzeModelAndEffortFit: avoids Counterfactual Trap on 1-step surgical High-effort fix', () => {
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'fix race condition in server.mjs' } },
    { type: 'CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT' },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' },
  ];
  const genMeta = [
    {
      stepIndices: [1, 2],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M73',
        timeToFirstToken: '8.5s',
        usage: { inputTokens: '50000', outputTokens: '600', thinkingOutputTokens: '1800' },
      },
    },
  ];

  const res = analyzeModelAndEffortFit(genMeta, steps, MOCK_MODEL_CONFIG);
  assert.equal(res.totalTurns, 1);
  assert.equal(res.optimalTurns, 1);
  assert.equal(res.flaggedTurnsCount, 0);
  assert.equal(res.latestTurnFit.status, 'optimal');
  assert.equal(res.latestTurnFit.badge, 'Good fit');
  assert.equal(res.latestTurnFit.recommendedModel, '4 Argon (High)');
});

test('analyzeModelAndEffortFit: flags unused_effort and recommends lighter model/effort', () => {
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'yes' } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' },
  ];
  const genMeta = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M73',
        timeToFirstToken: '3.2s',
        usage: { inputTokens: '20000', outputTokens: '120', thinkingOutputTokens: '45' },
      },
    },
  ];

  const res = analyzeModelAndEffortFit(genMeta, steps, MOCK_MODEL_CONFIG);
  assert.equal(res.latestTurnFit.status, 'unused_effort');
  assert.equal(res.latestTurnFit.badge, 'Lower effort');
  assert.equal(res.latestTurnFit.recommendedModel, '3.8 Flash (Low)');
  assert.equal(res.latestTurnFit.promptPreview, 'yes');
});

test('analyzeModelAndEffortFit: skips unused_effort when no invocation reported thinkingOutputTokens', () => {
  const modelConfig = {
    clientModelConfigs: [
      {
        label: 'Claude Opus 5.5 (High)',
        modelId: 'claude-opus-5-5-high',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' },
      },
    ],
  };
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'explain the cache' } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' },
  ];
  const genMetaFor = (usage) => [
    { stepIndices: [1], chatModel: { model: 'MODEL_PLACEHOLDER_M402', timeToFirstToken: '3.2s', usage } },
  ];

  // Anthropic Vertex usage omits thinkingOutputTokens entirely: unknown, not zero
  const unreported = analyzeModelAndEffortFit(
    genMetaFor({ inputTokens: '20000', outputTokens: '120', apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX' }),
    steps,
    modelConfig
  );
  assert.equal(unreported.latestTurnFit.effort, 'High');
  assert.equal(unreported.latestTurnFit.status, 'optimal');

  const reported = analyzeModelAndEffortFit(
    genMetaFor({ inputTokens: '20000', outputTokens: '120', thinkingOutputTokens: '45' }),
    steps,
    modelConfig
  );
  assert.equal(reported.latestTurnFit.status, 'unused_effort');
});

test('analyzeModelAndEffortFit: flags loop_tax and steps down effort within family', () => {
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'search files and summarize' } },
    { type: 'CORTEX_STEP_TYPE_VIEW_FILE' },
    { type: 'CORTEX_STEP_TYPE_VIEW_FILE' },
    { type: 'CORTEX_STEP_TYPE_VIEW_FILE' },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' },
  ];
  const genMeta = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M73',
        timeToFirstToken: '2.0s',
        usage: { inputTokens: '30000', outputTokens: '100', thinkingOutputTokens: '150' },
      },
    },
    {
      stepIndices: [2],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M73',
        timeToFirstToken: '5.0s',
        usage: { inputTokens: '32000', outputTokens: '100', thinkingOutputTokens: '600' },
      },
    },
    {
      stepIndices: [3],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M73',
        timeToFirstToken: '4.5s',
        usage: { inputTokens: '34000', outputTokens: '100', thinkingOutputTokens: '550' },
      },
    },
    {
      stepIndices: [4],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M73',
        timeToFirstToken: '2.5s',
        usage: { inputTokens: '36000', outputTokens: '300', thinkingOutputTokens: '200' },
      },
    },
  ];

  const res = analyzeModelAndEffortFit(genMeta, steps, MOCK_MODEL_CONFIG);
  assert.equal(res.latestTurnFit.status, 'loop_tax');
  assert.equal(res.latestTurnFit.badge, 'Lower effort');
  assert.equal(res.latestTurnFit.recommendedModel, '4 Argon (Med)');
});

test('analyzeModelAndEffortFit: flags housekeeping on Flagship and recommends 3.8 Flash (Low)', () => {
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'commit changes' } },
    { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_DONE', runCommand: { exitCode: 0 } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' },
  ];
  const genMeta = [
    {
      stepIndices: [1, 2],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M74',
        timeToFirstToken: '3.0s',
        usage: { inputTokens: '18000', outputTokens: '150', thinkingOutputTokens: '180' },
      },
    },
  ];

  const res = analyzeModelAndEffortFit(genMeta, steps, MOCK_MODEL_CONFIG);
  assert.equal(res.latestTurnFit.status, 'housekeeping');
  assert.equal(res.latestTurnFit.badge, 'Lighter model');
  assert.equal(res.latestTurnFit.recommendedModel, '3.8 Flash (Low)');
});

test('analyzeModelAndEffortFit: flags thrashing and recommends upgrading to 4 Argon (High)', () => {
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'refactor complex parser' } },
    { type: 'CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT' },
  ];
  const genMeta = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M74',
        retryInfos: [{ retryReason: 'RETRY_REASON_MODEL_CORRECTABLE' }],
        usage: { inputTokens: '45000', outputTokens: '500', thinkingOutputTokens: '120' },
      },
    },
  ];

  const res = analyzeModelAndEffortFit(genMeta, steps, MOCK_MODEL_CONFIG);
  assert.equal(res.latestTurnFit.status, 'thrashing');
  assert.equal(res.latestTurnFit.badge, 'Upgrade tier');
  assert.equal(res.latestTurnFit.recommendedModel, '4 Argon (High)');
});

test('analyzeModelAndEffortFit: prioritizes userStep planModel over chatModel.model and carries it across turns', () => {
  const steps = [
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      userInput: {
        userResponse: 'yes',
        userConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M73' } },
      },
    },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' },
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      userInput: { userResponse: 'ok' },
    },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' },
  ];
  const genMeta = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M74',
        timeToFirstToken: '3.0s',
        usage: { inputTokens: '10000', outputTokens: '80', thinkingOutputTokens: '40' },
      },
    },
    {
      stepIndices: [3],
      chatModel: {
        timeToFirstToken: '3.1s',
        usage: { inputTokens: '11000', outputTokens: '80', thinkingOutputTokens: '45' },
      },
    },
  ];

  const res = analyzeModelAndEffortFit(genMeta, steps, MOCK_MODEL_CONFIG);
  assert.equal(res.totalTurns, 2);
  assert.equal(res.latestTurnFit.effort, 'High');
  assert.equal(res.latestTurnFit.status, 'unused_effort');
  assert.equal(res.recentFlaggedTurns.length, 2);
});
