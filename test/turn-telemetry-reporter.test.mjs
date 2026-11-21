import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearReportedTurnKeys,
  extractSettledTurnTelemetryRecords,
  reportSettledTurnTelemetry,
  resolveTelemetryOptIn,
} from '../lib/turn-telemetry-reporter.mjs';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

test('resolveTelemetryOptIn honors telemetry:false, DO_NOT_TRACK, HANGAR_TELEMETRY, and UUID validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-tel-'));
  const hangarPath = join(dir, 'hangar.json');

  try {
    writeFileSync(
      hangarPath,
      JSON.stringify({
        installId: VALID_UUID,
        telemetry: true,
        registryUrl: 'https://hangar.arthurcavallari.dev/registry.json',
      }),
      'utf8'
    );

    const ok = resolveTelemetryOptIn({ hangarConfigPath: hangarPath, env: {} });
    assert.deepEqual(ok, {
      enabled: true,
      installId: VALID_UUID,
      baseUrl: 'https://hangar.arthurcavallari.dev',
    });

    assert.equal(
      resolveTelemetryOptIn({ hangarConfigPath: hangarPath, env: { DO_NOT_TRACK: '1' } }).enabled,
      false
    );
    assert.equal(
      resolveTelemetryOptIn({ hangarConfigPath: hangarPath, env: { HANGAR_TELEMETRY: 'false' } }).enabled,
      false
    );

    writeFileSync(hangarPath, JSON.stringify({ installId: VALID_UUID, telemetry: false }), 'utf8');
    assert.equal(resolveTelemetryOptIn({ hangarConfigPath: hangarPath, env: {} }).enabled, false);

    writeFileSync(hangarPath, JSON.stringify({ installId: 'not-a-uuid', telemetry: true }), 'utf8');
    assert.equal(resolveTelemetryOptIn({ hangarConfigPath: hangarPath, env: {} }).enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractSettledTurnTelemetryRecords skips in-flight turns, extracts numerical records, and deduplicates', () => {
  clearReportedTurnKeys();
  const modelConfigData = {
    clientModelConfigs: [
      {
        label: 'Claude Opus 5.5 (High)',
        modelId: 'claude-opus-5-5-high',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' },
      },
    ],
  };

  const steps = [
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      status: 'CORTEX_STEP_STATUS_DONE',
      userInput: { userResponse: 'secret prompt text that must never be exported' },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_RUNNING',
      plannerResponse: {
        response: 'x'.repeat(448),
        thinking: 'reasoning...',
        thinkingDuration: '3.4s',
        toolCalls: [
          {
            id: 'call_1',
            name: 'view_file',
            argumentsJson: '{"TargetFile":"/secret/path.js"}',
            thinkingSignature: 'S'.repeat(1000),
          },
        ],
      },
    },
  ];
  const generators = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M402',
        timeToFirstToken: '4.1s',
        streamingDuration: '2.5s',
        usage: {
          inputTokens: '18000',
          cacheReadTokens: '90000',
          outputTokens: '650',
          responseOutputTokens: '650',
          apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX',
        },
      },
    },
  ];

  // 1. In-flight step -> 0 records extracted
  assert.equal(
    extractSettledTurnTelemetryRecords({
      cascadeId: 'conv-1',
      generatorMetadataList: generators,
      steps,
      modelConfigData,
    }).length,
    0
  );

  // 2. Settled step -> 1 invocation record ('plan') + 1 turn summary record ('turn')
  steps[1].status = 'CORTEX_STEP_STATUS_DONE';
  const records = extractSettledTurnTelemetryRecords({
    cascadeId: 'conv-1',
    generatorMetadataList: generators,
    steps,
    modelConfigData,
  });
  assert.equal(records.length, 2);
  assert.equal(records[0].phase, 'plan');
  assert.equal(records[0].modelId, 'claude-opus-5-5-high');
  assert.equal(records[0].effort, 'High');
  assert.equal(records[0].hasThinkingBlock, 1);
  assert.equal(records[0].thinkingSigChars, 1000);
  assert.equal(records[0].thinkingDurationMs, 3400);
  assert.equal(records[0].ttftMs, 4100);
  assert.equal(records[1].phase, 'turn');

  // Ensure no prompt or file strings leak into the serialized payload
  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes('secret'));

  // 3. Subsequent poll on same settled turn is deduplicated
  assert.equal(
    extractSettledTurnTelemetryRecords({
      cascadeId: 'conv-1',
      generatorMetadataList: generators,
      steps,
      modelConfigData,
    }).length,
    0
  );
  clearReportedTurnKeys();
});

test('reportSettledTurnTelemetry POSTs numerical records when opted in', async () => {
  clearReportedTurnKeys();
  const dir = mkdtempSync(join(tmpdir(), 'cm-report-'));
  const hangarPath = join(dir, 'hangar.json');
  writeFileSync(
    hangarPath,
    JSON.stringify({
      installId: VALID_UUID,
      telemetry: true,
      registryUrl: 'https://hangar.arthurcavallari.dev',
    }),
    'utf8'
  );

  const posted = [];
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: { response: 'done' },
    },
  ];
  const generators = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'gemini-4-argon-high',
        timeToFirstToken: '2.0s',
        usage: {
          inputTokens: '10000',
          outputTokens: '50',
          thinkingOutputTokens: '120',
          apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        },
      },
    },
  ];

  try {
    const res = await reportSettledTurnTelemetry({
      cascadeId: 'conv-abc',
      generatorMetadataList: generators,
      steps,
      options: {
        hangarConfigPath: hangarPath,
        env: {},
        telemetryFetchFn: async (url, init) => {
          posted.push({ url, headers: init.headers, body: JSON.parse(init.body) });
          return { ok: true, status: 202 };
        },
      },
    });
    assert.equal(res.sent, 2);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, 'https://hangar.arthurcavallari.dev/api/v1/telemetry/turns');
    assert.equal(posted[0].headers['X-Hangar-Install-Id'], VALID_UUID);
    assert.equal(posted[0].body.records.length, 2);
  } finally {
    clearReportedTurnKeys();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractSettledTurnTelemetryRecords skips the final turn while isExecuting is true even if all current steps are DONE', () => {
  clearReportedTurnKeys();
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'ok' } },
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
    { type: 'CORTEX_STEP_TYPE_VIEW_FILE', status: 'CORTEX_STEP_STATUS_DONE' },
  ];
  const generators = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'gemini-4-argon-high',
        usage: { inputTokens: '1000', outputTokens: '40', thinkingOutputTokens: '20' },
      },
    },
    {
      stepIndices: [3],
      chatModel: {
        model: 'gemini-4-argon-high',
        usage: { inputTokens: '1200', outputTokens: '40', thinkingOutputTokens: '20' },
      },
    },
  ];

  // Turn 1 is settled, Turn 2 is the last turn and isExecuting=true (between tool step and next model step)
  const whileRunning = extractSettledTurnTelemetryRecords({
    cascadeId: 'conv-exec',
    generatorMetadataList: generators,
    steps,
    isExecuting: true,
  });
  assert.equal(whileRunning.length, 2); // Only Turn 1 (1 invocation + 1 turn summary)

  // Once execution finishes, Turn 2 is emitted
  const afterDone = extractSettledTurnTelemetryRecords({
    cascadeId: 'conv-exec',
    generatorMetadataList: generators,
    steps,
    isExecuting: false,
  });
  assert.equal(afterDone.length, 2);
  clearReportedTurnKeys();
});

test('reportSettledTurnTelemetry retries after failed POST and batches >25 records without dropping turns', async () => {
  clearReportedTurnKeys();
  const dir = mkdtempSync(join(tmpdir(), 'cm-retry-'));
  const hangarPath = join(dir, 'hangar.json');
  writeFileSync(
    hangarPath,
    JSON.stringify({
      installId: VALID_UUID,
      telemetry: true,
      registryUrl: 'https://hangar.arthurcavallari.dev',
    }),
    'utf8'
  );

  // Build 15 turns (30 records total: 15 invocation rows + 15 turn rows, exceeding MAX_RECORDS_PER_POST=25)
  const steps = [];
  const generators = [];
  for (let i = 0; i < 15; i++) {
    const userIdx = steps.length;
    steps.push({ type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' });
    const respIdx = steps.length;
    steps.push({
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: { response: `turn-${i}` },
    });
    void userIdx;
    generators.push({
      stepIndices: [respIdx],
      chatModel: {
        model: 'gemini-4-argon-high',
        usage: { inputTokens: '1000', outputTokens: '40', thinkingOutputTokens: '10' },
      },
    });
  }

  let shouldFail = true;
  const batches = [];

  try {
    // 1. First poll fails with HTTP 500 -> 0 sent, nothing marked deduplicated
    const failedRes = await reportSettledTurnTelemetry({
      cascadeId: 'conv-batch',
      generatorMetadataList: generators,
      steps,
      options: {
        hangarConfigPath: hangarPath,
        env: {},
        telemetryFetchFn: async () => ({ ok: false, status: 500 }),
      },
    });
    assert.equal(failedRes.sent, 0);

    // 2. Second and third polls succeed -> drains all 30 records across 2 turn-aligned polls (24 + 6)
    shouldFail = false;
    const pollOptions = {
      hangarConfigPath: hangarPath,
      env: {},
      telemetryFetchFn: async (_url, init) => {
        if (shouldFail) return { ok: false, status: 500 };
        const body = JSON.parse(init.body);
        batches.push(body.records.length);
        return { ok: true, status: 202 };
      },
    };
    const okRes1 = await reportSettledTurnTelemetry({
      cascadeId: 'conv-batch',
      generatorMetadataList: generators,
      steps,
      options: pollOptions,
    });
    const okRes2 = await reportSettledTurnTelemetry({
      cascadeId: 'conv-batch',
      generatorMetadataList: generators,
      steps,
      options: pollOptions,
    });
    assert.equal(okRes1.sent, 24);
    assert.equal(okRes2.sent, 6);
    assert.deepEqual(batches, [24, 6]);
  } finally {
    clearReportedTurnKeys();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reportSettledTurnTelemetry deduplicates concurrent polls, persists across restarts with zero prompt text, and preserves turn summary on 25+ invocation turns', async () => {
  clearReportedTurnKeys();
  const dir = mkdtempSync(join(tmpdir(), 'cm-persist-'));
  const hangarPath = join(dir, 'hangar.json');
  const statePath = join(dir, 'turn-telemetry-state.json');
  writeFileSync(
    hangarPath,
    JSON.stringify({
      installId: VALID_UUID,
      telemetry: true,
      registryUrl: 'https://hangar.arthurcavallari.dev',
    }),
    'utf8'
  );

  const steps = [
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-10-27T07:00:00Z' },
      userInput: { userResponse: 'SENSITIVE_USER_PROMPT_DO_NOT_WRITE_TO_DISK' },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: { response: 'SENSITIVE_MODEL_RESPONSE_DO_NOT_WRITE_TO_DISK' },
    },
  ];
  const generators = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'gemini-4-argon-high',
        usage: { inputTokens: '1000', outputTokens: '40', thinkingOutputTokens: '10' },
      },
    },
  ];

  let postCount = 0;
  const options = {
    hangarConfigPath: hangarPath,
    env: {},
    telemetryFetchFn: async () => {
      postCount++;
      await new Promise((r) => setTimeout(r, 25));
      return { ok: true, status: 202 };
    },
  };

  try {
    // 1. Concurrent overlapping polls -> only 1 POST sent due to inFlightTurnKeys lock
    const [r1, r2] = await Promise.all([
      reportSettledTurnTelemetry({ cascadeId: 'conv-race', generatorMetadataList: generators, steps, options }),
      reportSettledTurnTelemetry({ cascadeId: 'conv-race', generatorMetadataList: generators, steps, options }),
    ]);
    assert.equal(r1.sent + r2.sent, 2);
    assert.equal(postCount, 1);

    // 2. Simulate process restart (clear in-memory Sets) -> reloads state file and sends 0 duplicate POSTs
    clearReportedTurnKeys();
    const afterRestart = await reportSettledTurnTelemetry({
      cascadeId: 'conv-race',
      generatorMetadataList: generators,
      steps,
      options,
    });
    assert.equal(afterRestart.sent, 0);
    assert.equal(postCount, 1);

    // 3. Trailing non-user step appended after turn -> dedup key anchored on lastGenStepIdx does not change
    steps.push({ type: 'CORTEX_STEP_TYPE_COMMAND_STATUS', status: 'CORTEX_STEP_STATUS_DONE' });
    const afterTrailingStep = await reportSettledTurnTelemetry({
      cascadeId: 'conv-race',
      generatorMetadataList: generators,
      steps,
      options,
    });
    assert.equal(afterTrailingStep.sent, 0);
    assert.equal(postCount, 1);

    // 4. Verify state file on disk contains zero prompt or response text
    const { readFileSync } = await import('node:fs');
    const rawState = readFileSync(statePath, 'utf8');
    assert.ok(!rawState.includes('SENSITIVE_USER_PROMPT'));
    assert.ok(!rawState.includes('SENSITIVE_MODEL_RESPONSE'));

    // 5. Reverting and modifying Turn 1 content produces a new FNV-1a content hash and reports the new turn
    steps[0].userInput.userResponse = 'DIFFERENT_PROMPT_AFTER_REVERT';
    const afterRevert = await reportSettledTurnTelemetry({
      cascadeId: 'conv-race',
      generatorMetadataList: generators,
      steps,
      options,
    });
    assert.equal(afterRevert.sent, 2);
    assert.equal(postCount, 2);

    // 6. Single turn with 26 invocations (27 records total) caps at 25 records AND preserves the final 'turn' summary row
    const bigSteps = [{ type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' }];
    const bigGens = [];
    for (let i = 0; i < 26; i++) {
      const idx = bigSteps.length;
      bigSteps.push({
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: `step-${i}` },
      });
      bigGens.push({
        stepIndices: [idx],
        chatModel: {
          model: 'gemini-4-argon-high',
          usage: { inputTokens: '1000', outputTokens: '40', thinkingOutputTokens: '10' },
        },
      });
    }
    let lastPostedBatch = null;
    const bigRes = await reportSettledTurnTelemetry({
      cascadeId: 'conv-big-turn',
      generatorMetadataList: bigGens,
      steps: bigSteps,
      options: {
        hangarConfigPath: hangarPath,
        env: {},
        telemetryFetchFn: async (_url, init) => {
          lastPostedBatch = JSON.parse(init.body).records;
          return { ok: true, status: 202 };
        },
      },
    });
    assert.equal(bigRes.sent, 25);
    assert.equal(lastPostedBatch.length, 25);
    assert.equal(lastPostedBatch[lastPostedBatch.length - 1].phase, 'turn');
    assert.equal(lastPostedBatch[lastPostedBatch.length - 1].invocationsCount, 26);

    // 7. Turn 1 RUNNING followed by Turn 2 DONE -> breaks at Turn 1 (0 records emitted) so Turn 2 is never emitted out of order
    clearReportedTurnKeys();
    const outOfOrderSteps = [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_RUNNING' },
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 't2' } },
    ];
    const outOfOrderGens = [
      { stepIndices: [1], chatModel: { model: 'gemini-4-argon-high', usage: { outputTokens: '20' } } },
      { stepIndices: [3], chatModel: { model: 'gemini-4-argon-high', usage: { outputTokens: '30' } } },
    ];
    assert.equal(
      extractSettledTurnTelemetryRecords({
        cascadeId: 'conv-order',
        generatorMetadataList: outOfOrderGens,
        steps: outOfOrderSteps,
      }).length,
      0
    );

    // 8. Generator referencing out-of-bounds stepIndices (not yet in steps[]) is treated as unsettled
    assert.equal(
      extractSettledTurnTelemetryRecords({
        cascadeId: 'conv-oob',
        generatorMetadataList: [{ stepIndices: [1, 2], chatModel: { model: 'gemini-4-argon-high', usage: { outputTokens: '20' } } }],
        steps: [
          { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
          { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
        ],
      }).length,
      0
    );

    // 9. Prompts stored in userInput.items[].text produce distinct dedup keys after revert
    const itemSteps = [
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        status: 'CORTEX_STEP_STATUS_DONE',
        userInput: { items: [{ text: 'prompt version A' }] },
      },
      { type: 'CORTEX_STEP_TYPE_VIEW_FILE', status: 'CORTEX_STEP_STATUS_DONE' },
    ];
    const itemGens = [{ stepIndices: [1], chatModel: { model: 'gemini-4-argon-high', usage: { outputTokens: '25' } } }];
    assert.equal(
      extractSettledTurnTelemetryRecords({
        cascadeId: 'conv-items',
        generatorMetadataList: itemGens,
        steps: itemSteps,
      }).length,
      2
    );
    itemSteps[0].userInput.items[0].text = 'prompt version B';
    assert.equal(
      extractSettledTurnTelemetryRecords({
        cascadeId: 'conv-items',
        generatorMetadataList: itemGens,
        steps: itemSteps,
      }).length,
      2
    );
  } finally {
    clearReportedTurnKeys();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractSettledTurnTelemetryRecords reports antigravity-add-model custom models by real name, or as `custom` when customNames is off [CM-06r]', () => {
  clearReportedTurnKeys();
  // antigravity-add-model lists a custom model with a slug of the user's own model name and a Gemini provider
  const modelConfigData = {
    clientModelConfigs: [
      {
        label: 'Acme Corp Fine-tune (High)',
        modelId: 'custom-ft-gpt-4o-mini-acme-corp-abc123',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M512' },
      },
    ],
  };
  const steps = [
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      status: 'CORTEX_STEP_STATUS_DONE',
      userInput: { userResponse: 'hello' },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: { response: 'x'.repeat(120) },
    },
  ];
  const generators = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M512',
        usage: {
          inputTokens: '4000',
          outputTokens: '40',
          responseOutputTokens: '40',
          apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        },
      },
    },
  ];

  const records = extractSettledTurnTelemetryRecords({
    cascadeId: 'conv-custom',
    generatorMetadataList: generators,
    steps,
    modelConfigData,
  });
  assert.equal(records.length, 2);
  for (const rec of records) {
    assert.equal(rec.modelId, 'custom-ft-gpt-4o-mini-acme-corp-abc123');
    assert.equal(rec.apiProvider, 'API_PROVIDER_CUSTOM', 'a custom model on a borrowed first-party provider never lands in Gemini buckets');
    assert.equal(rec.isCustom, true);
  }
  assert.equal(records[0].effort, 'High');
  assert.equal(records[0].outputTokens, 40);
  clearReportedTurnKeys();

  const optedOut = extractSettledTurnTelemetryRecords({
    cascadeId: 'conv-custom-off',
    generatorMetadataList: generators,
    steps,
    modelConfigData,
    customNames: false,
  });
  assert.equal(optedOut.length, 2);
  for (const rec of optedOut) {
    assert.equal(rec.modelId, 'custom');
    assert.equal(rec.apiProvider, 'API_PROVIDER_CUSTOM');
    assert.equal(rec.isCustom, true);
  }
  const serialized = JSON.stringify(optedOut).toLowerCase();
  assert.ok(!serialized.includes('acme'));
  assert.ok(!serialized.includes('gpt-4o'));
  clearReportedTurnKeys();
});

test('native 2.31.0 BYOM custom_models without custom- prefix report real names, skip calibration, and suppress Google quota active badge [CM-06]', async () => {
  clearReportedTurnKeys();
  const { resolveModelMetadata } = await import('../lib/session-resolver.mjs');
  const { extractPlanUsage } = await import('../lib/plan-quota.mjs');
  const { analyzeModelAndEffortFit } = await import('../lib/effort-advisor.mjs');

  const modelConfigData = {
    clientModelConfigs: [
      { label: 'Gemini 4 Carbon (High)', modelId: 'gemini-4-carbon-high', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M427' } },
      { label: 'Private Internal DeepSeek', modelId: 'deepseek-r1-corp' },
    ],
  };
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: 'audit' } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'done' } },
  ];
  const generators = [
    {
      stepIndices: [1],
      plannerConfig: { modelName: 'deepseek-r1-corp' },
      chatModel: {
        usage: {
          inputTokens: '6000',
          outputTokens: '90',
          apiProvider: 'API_PROVIDER_CUSTOM_OPENAI_COMPAT',
        },
      },
    },
  ];

  const meta = resolveModelMetadata(modelConfigData, generators[0], steps);
  assert.equal(meta.isCustom, true);
  assert.equal(meta.isGemini, false);
  assert.equal(meta.nativeCeiling, 256_000);

  const plan = extractPlanUsage({ response: { groups: [{ displayName: 'Gemini Models', buckets: [] }] } }, meta);
  assert.equal(plan.customModel, true);
  assert.equal(plan.activeGroupId, '');

  const fit = analyzeModelAndEffortFit(generators, steps, modelConfigData);
  assert.equal(fit.totalTurns, 0);
  assert.equal(fit.customTurns, 1);

  const records = extractSettledTurnTelemetryRecords({
    cascadeId: 'conv-byom-2310',
    generatorMetadataList: generators,
    steps,
    modelConfigData,
  });
  assert.equal(records.length, 2);
  for (const rec of records) {
    assert.equal(rec.modelId, 'deepseek-r1-corp');
    assert.equal(rec.apiProvider, 'API_PROVIDER_CUSTOM_OPENAI_COMPAT');
    assert.equal(rec.isCustom, true);
  }
  clearReportedTurnKeys();
});

test('custom model names are bounded, never carry URLs or keys, and opt out via HANGAR_TELEMETRY_CUSTOM_NAMES=0 or hangar.json [CM-06r]', async () => {
  const { sanitizeCustomModelId, resolveCustomModelNamesOptIn, reportSettledTurnTelemetry } = await import('../lib/turn-telemetry-reporter.mjs');
  assert.equal(sanitizeCustomModelId('deepseek-r1-local'), 'deepseek-r1-local');
  assert.equal(sanitizeCustomModelId('openrouter/deepseek-r1:free@v2+x'), 'openrouter/deepseek-r1:free@v2+x');
  assert.equal(sanitizeCustomModelId('https://api.corp.example/v1/model'), 'custom');
  assert.equal(sanitizeCustomModelId('sk-abcdefghijklmnop1234'), 'custom');
  assert.equal(sanitizeCustomModelId('x'.repeat(129)), 'custom');
  assert.equal(sanitizeCustomModelId('Aa0'.repeat(14)), 'custom', '40+ char opaque runs are key-like');
  assert.equal(sanitizeCustomModelId('name with spaces'), 'custom');
  assert.equal(sanitizeCustomModelId(''), 'custom');

  const dir = mkdtempSync(join(tmpdir(), 'cm06r-'));
  try {
    const installId = '11111111-2222-3333-4444-555555555555';
    const hangarConfigPath = join(dir, 'hangar.json');
    writeFileSync(hangarConfigPath, JSON.stringify({ installId, telemetry: true }));
    assert.equal(resolveCustomModelNamesOptIn({ hangarConfigPath, env: {} }), true, 'default ON');
    assert.equal(resolveCustomModelNamesOptIn({ hangarConfigPath, env: { HANGAR_TELEMETRY_CUSTOM_NAMES: '0' } }), false);
    assert.equal(resolveCustomModelNamesOptIn({ hangarConfigPath, env: { HANGAR_TELEMETRY_CUSTOM_NAMES: 'false' } }), false);
    writeFileSync(hangarConfigPath, JSON.stringify({ installId, customModelNames: false }));
    assert.equal(resolveCustomModelNamesOptIn({ hangarConfigPath, env: {} }), false, 'hangar.json opt-out');
    writeFileSync(hangarConfigPath, JSON.stringify({ installId }));

    const steps = [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: 'go' } },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'ok' } },
    ];
    const generators = [{
      stepIndices: [1],
      plannerConfig: { modelName: 'deepseek-r1' },
      chatModel: {
        usage: {
          inputTokens: '100',
          outputTokens: '10',
          apiProvider: 'API_PROVIDER_CUSTOM_OPENAI_COMPAT',
          baseUrl: 'https://llm.corp.example/v1',
          apiKey: 'sk-secretsecretsecret',
        },
      },
    }];
    const modelConfigData = {
      clientModelConfigs: [{ label: 'DeepSeek', modelId: 'deepseek-r1', baseUrl: 'https://llm.corp.example/v1', apiKey: 'sk-secretsecretsecret' }],
    };
    const send = async (env, id) => {
      clearReportedTurnKeys();
      const bodies = [];
      await reportSettledTurnTelemetry({
        cascadeId: id,
        generatorMetadataList: generators,
        steps,
        modelConfigData,
        options: {
          hangarConfigPath,
          telemetryStatePath: join(dir, `state-${id}.json`),
          env,
          telemetryFetchFn: async (_url, init) => {
            bodies.push(init.body);
            return { ok: true };
          },
        },
      });
      return bodies.join('');
    };
    const on = await send({}, 'conv-on');
    assert.match(on, /"modelId":"deepseek-r1"/);
    assert.match(on, /"apiProvider":"API_PROVIDER_CUSTOM_OPENAI_COMPAT"/);
    assert.match(on, /"isCustom":true/);
    for (const leak of ['llm.corp.example', 'sk-secret', 'baseUrl', 'apiKey']) assert.ok(!on.includes(leak), leak);
    const off = await send({ HANGAR_TELEMETRY_CUSTOM_NAMES: '0' }, 'conv-off');
    assert.match(off, /"modelId":"custom"/);
    assert.match(off, /"apiProvider":"API_PROVIDER_CUSTOM"/);
    assert.ok(!off.includes('deepseek'));
  } finally {
    clearReportedTurnKeys();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractSettledTurnTelemetryRecords preserves XHigh (including Orchestrator Neon) and Orchestrator Carbon High effort on warm turns', () => {
  clearReportedTurnKeys();
  const warmCatalog = {
    clientModelConfigs: [
      { label: 'Gemini 4 Neon (XHigh)', modelId: 'gemini-4-neon-xhigh', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M901' } },
      { label: 'Orchestrator (Neon)', modelId: 'gemini-pro-orchestrator-neon', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M905' } },
      { label: 'Orchestrator (Carbon)', modelId: 'gemini-pro-orchestrator', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M906' } },
    ],
  };
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'ok' } },
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'coordinated' } },
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'carbon coordinated' } },
  ];
  const generators = [
    {
      stepIndices: [1],
      chatModel: {
        model: 'gemini-4-neon-xhigh',
        usage: { inputTokens: '12000', outputTokens: '200', thinkingOutputTokens: '900', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
      },
    },
    {
      stepIndices: [3],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M905',
        usage: { inputTokens: '14000', outputTokens: '220', thinkingOutputTokens: '800', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
      },
    },
    {
      stepIndices: [5],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M906',
        usage: { inputTokens: '15000', outputTokens: '220', thinkingOutputTokens: '800', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
      },
    },
  ];
  try {
    const records = extractSettledTurnTelemetryRecords({
      cascadeId: 'conv-233-warm',
      generatorMetadataList: generators,
      steps,
      modelConfigData: warmCatalog,
    });
    const turnRecords = records.filter((r) => r.phase === 'turn');
    assert.equal(turnRecords.length, 3);
    assert.equal(turnRecords[0].modelId, 'gemini-4-neon-xhigh');
    assert.equal(turnRecords[0].effort, 'XHigh');
    assert.equal(turnRecords[1].modelId, 'gemini-pro-orchestrator-neon');
    assert.equal(turnRecords[1].effort, 'XHigh');
    assert.equal(turnRecords[2].modelId, 'gemini-pro-orchestrator');
    assert.equal(turnRecords[2].effort, 'High');
  } finally {
    clearReportedTurnKeys();
  }
});

test('2.34.0 dual-model turns resolve per-invocation executor modelId/effort/apiProvider/isCustom/_modelHint while keeping planner on turn summary', async () => {
  clearReportedTurnKeys();
  const dir = mkdtempSync(join(tmpdir(), 'cm-dual-tel-'));
  const hangarPath = join(dir, 'hangar.json');
  writeFileSync(
    hangarPath,
    JSON.stringify({
      installId: VALID_UUID,
      telemetry: true,
      registryUrl: 'https://hangar.arthurcavallari.dev',
    }),
    'utf8',
  );

  const modelConfigData = {
    clientModelConfigs: [
      { label: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' } },
      { label: 'Gemini 4 Hydrogen (Low)', modelId: 'gemini-4-hydrogen-low', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M527' } },
      { label: 'Gemini 5 Xenon Flash (Low)', modelId: 'gemini-5-xenon-flash-low', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M990' } },
      { label: 'Claude Sonnet 4.6 (Low)', modelId: 'claude-sonnet-4-6-low', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M409' }, apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX' },
      { label: 'Private Internal DeepSeek', modelId: 'deepseek-r1-corp' },
    ],
  };

  try {
    // 1. Neon (High) Planner + Hydrogen (Low) Executor (including step-level steps[idx].model fallback) + warm new placeholder M990 Executor
    const dualSteps = [
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        status: 'CORTEX_STEP_STATUS_DONE',
        userInput: {
          userResponse: 'refactor module',
          userConfig: {
            plannerConfig: {
              planModel: 'MODEL_PLACEHOLDER_M532',
              planExecuteConfig: { executionModel: 'MODEL_PLACEHOLDER_M527' },
            },
          },
        },
      },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'Plan ready.' } },
      { type: 'CORTEX_STEP_TYPE_VIEW_FILE', status: 'CORTEX_STEP_STATUS_DONE', model: 'MODEL_PLACEHOLDER_M527' },
      { type: 'CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT', status: 'CORTEX_STEP_STATUS_DONE', replaceFileContent: { targetFile: 'src/a.mjs' } },
      // Turn 2: Planner M532 + newly rolled-out M990 Executor (emits _modelHint for M990) + cold unmapped M999 Executor
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        status: 'CORTEX_STEP_STATUS_DONE',
        userInput: {
          userResponse: 'follow-up edit',
          userConfig: {
            plannerConfig: {
              planModel: 'MODEL_PLACEHOLDER_M532',
              planExecuteConfig: { executionModel: 'MODEL_PLACEHOLDER_M990' },
            },
          },
        },
      },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'Plan 2.' } },
      { type: 'CORTEX_STEP_TYPE_VIEW_FILE', status: 'CORTEX_STEP_STATUS_DONE' },
      { type: 'CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT', status: 'CORTEX_STEP_STATUS_DONE', replaceFileContent: { targetFile: 'src/b.mjs' } },
    ];
    const dualGens = [
      {
        stepIndices: [1],
        plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M532', modelName: 'gemini-4-neon-high', planExecuteConfig: { executionModel: 'MODEL_PLACEHOLDER_M527' } },
        chatModel: { model: 'MODEL_PLACEHOLDER_M532', timeToFirstToken: '3.2s', usage: { inputTokens: '20000', outputTokens: '180', thinkingOutputTokens: '420', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' } },
      },
      {
        stepIndices: [2], // Omitted chatModel.model -> resolved via steps[2].model
        chatModel: { timeToFirstToken: '1.1s', usage: { inputTokens: '22000', outputTokens: '80', thinkingOutputTokens: '40', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' } },
      },
      {
        stepIndices: [3],
        chatModel: { model: 'MODEL_PLACEHOLDER_M527', timeToFirstToken: '1.4s', usage: { inputTokens: '24000', outputTokens: '210', thinkingOutputTokens: '60', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' } },
      },
      {
        stepIndices: [5],
        plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M532', modelName: 'gemini-4-neon-high' },
        chatModel: { model: 'MODEL_PLACEHOLDER_M532', timeToFirstToken: '3.0s', usage: { inputTokens: '25000', outputTokens: '150', thinkingOutputTokens: '380', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' } },
      },
      {
        stepIndices: [6],
        chatModel: { model: 'MODEL_PLACEHOLDER_M990', timeToFirstToken: '0.9s', usage: { inputTokens: '26000', outputTokens: '90', thinkingOutputTokens: '30', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' } },
      },
      {
        stepIndices: [7],
        plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M532', modelName: 'gemini-4-neon-high' },
        chatModel: { model: 'MODEL_PLACEHOLDER_M999', timeToFirstToken: '1.0s', usage: { inputTokens: '27000', outputTokens: '190', thinkingOutputTokens: '50', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' } },
      },
    ];

    const postedBodies = [];
    const postRes = await reportSettledTurnTelemetry({
      cascadeId: 'conv-dual-234-tel',
      generatorMetadataList: dualGens,
      steps: dualSteps,
      modelConfigData,
      options: {
        hangarConfigPath: hangarPath,
        telemetryStatePath: join(dir, 'state-dual.json'),
        env: {},
        telemetryFetchFn: async (_url, init) => {
          postedBodies.push(JSON.parse(init.body));
          return { ok: true, status: 202 };
        },
      },
    });
    assert.equal(postRes.sent, 8);
    assert.equal(postedBodies.length, 1);
    const recs = postedBodies[0].records;

    // Turn 1 records: [plan (Neon High), loop (Hydrogen Low), edit (Hydrogen Low), turn (Neon High)]
    assert.deepEqual(
      recs.slice(0, 4).map((r) => ({ phase: r.phase, modelId: r.modelId, effort: r.effort, apiProvider: r.apiProvider })),
      [
        { phase: 'plan', modelId: 'gemini-4-neon-high', effort: 'High', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
        { phase: 'loop', modelId: 'gemini-4-hydrogen-low', effort: 'Low', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
        { phase: 'edit', modelId: 'gemini-4-hydrogen-low', effort: 'Low', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
        { phase: 'turn', modelId: 'gemini-4-neon-high', effort: 'High', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
      ],
    );

    // Turn 2 records: [plan (Neon High), loop (Xenon Flash Low via M990), edit (cold M999 Low), turn (Neon High)]
    assert.deepEqual(
      recs.slice(4, 8).map((r) => ({ phase: r.phase, modelId: r.modelId, effort: r.effort })),
      [
        { phase: 'plan', modelId: 'gemini-4-neon-high', effort: 'High' },
        { phase: 'loop', modelId: 'gemini-5-xenon-flash-low', effort: 'Low' },
        { phase: 'edit', modelId: 'MODEL_PLACEHOLDER_M999', effort: 'Low' },
        { phase: 'turn', modelId: 'gemini-4-neon-high', effort: 'High' },
      ],
    );
    assert.deepEqual(postedBodies[0].modelHints.MODEL_PLACEHOLDER_M990, {
      modelId: 'gemini-5-xenon-flash-low',
      effort: 'Low',
      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
      displayName: 'Gemini 5 Xenon Flash (Low)',
    });
    assert.equal(postedBodies[0].modelHints.MODEL_PLACEHOLDER_M999, undefined);

    // 2. Cross-vendor Dual-Model (Gemini Neon Planner + Claude Sonnet Executor) & Mixed Built-in Planner + Custom BYOM Executor
    clearReportedTurnKeys();
    const mixedSteps = [
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        status: 'CORTEX_STEP_STATUS_DONE',
        userInput: {
          userResponse: 'cross-vendor turn',
          userConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M532', planExecuteConfig: { executionModel: 'MODEL_PLACEHOLDER_M409' } } },
        },
      },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'Plan.' } },
      { type: 'CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT', status: 'CORTEX_STEP_STATUS_DONE', replaceFileContent: { targetFile: 'src/c.mjs' } },
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        status: 'CORTEX_STEP_STATUS_DONE',
        userInput: {
          userResponse: 'mixed custom executor turn',
          userConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M532', planExecuteConfig: { executionModel: 'deepseek-r1-corp' } } },
        },
      },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'Plan custom.' } },
      { type: 'CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT', status: 'CORTEX_STEP_STATUS_DONE', replaceFileContent: { targetFile: 'src/d.mjs' } },
    ];
    const mixedGens = [
      {
        stepIndices: [1],
        chatModel: { model: 'MODEL_PLACEHOLDER_M532', usage: { inputTokens: '15000', outputTokens: '120', thinkingOutputTokens: '350', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' } },
      },
      {
        stepIndices: [2],
        chatModel: { model: 'MODEL_PLACEHOLDER_M409', usage: { inputTokens: '16000', outputTokens: '200', responseOutputTokens: '200', apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX' } },
      },
      {
        stepIndices: [4],
        chatModel: { model: 'MODEL_PLACEHOLDER_M532', usage: { inputTokens: '17000', outputTokens: '130', thinkingOutputTokens: '320', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' } },
      },
      {
        stepIndices: [5],
        plannerConfig: { modelName: 'deepseek-r1-corp' },
        chatModel: { usage: { inputTokens: '18000', outputTokens: '240', apiProvider: 'API_PROVIDER_CUSTOM_OPENAI_COMPAT' } },
      },
    ];

    const mixedRecs = extractSettledTurnTelemetryRecords({
      cascadeId: 'conv-mixed-234',
      generatorMetadataList: mixedGens,
      steps: mixedSteps,
      modelConfigData,
    });
    assert.equal(mixedRecs.length, 6);
    // Cross-vendor Turn 1
    assert.equal(mixedRecs[0].phase, 'plan');
    assert.equal(mixedRecs[0].modelId, 'gemini-4-neon-high');
    assert.equal(mixedRecs[0].apiProvider, 'API_PROVIDER_GOOGLE_GEMINI');
    assert.equal(mixedRecs[0].isCustom, undefined);
    assert.equal(mixedRecs[1].phase, 'edit');
    assert.equal(mixedRecs[1].modelId, 'claude-sonnet-4-6-low');
    assert.equal(mixedRecs[1].effort, 'Low');
    assert.equal(mixedRecs[1].apiProvider, 'API_PROVIDER_ANTHROPIC_VERTEX');
    assert.equal(mixedRecs[1].isCustom, undefined);
    assert.equal(mixedRecs[2].phase, 'turn');
    assert.equal(mixedRecs[2].modelId, 'gemini-4-neon-high');
    assert.equal(mixedRecs[2].effort, 'High');
    assert.equal(mixedRecs[2].apiProvider, 'API_PROVIDER_GOOGLE_GEMINI');
    assert.equal(mixedRecs[2].isCustom, undefined);

    // Mixed Built-in Planner + Custom BYOM Executor Turn 2
    assert.equal(mixedRecs[3].phase, 'plan');
    assert.equal(mixedRecs[3].modelId, 'gemini-4-neon-high');
    assert.equal(mixedRecs[3].effort, 'High');
    assert.equal(mixedRecs[3].apiProvider, 'API_PROVIDER_GOOGLE_GEMINI');
    assert.equal(mixedRecs[3].isCustom, undefined);
    assert.equal(mixedRecs[4].phase, 'edit');
    assert.equal(mixedRecs[4].modelId, 'deepseek-r1-corp');
    assert.equal(mixedRecs[4].apiProvider, 'API_PROVIDER_CUSTOM_OPENAI_COMPAT');
    assert.equal(mixedRecs[4].isCustom, true);
    assert.equal(mixedRecs[5].phase, 'turn');
    assert.equal(mixedRecs[5].modelId, 'gemini-4-neon-high');
    assert.equal(mixedRecs[5].effort, 'High');
    assert.equal(mixedRecs[5].apiProvider, 'API_PROVIDER_GOOGLE_GEMINI');
    assert.equal(mixedRecs[5].isCustom, true);

    clearReportedTurnKeys();
    const mixedRedacted = extractSettledTurnTelemetryRecords({
      cascadeId: 'conv-mixed-234-redacted',
      generatorMetadataList: mixedGens,
      steps: mixedSteps,
      modelConfigData,
      customNames: false,
    });
    assert.equal(mixedRedacted[3].modelId, 'gemini-4-neon-high');
    assert.equal(mixedRedacted[3].isCustom, undefined);
    assert.equal(mixedRedacted[4].modelId, 'custom');
    assert.equal(mixedRedacted[4].apiProvider, 'API_PROVIDER_CUSTOM');
    assert.equal(mixedRedacted[4].isCustom, true);
    assert.equal(mixedRedacted[5].modelId, 'gemini-4-neon-high');
    assert.equal(mixedRedacted[5].isCustom, true);
  } finally {
    clearReportedTurnKeys();
    rmSync(dir, { recursive: true, force: true });
  }
});
