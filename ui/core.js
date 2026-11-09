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
  const ICONS = {
    chevron_right: 'M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z',
    expand_more: 'M480-345 240-585l56-56 184 183 184-183 56 56-240 240Z',
    // Stop (a ring around a square) and the pending spinner (a three-quarter ring), on the
    // Material Symbols 960-unit grid that Antigravity uses for its stop and loading states.
    stop_circle:
      'M320-320h320v-320H320v320ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Z',
    progress_activity:
      'M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-155.5t86-127Q252-817 325-848.5T480-880q17 0 28.5 11.5T520-840q0 17-11.5 28.5T480-800q-133 0-226.5 93.5T160-480q0 133 93.5 226.5T480-160q133 0 226.5-93.5T800-480q0-17 11.5-28.5T840-520q17 0 28.5 11.5T880-480q0 82-31.5 155t-86 127.5q-54.5 54.5-127 86T480-80Z',
  };
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
    const isErr = isError === true || isError === 'error';
    if (window.AgyUI?.showToast) {
      if (!text) {
        document.querySelector?.('.agy-toast')?.remove?.();
        return;
      }
      const toast = window.AgyUI.showToast(text, { error: isErr, durationMs });
      // Older kits render the toast without a live region; make sure it is announced.
      toast?.setAttribute?.('role', isErr ? 'alert' : 'status');
      toast?.setAttribute?.('aria-live', isErr ? 'assertive' : 'polite');
      return;
    }
    let slot = document.getElementById?.('action-msg-slot');
    if (!slot && document.body?.appendChild && document.createElement) {
      slot = document.createElement('div');
      slot.id = 'action-msg-slot';
      document.body.appendChild(slot);
    }
    if (!slot) return;
    if (!slot.getAttribute?.('aria-live')) slot.setAttribute?.('aria-live', 'polite');
    if (typeof clearTimeout === 'function' && toastTimer) clearTimeout(toastTimer);
    setHtml(
      slot,
      text
        ? html`<div class="${isErr ? 'error-banner' : 'loading-state'} action-msg"${rawHtml(isErr ? ' role="alert"' : '')}>${esc(text)}</div>`
        : '',
    );
    if (text && typeof setTimeout === 'function' && durationMs > 0) {
      toastTimer = setTimeout(() => setHtml(slot, ''), durationMs);
    }
  }

  // Re-renders replace nodes through innerHTML, so focus is restored by a selector that finds the
  // same control again. Controls without an id are keyed by their tag, stable classes and data attributes.
  const FOCUS_KEY_ATTRS = ['data-subagent-id', 'data-server', 'data-terminal-id', 'data-sidecar-id', 'data-plugin-id', 'data-action', 'data-tab'];
  const STATE_CLASSES = new Set(['active', 'active-subagent', 'open', 'on', 'spinning', 'disabled', 'strike']);
  const cssIdent = (v) => (globalThis.CSS?.escape ? globalThis.CSS.escape(String(v)) : String(v).replace(/[^\w-]/g, (c) => `\\${c}`));
  const cssString = (v) => String(v).replace(/["\\]/g, (c) => `\\${c}`);
  function focusKeyOf(el) {
    if (!el?.tagName || (typeof document !== 'undefined' && el === document.body)) return '';
    if (el.id) return `#${cssIdent(el.id)}`;
    if (el.tagName === 'SUMMARY') {
      const idx = el.closest?.('[data-cp-index]')?.getAttribute?.('data-cp-index');
      return idx ? `details[data-cp-index="${cssString(idx)}"] > summary` : '';
    }
    const attrs = FOCUS_KEY_ATTRS.filter((a) => el.hasAttribute?.(a))
      .map((a) => `[${a}="${cssString(el.getAttribute(a))}"]`)
      .join('');
    if (!attrs) return '';
    const cls = Array.from(el.classList || [])
      .filter((c) => !STATE_CLASSES.has(c))
      .map((c) => `.${cssIdent(c)}`)
      .join('');
    return `${el.tagName.toLowerCase()}${cls}${attrs}`;
  }
  function restoreFocus(root, key) {
    if (!key || !root?.querySelector) return false;
    try {
      const target = root.querySelector(key);
      target?.focus?.({ preventScroll: true });
      return Boolean(target);
    } catch {
      return false;
    }
  }

  // A modal confirmation shaped like Antigravity's own: a question as the title, a short body,
  // Cancel and the action button, focus on the action button, a spinner while it runs, and an
  // inline role="alert" error. onConfirm throws to keep the dialog open with that error.
  function openConfirmDialog({ title, body = '', note = '', confirmLabel, onConfirm, returnFocusKey = '' }) {
    const host = document.getElementById?.('app') || document.body;
    if (!host?.appendChild) return null;
    document.getElementById?.('cm-dialog')?.remove?.();
    const dlg = document.createElement('dialog');
    dlg.id = 'cm-dialog';
    dlg.className = 'cm-dialog';
    dlg.setAttribute('aria-labelledby', 'cm-dialog-title');
    dlg.setAttribute('aria-describedby', 'cm-dialog-body');
    const actionLabel = (busy) => html`${busy ? icon('progress_activity', 14, 'cm-spin') : ''}<span>${confirmLabel}</span>`;
    setHtml(
      dlg,
      html`
        <h2 id="cm-dialog-title" class="cm-dialog-title">${title}</h2>
        <div id="cm-dialog-body" class="cm-dialog-body">
          ${body ? html`<p class="cm-dialog-quote">${body}</p>` : ''}
          ${note ? html`<p>${note}</p>` : ''}
        </div>
        <p class="cm-dialog-error" role="alert"></p>
        <div class="cm-dialog-actions">
          <button type="button" class="agy-btn agy-btn-secondary cm-dialog-btn" data-dialog="cancel">Cancel</button>
          <button type="button" class="agy-btn agy-btn-primary cm-dialog-btn" data-dialog="confirm" autofocus>${actionLabel(false)}</button>
        </div>
      `,
    );
    host.appendChild(dlg);
    const confirmBtn = dlg.querySelector('[data-dialog="confirm"]');
    const cancelBtn = dlg.querySelector('[data-dialog="cancel"]');
    const errorEl = dlg.querySelector('.cm-dialog-error');
    let busy = false;
    const setBusy = (on) => {
      busy = on;
      // aria-disabled, not disabled: a disabled button drops focus out of the dialog.
      for (const b of [confirmBtn, cancelBtn]) {
        if (on) b?.setAttribute?.('aria-disabled', 'true');
        else b?.removeAttribute?.('aria-disabled');
      }
      setHtml(confirmBtn, actionLabel(on));
    };
    const close = () => {
      if (dlg.open && typeof dlg.close === 'function') dlg.close();
      dlg.remove?.();
      restoreFocus(document, returnFocusKey);
    };
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault?.();
      if (!busy) close();
    });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !busy && typeof dlg.showModal !== 'function') close();
    });
    dlg.addEventListener('click', (e) => {
      if (e.target !== dlg || busy || typeof dlg.getBoundingClientRect !== 'function') return;
      const r = dlg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) close();
    });
    cancelBtn?.addEventListener('click', () => {
      if (!busy) close();
    });
    confirmBtn?.addEventListener('click', async () => {
      if (busy) return;
      errorEl.textContent = '';
      setBusy(true);
      try {
        await onConfirm?.();
        close();
      } catch (err) {
        setBusy(false);
        errorEl.textContent = err?.message || 'Something went wrong. Try again.';
        confirmBtn.focus?.();
      }
    });
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    confirmBtn?.focus?.();
    return dlg;
  }

  // A collapsible drawer row. Antigravity's disclosures are real <button aria-expanded> elements.
  // The label and summary truncate with an ellipsis; below 340px the summary drops under the label.
  // label and summary may be plain text or trusted html; each gets a title so cut-off text is
  // recoverable on hover.
  const drawerToggleHtml = ({ id, controls, expanded = false, label, summary = '', summaryCls = '', extra = '', style = '' }) => html`
    <button
      type="button"
      id="${id}"
      class="breakdown-row collapsible-toggle"
      aria-expanded="${expanded ? 'true' : 'false'}"
      aria-controls="${controls}"${style ? rawHtml(` style="${escapeRaw(style)}"`) : ''}
    >
      <span class="row-label muted">
        <span class="chevron ${expanded ? 'open' : ''}" aria-hidden="true">${icon('chevron_right', 14)}</span>
        <span title="${label}">${label}</span>
        ${extra}
      </span>
      <span class="row-tokens${summaryCls ? ` ${summaryCls}` : ''}" title="${summary}">${summary}</span>
    </button>
  `;

  // Antigravity's switch is the track itself: one button role="switch", named from outside
  // (aria-labelledby or aria-label). attrs is raw markup, so callers escape interpolated values.
  const switchHtml = ({ on = false, size = 'md', cls = '', attrs = '' } = {}) => rawHtml(
    `<button type="button" role="switch" aria-checked="${on ? 'true' : 'false'}" class="${
      ['agy-switch', size === 'sm' ? 'sm' : '', cls, on ? 'on' : ''].filter(Boolean).join(' ')
    }"${attrs ? ` ${attrs}` : ''}><span class="agy-switch-thumb"></span></button>`,
  );
  function setSwitch(el, on) {
    if (!el) return;
    if (window.AgyUI?.syncSwitchState) {
      window.AgyUI.syncSwitchState(el, on);
      return;
    }
    el.setAttribute?.('aria-checked', on ? 'true' : 'false');
    el.classList?.toggle?.('on', Boolean(on));
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
    focusKeyOf,
    restoreFocus,
    openConfirmDialog,
    drawerToggleHtml,
    switchHtml,
    setSwitch,
    formatTokens: (n) => (Number(n) >= 1000 ? `${(Number(n) / 1000).toFixed(1)}k` : String(Number(n) || 0)),
    formatPct: (n) => `${(Number(n) || 0).toFixed(1)}%`,
    formatRelativeReset: (str) => String(str || '—'),
    formatTimeShort: (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'),
    barColor: (r) => (r === 'danger' ? 'var(--cm-red)' : (r === 'warn' ? 'var(--cm-yellow)' : 'var(--cm-accent)')),
    tierColor: (c) => (c ? 'var(--cm-yellow)' : 'var(--cm-blue)'),
    renderEmptyState: (msg) => html`<div class="empty-hint">${esc(msg)}</div>`,
  });
})();
