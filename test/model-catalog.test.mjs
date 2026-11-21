import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchFullTelemetry, clearConversationDetails } from '../lib/context-telemetry.mjs';
import { clearRpcCache, lsRpcCache } from '../lib/rpc-cache.mjs';
import {
  clearModelCatalogState,
  collectReferencedModelKeys,
  extractThinkingEffort,
  mapThinkingLevel,
  stripModelFamilySlug,
  stripModelSuffixAndVendor,
} from '../lib/model-catalog.mjs';
import { STATIC_MODEL_FALLBACKS } from '../lib/constants.mjs';
import { clearReportedTurnKeys, reportSettledTurnTelemetry } from '../lib/turn-telemetry-reporter.mjs';

const VALID_UUID = '12345678-1234-4234-8234-1234567890ab';

function makeXenonCatalog({ includeRadon = false, includeGptOss = true } = {}) {
  const models = {
    'gemini-5-xenon-xhigh': {
      model: 'MODEL_PLACEHOLDER_M910',
      displayName: 'Gemini 5 Xenon (XHigh)',
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
      thinkingLevel: 100,
      maxTokens: 2097152,
      maxOutputTokens: 262144,
      recommended: true,
      modelExperiments: {
        experiments: {
          CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
            stringValue: JSON.stringify({ max_token_limit: '768000' }),
          },
          bloated_monitor_prompt: { stringValue: 'P'.repeat(40000) },
        },
      },
    },
    'gemini-5-helium-tiered-high': {
      model: 'MODEL_PLACEHOLDER_M922',
      displayName: 'Gemini 5 Helium (High)',
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
      thinkingLevel: 3,
      maxTokens: 1048576,
      maxOutputTokens: 262144,
      recommended: true,
      modelExperiments: {
        experiments: {
          CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
            stringValue: JSON.stringify({ max_token_limit: '512000' }),
          },
        },
      },
    },
    'gemini-5-helium-low': {
      model: 'MODEL_PLACEHOLDER_M921',
      displayName: 'Gemini 5 Helium (Low)',
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
      thinkingLevel: 1,
      maxTokens: 1048576,
      maxOutputTokens: 262144,
      recommended: true,
      modelExperiments: {
        experiments: {
          CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
            stringValue: JSON.stringify({ max_token_limit: '512000' }),
          },
        },
      },
    },
    'gemini-5-helium-minimal': {
      model: 'MODEL_PLACEHOLDER_M940',
      displayName: 'Gemini 5 Helium (Minimal)',
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
      thinkingLevel: 4,
      maxTokens: 1048576,
      maxOutputTokens: 65536,
      recommended: true,
    },
  };
  if (includeRadon) {
    models['gemini-5-radon-xhigh'] = {
      model: 'MODEL_PLACEHOLDER_M990',
      displayName: 'Gemini 5 Radon (XHigh)',
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
      thinkingLevel: 100,
      maxTokens: 1048576,
      maxOutputTokens: 262144,
      recommended: true,
      modelExperiments: {
        experiments: {
          CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
            stringValue: JSON.stringify({ max_token_limit: '512000' }),
          },
        },
      },
    };
  }
  if (includeGptOss) {
    models['gpt-oss-120b-medium'] = {
      model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
      displayName: 'GPT-OSS 120B (Medium)',
      modelProvider: 'MODEL_PROVIDER_OPENAI',
      apiProvider: 'API_PROVIDER_OPENAI_VERTEX',
      maxTokens: 131072,
      maxOutputTokens: 32768,
      recommended: true,
      modelExperiments: {
        experiments: {
          CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
            stringValue: JSON.stringify({ max_token_limit: '80000' }),
          },
        },
      },
    };
  }
  return {
    response: {
      defaultAgentModelId: includeRadon ? 'gemini-5-radon-xhigh' : 'gemini-5-xenon-xhigh',
      tieredModelIds: {
        flashLite: ['gemini-4.5-flash-lite'],
        flash: ['gemini-5-helium-tiered-high'],
        pro: ['gemini-5-helium-tiered-high'],
      },
      agentModelSorts: [
        {
          displayName: 'Recommended',
          groups: [
            {
              modelIds: [
                ...(includeRadon ? ['gemini-5-radon-xhigh'] : []),
                'gemini-5-xenon-xhigh',
                'gemini-5-helium-low',
                'gemini-5-helium-minimal',
                ...(includeGptOss ? ['gpt-oss-120b-medium'] : []),
              ],
            },
          ],
        },
      ],
      models,
    },
  };
}

test('GetAvailableModels auto-detects unhardcoded future models, dynamic checkpointer ceilings, hidden subagent models, and Minimal effort', async () => {
  clearRpcCache();
  clearConversationDetails();
  clearModelCatalogState();
  const avail = makeXenonCatalog();
  try {
    const res = await fetchFullTelemetry({
      lsAddress: '127.0.0.1:59801',
      csrfToken: 'csrf',
      configPath: join(tmpdir(), 'nonexistent-agy-cfg.json'),
      hostCascadeId: 'conv-xenon',
      fetchFn: async (url) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        let body = {};
        if (method === 'GetAvailableModels') body = avail;
        else if (method === 'GetAllCascadeTrajectories') {
          body = {
            trajectorySummaries: {
              'conv-xenon': {
                status: 'CASCADE_RUN_STATUS_IDLE',
                stepCount: 2,
                lastModifiedTime: '2026-11-19T11:00:00Z',
                annotations: { title: 'Xenon Test' },
              },
              'sub-helium': {
                status: 'CASCADE_RUN_STATUS_IDLE',
                stepCount: 3,
                createdTime: '2026-11-19T10:59:00Z',
                lastModifiedTime: '2026-11-19T10:59:30Z',
                trajectoryMetadata: {
                  parentConversationId: 'conv-xenon',
                  rootConversationId: 'conv-xenon',
                  nestingDepth: 1,
                  subagentSpec: { typeName: 'research', role: 'Fast Explorer', model: 'MODEL_PLACEHOLDER_M922' },
                },
              },
            },
          };
        } else if (method === 'GetCascadeTrajectorySteps') {
          body = {
            steps: [
              { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: 'ok' } },
              { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'Done.' } },
            ],
          };
        } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          body = {
            generatorMetadata: [
              {
                stepIndices: [1],
                chatModel: {
                  model: 'MODEL_PLACEHOLDER_M910',
                  timeToFirstToken: '3.5s',
                  usage: { inputTokens: '20000', outputTokens: '80', thinkingOutputTokens: '35' },
                },
              },
            ],
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      },
    });

    assert.equal(res.model.modelId, 'gemini-5-xenon-xhigh');
    assert.equal(res.model.badgeLabel, 'Gemini 5 Xenon (XHigh)');
    assert.equal(res.model.thinkingEffort, 'XHigh');
    assert.equal(res.model.ceiling, 768000);
    assert.equal(res.model.ceilingFormatted, '768k');
    assert.equal(res.model.nativeCeiling, 2097152);
    assert.equal(res.model.nativeCeilingFormatted, '2.0M');
    assert.equal(res.model.maxOutputTokens, 262144);

    // Flagship vs Fast auto-detected without hardcoding 'xenon' or 'helium'
    assert.equal(res.turnInsights.effortAdvisor.latestTurnFit.status, 'unused_effort');
    assert.equal(res.turnInsights.effortAdvisor.latestTurnFit.recommendedModel, '5 Helium (Low)');

    // Hidden subagent tiered model M922 resolved via GetAvailableModels
    assert.equal(res.subagents.items[0].modelBadge, 'Gemini 5 Helium (High)');
  } finally {
    clearRpcCache();
    clearConversationDetails();
    clearModelCatalogState();
  }
});

test('reactive cache-miss refresh detects newly rolled-out server models on their very first turn with 60s cooldown guard', async () => {
  clearRpcCache();
  clearConversationDetails();
  clearModelCatalogState();

  let serverRolledOutRadon = false;
  let activeModelEnum = 'MODEL_PLACEHOLDER_M910';
  let stepMod = '2026-11-19T11:00:00Z';
  const rpcCounts = {};

  const callTelemetry = (nowMs) =>
    fetchFullTelemetry({
      lsAddress: '127.0.0.1:59802',
      csrfToken: 'csrf',
      configPath: join(tmpdir(), 'nonexistent-agy-cfg.json'),
      hostCascadeId: 'conv-live',
      nowMs,
      fetchFn: async (url, init) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        const req = JSON.parse(init?.body || '{}');
        rpcCounts[method] = (rpcCounts[method] || 0) + 1;
        let body = {};
        if (method === 'GetAvailableModels') {
          body = makeXenonCatalog({ includeRadon: serverRolledOutRadon });
        } else if (method === 'GetAllCascadeTrajectories') {
          body = {
            trajectorySummaries: {
              'conv-live': {
                status: 'CASCADE_RUN_STATUS_IDLE',
                stepCount: 2,
                lastModifiedTime: stepMod,
                annotations: { title: 'Live Rollout' },
              },
            },
          };
        } else if (method === 'GetCascadeTrajectorySteps') {
          const all = [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: 'hi' } },
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'yo' } },
          ];
          body = { steps: all.slice(req.stepOffset || 0) };
        } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          const all = [
            {
              stepIndices: [1],
              chatModel: {
                model: activeModelEnum,
                usage: { inputTokens: '10000', outputTokens: '100', thinkingOutputTokens: '800' },
              },
            },
          ];
          body = { generatorMetadata: all.slice(req.generatorMetadataOffset || 0) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      },
    });

  try {
    // Poll 1: initial hydration before Radon exists
    const first = await callTelemetry(1_000);
    assert.equal(first.model.badgeLabel, 'Gemini 5 Xenon (XHigh)');
    assert.equal(rpcCounts.GetAvailableModels, 1);

    // 5s later (2s trajectory TTL expired, 30s GetAvailableModels TTL still cached): Radon rolls out server-side
    serverRolledOutRadon = true;
    activeModelEnum = 'MODEL_PLACEHOLDER_M990';
    stepMod = '2026-11-19T11:00:05Z';
    lsRpcCache.invalidate('GetAllCascadeTrajectories');
    const second = await callTelemetry(6_000);
    assert.equal(rpcCounts.GetAvailableModels, 2, 'cache-miss immediately invalidated and re-fetched GetAvailableModels');
    assert.equal(second.model.modelId, 'gemini-5-radon-xhigh');
    assert.equal(second.model.badgeLabel, 'Gemini 5 Radon (XHigh)');
    assert.equal(second.model.ceiling, 512000);

    // Genuinely unknown model M999 refreshes once, then respects 60s cooldown on the next poll 2s later
    activeModelEnum = 'MODEL_PLACEHOLDER_M999';
    stepMod = '2026-11-19T11:00:08Z';
    lsRpcCache.invalidate('GetAllCascadeTrajectories');
    await callTelemetry(8_000);
    assert.equal(rpcCounts.GetAvailableModels, 3);

    stepMod = '2026-11-19T11:00:10Z';
    lsRpcCache.invalidate('GetAllCascadeTrajectories');
    await callTelemetry(10_000);
    assert.equal(rpcCounts.GetAvailableModels, 3, '60s per-key cooldown prevents RPC spam');
  } finally {
    clearRpcCache();
    clearConversationDetails();
    clearModelCatalogState();
  }
});

test('model-catalog-cache.json persists compact catalog across cold LS restarts, retains retired models, and canonicalizes outgoing turn telemetry', async () => {
  clearRpcCache();
  clearConversationDetails();
  clearModelCatalogState();
  clearReportedTurnKeys();
  const dir = mkdtempSync(join(tmpdir(), 'cm-cat-disk-'));
  const catalogPath = join(dir, 'model-catalog-cache.json');
  const hangarPath = join(dir, 'hangar.json');

  try {
    // 1. Hydrate disk cache with Xenon + GPT-OSS
    await fetchFullTelemetry({
      lsAddress: '127.0.0.1:59803',
      csrfToken: 'csrf',
      configPath: join(dir, 'nonexistent.json'),
      modelCatalogPath: catalogPath,
      hostCascadeId: 'conv-1',
      fetchFn: async (url) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        const body = method === 'GetAvailableModels' ? makeXenonCatalog({ includeGptOss: true }) : {};
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      },
    });
    assert.equal(existsSync(catalogPath), true);
    const diskRaw = readFileSync(catalogPath, 'utf8');
    assert.ok(diskRaw.length < 15_000, `disk cache must strip huge prompt blobs, got ${diskRaw.length} bytes`);
    assert.ok(!diskRaw.includes('PPPPPPPP'));

    // 2. Cold LS restart: wipe in-memory caches; LS returns empty {} for all model RPCs
    clearRpcCache();
    clearConversationDetails();
    clearModelCatalogState();

    const coldRes = await fetchFullTelemetry({
      lsAddress: '127.0.0.1:59804',
      csrfToken: 'csrf',
      configPath: join(dir, 'nonexistent.json'),
      modelCatalogPath: catalogPath,
      hostCascadeId: 'conv-cold',
      fetchFn: async (url) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        let body = {};
        if (method === 'GetAllCascadeTrajectories') {
          body = {
            trajectorySummaries: {
              'conv-cold': { status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 2, lastModifiedTime: '2026-11-19T12:00:00Z' },
            },
          };
        } else if (method === 'GetCascadeTrajectorySteps') {
          body = {
            steps: [
              { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: 'cold' } },
              { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'ok' } },
            ],
          };
        } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          body = {
            generatorMetadata: [
              {
                stepIndices: [1],
                chatModel: {
                  model: 'MODEL_PLACEHOLDER_M910',
                  usage: { inputTokens: '12000', outputTokens: '100', thinkingOutputTokens: '600' },
                },
              },
            ],
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      },
    });
    assert.equal(coldRes.model.modelId, 'gemini-5-xenon-xhigh');
    assert.equal(coldRes.model.badgeLabel, 'Gemini 5 Xenon (XHigh)');
    assert.equal(coldRes.model.ceiling, 768000);

    // 3. Server drops GPT-OSS after retirement date; historical GPT-OSS conversation still resolves from retained disk entry
    clearRpcCache();
    const postRetirementRes = await fetchFullTelemetry({
      lsAddress: '127.0.0.1:59805',
      csrfToken: 'csrf',
      configPath: join(dir, 'nonexistent.json'),
      modelCatalogPath: catalogPath,
      hostCascadeId: 'conv-gpt-old',
      fetchFn: async (url) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        let body = {};
        if (method === 'GetAvailableModels') body = makeXenonCatalog({ includeGptOss: false });
        else if (method === 'GetAllCascadeTrajectories') {
          body = {
            trajectorySummaries: {
              'conv-gpt-old': { status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 2, lastModifiedTime: '2026-12-02T12:00:00Z' },
            },
          };
        } else if (method === 'GetCascadeTrajectorySteps') {
          body = {
            steps: [
              { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
              { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'old' } },
            ],
          };
        } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          body = {
            generatorMetadata: [
              {
                stepIndices: [1],
                chatModel: {
                  model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
                  usage: { inputTokens: '8000', outputTokens: '90' },
                },
              },
            ],
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      },
    });
    assert.equal(postRetirementRes.model.badgeLabel, 'GPT-OSS 120B (Medium)');
    assert.equal(postRetirementRes.model.ceiling, 80000);

    // 4. Outgoing turn telemetry resolves cold MODEL_PLACEHOLDER_M910 via catalog and includes modelHints
    const { writeFileSync } = await import('node:fs');
    writeFileSync(hangarPath, JSON.stringify({ installId: VALID_UUID, telemetry: true }));
    const postedPayloads = [];
    await reportSettledTurnTelemetry({
      cascadeId: 'conv-ship-xenon',
      generatorMetadataList: [
        {
          stepIndices: [1],
          chatModel: {
            model: 'MODEL_PLACEHOLDER_M910',
            usage: { inputTokens: '12000', outputTokens: '100', thinkingOutputTokens: '600' },
          },
        },
      ],
      steps: [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'ok' } },
      ],
      modelConfigData: { modelCatalog: coldRes._modelCatalogForTest || undefined },
      options: {
        hangarConfigPath: hangarPath,
        modelCatalogPath: catalogPath,
        env: {},
        telemetryFetchFn: async (_url, init) => {
          postedPayloads.push(JSON.parse(init.body));
          return { ok: true, status: 202 };
        },
      },
    });
    assert.equal(postedPayloads.length, 1);
    const turnRec = postedPayloads[0].records.find((r) => r.phase === 'turn');
    assert.equal(turnRec.modelId, 'gemini-5-xenon-xhigh');
    assert.equal(turnRec.effort, 'XHigh');
    assert.equal(turnRec.apiProvider, 'API_PROVIDER_GOOGLE_GEMINI');
    assert.equal(postedPayloads[0].modelHints.MODEL_PLACEHOLDER_M910.modelId, 'gemini-5-xenon-xhigh');
    assert.equal(postedPayloads[0].modelHints.MODEL_PLACEHOLDER_M910.displayName, 'Gemini 5 Xenon (XHigh)');
  } finally {
    clearRpcCache();
    clearConversationDetails();
    clearModelCatalogState();
    clearReportedTurnKeys();
    rmSync(dir, { recursive: true, force: true });
  }

  const t0 = performance.now();
  assert.equal(extractThinkingEffort(`${' '.repeat(50_000)}(Nope)`, 'x'), '');
  assert.equal(stripModelSuffixAndVendor(`Gemini ${' '.repeat(50_000)}(Nope)`), '(Nope)');
  assert.equal(stripModelFamilySlug(`gemini${'-tiered-'.repeat(10_000)}x`), 'gemini');
  assert.ok(performance.now() - t0 < 200);
});

test('2.34.0 M537 XHigh, mapThinkingLevel(7), Orchestrator (Neon) effort, and collectReferencedModelKeys dual-model/step keys', () => {
  assert.equal(STATIC_MODEL_FALLBACKS.MODEL_PLACEHOLDER_M537.thinkingEffort, 'XHigh');
  assert.equal(STATIC_MODEL_FALLBACKS.MODEL_PLACEHOLDER_M667.thinkingEffort, 'High');
  assert.equal(mapThinkingLevel(7), 'XHigh');
  assert.equal(mapThinkingLevel(5), 'XHigh');
  assert.equal(mapThinkingLevel(100), 'XHigh');
  assert.equal(extractThinkingEffort('Orchestrator (Neon)', 'gemini-pro-orchestrator-neon'), 'XHigh');
  assert.equal(extractThinkingEffort('Orchestrator (Neon)', ''), 'XHigh');
  assert.equal(extractThinkingEffort('Orchestrator (Carbon)', 'gemini-pro-orchestrator'), 'High');

  const refs = collectReferencedModelKeys(
    [
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        userInput: {
          userConfig: {
            plannerConfig: {
              planModel: 'MODEL_PLACEHOLDER_M532',
              planExecuteConfig: { executionModel: 'MODEL_PLACEHOLDER_M525' },
            },
          },
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        model: 'MODEL_PLACEHOLDER_M977',
      },
    ],
    [
      {
        plannerConfig: {
          planModel: 'MODEL_PLACEHOLDER_M532',
          planExecuteConfig: { executionModel: 'MODEL_PLACEHOLDER_M988' },
        },
        chatModel: { usage: { apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' } },
      },
    ],
  );
  assert.ok(refs.includes('MODEL_PLACEHOLDER_M532'));
  assert.ok(refs.includes('MODEL_PLACEHOLDER_M525'), 'collects step planExecuteConfig.executionModel');
  assert.ok(refs.includes('MODEL_PLACEHOLDER_M988'), 'collects generator planExecuteConfig.executionModel');
  assert.ok(refs.includes('MODEL_PLACEHOLDER_M977'), 'collects step-level steps[i].model');
});
