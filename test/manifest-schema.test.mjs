import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateManifest, validateSidecarConfig } from '../scripts/validate-manifest.mjs';

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

describe('hub-manifest.json validation', () => {
  it('accepts the shipped hub-manifest.json, whose version matches package.json', () => {
    assert.deepEqual(validateManifest(read('hub-manifest.json'), { packageVersion: read('package.json').version }), []);
  });

  it('accepts the shipped sidecar.json', () => {
    assert.deepEqual(validateSidecarConfig(read('sidecar.json')), []);
  });

  it('rejects manifests that would break or endanger installs', () => {
    const base = read('hub-manifest.json');
    const errorsFor = (overrides, opts = {}) => validateManifest({ ...base, ...overrides }, opts).join('\n');

    assert.match(errorsFor({ id: '../evil' }), /id must match/);
    assert.match(errorsFor({ id: 'sidecar-hub' }), /reserved/);
    assert.match(errorsFor({ capabilityTier: 'TIER_0' }), /capabilityTier must be one of/);
    assert.match(errorsFor({ version: 'latest' }), /version must be semver/);
    assert.match(errorsFor({ release: { gitRepo: 'http://github.com/a/b' } }), /gitRepo must be an https URL/);
    assert.match(errorsFor({ release: { tarballUrl: 'ftp://x.test/a.tgz' } }), /tarballUrl must be an https URL/);
    assert.match(errorsFor({ workspaceTriggers: { files: ['../../.ssh/id_rsa'] } }), /relative paths inside the workspace/);
    assert.match(errorsFor({ workspaceTriggers: { files: ['C:/Windows/win.ini'] } }), /relative paths inside the workspace/);
    assert.match(errorsFor({ workspaceTriggers: { files: ['/etc/passwd'] } }), /relative paths inside the workspace/);
    assert.match(errorsFor({}, { packageVersion: '9.9.9' }), /must match package\.json version/);
    assert.match(validateSidecarConfig({ args: ['server.mjs'] }).join('\n'), /command is required/);
  });
});
