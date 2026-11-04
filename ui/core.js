/** @fileoverview AgyUI / AgyShell bridge, theme sync, StateSync helpers, and formatting utilities. */
(function () {
  const cm = (window.ContextMonitor = window.ContextMonitor || {});
  try {
    const scripts = Array.from(document?.scripts || []);
    const src = (typeof document !== 'undefined' && (document.currentScript?.src || scripts.find((s) => s?.src?.includes('token='))?.src)) || '';
    const st = src ? new URL(src, 'http://127.0.0.1').searchParams.get('token') : '';
    if (st && !window.__AGY_TOKEN__) window.__AGY_TOKEN__ = st;
  } catch {
    /* ignore */
  }
  const ICONS = { chevron_right: 'M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z' };
  window.AgyUI?.registerIcons?.(ICONS);
  const CM_FALLBACK_KEYS = [
    '--cm-bg',
    '--cm-surface',
    '--cm-card',
    '--cm-secondary',
    '--cm-secondary-fg',
    '--cm-border',
    '--cm-border-solid',
    '--cm-text',
    '--cm-muted',
    '--cm-accent',
    '--cm-hover',
  ];
  let lastThemeSig = '';
  let hasLiveHostTheme = false;
  let toastTimer = 0;

  function deriveCmVarsFromEditor(bg, fg, isLight) {
    return {
      '--cm-bg': bg,
      '--cm-surface': `color-mix(in srgb, ${fg} 2.5%, ${bg})`,
      '--cm-card': isLight ? '#ffffff' : `color-mix(in srgb, ${fg} 5%, ${bg})`,
      '--cm-secondary': `color-mix(in srgb, ${fg} ${isLight ? '8%' : '12%'}, ${bg})`,
      '--cm-secondary-fg': `color-mix(in srgb, ${fg} ${isLight ? '80%' : '85%'}, ${bg})`,
      '--cm-border': `color-mix(in srgb, ${fg} ${isLight ? '7.5%' : '8%'}, transparent)`,
      '--cm-border-solid': `color-mix(in srgb, ${fg} ${isLight ? '7.5%' : '8%'}, ${bg})`,
      '--cm-text': fg,
      '--cm-muted': `color-mix(in srgb, ${fg} ${isLight ? '60%' : '65%'}, ${bg})`,
      '--cm-hover': `color-mix(in srgb, ${fg} ${isLight ? '7.5%' : '6%'}, transparent)`,
    };
  }

  function applyTheme(theme) {
    if (!theme || typeof theme !== 'object') return;
    const root = document.documentElement;
    const cv = theme.cssVariables && typeof theme.cssVariables === 'object'
      ? theme.cssVariables
      : (!theme.vars ? theme : null);
    if (cv && !theme.vars) {
      hasLiveHostTheme = true;
      lastThemeSig = JSON.stringify(theme);
      const isLight = theme.themeType === 'light' || theme.isDark === false;
      const bg = cv['--background'] || cv['--vscode-editor-background'] || (isLight ? '#f8f9fc' : '#101010');
      const fg = cv['--foreground'] || cv['--vscode-editor-foreground'] || (isLight ? '#121317' : '#cccccc');
      const inkSoft = cv['--agy-ink-soft'] || `color-mix(in srgb, ${fg} 88%, ${bg})`;
      window.AgyShell?.applyAgyThemeFromPayload?.({
        ...theme,
        cssVariables: { ...cv, '--background': bg, '--foreground': fg, '--agy-ink-soft': inkSoft },
      });
      const hasNative = Boolean(cv['--background'] || cv['--foreground']);
      if (hasNative || cv['--vscode-editor-background'] || cv['--vscode-editor-foreground']) {
        root.dataset.theme = isLight ? 'light' : 'dark';
        for (const [k, v] of Object.entries(cv)) {
          if (typeof v === 'string' && !(hasNative && k.startsWith('--agy-'))) {
            root.style.setProperty(k, v);
          }
        }
        for (const k of hasNative ? [...CM_FALLBACK_KEYS, '--agy-ink-soft'] : []) {
          root.style.removeProperty(k);
        }
        if (!hasNative) {
          for (const [k, v] of Object.entries(deriveCmVarsFromEditor(bg, fg, isLight))) {
            root.style.setProperty(k, v);
          }
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
    if (!theme.vars || hasLiveHostTheme || JSON.stringify(theme) === lastThemeSig) return;
    lastThemeSig = JSON.stringify(theme);
    const isLight = (theme.mode || 'dark') === 'light';
    const bg = theme.vars['--background'] || theme.vars['--cm-bg'] || (isLight ? '#f8f9fc' : '#101010');
    const fg = theme.vars['--foreground'] || theme.vars['--cm-text'] || (isLight ? '#121317' : '#cccccc');
    root.dataset.theme = theme.mode || 'dark';
    for (const [k, v] of Object.entries(theme.vars)) {
      root.style.setProperty(k, v);
    }
    if (!theme.vars['--cm-secondary-fg']) {
      root.style.setProperty('--cm-secondary-fg', `color-mix(in srgb, ${fg} ${isLight ? '80%' : '85%'}, ${bg})`);
    }
    root.style.setProperty('--agy-ink-soft', `color-mix(in srgb, ${fg} 88%, ${bg})`);
    if (document.body) document.body.style.fontFamily = 'var(--vscode-font-family)';
  }

  const trustedHtml = new Set();
  const rawHtml = (str = '') => {
    const s = String(str ?? '');
    if (/[&<>"']/.test(s)) {
      if (trustedHtml.has(s)) {
        trustedHtml.delete(s);
      } else if (trustedHtml.size >= 10000) {
        trustedHtml.delete(trustedHtml.values().next().value);
      }
      trustedHtml.add(s);
    }
    return s;
  };
  const escapeRaw = (v) => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const esc = (v) => rawHtml(window.AgyUI?.escHtml ? window.AgyUI.escHtml(v) : escapeRaw(v));
  const formatBadgeLabel = (raw) => {
    if (window.AgyUI?.formatBadgeLabel) return window.AgyUI.formatBadgeLabel(raw);
    return String(raw || '').trim().replace(/^(?!pid\b)(.)(.*)/i, (_, a, b) => a.toUpperCase() + b.toLowerCase());
  };
  const icon = (name, size = 14, cls = '') => rawHtml(
    window.AgyUI?.iconSvg
      ? window.AgyUI.iconSvg(name, size, cls)
      : `<svg width="${size}" height="${size}" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="${ICONS[name] || ''}"/></svg>`,
  );
  const toHtml = (node) => {
    if (Array.isArray(node)) return node.map(toHtml).join('');
    if (node == null || typeof node !== 'object') {
      const s = String(node ?? '');
      return trustedHtml.has(s) ? s : escapeRaw(s);
    }
    return node.outerHTML ?? Array.from(node.childNodes || [], (c) => c.outerHTML ?? escapeRaw(c.textContent ?? '')).join('');
  };
  const html = (s, ...v) => rawHtml(s.reduce((acc, p, i) => acc + p + (i < v.length ? toHtml(v[i] ?? '') : ''), ''));
  const setHtml = (target, content) => {
    if (!target) return;
    if (Array.isArray(content)) {
      target.innerHTML = content.map(toHtml).join('');
      return;
    }
    target.innerHTML = typeof content === 'string' ? content : toHtml(content ?? '');
  };

  async function apiCall(path, body = {}) {
    if (window.AgyUI?.apiCall) return window.AgyUI.apiCall(path, body);
    const fn = window.sidecar?.fetch || window.fetch.bind(window);
    const tok = new URLSearchParams(window.location?.search || '').get('token') || window.__AGY_TOKEN__ || '';
    const res = await fn(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(tok ? { 'X-Sidecar-Token': tok } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  async function notifyAgent({
    message,
    severity = 'info',
    triggerTurn = true,
    cascadeId = '',
    conversationId = '',
    title = '',
    workspace = '',
  } = {}) {
    const p = new URLSearchParams(window.location?.search || '');
    const conv = cascadeId || conversationId || cm.activeConversationId || window.sidecar?.conversationId || p.get('conversationId') || '';
    const ws = workspace || window.sidecar?.workspace || p.get('workspace') || '';
    return cm.apiCall('/api/notify', {
      message: String(message || ''),
      severity,
      triggerTurn: Boolean(triggerTurn),
      ...(conv ? { conversationId: conv } : {}),
      ...(ws ? { workspace: ws } : {}),
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
    const isErr = isError === true || isError === 'error';
    setHtml(
      slot,
      text ? html`<div class="${isErr ? 'error-banner' : 'loading-state'} action-msg">${esc(text)}</div>` : '',
    );
    if (text && typeof setTimeout === 'function' && durationMs > 0) {
      toastTimer = setTimeout(() => setHtml(slot, ''), durationMs);
    }
  }

  const POLL_FAST_MS = 1500;
  const POLL_IDLE_MS = 5000;
  const VISIBILITY_MESSAGE_TYPE = 'sidecar-visibility';
  const nextPollDelayMs = ({ isExecuting = false, activeTab = '' } = {}) => (
    isExecuting || activeTab === 'diagnostics' ? POLL_FAST_MS : POLL_IDLE_MS
  );
  const readHostVisibility = (d) => {
    if (window.AgyUI?.readHostVisibility) return window.AgyUI.readHostVisibility(d);
    return d?.type === VISIBILITY_MESSAGE_TYPE && typeof d?.payload?.visible === 'boolean' ? d.payload.visible : null;
  };
  function createVisibilityPoller(optionsOrFn = {}, maybeOpts = {}) {
    const opts = typeof optionsOrFn === 'function' ? { ...maybeOpts, onPoll: optionsOrFn } : optionsOrFn || {};
    if (window.AgyShell?.createVisibilityPoller) {
      return window.AgyShell.createVisibilityPoller({ autoStart: opts.autoStart !== false, ...opts });
    }
    let pollTimer = 0;
    let hostVisible = true;
    let inViewport = true;
    let running = false;
    let inFlight = null;
    let pendingWake = false;
    let observer = null;
    let attached = false;
    const isVisible = () => hostVisible && inViewport && !(typeof document !== 'undefined' && document.hidden);
    const clear = () => {
      if (pollTimer && typeof clearTimeout === 'function') clearTimeout(pollTimer);
      pollTimer = 0;
    };
    const schedule = () => {
      clear();
      if (!running || !isVisible() || typeof setTimeout !== 'function') return;
      pollTimer = setTimeout(tick, opts.getIntervalMs ? opts.getIntervalMs() : POLL_IDLE_MS);
    };
    const runPoll = () => {
      pendingWake = false;
      let res;
      try {
        res = opts.onPoll?.();
      } catch {
        schedule();
        return res;
      }
      if (res && typeof res.then === 'function') {
        const done = () => {
          if (inFlight === p) inFlight = null;
          if (pendingWake && running && isVisible()) {
            pendingWake = false;
            tick();
          } else {
            schedule();
          }
        };
        const p = res.then(done, done);
        inFlight = p;
        return p;
      }
      schedule();
      return res;
    };
    const tick = () => {
      pollTimer = 0;
      if (!running || !isVisible() || inFlight) return;
      runPoll();
    };
    const sync = () => {
      clear();
      if (!running) return;
      if (inFlight) {
        if (isVisible()) pendingWake = true;
        return;
      }
      if (isVisible()) tick();
    };
    const triggerNow = () => {
      clear();
      if (inFlight) {
        if (running && isVisible()) pendingWake = true;
        return inFlight;
      }
      return runPoll();
    };
    const onMessage = (e) => {
      if (!running || e?.source !== window.parent) return;
      opts.onHostMessage?.(e);
      const visible = readHostVisibility(e.data);
      if (visible !== null && visible !== hostVisible) {
        hostVisible = visible;
        sync();
      }
    };
    const attach = () => {
      if (attached) return;
      attached = true;
      if (typeof IntersectionObserver === 'function' && typeof document !== 'undefined' && document.documentElement && !observer) {
        observer = new IntersectionObserver((entries) => {
          const last = entries?.[entries.length - 1];
          if (!last || typeof last.isIntersecting !== 'boolean') return;
          if (last.isIntersecting !== inViewport) {
            inViewport = last.isIntersecting;
            sync();
          }
        });
        observer.observe(document.documentElement);
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('message', onMessage);
      }
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', sync);
      }
    };
    const start = () => {
      if (running) return;
      running = true;
      attach();
      if (opts.immediate === false) schedule();
      else sync();
    };
    const stop = () => {
      running = false;
      pendingWake = false;
      clear();
      if (!attached) return;
      attached = false;
      observer?.disconnect?.();
      observer = null;
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('message', onMessage);
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', sync);
      }
    };
    if (opts.autoStart !== false) start();
    return { start, sync, stop, triggerNow, isVisible };
  }
  Object.assign(cm, {
    ICONS,
    POLL_FAST_MS,
    POLL_IDLE_MS,
    nextPollDelayMs,
    VISIBILITY_MESSAGE_TYPE,
    readHostVisibility,
    createVisibilityPoller,
    applyTheme,
    deriveCmVarsFromEditor,
    rawHtml,
    html,
    setHtml,
    toHtml,
    el: (...a) => window.AgyUI?.el?.(...a),
    clear: (e) => window.AgyUI?.clear?.(e),
    icon,
    iconSvg: icon,
    iconEl: (...a) => window.AgyUI?.iconEl?.(...a),
    esc,
    escapeHtml: esc,
    formatBadgeLabel,
    apiCall,
    mutateState: (a, p = {}) => cm.apiCall('/api/mutate', a && typeof a === 'object' ? a : { action: String(a || ''), payload: p }),
    notifyAgent,
    showToast,
    formatTokens: (n) => (Number(n) >= 1000 ? `${(Number(n) / 1000).toFixed(1)}k` : String(Number(n) || 0)),
    formatPct: (n) => `${(Number(n) || 0).toFixed(1)}%`,
    formatRelativeReset: (str) => String(str || '—'),
    formatTimeShort: (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'),
    barColor: (r) => (r === 'danger' ? 'var(--cm-red)' : (r === 'warn' ? 'var(--cm-yellow)' : 'var(--cm-accent)')),
    tierColor: (c) => (c ? 'var(--cm-yellow)' : 'var(--cm-blue)'),
    renderEmptyState: (msg) => html`<div class="empty-hint">${esc(msg)}</div>`,
  });
})();
