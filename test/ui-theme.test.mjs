import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

function loadCore() {
  const props = new Map();
  const document = {
    documentElement: {
      dataset: {},
      style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
    },
  };
  const window = {};
  vm.runInContext(readFileSync(join(UI_DIR, 'core.js'), 'utf8'), vm.createContext({ window, document }), { filename: 'core.js' });
  return { applyTheme: window.ContextMonitor.applyTheme, props, document };
}

const serverOnyx = (mode) => ({
  themeType: mode,
  mode,
  cssVariables: {
    '--background': mode === 'dark' ? '#070709' : '#FFFFFF',
    '--foreground': mode === 'dark' ? '#FFFFFF' : '#0A0A0C',
    '--muted-foreground': mode === 'dark' ? '#87888F' : '#71717A',
    '--secondary-foreground': mode === 'dark' ? '#BCBDC6' : '#3F3F46',
    '--onyx-well': mode === 'dark' ? '#111115' : 'rgb(10 10 12 / 0.055)',
    '--chart-purple': mode === 'dark' ? '#9b59b6' : '#6f42c1',
    '--cm-muted': 'color-mix(in srgb, #FFFFFF 65%, #070709)',
  },
  vars: { '--background': mode === 'dark' ? '#070709' : '#FFFFFF', '--cm-muted': 'color-mix(in srgb, #FFFFFF 65%, #070709)' },
});

test('a server theme payload applies the full native map until the host speaks', () => {
  const { applyTheme, props, document } = loadCore();
  applyTheme(serverOnyx('dark'));
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(props.get('--muted-foreground'), '#87888F', 'native tokens are applied from the server payload');
  assert.equal(props.get('--onyx-well'), '#111115');
  assert.equal(props.has('--cm-muted'), false, 'the 65% inline override no longer pins muted text');
});

test('once the host has posted theme-change, server payloads only fill in chart colors', () => {
  const { applyTheme, props, document } = loadCore();
  applyTheme({ themeType: 'light', cssVariables: { '--background': '#FFFFFF', '--foreground': '#0A0A0C', '--muted-foreground': '#71717A' } });
  assert.equal(document.documentElement.dataset.theme, 'light');

  applyTheme(serverOnyx('dark'));
  assert.equal(document.documentElement.dataset.theme, 'light', 'the host stays in charge of the theme');
  assert.equal(props.get('--background'), '#FFFFFF');
  assert.equal(props.get('--muted-foreground'), '#71717A');
  assert.equal(props.get('--chart-purple'), '#9b59b6', 'chart colors, which the host never sends, still arrive');
  assert.equal(props.has('--onyx-well'), false);
});

test('styles.css scopes native muted text to Onyx and keeps a contrast-safe fallback elsewhere', () => {
  const css = readFileSync(join(UI_DIR, 'styles.css'), 'utf8');
  assert.match(css, /body\[data-newux-theme='onyx'\] \{\s*--cm-secondary-fg: var\(--secondary-foreground, var\(--agy-ink-soft\)\);\s*--cm-muted: var\(--muted-foreground, var\(--agy-ink-soft\)\);/);
  assert.match(css, /--cm-muted: var\(--agy-ink-soft,/, 'other presets keep the 88% ink mix');
  assert.match(css, /\[data-theme='light'\] \{[^}]*--cm-blue-ink: color-mix\(in srgb, var\(--color-blue-500, #4380b4\) 70%, var\(--agy-ink\)\)/);
});
