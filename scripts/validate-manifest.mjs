#!/usr/bin/env node
/**
 * @fileoverview Validates hub-manifest.json and sidecar.json. Hangar reads hub-manifest.json to install
 * and trigger this sidecar, so a broken or unsafe manifest reaches users on the next release; CI runs
 * this on every push and PR.
 *
 * Usage: node scripts/validate-manifest.mjs [path/to/hub-manifest.json]
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i;
// Same shape sanitizeSidecarId() produces, so the id always installs under its own name
const SIDECAR_ID = /^[a-z0-9][a-z0-9_-]*$/;
const TIERS = new Set(['TIER_1_TELEMETRY', 'TIER_2_LOCAL_TOOLING', 'TIER_3_AGENT_CONTROL']);
const RESERVED_IDS = new Set(['hangar', 'sidecar-hub']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Returns a list of human-readable problems; empty means the manifest is valid. */
export function validateManifest(manifest, { packageVersion } = {}) {
  const errors = [];
  if (!isObject(manifest)) return ['hub-manifest.json must be a JSON object'];

  if (!SIDECAR_ID.test(String(manifest.id || ''))) errors.push(`id must match ${SIDECAR_ID}`);
  if (RESERVED_IDS.has(manifest.id)) errors.push('id is reserved');
  if (!isNonEmptyString(manifest.name)) errors.push('name is required');
  if (!SEMVER.test(String(manifest.version || ''))) errors.push('version must be semver');
  if (packageVersion && manifest.version !== packageVersion) {
    errors.push(`version (${manifest.version}) must match package.json version (${packageVersion})`);
  }
  if (!TIERS.has(manifest.capabilityTier)) errors.push(`capabilityTier must be one of ${[...TIERS].join(', ')}`);

  const files = manifest.workspaceTriggers?.files;
  if (files !== undefined) {
    // Trigger files are joined onto the user's workspace path, so they must stay relative and inside it
    const bad = Array.isArray(files)
      ? files.filter((f) => !isNonEmptyString(f) || /^[\/]|^[a-z]:/i.test(f) || f.split(/[\/]/).includes('..'))
      : [files];
    if (bad.length) errors.push(`workspaceTriggers.files must be relative paths inside the workspace: ${JSON.stringify(bad)}`);
  }

  if (manifest.release !== undefined) {
    if (!isObject(manifest.release)) {
      errors.push('release must be an object');
    } else {
      for (const key of ['gitRepo', 'tarballUrl']) {
        const url = manifest.release[key];
        if (url !== undefined && !isHttpsUrl(url)) errors.push(`release.${key} must be an https URL`);
      }
    }
  }
  return errors;
}

/** Returns a list of problems with sidecar.json, which the Language Server launches from. */
export function validateSidecarConfig(sidecar) {
  if (!isObject(sidecar)) return ['sidecar.json must be a JSON object'];
  return isNonEmptyString(sidecar.command) ? [] : ['sidecar.json: command is required'];
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const manifestPath = resolve(process.argv[2] || join(REPO_ROOT, 'hub-manifest.json'));
  const sidecarPath = join(REPO_ROOT, 'sidecar.json');
  const { version } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  let manifest, sidecar;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const errors = [
    ...validateManifest(manifest, { packageVersion: version }).map((e) => `hub-manifest.json: ${e}`),
    ...validateSidecarConfig(sidecar),
  ];
  for (const e of errors) console.error(e);
  if (errors.length) process.exit(1);
  console.log(`hub-manifest.json and sidecar.json are valid (${manifest.id} ${manifest.version})`);
}
