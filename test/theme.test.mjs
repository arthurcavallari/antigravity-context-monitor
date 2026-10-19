import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHostTheme, fetchHostStylesheet } from '../lib/theme.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

test('resolveHostTheme and fetchHostStylesheet resolve theme seeds, discover renamed CSS, and guard SPA catch-all', async () => {
  const darkDefault = resolveHostTheme({ themeMode: 2 });
  assert.equal(darkDefault.mode, 'dark');
  assert.equal(darkDefault.contrast, 'normal');
  assert.equal(darkDefault.vars['--cm-bg'], '#181818');
  assert.equal(darkDefault.vars['--cm-text'], '#ffffff');
  assert.equal(darkDefault.vars['--cm-card'], 'color-mix(in srgb, #ffffff 5%, #181818)');
  assert.equal(darkDefault.vars['--cm-border'], 'color-mix(in srgb, #ffffff 5%, transparent)');
  assert.equal(darkDefault.vars['--cm-hover'], 'rgba(255, 255, 255, 0.05)');
  assert.equal(darkDefault.vars['color-scheme'], 'dark');

  const lightNormal = resolveHostTheme({ themeMode: 1 });
  assert.equal(lightNormal.mode, 'light');
  assert.equal(lightNormal.contrast, 'normal');
  assert.equal(lightNormal.vars['--cm-bg'], '#f8f9fc');
  assert.equal(lightNormal.vars['--cm-text'], '#121317');
  assert.equal(lightNormal.vars['--cm-card'], '#ffffff');
  assert.equal(lightNormal.vars['--cm-border'], 'color-mix(in srgb, #121317 7.5%, transparent)');
  assert.equal(lightNormal.vars['--cm-hover'], 'rgba(0, 0, 0, 0.075)');
  assert.equal(lightNormal.vars['color-scheme'], 'light');

  const darkHighContrast = resolveHostTheme({ themeMode: 2, contrast: 2 });
  assert.equal(darkHighContrast.mode, 'dark');
  assert.equal(darkHighContrast.contrast, 'high');
  assert.equal(darkHighContrast.vars['--cm-card'], 'color-mix(in srgb, #ffffff 6.5%, #181818)');
  assert.equal(darkHighContrast.vars['--cm-border'], 'color-mix(in srgb, #ffffff 10%, transparent)');
  assert.equal(darkHighContrast.vars['--cm-hover'], 'rgba(255, 255, 255, 0.1)');

  const realConfigSeeds = resolveHostTheme({
    themeMode: 'THEME_MODE_DARK',
    customThemeSeedsDark: { background: '#101010', foregroundOverride: '#cccccc', primary: '#007acc' },
  });
  assert.equal(realConfigSeeds.vars['--cm-bg'], '#101010');
  assert.equal(realConfigSeeds.vars['--cm-text'], '#cccccc');
  assert.equal(realConfigSeeds.vars['--cm-accent'], '#007acc');

  const tmp = mkdtempSync(join(tmpdir(), 'cm-theme-'));
  try {
    const customLightPath = join(tmp, 'light-config.json'), storagePath = join(tmp, 'app_storage.json');
    writeFileSync(customLightPath, JSON.stringify({ userSettings: { themeMode: 'THEME_MODE_LIGHT', customThemeSeedsLight: { primary: '#f0f4f8', secondary: '#0f172a', tertiary: '#2563eb' } } }), 'utf8');
    writeFileSync(storagePath, JSON.stringify({ 'jetski.contrast': '2' }), 'utf8');
    const customLight = resolveHostTheme(customLightPath, storagePath);
    assert.equal(customLight.mode, 'light');
    assert.equal(customLight.contrast, 'high');
    assert.equal(customLight.vars['--cm-bg'], '#f0f4f8');
    assert.equal(customLight.vars['--cm-text'], '#0f172a');
    assert.equal(customLight.vars['--cm-accent'], '#2563eb');
    assert.equal(customLight.vars['--cm-border'], 'color-mix(in srgb, #0f172a 12%, transparent)');
    assert.equal(customLight.vars['--border'], 'rgba(0, 0, 0, 0.12)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const css = await fetchHostStylesheet({
    lsAddress: '127.0.0.1:59125',
    fetchFn: async (u) => u.endsWith('/')
      ? { ok: true, headers: new Map([['content-type', 'text/html']]), text: async () => '<link rel="stylesheet" href="/app-hash.css">' }
      : { ok: true, headers: new Map([['content-type', 'text/css']]), text: async () => ':root{--radius-sm:4px}@property --tw-x { syntax: "*"; }' },
    forceRefresh: true,
  });
  assert.match(css, /^@layer agy-host \{[\s\S]*--radius-sm:4px[\s\S]*\}\n@property --tw-x/);
});

test('every source file in repository strictly obeys the <= 300 line constraint', () => {
  const walk = (dir) => {
    const results = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git' || entry === '.idea') continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        results.push(...walk(full));
      } else if (/\.(mjs|js|css|html|json)$/.test(entry) && entry !== 'package-lock.json') {
        results.push(full);
      }
    }
    return results;
  };

  const files = walk(REPO_ROOT);
  assert.ok(files.length >= 15, 'Should scan all project files');
  for (const file of files) {
    const lineCount = readFileSync(file, 'utf8').split(/\r?\n/).length;
    assert.ok(
      lineCount <= 300,
      `File ${file} has ${lineCount} lines, exceeding the 300-line limit`
    );
  }
});
