/**
 * @fileoverview Authenticated fetch wrapper, AGY 88% contrast theme sync, StateSync helpers, and UI formatting utilities.
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
  let hasLiveHostTheme = false;
  let toastTimer = 0;

  const CM_FALLBACK_KEYS = [
    '--cm-bg', '--cm-surface', '--cm-card', '--cm-secondary', '--cm-secondary-fg',
    '--cm-border', '--cm-border-solid', '--cm-text', '--cm-muted', '--cm-accent', '--cm-hover',
  ];

  function deriveCmVarsFromEditor(bg, fg, isLight) {
    const surfaceMix = '2.5%';
    const cardMix = isLight ? '#ffffff' : `color-mix(in srgb, ${fg} 5%, ${bg})`;
    const secMix = isLight ? '8%' : '12%';
    const secFgMix = isLight ? '80%' : '85%';
    const borderMix = isLight ? '7.5%' : '8%';
    const mutedMix = isLight ? '60%' : '65%';
    return {
      '--cm-bg': bg,
      '--cm-surface': `color-mix(in srgb, ${fg} ${surfaceMix}, ${bg})`,
      '--cm-card': cardMix,
      '--cm-secondary': `color-mix(in srgb, ${fg} ${secMix}, ${bg})`,
      '--cm-secondary-fg': `color-mix(in srgb, ${fg} ${secFgMix}, ${bg})`,
      '--cm-border': `color-mix(in srgb, ${fg} ${borderMix}, transparent)`,
      '--cm-border-solid': `color-mix(in srgb, ${fg} ${borderMix}, ${bg})`,
      '--cm-text': fg,
      '--cm-muted': `color-mix(in srgb, ${fg} ${mutedMix}, ${bg})`,
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
      if (window.AgyShell?.applyAgyThemeFromPayload) {
        window.AgyShell.applyAgyThemeFromPayload({
          ...theme,
          cssVariables: { ...cv, '--background': bg, '--foreground': fg, '--agy-ink-soft': inkSoft },
        });
      }
      const hasNativeVars = Boolean(cv['--background'] || cv['--foreground']);
      const hasEditorVars = Boolean(cv['--vscode-editor-background'] || cv['--vscode-editor-foreground']);
      if (hasNativeVars || hasEditorVars) {
        root.dataset.theme = isLight ? 'light' : 'dark';
        for (const [k, v] of Object.entries(cv)) {
          if (typeof v !== 'string') continue;
          if (hasNativeVars && k.startsWith('--agy-')) continue;
          root.style.setProperty(k, v);
        }
        if (hasNativeVars) {
          for (const k of CM_FALLBACK_KEYS) root.style.removeProperty(k);
          root.style.removeProperty('--agy-ink-soft');
        } else {
          const derived = deriveCmVarsFromEditor(
            cv['--vscode-editor-background'] || (isLight ? '#f8f9fc' : '#101010'),
            cv['--vscode-editor-foreground'] || (isLight ? '#121317' : '#cccccc'),
            isLight
          );
          for (const [k, v] of Object.entries(derived)) root.style.setProperty(k, v);
          root.style.setProperty('--agy-ink-soft', inkSoft);
        }
      }
      if (cv['--font-family'] || cv['--vscode-font-family']) {
        root.style.setProperty('--vscode-font-family', cv['--vscode-font-family'] || cv['--font-family']);
      }
      if (cv['--editor-font-family']) {
        root.style.setProperty('--editor-font-family', cv['--editor-font-family']);
      }
      return;
    }
    if (!theme.vars || hasLiveHostTheme) return;
    const sig = JSON.stringify(theme);
    if (sig === lastThemeSig) return;
    lastThemeSig = sig;
    const isLight = (theme.mode || 'dark') === 'light';
    const bg = theme.vars['--background'] || theme.vars['--cm-bg'] || (isLight ? '#f8f9fc' : '#101010');
    const fg = theme.vars['--foreground'] || theme.vars['--cm-text'] || (isLight ? '#121317' : '#cccccc');
    const inkSoft = `color-mix(in srgb, ${fg} 88%, ${bg})`;
    root.dataset.theme = theme.mode || 'dark';
    for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
    if (!theme.vars['--cm-secondary-fg']) {
      root.style.setProperty('--cm-secondary-fg', `color-mix(in srgb, ${fg} ${isLight ? '80%' : '85%'}, ${bg})`);
    }
    root.style.setProperty('--agy-ink-soft', inkSoft);
    if (document.body) document.body.style.fontFamily = 'var(--vscode-font-family)';
  }

  if (window.AgyUI?.registerIcons) {
    window.AgyUI.registerIcons(ICONS);
  }

  function icon(name, size = 14) {
    if (window.AgyUI?.iconSvg) {
      return window.AgyUI.iconSvg(name, size);
    }
    const d = ICONS[name];
    if (!d) return '';
    return `<svg width="${size}" height="${size}" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  }

  function iconSvg(name, size = 14, className = '') {
    if (window.AgyUI?.iconSvg) {
      return window.AgyUI.iconSvg(name, size, className);
    }
    const cls = ['agy-icon', className].filter(Boolean).join(' ');
    const d = ICONS[name] || ICONS.refresh;
    return `<svg width="${size}" height="${size}" viewBox="0 -960 960 960" fill="currentColor" class="${cls}" aria-hidden="true"><path d="${d}"/></svg>`;
  }

  function iconEl(name, size = 14, className = '') {
    if (window.AgyUI?.iconEl) {
      return window.AgyUI.iconEl(name, size, className);
    }
    const wrap = document.createElement('span');
    wrap.className = 'agy-icon-wrap';
    wrap.innerHTML = iconSvg(name, size, className);
    return wrap.firstElementChild;
  }

  function el(tag, attrs = {}, children = []) {
    if (window.AgyUI?.el) {
      return window.AgyUI.el(tag, attrs, children);
    }
    const elem = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'className' || k === 'class') elem.className = v;
      else if (k === 'dataset' && typeof v === 'object') Object.assign(elem.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(elem.style, v);
      else if (k.startsWith('on') && typeof v === 'function') elem.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'innerHTML') elem.innerHTML = v;
      else if (k === 'textContent') elem.textContent = v;
      else elem.setAttribute?.(k, v);
    }
    for (const ch of (Array.isArray(children) ? children : [children]).filter(Boolean)) {
      if (typeof ch === 'string') elem.appendChild(document.createTextNode(ch));
      else elem.appendChild(ch);
    }
    return elem;
  }

  function clear(elem) {
    if (window.AgyUI?.clear) {
      return window.AgyUI.clear(elem);
    }
    if (elem) elem.innerHTML = '';
    return elem;
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
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return data;
  }

  async function mutateState(action, payload = {}) {
    const body = action && typeof action === 'object' ? action : { action: String(action || ''), payload };
    return apiCall('/api/mutate', body);
  }

  async function notifyAgent({ message, severity = 'info', triggerTurn = true, cascadeId = '', conversationId = '', title = '' } = {}) {
    const urlConv = typeof window !== 'undefined' ? new URLSearchParams(window.location?.search || '').get('conversationId') : '';
    const rawConv = cascadeId || conversationId || window.ContextMonitor?.activeConversationId || window.sidecar?.conversationId || urlConv || '';
    const convId = rawConv && rawConv !== '_new' ? rawConv : undefined;
    return apiCall('/api/notify', {
      message: String(message || ''),
      severity,
      triggerTurn: Boolean(triggerTurn),
      ...(convId ? { conversationId: convId } : {}),
      ...(title ? { title } : {}),
    });
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
    if (!text) { slot.innerHTML = ''; return; }
    const isErr = isError === true || isError === 'error';
    slot.innerHTML = `<div class="${isErr ? 'error-banner' : 'loading-state'} action-msg">${esc(text)}</div>`;
    if (typeof setTimeout === 'function' && durationMs > 0) {
      toastTimer = setTimeout(() => { slot.innerHTML = ''; }, durationMs);
    }
  }

  // Poll fast while an agent is executing (or logs are tailing), slowly while idle
  const POLL_FAST_MS = 1500;
  const POLL_IDLE_MS = 5000;

  function nextPollDelayMs({ isExecuting = false, activeTab = '' } = {}) {
    return isExecuting || activeTab === 'diagnostics' ? POLL_FAST_MS : POLL_IDLE_MS;
  }

  // A host that hides this frame with CSS (Hangar's deck) posts
  // { type: 'sidecar-visibility', payload: { visible } }; document.hidden stays false there
  const VISIBILITY_MESSAGE_TYPE = 'sidecar-visibility';

  function readHostVisibility(data) {
    if (data?.type !== VISIBILITY_MESSAGE_TYPE || typeof data?.payload?.visible !== 'boolean') return null;
    return data.payload.visible;
  }

  Object.assign(window.ContextMonitor, {
    ICONS,
    POLL_FAST_MS,
    POLL_IDLE_MS,
    nextPollDelayMs,
    VISIBILITY_MESSAGE_TYPE,
    readHostVisibility,
    applyTheme,
    icon,
    iconSvg,
    iconEl,
    el,
    clear,
    esc,
    escapeHtml: esc,
    formatBadgeLabel,
    apiCall,
    mutateState,
    notifyAgent,
    showToast,
  });
})();
