/**
 * @fileoverview Host theme resolution, contrast detection, and Antigravity stylesheet proxy.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { APP_STORAGE_PATH, DEFAULT_CONFIG_PATH, readJsonFile } from './constants.mjs';

let cachedStorageMtime = -1;
let cachedStorageContrast = 1;

export function readHostContrast(storagePath = APP_STORAGE_PATH) {
  try {
    if (!existsSync(storagePath)) return 1;
    const mtime = statSync(storagePath).mtimeMs;
    if (storagePath === APP_STORAGE_PATH && mtime === cachedStorageMtime) return cachedStorageContrast;
    const m = readFileSync(storagePath, 'utf8').match(/"jetski\.contrast"\s*:\s*"?([12])"?/);
    const val = m ? Number(m[1]) : 1;
    if (storagePath === APP_STORAGE_PATH) {
      cachedStorageMtime = mtime;
      cachedStorageContrast = val;
    }
    return val;
  } catch {
    return 1;
  }
}

export function resolveHostTheme(input = {}, appStoragePath) {
  let userSettings = {};
  if (typeof input === 'string') {
    const parsed = readJsonFile(input);
    userSettings = parsed?.userSettings || parsed || {};
  } else if (input && typeof input === 'object') {
    userSettings = input.userSettings || input;
  }

  const rawMode = userSettings?.themeMode;
  const isLight = rawMode === 1 || rawMode === 'THEME_MODE_LIGHT';
  const mode = isLight ? 'light' : 'dark';
  const rawContrast =
    userSettings?.contrast !== undefined
      ? userSettings.contrast
      : appStoragePath || input === DEFAULT_CONFIG_PATH
        ? readHostContrast(appStoragePath)
        : 1;
  const isHighContrast = rawContrast === 2 || rawContrast === '2' || rawContrast === 'CONTRAST_HIGH';
  const rawSeeds = (isLight ? userSettings?.customThemeSeedsLight : userSettings?.customThemeSeedsDark) || {};
  const defaults = isLight
    ? { primary: '#f8f9fc', secondary: '#121317', tertiary: '#007acc' }
    : { primary: '#181818', secondary: '#ffffff', tertiary: '#007acc' };
  const seeds = rawSeeds.background
    ? {
        primary: rawSeeds.background,
        secondary: rawSeeds.foregroundOverride || rawSeeds.secondary || defaults.secondary,
        tertiary: rawSeeds.primary || rawSeeds.tertiary || defaults.tertiary,
      }
    : {
        primary: rawSeeds.primary || defaults.primary,
        secondary: rawSeeds.foregroundOverride || rawSeeds.secondary || defaults.secondary,
        tertiary: rawSeeds.tertiary || defaults.tertiary,
      };

  const c = isHighContrast
    ? { darkPct: '10%', darkAlpha: 0.1, lightPct: '12%', lightAlpha: 0.12, mutedPct: '4%', secDark: '14%', secLight: '8%', cardDark: '6.5%' }
    : { darkPct: '5%', darkAlpha: 0.05, lightPct: '7.5%', lightAlpha: 0.075, mutedPct: '2.5%', secDark: '12%', secLight: '6%', cardDark: '5%' };

  const fontSans =
    userSettings?.['font.family'] ||
    userSettings?.fontFamily ||
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const fontMono =
    userSettings?.['editor.font.family'] ||
    userSettings?.['editor.fontFamily'] ||
    userSettings?.editorFontFamily ||
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

  const surface = `color-mix(in srgb, ${seeds.secondary} ${c.mutedPct}, ${seeds.primary})`;
  const card = isLight ? '#ffffff' : `color-mix(in srgb, ${seeds.secondary} ${c.cardDark}, ${seeds.primary})`;
  const secondary = `color-mix(in srgb, ${seeds.secondary} ${isLight ? c.secLight : c.secDark}, ${seeds.primary})`;
  const borderSolid = `color-mix(in srgb, ${seeds.secondary} ${isLight ? c.lightPct : c.darkPct}, ${seeds.primary})`;
  const border = `color-mix(in srgb, ${seeds.secondary} ${isLight ? c.lightPct : c.darkPct}, transparent)`;
  const hover = isLight ? `rgba(0, 0, 0, ${c.lightAlpha})` : `rgba(255, 255, 255, ${c.darkAlpha})`;
  const vars = {
    '--background': seeds.primary, '--foreground': seeds.secondary, '--primary': seeds.tertiary,
    '--muted': surface, '--card': card, '--secondary': secondary, '--card-border': borderSolid, '--border': hover,
    '--cm-bg': seeds.primary, '--cm-surface': surface, '--cm-card': card, '--cm-secondary': secondary,
    '--cm-border': border, '--cm-border-solid': borderSolid, '--cm-text': seeds.secondary,
    '--cm-muted': `color-mix(in srgb, ${seeds.secondary} ${isLight ? '60%' : '65%'}, ${seeds.primary})`,
    '--cm-accent': seeds.tertiary, '--cm-hover': hover,
    '--chart-blue': isLight ? '#0066cc' : '#4e9de0', '--chart-purple': isLight ? '#6f42c1' : '#9b59b6',
    '--chart-green': isLight ? '#28a745' : '#388a34', '--chart-yellow': isLight ? '#d29922' : '#b5a642',
    '--chart-orange': isLight ? '#e36209' : '#d18616', '--chart-red': isLight ? '#d73a49' : '#d14d41',
    '--vscode-font-family': fontSans, '--editor-font-family': fontMono,
    'color-scheme': isLight ? 'light' : 'dark',
  };

  return { mode, contrast: isHighContrast ? 'high' : 'normal', vars };
}

let cachedHostCss = '';
export async function fetchHostStylesheet({
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS || '',
  fetchFn = globalThis.fetch,
  forceRefresh = false,
} = {}) {
  if (cachedHostCss && !forceRefresh) return cachedHostCss;
  if (!lsAddress || typeof fetchFn !== 'function') return '';
  const baseUrl = lsAddress.startsWith('http') ? lsAddress : `http://${lsAddress}`;
  const candidates = ['/compiled_tailwind.css'];
  try {
    const htmlRes = await fetchFn(`${baseUrl}/`, { signal: AbortSignal.timeout(1500) });
    if (htmlRes?.ok) {
      const html = await htmlRes.text();
      const hrefs = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']|<link[^>]+href=["']([^"']+)["'][^>]+rel=["']stylesheet["']/gi)]
        .map((m) => m[1] || m[2])
        .filter((h) => h && h.startsWith('/') && !h.includes('jetbox'));
      for (const h of hrefs.reverse()) {
        if (!candidates.includes(h)) candidates.unshift(h);
      }
    }
  } catch { /* fallback to default candidate */ }

  for (const path of candidates) {
    try {
      const res = await fetchFn(`${baseUrl}${path}`, { signal: AbortSignal.timeout(1500) });
      const ctype = String(res?.headers?.get?.('content-type') || '').toLowerCase();
      if (!res?.ok || !ctype.includes('text/css')) continue;
      const rawCss = await res.text();
      const trimmed = rawCss.trimStart();
      if (!trimmed || trimmed.startsWith('<')) continue;
      const props = [];
      const body = rawCss.replace(/@property\s+--[\w-]+\s*\{[^}]*\}/g, (m) => {
        props.push(m);
        return '';
      });
      const wrapped = `@layer agy-host {\n${body}\n}\n${props.join('\n')}`;
      if (!forceRefresh) cachedHostCss = wrapped;
      return wrapped;
    } catch { /* try next candidate */ }
  }
  return '';
}
