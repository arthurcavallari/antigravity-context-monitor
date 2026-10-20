/**
 * @fileoverview Authenticated fetch wrapper, theme sync, and shared UI formatting utilities.
 */

(function () {
  window.ContextMonitor = window.ContextMonitor || {};

  const ICONS = {
    refresh:
      'M481.54-180q-125.62,0-212.81-87.17T181.54-479.94t87.19-212.83T481.54-780q70.15,0 132.77,31.19t104.15,88.04V-780h60v244.61H533.85v-60h158q-31.62-57.92-87.69-91.27T481.54-720q-100,0-170,70t-70,170t70,170t170,70q77,0 139-44t87-116h63.23Q743.54-302.08 663.5-241.04T481.54-180Z',
    close:
      'M480-437.85L277.08-234.92q-8.31,8.31-20.88,8.5t-21.27-8.5T226.23-256t8.69-21.08L437.85-480L234.92-682.92q-8.31-8.31-8.5-20.88t8.5-21.27T256-733.77t21.08,8.69L480-522.15L682.92-725.08q8.31-8.31 20.88-8.5t21.27,8.5T733.77-704t-8.69,21.08L522.15-480L725.08-277.08q8.31,8.31 8.5,20.88t-8.5,21.27T704-226.23t-21.08-8.69L480-437.85Z',
    chevron_right: 'M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z',
  };

  let lastThemeSig = '';

  function applyTheme(theme) {
    if (!theme) return;
    const root = document.documentElement;
    const cv = theme.cssVariables;
    if (cv && typeof cv === 'object' && !theme.vars) {
      if (cv['--background'] || cv['--foreground']) {
        root.dataset.theme = theme.themeType === 'light' || theme.isDark === false ? 'light' : 'dark';
        for (const [k, v] of Object.entries(cv)) {
          if (typeof v === 'string') root.style.setProperty(k, v);
        }
        const fallbackKeys = [
          '--cm-bg', '--cm-surface', '--cm-card', '--cm-secondary', '--cm-border',
          '--cm-border-solid', '--cm-text', '--cm-muted', '--cm-accent', '--cm-hover',
        ];
        for (const k of fallbackKeys) root.style.removeProperty(k);
        lastThemeSig = '';
      }
      if (cv['--font-family'] || cv['--vscode-font-family']) {
        root.style.setProperty('--vscode-font-family', cv['--vscode-font-family'] || cv['--font-family']);
      }
      if (cv['--editor-font-family']) {
        root.style.setProperty('--editor-font-family', cv['--editor-font-family']);
      }
    }
    if (!theme.vars) return;
    const sig = JSON.stringify(theme);
    if (sig === lastThemeSig) return;
    lastThemeSig = sig;
    root.dataset.theme = theme.mode || 'dark';
    for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
    if (document.body) document.body.style.fontFamily = 'var(--vscode-font-family)';
  }

  function icon(name, size = 14) {
    const d = ICONS[name];
    if (!d) return '';
    return `<svg width="${size}" height="${size}" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBadgeLabel(raw) {
    const s = String(raw || '').trim();
    if (!s || /^pid\b/i.test(s)) return s;
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  async function apiCall(path, body = {}) {
    const fn = window.sidecar?.fetch || window.fetch.bind(window);
    const res = await fn(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  Object.assign(window.ContextMonitor, {
    ICONS,
    applyTheme,
    icon,
    esc,
    formatBadgeLabel,
    apiCall,
  });
})();
