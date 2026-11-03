/** @fileoverview AgyUI / AgyShell bridge, theme sync, StateSync helpers, and formatting utilities. */
(function () {
  const cm = (window.ContextMonitor = window.ContextMonitor || {});
  try {
    const src = (typeof document !== 'undefined' && (document.currentScript?.src || Array.from(document.scripts || []).find((s) => s?.src?.includes('token='))?.src)) || '';
    const st = src ? new URL(src, 'http://127.0.0.1').searchParams.get('token') : '';
    if (st && !window.__AGY_TOKEN__) window.__AGY_TOKEN__ = st;
  } catch {}
  const ICONS = { chevron_right: 'M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z' };
  window.AgyUI?.registerIcons?.(ICONS);
  const CM_FALLBACK_KEYS = [
    '--cm-bg', '--cm-surface', '--cm-card', '--cm-secondary', '--cm-secondary-fg',
    '--cm-border', '--cm-border-solid', '--cm-text', '--cm-muted', '--cm-accent', '--cm-hover',
  ];
  let lastThemeSig = '';
  let hasLiveHostTheme = false;
  let toastTimer = 0;

  function deriveCmVarsFromEditor(bg, fg, isLight) {
    return {
      '--cm-bg': bg, '--cm-surface': `color-mix(in srgb, ${fg} 2.5%, ${bg})`,
      '--cm-card': isLight ? '#ffffff' : `color-mix(in srgb, ${fg} 5%, ${bg})`,
      '--cm-secondary': `color-mix(in srgb, ${fg} ${isLight ? '8%' : '12%'}, ${bg})`,
      '--cm-secondary-fg': `color-mix(in srgb, ${fg} ${isLight ? '80%' : '85%'}, ${bg})`,
      '--cm-border': `color-mix(in srgb, ${fg} ${isLight ? '7.5%' : '8%'}, transparent)`,
      '--cm-border-solid': `color-mix(in srgb, ${fg} ${isLight ? '7.5%' : '8%'}, ${bg})`,
      '--cm-text': fg, '--cm-muted': `color-mix(in srgb, ${fg} ${isLight ? '60%' : '65%'}, ${bg})`,
      '--cm-hover': `color-mix(in srgb, ${fg} ${isLight ? '7.5%' : '6%'}, transparent)`,
    };
  }

  function applyTheme(theme) {
    if (!theme || typeof theme !== 'object') return;
    const root = document.documentElement;
    const cv = theme.cssVariables && typeof theme.cssVariables === 'object' ? theme.cssVariables : (!theme.vars ? theme : null);
    if (cv && !theme.vars) {
      hasLiveHostTheme = true;
      lastThemeSig = JSON.stringify(theme);
      const isLight = theme.themeType === 'light' || theme.isDark === false;
      const bg = cv['--background'] || cv['--vscode-editor-background'] || (isLight ? '#f8f9fc' : '#101010');
      const fg = cv['--foreground'] || cv['--vscode-editor-foreground'] || (isLight ? '#121317' : '#cccccc');
      const inkSoft = cv['--agy-ink-soft'] || `color-mix(in srgb, ${fg} 88%, ${bg})`;
      window.AgyShell?.applyAgyThemeFromPayload?.({ ...theme, cssVariables: { ...cv, '--background': bg, '--foreground': fg, '--agy-ink-soft': inkSoft } });
      const hasNative = Boolean(cv['--background'] || cv['--foreground']);
      if (hasNative || cv['--vscode-editor-background'] || cv['--vscode-editor-foreground']) {
        root.dataset.theme = isLight ? 'light' : 'dark';
        for (const [k, v] of Object.entries(cv)) {
          if (typeof v === 'string' && !(hasNative && k.startsWith('--agy-'))) root.style.setProperty(k, v);
        }
        for (const k of hasNative ? [...CM_FALLBACK_KEYS, '--agy-ink-soft'] : []) root.style.removeProperty(k);
        if (!hasNative) {
          for (const [k, v] of Object.entries(deriveCmVarsFromEditor(bg, fg, isLight))) root.style.setProperty(k, v);
          root.style.setProperty('--agy-ink-soft', inkSoft);
        }
      }
      if (cv['--font-family'] || cv['--vscode-font-family']) root.style.setProperty('--vscode-font-family', cv['--vscode-font-family'] || cv['--font-family']);
      if (cv['--editor-font-family']) root.style.setProperty('--editor-font-family', cv['--editor-font-family']);
      return;
    }
    if (!theme.vars || hasLiveHostTheme || JSON.stringify(theme) === lastThemeSig) return;
    lastThemeSig = JSON.stringify(theme);
    const isLight = (theme.mode || 'dark') === 'light';
    const bg = theme.vars['--background'] || theme.vars['--cm-bg'] || (isLight ? '#f8f9fc' : '#101010');
    const fg = theme.vars['--foreground'] || theme.vars['--cm-text'] || (isLight ? '#121317' : '#cccccc');
    root.dataset.theme = theme.mode || 'dark';
    for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
    if (!theme.vars['--cm-secondary-fg']) root.style.setProperty('--cm-secondary-fg', `color-mix(in srgb, ${fg} ${isLight ? '80%' : '85%'}, ${bg})`);
    root.style.setProperty('--agy-ink-soft', `color-mix(in srgb, ${fg} 88%, ${bg})`);
    if (document.body) document.body.style.fontFamily = 'var(--vscode-font-family)';
  }

  const esc = (v) => window.AgyUI?.escHtml ? window.AgyUI.escHtml(v) : String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const formatBadgeLabel = (raw) => window.AgyUI?.formatBadgeLabel ? window.AgyUI.formatBadgeLabel(raw) : String(raw || '').trim().replace(/^(?!pid\b)(.)(.*)/i, (_, a, b) => a.toUpperCase() + b.toLowerCase());
  const icon = (name, size = 14, cls = '') => window.AgyUI?.iconSvg ? window.AgyUI.iconSvg(name, size, cls) : `<svg width="${size}" height="${size}" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="${ICONS[name] || ''}"/></svg>`;
  const toHtml = (node) => Array.isArray(node) ? node.map(toHtml).join('') : (node == null || typeof node !== 'object') ? String(node ?? '') : (node.outerHTML ?? Array.from(node.childNodes || [], (c) => c.outerHTML ?? esc(c.textContent ?? '')).join(''));
  const html = (s, ...v) => s.reduce((acc, p, i) => acc + p + (i < v.length ? toHtml(v[i] ?? '') : ''), '');
  const setHtml = (target, content) => { if (target) target.innerHTML = toHtml(content ?? ''); };

  async function apiCall(path, body = {}) {
    if (window.AgyUI?.apiCall) return window.AgyUI.apiCall(path, body);
    const fn = window.sidecar?.fetch || window.fetch.bind(window);
    const tok = new URLSearchParams(window.location?.search || '').get('token') || window.__AGY_TOKEN__ || '';
    const res = await fn(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { 'X-Sidecar-Token': tok } : {}) }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  async function notifyAgent({ message, severity = 'info', triggerTurn = true, cascadeId = '', conversationId = '', title = '', workspace = '' } = {}) {
    const p = new URLSearchParams(window.location?.search || '');
    const conv = cascadeId || conversationId || cm.activeConversationId || window.sidecar?.conversationId || p.get('conversationId') || '';
    const ws = workspace || window.sidecar?.workspace || p.get('workspace') || '';
    return cm.apiCall('/api/notify', { message: String(message || ''), severity, triggerTurn: Boolean(triggerTurn), ...(conv ? { conversationId: conv } : {}), ...(ws ? { workspace: ws } : {}), ...(title ? { title } : {}) });
  }

  function showToast(text, isError = false, durationMs = 4000) {
    if (typeof document === 'undefined') return;
    let slot = document.getElementById?.('action-msg-slot');
    if (!slot && document.body?.appendChild && document.createElement) {
      slot = document.createElement('div');
      slot.id = 'action-msg-slot';
      document.body.appendChild(slot);
    }
    if (!slot) return;
    if (typeof clearTimeout === 'function' && toastTimer) clearTimeout(toastTimer);
    const isErr = isError === true || isError === 'error';
    setHtml(slot, text ? html`<div class="${isErr ? 'error-banner' : 'loading-state'} action-msg">${esc(text)}</div>` : '');
    if (text && typeof setTimeout === 'function' && durationMs > 0) toastTimer = setTimeout(() => setHtml(slot, ''), durationMs);
  }

  const POLL_FAST_MS = 1500;
  const POLL_IDLE_MS = 5000;
  const VISIBILITY_MESSAGE_TYPE = 'sidecar-visibility';
  const nextPollDelayMs = ({ isExecuting = false, activeTab = '' } = {}) => (isExecuting || activeTab === 'diagnostics' ? POLL_FAST_MS : POLL_IDLE_MS);
  const readHostVisibility = (d) => window.AgyUI?.readHostVisibility ? window.AgyUI.readHostVisibility(d) : (d?.type === VISIBILITY_MESSAGE_TYPE && typeof d?.payload?.visible === 'boolean' ? d.payload.visible : null);
  Object.assign(cm, {
    ICONS, POLL_FAST_MS, POLL_IDLE_MS, nextPollDelayMs, VISIBILITY_MESSAGE_TYPE, readHostVisibility,
    createVisibilityPoller: (opts = {}) => window.AgyShell?.createVisibilityPoller?.(opts) || { sync() {}, stop() {}, isVisible: () => true },
    applyTheme, deriveCmVarsFromEditor, html, setHtml, toHtml, el: (...a) => window.AgyUI?.el?.(...a), clear: (e) => window.AgyUI?.clear?.(e),
    icon, iconSvg: icon, iconEl: (...a) => window.AgyUI?.iconEl?.(...a), esc, escapeHtml: esc, formatBadgeLabel,
    apiCall, mutateState: (a, p = {}) => cm.apiCall('/api/mutate', a && typeof a === 'object' ? a : { action: String(a || ''), payload: p }),
    notifyAgent, showToast,
    formatTokens: (n) => (Number(n) >= 1000 ? `${(Number(n) / 1000).toFixed(1)}k` : String(Number(n) || 0)),
    formatPct: (n) => `${(Number(n) || 0).toFixed(1)}%`, formatRelativeReset: (str) => String(str || '—'),
    formatTimeShort: (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'),
    barColor: (r) => (r === 'danger' ? 'var(--cm-red)' : r === 'warn' ? 'var(--cm-yellow)' : 'var(--cm-accent)'),
    tierColor: (c) => (c ? 'var(--cm-yellow)' : 'var(--cm-blue)'),
    renderEmptyState: (msg) => html`<div class="empty-hint">${esc(msg)}</div>`,
  });
})();