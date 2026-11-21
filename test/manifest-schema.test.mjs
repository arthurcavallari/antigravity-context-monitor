import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateManifest, validateSidecarConfig } from '../scripts/validate-manifest.mjs';

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

describe('hub-manifest.json validation', () => {
  it('accepts the shipped hub-manifest.json, whose version matches package.json', () => {
    const shipped = read('hub-manifest.json');
    assert.deepEqual(validateManifest(shipped, { packageVersion: read('package.json').version }), []);
    assert.equal(shipped.workspaceTriggers, undefined);
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
    assert.match(errorsFor({ workspaceTriggers: { files: ['..\\..\\evil'] } }), /relative paths inside the workspace/);
    assert.match(errorsFor({ workspaceTriggers: { files: ['*'] } }), /relative paths inside the workspace/);
    assert.match(errorsFor({ workspaceTriggers: { files: ['C:/Windows/win.ini'] } }), /relative paths inside the workspace/);
    assert.match(errorsFor({ workspaceTriggers: { files: ['/etc/passwd'] } }), /relative paths inside the workspace/);
    assert.match(errorsFor({}, { packageVersion: '9.9.9' }), /must match package\.json version/);
    assert.match(validateSidecarConfig({ args: ['server.mjs'] }).join('\n'), /command is required/);
  });

  it('keeps package.json, hub-manifest.json, and package-lock.json aligned and sidecar-kit >=1.9.0 with zero file: paths [CM-14]', () => {
    const pkgRaw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const lockRaw = readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8');
    assert.doesNotMatch(pkgRaw, /"file:/i);
    assert.doesNotMatch(lockRaw, /"file:/i);

    const pkg = JSON.parse(pkgRaw);
    const hub = read('hub-manifest.json');
    const lock = JSON.parse(lockRaw);
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.equal(hub.version, pkg.version);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(pkg.dependencies['antigravity-sidecar-kit'], '^1.9.0');
    assert.equal(lock.packages?.['']?.version, pkg.version);
    assert.match(lock.packages?.['node_modules/antigravity-sidecar-kit']?.version || '', /^1\.9\./);
  });
});
