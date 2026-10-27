import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeModelAndEffortFit,
  countInvocationRetries,
  extractInvocationCharMetrics,
  measureInvocationThinking,
  formatThinkingTokens,
} from '../lib/effort-advisor.mjs';

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

const CLAUDE_HIGH_CONFIG = {
  clientModelConfigs: [
    {
      label: 'Claude Opus 5.5 (High)',
      modelId: 'claude-opus-5-5-high',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' },
    },
  ],
};

// 448 response chars + '[]' toolCalls JSON = 450 visible chars ≈ 247 output tokens at 1.82 chars/token
const VISIBLE_RESPONSE = 'x'.repeat(448);

function singleInvocationTurn({ usage, plannerResponse, model = 'MODEL_PLACEHOLDER_M402', stepIndices = [1] }) {
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'explain the cache' } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse },
  ];
  const genMeta = [{ stepIndices, chatModel: { model, timeToFirstToken: '3.2s', usage } }];
  return { steps, genMeta };
}

test('measureInvocationThinking: exact, known zero, estimated, unknown, and clamped', () => {
  const steps = [
    {},
    { plannerResponse: { response: VISIBLE_RESPONSE, thinking: 'hmm', thinkingSignature: 'sig' } },
    { plannerResponse: { response: VISIBLE_RESPONSE } },
  ];

  assert.deepEqual(
    measureInvocationThinking({ stepIndices: [1], chatModel: { usage: { outputTokens: '300', thinkingOutputTokens: '45' } } }, steps),
    { tokens: 45, estimated: false, known: true }
  );
  const claude = (outputTokens, stepIndices) => ({
    stepIndices,
    chatModel: { usage: { outputTokens, apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX' } },
  });
  assert.deepEqual(measureInvocationThinking(claude('247', [2]), steps), { tokens: 0, estimated: false, known: true });
  assert.deepEqual(measureInvocationThinking(claude('300', [1]), steps), { tokens: 53, estimated: true, known: true });
  assert.deepEqual(measureInvocationThinking(claude('300'), steps), { tokens: 0, estimated: false, known: false });
  assert.equal(measureInvocationThinking(claude('100', [1]), steps).tokens, 0);

  // Other providers: an absent field is an omitted zero, even with a thinking block
  assert.deepEqual(
    measureInvocationThinking(
      { stepIndices: [1], chatModel: { usage: { outputTokens: '300', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' } } },
      steps
    ),
    { tokens: 0, estimated: false, known: true }
  );
});

test('analyzeModelAndEffortFit: estimates Claude thinking from output minus visible text', () => {
  const claudeUsage = (outputTokens) => ({
    inputTokens: '20000',
    outputTokens,
    responseOutputTokens: outputTokens,
    apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX',
  });
  const thinkingResponse = { response: VISIBLE_RESPONSE, thinking: 'Let me check.', thinkingSignature: 'c2ln' };

  const light = singleInvocationTurn({ usage: claudeUsage('300'), plannerResponse: thinkingResponse });
  const lightFit = analyzeModelAndEffortFit(light.genMeta, light.steps, CLAUDE_HIGH_CONFIG).latestTurnFit;
  assert.equal(lightFit.effort, 'High');
  assert.equal(lightFit.status, 'unused_effort');
  assert.equal(lightFit.thinkEstimated, true);
  assert.match(lightFit.reason, /^Only needed ~53 thinking tokens/);

  const heavy = singleInvocationTurn({ usage: claudeUsage('900'), plannerResponse: thinkingResponse });
  const heavyFit = analyzeModelAndEffortFit(heavy.genMeta, heavy.steps, CLAUDE_HIGH_CONFIG).latestTurnFit;
  assert.equal(heavyFit.status, 'optimal');
  assert.equal(heavyFit.phaseSplit.totalThink, 653);

  // No thinking block at all: zero thinking is known, not estimated
  const none = singleInvocationTurn({ usage: claudeUsage('247'), plannerResponse: { response: VISIBLE_RESPONSE } });
  const noneFit = analyzeModelAndEffortFit(none.genMeta, none.steps, CLAUDE_HIGH_CONFIG).latestTurnFit;
  assert.equal(noneFit.status, 'unused_effort');
  assert.equal(noneFit.thinkEstimated, false);
});

test('analyzeModelAndEffortFit: treats an omitted thinkingOutputTokens without a thinking block as zero', () => {
  // The LS omits zero-valued fields, so a Gemini turn that did not think has no thinkingOutputTokens
  const turn = singleInvocationTurn({
    model: 'MODEL_PLACEHOLDER_M73',
    usage: { inputTokens: '20000', outputTokens: '120', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
    plannerResponse: { response: 'done' },
  });
  const fit = analyzeModelAndEffortFit(turn.genMeta, turn.steps, MOCK_MODEL_CONFIG).latestTurnFit;
  assert.equal(fit.effort, 'High');
  assert.equal(fit.status, 'unused_effort');
});

test('analyzeModelAndEffortFit: skips unused_effort when thinking cannot be measured', () => {
  const turn = singleInvocationTurn({
    usage: { inputTokens: '20000', outputTokens: '120', apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX' },
    plannerResponse: { response: 'done' },
    stepIndices: null,
  });
  const fit = analyzeModelAndEffortFit(turn.genMeta, turn.steps, CLAUDE_HIGH_CONFIG).latestTurnFit;
  assert.equal(fit.effort, 'High');
  assert.equal(fit.status, 'optimal');
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

test('formatThinkingTokens marks estimates and shows sub-margin estimates as <20', () => {
  assert.equal(formatThinkingTokens(0), '0');
  assert.equal(formatThinkingTokens(1_500), '1.5k');
  assert.equal(formatThinkingTokens(0, true), '<20');
  assert.equal(formatThinkingTokens(19, true), '<20');
  assert.equal(formatThinkingTokens(20, true), '~20');
  assert.equal(formatThinkingTokens(2_800, true), '~2.8k');
});

test('analyzeModelAndEffortFit: estimated thinking needs the error margin below the cut-off', () => {
  const claudeUsage = (outputTokens) => ({
    inputTokens: '20000',
    outputTokens,
    responseOutputTokens: outputTokens,
    apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX',
  });
  const thinkingResponse = { response: VISIBLE_RESPONSE, thinking: 'Let me check.', thinkingSignature: 'c2ln' };
  const fitFor = (outputTokens) => {
    const turn = singleInvocationTurn({ usage: claudeUsage(outputTokens), plannerResponse: thinkingResponse });
    return analyzeModelAndEffortFit(turn.genMeta, turn.steps, CLAUDE_HIGH_CONFIG).latestTurnFit;
  };

  // ~228 estimated thinking: under 240 on its own, but not once the ±20 margin is added
  assert.equal(fitFor('475').status, 'optimal');
  // ~208 estimated: clearly under 240 even with the margin
  assert.equal(fitFor('455').status, 'unused_effort');
  // A thinking block whose estimate rounds to nothing reads as "<20", not "~0"
  assert.match(fitFor('250').reason, /^Only needed <20 thinking tokens/);
});

test('analyzeModelAndEffortFit: exact thinking counts keep the plain cut-off', () => {
  const turn = singleInvocationTurn({
    model: 'MODEL_PLACEHOLDER_M73',
    usage: { inputTokens: '20000', outputTokens: '400', thinkingOutputTokens: '230', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
    plannerResponse: { response: 'done' },
  });
  const fit = analyzeModelAndEffortFit(turn.genMeta, turn.steps, MOCK_MODEL_CONFIG).latestTurnFit;
  assert.equal(fit.status, 'unused_effort');
  assert.match(fit.reason, /^Only needed 230 thinking tokens/);
});

test('measureInvocationThinking: strips toolCalls[].thinkingSignature and applies thinking text lower bound', () => {
  const bigSig = 'S'.repeat(1200);
  const steps = [
    {},
    {
      plannerResponse: {
        response: '',
        thinking: 'Analyzing the AST and type flow across modules...'.repeat(20), // 980 chars => >= 233 tokens
        thinkingDuration: '4.2s',
        toolCalls: [
          {
            id: 'call_1',
            name: 'run_command',
            argumentsJson: '{"CommandLine":"npm test"}',
            thinkingSignature: bigSig,
          },
        ],
      },
    },
  ];

  const metrics = extractInvocationCharMetrics([steps[1].plannerResponse]);
  assert.equal(metrics.hasThinkingBlock, true);
  assert.equal(metrics.thinkingSigChars, 1200);
  assert.equal(metrics.thinkingDurationSec, 4.2);
  // visibleToolChars excludes the 1200-char thinkingSignature
  assert.ok(metrics.visibleToolChars < 120);

  const claudeGen = {
    stepIndices: [1],
    chatModel: {
      usage: { outputTokens: '310', apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX' },
    },
  };
  const measured = measureInvocationThinking(claudeGen, steps);
  assert.equal(measured.estimated, true);
  assert.equal(measured.known, true);
  // Without stripping bigSig, 1200 chars would wipe out all 310 outputTokens to 0
  assert.ok(measured.tokens >= 233, `expected >= 233 thinking tokens, got ${measured.tokens}`);
});

test('analyzeModelAndEffortFit: requires 5x same-file edits or 3x+ with a failed command to flag thrashing, and prioritizes Re-edited reason', () => {
  const makeEditStep = (file) => ({
    type: 'CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT',
    replaceFileContent: { targetFile: file },
  });
  const genForStep = (idx) => ({
    stepIndices: [idx],
    chatModel: {
      model: 'MODEL_PLACEHOLDER_M74', // Argon Low
      timeToFirstToken: '2.0s',
      usage: { inputTokens: '20000', outputTokens: '200', thinkingOutputTokens: '120' },
    },
  });

  // 3 edits to the SAME file on Low effort WITHOUT failed commands -> optimal (routine surgical edits)
  const sameFileSteps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'update parser' } },
    makeEditStep('src/parser.mjs'),
    makeEditStep('src/parser.mjs'),
    makeEditStep('src/parser.mjs'),
  ];
  const sameFileRes = analyzeModelAndEffortFit(
    [genForStep(1), genForStep(2), genForStep(3)],
    sameFileSteps,
    MOCK_MODEL_CONFIG
  );
  assert.equal(sameFileRes.latestTurnFit.status, 'optimal');
  assert.equal(sameFileRes.latestTurnFit.sameFileMaxEdits, 3);

  // 2 edits to the SAME file on Low effort WITH a failed command -> thrashing via editAfterFailedCmd ("Edited code -> test command failed -> had to re-edit to fix it")
  const twoEditsFailedCmdSteps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'run test and fix' } },
    makeEditStep('src/parser.mjs'),
    { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', runCommand: { exitCode: 1 } },
    makeEditStep('src/parser.mjs'),
  ];
  const twoEditsFailedCmdRes = analyzeModelAndEffortFit(
    [genForStep(1), genForStep(2), genForStep(3)],
    twoEditsFailedCmdSteps,
    MOCK_MODEL_CONFIG
  );
  assert.equal(twoEditsFailedCmdRes.latestTurnFit.status, 'thrashing');
  assert.equal(twoEditsFailedCmdRes.latestTurnFit.sameFileMaxEdits, 2);
  assert.match(
    twoEditsFailedCmdRes.latestTurnFit.reason,
    /Edited code → test command failed → had to re-edit to fix it/
  );

  // 3 edits to the SAME file on Low effort WITH a failed command -> thrashing (Re-edited reason wins over Edited after 1 failed command)
  const sameFileFailedCmdSteps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'fix parser test' } },
    makeEditStep('src/parser.mjs'),
    { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', runCommand: { exitCode: 1 } },
    makeEditStep('src/parser.mjs'),
    makeEditStep('src/parser.mjs'),
  ];
  const sameFileFailedCmdRes = analyzeModelAndEffortFit(
    [genForStep(1), genForStep(2), genForStep(3), genForStep(4)],
    sameFileFailedCmdSteps,
    MOCK_MODEL_CONFIG
  );
  assert.equal(sameFileFailedCmdRes.latestTurnFit.status, 'thrashing');
  assert.equal(sameFileFailedCmdRes.latestTurnFit.sameFileMaxEdits, 3);
  assert.match(sameFileFailedCmdRes.latestTurnFit.reason, /Re-edited parser\.mjs 3x/);

  // 5 edits to the SAME file on Low effort WITHOUT failed commands -> thrashing
  const fiveEditSteps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'patch parser repeatedly' } },
    makeEditStep('src/parser.mjs'),
    makeEditStep('src/parser.mjs'),
    makeEditStep('src/parser.mjs'),
    makeEditStep('src/parser.mjs'),
    makeEditStep('src/parser.mjs'),
  ];
  const fiveEditRes = analyzeModelAndEffortFit(
    [genForStep(1), genForStep(2), genForStep(3), genForStep(4), genForStep(5)],
    fiveEditSteps,
    MOCK_MODEL_CONFIG
  );
  assert.equal(fiveEditRes.latestTurnFit.status, 'thrashing');
  assert.equal(fiveEditRes.latestTurnFit.sameFileMaxEdits, 5);
  assert.match(fiveEditRes.latestTurnFit.reason, /Re-edited parser\.mjs 5x/);

  // 3 edits to DIFFERENT files on Low effort -> optimal
  const multiFileSteps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'update three modules' } },
    makeEditStep('src/a.mjs'),
    makeEditStep('src/b.mjs'),
    makeEditStep('src/c.mjs'),
  ];
  const multiFileRes = analyzeModelAndEffortFit(
    [genForStep(1), genForStep(2), genForStep(3)],
    multiFileSteps,
    MOCK_MODEL_CONFIG
  );
  assert.equal(multiFileRes.latestTurnFit.status, 'optimal');
  assert.equal(multiFileRes.latestTurnFit.sameFileMaxEdits, 1);
});

test('analyzeModelAndEffortFit: canceled/interrupted turns never downgrade effort and flag thrashing on aborted edits', () => {
  // Aborted read-only turn on High effort with 30 thinking tokens -> stays optimal, NOT unused_effort
  const canceledReadSteps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'explain everything' } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_CANCELED' },
  ];
  const highGen = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M73',
        timeToFirstToken: '2.5s',
        usage: { inputTokens: '15000', outputTokens: '60', thinkingOutputTokens: '30' },
      },
    },
  ];
  const canceledReadFit = analyzeModelAndEffortFit(highGen, canceledReadSteps, MOCK_MODEL_CONFIG).latestTurnFit;
  assert.equal(canceledReadFit.wasAborted, true);
  assert.equal(canceledReadFit.status, 'optimal');

  // Aborted edit turn on Low effort -> thrashing
  const interruptedEditSteps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'fix bug' } },
    {
      type: 'CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT',
      status: 'CORTEX_STEP_STATUS_INTERRUPTED',
      replaceFileContent: { targetFile: 'src/app.mjs' },
    },
  ];
  const lowGen = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M74',
        timeToFirstToken: '2.0s',
        usage: { inputTokens: '15000', outputTokens: '100', thinkingOutputTokens: '40' },
      },
    },
  ];
  const abortedEditFit = analyzeModelAndEffortFit(lowGen, interruptedEditSteps, MOCK_MODEL_CONFIG).latestTurnFit;
  assert.equal(abortedEditFit.wasAborted, true);
  assert.equal(abortedEditFit.status, 'thrashing');
});

test('measureInvocationThinking: clamps textLowerBound so response tokens cannot fall below physical visible minimum', () => {
  const steps = [
    {},
    {
      plannerResponse: {
        response: 'v'.repeat(840), // 840 visible chars => minimum ceil(840 / 4.2) = 200 response tokens
        thinking: 't'.repeat(1260), // 1260 thinking chars => floor(1260 / 4.2) = 300 unclamped
      },
    },
  ];
  const claudeGen = {
    stepIndices: [1],
    chatModel: {
      usage: { outputTokens: '350', apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX' },
    },
  };
  const measured = measureInvocationThinking(claudeGen, steps);
  // maxPossibleThinking = 350 - ceil(840 / 4.2) = 149 (IEEE-754 840 / 4.2 = 200.00000000000003)
  assert.equal(measured.tokens, 149);
  assert.equal(measured.estimated, true);
});

test('analyzeModelAndEffortFit: normalizes CODE_ACTION, file:/// URIs, and Windows paths while excluding brain artifacts and hiding evaluatedTurns from JSON', () => {
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'fix file' } },
    {
      type: 'CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT',
      replaceFileContent: { targetFileUri: 'file:///c%3A/repo/src/index.mjs' },
    },
    {
      type: 'CORTEX_STEP_TYPE_WRITE_TO_FILE',
      writeToFile: { targetFile: 'C:\\repo\\src\\index.mjs' },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      plannerResponse: {
        toolCalls: [{ name: 'edit_file', argumentsJson: '{"Path":"c:/repo/src/index.mjs"}' }],
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      codeAction: {
        isArtifactFile: false,
        actionSpec: { modifyFile: { path: { absoluteUri: 'file:///C:/repo/src/index.mjs' } } },
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      codeAction: {
        isArtifactFile: false,
        actionSpec: { deleteFile: { path: { absoluteUri: 'file:///c:/repo/src/index.mjs' } } },
      },
    },
  ];
  const genForStep = (idx) => ({
    stepIndices: [idx],
    chatModel: {
      model: 'MODEL_PLACEHOLDER_M74',
      timeToFirstToken: '2.0s',
      usage: { inputTokens: '20000', outputTokens: '200', thinkingOutputTokens: '120' },
    },
  });
  const res = analyzeModelAndEffortFit(
    [genForStep(1), genForStep(2), genForStep(3), genForStep(4), genForStep(5)],
    steps,
    MOCK_MODEL_CONFIG
  );
  assert.equal(res.latestTurnFit.sameFileMaxEdits, 5);
  assert.equal(res.latestTurnFit.status, 'thrashing');
  assert.equal(res.evaluatedTurns.length, 1);
  assert.equal(Object.prototype.propertyIsEnumerable.call(res, 'evaluatedTurns'), false);
  assert.ok(!('evaluatedTurns' in JSON.parse(JSON.stringify(res))));

  // Dedicated non-tautological brain artifact test: 5 artifact edits to the same file on Low effort must produce sameFileMaxEdits === 0 and status === 'optimal'
  const artifactOnlySteps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'update implementation plan 5 times' } },
    {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      codeAction: {
        isArtifactFile: true,
        actionSpec: {
          command: {
            file: {
              absoluteUri: 'file:///c%3A/Users/dev/.gemini/antigravity/brain/conv-1/implementation_plan.md',
            },
          },
        },
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      codeAction: {
        isArtifactFile: true,
        actionSpec: {
          createFile: {
            path: {
              absoluteUri: 'file:///c%3A/Users/dev/.gemini/antigravity/brain/conv-1/implementation_plan.md',
            },
          },
        },
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_WRITE_TO_FILE',
      writeToFile: {
        targetFileUri: 'file:///c%3A/Users/dev/.gemini/antigravity/brain/conv-1/implementation_plan.md',
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_WRITE_TO_FILE',
      metadata: {
        toolCall: {
          name: 'write_file',
          argumentsJson:
            '{"Path":"C:\\\\Users\\\\dev\\\\custom\\\\implementation_plan.md","ArtifactMetadata":{"Summary":"plan"}}',
        },
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      plannerResponse: {
        toolCalls: [
          {
            name: 'edit_file',
            argumentsJson:
              '{"Path":"C:\\\\Users\\\\dev\\\\.gemini\\\\antigravity\\\\brain\\\\conv-1\\\\implementation_plan.md","ArtifactMetadata":{"Summary":"plan"}}',
          },
        ],
      },
    },
  ];
  const artifactOnlyRes = analyzeModelAndEffortFit(
    [genForStep(1), genForStep(2), genForStep(3), genForStep(4), genForStep(5)],
    artifactOnlySteps,
    MOCK_MODEL_CONFIG
  );
  assert.equal(artifactOnlyRes.latestTurnFit.sameFileMaxEdits, 0);
  assert.equal(artifactOnlyRes.latestTurnFit.status, 'optimal');
});
