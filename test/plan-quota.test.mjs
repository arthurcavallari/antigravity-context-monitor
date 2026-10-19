import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatResetCountdown,
  extractPlanUsage,
  extractAiCreditsTelemetry,
  setAiCreditsOverageSetting,
  isGeminiFamily,
} from '../lib/plan-quota.mjs';

test('formatResetCountdown formats 5h and weekly windows accurately', () => {
  const now = Date.parse('2026-10-15T16:00:00Z');
  const in3h20m = '2026-10-15T19:20:00Z';
  const in5d21h = '2026-10-21T13:00:00Z';

  assert.equal(formatResetCountdown(in3h20m, '5h', now), '3h 20m');
  assert.equal(formatResetCountdown(in5d21h, 'weekly', now), '5d 21h');
  assert.equal(formatResetCountdown('2026-10-15T15:00:00Z', '5h', now), 'now');
});

test('isGeminiFamily distinguishes Gemini from Claude and GPT models', () => {
  assert.equal(
    isGeminiFamily('gemini-3.8-flash-high', 'API_PROVIDER_GOOGLE_GEMINI', 'Gemini 3.8 Flash'),
    true
  );
  assert.equal(
    isGeminiFamily('claude-sonnet-5-5-high', 'API_PROVIDER_ANTHROPIC', 'Claude Sonnet 5.5'),
    false
  );
  assert.equal(isGeminiFamily('gpt-oss-120b-medium', '', 'GPT-OSS 120B'), false);
});

test('extractPlanUsage selects matching provider group and computes percentages', () => {
  const now = Date.parse('2026-10-15T16:00:00Z');
  const mockQuota = {
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.76,
              resetTime: '2026-10-15T18:50:00Z',
            },
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.85,
              resetTime: '2026-10-21T12:00:00Z',
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-5h',
              window: '5h',
              remainingFraction: 0.92,
              resetTime: '2026-10-15T19:10:00Z',
            },
            {
              bucketId: '3p-weekly',
              window: 'weekly',
              remainingFraction: 0.64,
              resetTime: '2026-10-20T16:00:00Z',
            },
          ],
        },
      ],
    },
  };

  const geminiPlan = extractPlanUsage(
    mockQuota,
    { modelId: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { availablePromptCredits: 500 },
    now
  );
  assert.equal(geminiPlan.activeGroupId, 'gemini');
  assert.equal(geminiPlan.fiveHour.remainingPct, 76);
  assert.equal(geminiPlan.fiveHour.statusText, '76% · resets 2h 50m');
  assert.equal(geminiPlan.weekly.remainingPct, 85);
  assert.equal(geminiPlan.weekly.statusText, '85% · resets 5d 20h');

  const claudePlan = extractPlanUsage(
    mockQuota,
    { modelId: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    {},
    now
  );
  assert.equal(claudePlan.activeGroupId, 'claude_gpt');
  assert.equal(claudePlan.fiveHour.remainingPct, 92);
  assert.equal(claudePlan.weekly.remainingPct, 64);
});

test('extractAiCreditsTelemetry and setAiCreditsOverageSetting read/write credits & overage and refuse to overwrite malformed config.json', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cm-test-'));
  const cfgPath = join(tmpDir, 'config.json');

  try {
    await setAiCreditsOverageSetting(true, { configPath: cfgPath, lsAddress: '' });

    const userStatus = {
      userStatus: {
        userTier: {
          name: 'Google AI Ultra',
          availableCredits: [
            { creditType: 'GOOGLE_ONE_AI', creditAmount: '5589', minimumCreditAmountForUsage: '50' },
          ],
        },
      },
    };
    const gmList = [
      { chatModel: { consumedCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '20' }] } },
      { chatModel: { consumedCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '37' }] } },
    ];

    const c1 = extractAiCreditsTelemetry(userStatus, gmList, { configPath: cfgPath });
    assert.equal(c1.tierName, 'Google AI Ultra');
    assert.equal(c1.available, 5589);
    assert.equal(c1.formattedAvailable, '5,589');
    assert.equal(c1.sessionUsed, 57);
    assert.equal(c1.lastTurnUsed, 37);
    assert.equal(c1.useAiCredits, true);

    await setAiCreditsOverageSetting(false, { configPath: cfgPath, lsAddress: '' });
    const c2 = extractAiCreditsTelemetry(userStatus, gmList, { configPath: cfgPath });
    assert.equal(c2.useAiCredits, false);

    // Malformed config.json must throw and remain untouched rather than being truncated
    const corruptedContent = '{ "sidecars": { "context-monitor": { "enabled": true } ';
    writeFileSync(cfgPath, corruptedContent, 'utf8');
    await assert.rejects(() => setAiCreditsOverageSetting(true, { configPath: cfgPath, lsAddress: '' }));
    assert.equal(readFileSync(cfgPath, 'utf8'), corruptedContent);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
