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
