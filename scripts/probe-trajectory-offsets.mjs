#!/usr/bin/env node
/**
 * @fileoverview Read-only check of how the running Language Server pages GetCascadeTrajectorySteps and
 * GetCascadeTrajectoryGeneratorMetadata, which Context Monitor's incremental reads rely on.
 *
 *   node scripts/probe-trajectory-offsets.mjs [cascadeId]
 *
 * Uses ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN, or the runtime.json a running sidecar caches.
 * Without a cascadeId it picks the most recently viewed conversation. It sends one full read of each
 * list (as heavy as one old-style telemetry poll) plus a few small offset reads, and changes nothing.
 */

// Only the kit's callLsRpc/getLsConfig (in every kit release), so it also runs where the kit is older
import { callLsRpc, getLsConfig } from 'antigravity-sidecar-kit/rpc';

const TAIL = 5;
const OLD_TIMEOUT_MS = 4000;

// Times each call and keeps the raw response size
async function timedCall(method, body) {
  let bytes = 0;
  const fetchFn = async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.text();
    bytes = Buffer.byteLength(text);
    return { ok: res.ok, status: res.status, text: async () => text };
  };
  const t0 = performance.now();
  const data = await callLsRpc(method, body, { fetchFn, timeoutMs: 180_000 });
  return { data, bytes, ms: Math.round(performance.now() - t0) };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function probeList(method, listField, offsetField, cascadeId, expectedCount) {
  const full = await timedCall(method, { cascadeId });
  const all = full.data?.[listField] || [];
  const result = {
    fullRead: { items: all.length, mb: +(full.bytes / 1e6).toFixed(2), ms: full.ms },
    fullReadWouldTimeOutAt4s: full.ms > OLD_TIMEOUT_MS,
  };
  if (expectedCount !== undefined) result.fullReadIsComplete = all.length >= expectedCount;

  const from = Math.max(0, all.length - TAIL);
  const tail = await timedCall(method, { cascadeId, [offsetField]: from });
  const tailItems = tail.data?.[listField] || [];
  result.offsetRead = { offset: from, items: tailItems.length, kb: +(tail.bytes / 1024).toFixed(1), ms: tail.ms };
  result.offsetReadMatchesFullRead = sameJson(tailItems, all.slice(from, from + tailItems.length));

  const past = await timedCall(method, { cascadeId, [offsetField]: all.length });
  result.readPastEnd = { offset: all.length, items: (past.data?.[listField] || []).length, ms: past.ms };
  return result;
}

const { lsAddress } = getLsConfig();
const trajectories = await callLsRpc('GetAllCascadeTrajectories', {});
const summaries = trajectories?.trajectorySummaries || {};
const lastViewed = Object.entries(summaries).sort(([, a], [, b]) =>
  String(b.annotations?.lastUserViewTime || '').localeCompare(String(a.annotations?.lastUserViewTime || ''))
)[0]?.[0];
const cascadeId = process.argv[2] || lastViewed;
if (!cascadeId) throw new Error('No conversation found; pass a cascadeId');
const summary = summaries[cascadeId] || {};

const report = {
  lsAddress,
  cascadeId,
  summary: { stepCount: summary.stepCount, status: summary.status, lastModifiedTime: summary.lastModifiedTime },
  steps: await probeList('GetCascadeTrajectorySteps', 'steps', 'stepOffset', cascadeId, summary.stepCount),
  generatorMetadata: await probeList(
    'GetCascadeTrajectoryGeneratorMetadata',
    'generatorMetadata',
    'generatorMetadataOffset',
    cascadeId
  ),
};
console.log(JSON.stringify(report, null, 2));

const ok = (cond) => (cond ? 'yes' : 'NO');
for (const [name, r] of [['steps', report.steps], ['generator metadata', report.generatorMetadata]]) {
  console.log(
    `${name}: offset read matches full read: ${ok(r.offsetReadMatchesFullRead)}; ` +
      `read past the end is empty: ${ok(r.readPastEnd.items === 0)}` +
      (r.fullReadIsComplete === undefined ? '' : `; full read complete: ${ok(r.fullReadIsComplete)}`) +
      `; full read took ${r.fullRead.ms} ms for ${r.fullRead.mb} MB` +
      (r.fullReadWouldTimeOutAt4s ? ' (over the old 4 s timeout)' : '')
  );
}
