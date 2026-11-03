# `antigravity-context-monitor` UI v2 Design: Migration to `AgyUI.html` Tagged JSX, Custom Elements, and `--agy-*` Tokens

## 1. Intent & Why

Although `antigravity-context-monitor` (`commits 9aa4f24..c37196b`) wired `/shell.css`, `/shell.js`, `/ui.css`, and `/ui.js` into [`server.mjs`](../../../server.mjs) and [`ui/index.html`](../../../ui/index.html), the migration stopped halfway:

1. **Raw `innerHTML` Concatenation + Post-Hoc `querySelectorAll` Wiring:**
   [`ui/components/context-tab.js`](../../../ui/components/context-tab.js) (317 lines), [`ui/components/context-drawers.js`](../../../ui/components/context-drawers.js) (406 lines), [`ui/components/diagnostics-tab.js`](../../../ui/components/diagnostics-tab.js) (294 lines), and [`ui/components/mcp-budgets-tab.js`](../../../ui/components/mcp-budgets-tab.js) (125 lines) construct giant HTML strings using manual `${esc(...)}` interpolations, assign `container.innerHTML = ...`, and then run separate `wireContextInteractiveElements()` / `querySelectorAll('[data-action=...]')` loops to re-attach event listeners on every poll tick.
2. **Duplicate Runtime & Stylesheet Code (`ui/core.js`, `ui/app.js`, `ui/styles.css`, `ui/components.css`):**
   - [`ui/app.js:402-430`](../../../ui/app.js#L402-L430) manually re-implements SSE `EventSource` connection and exponential backoff (`connectStateEvents`) instead of calling `window.AgyShell.subscribeStateSyncEvents`.
   - [`ui/core.js:46-247`](../../../ui/core.js#L46-L247) manually re-implements `applyTheme` (62 lines), `iconSvg`, `iconEl`, `el`, `clear`, `esc`, `formatBadgeLabel`, `apiCall`, `notifyAgent`, and `showToast` despite loading `/shell.js` and `/ui.js`.
   - [`ui/styles.css:1-49`](../../../ui/styles.css#L1-L49) re-declares 49 lines of `:root` and `:root[data-theme="light"]` `--cm-*` variables that duplicate `/shell.css`'s `--agy-*` token system.
   - [`ui/components.css:158-225`](../../../ui/components.css#L158-L225) re-declares 68 lines of `.agy-badge`, `.agy-btn`, `.agy-icon-btn`, `.agy-count-pill`, and `.agy-switch` rules that are already served by `/ui.css`, and defines `.agy-icon-btn.spinning` twice ([`ui/styles.css:146-148`](../../../ui/styles.css#L146-L148) and [`ui/components.css:208-210`](../../../ui/components.css#L208-L210)).
3. **300-Line Ceiling Violations:**
   Four files exceed the mandatory 300-line ceiling (`ui/app.js`: 434 lines, `ui/components/context-drawers.js`: 406 lines, `ui/components.css`: 360 lines, `ui/components/context-tab.js`: 317 lines), while [`server.mjs:18-23,101-106`](../../../server.mjs#L18-L23) crams multiple statements per line to stay under 140 lines.

This design completes the migration of `antigravity-context-monitor` to `antigravity-sidecar-kit` v2 (`AgyUI.html`, `<agy-toggle-group>`, `<agy-switch>`, `AgyShell`), deletes all duplicated CSS/JS fallbacks, and brings every file in the repository under 300 lines.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Hard 300-Line Ceiling Across UI & Entrypoint Files (Builder Call):** Every UI and routing entrypoint file (`server.mjs`, `ui/**/*.js`, `ui/**/*.css`, `ui/**/*.html`, and UI test files) must be `<= 300 lines` without single-line statement cramming. Backend telemetry modules (`lib/*.mjs`) are untouched per Non-Goals.
- **Declarative View Rendering via `AgyUI.html`:** Replace raw HTML string concatenation + `esc()` + `querySelectorAll` listener wiring across `context-tab.js`, `context-drawers.js`, `mcp-budgets-tab.js`, and `diagnostics-tab.js` with `html\`...\`` templates and direct `onClick=${fn}` / `onChange=${fn}` handlers.
- **Adopt `<agy-toggle-group>` and `<agy-switch>`:** Use `AgyUI` custom elements / helpers for the top 3-tab navigation bar (`#tab-nav`), MCP server toggles, and the AI credit overages switch.
- **Unify Theme & CSS Tokens on `--agy-*`:** Map `--cm-*` aliases directly to `--agy-*` tokens from `/shell.css` (or use `--agy-*` directly), replace `.is-Connected` / `.is-Reconnecting` / `.is-Disconnected` with standard lowercase `AgyUI` badge state classes (`.running`, `.warn`, `.errored`), and delete the 68 lines of duplicate `.agy-*` overrides in `ui/components.css`.
- **Preserve `TIER_1_TELEMETRY` Compliance:** Keep zero `child_process` imports and zero external runtime dependencies beyond `antigravity-sidecar-kit`.

### Non-Goals
- Changing the backend telemetry RPC logic (`lib/context-telemetry.mjs`, `lib/plan-quota.mjs`, `lib/mcp-manager.mjs`, `lib/diagnostics.mjs`) or MCP tool schemas.

### Anti-Goals
- Keeping dead `if (window.AgyUI?.foo) ... else { /* 30 lines */ }` fallback branches in `ui/core.js`.
- Setting `innerHTML` with unescaped or manually escaped string concatenation when `AgyUI.html` is available.

---

## 3. Approaches Considered

### Approach 1 (Selected): Direct `AgyUI.html` DOM Templates + `<agy-toggle-group>` / `<agy-switch>` + Split Drawers
- **How it works:**
  - `ui/core.js` becomes a thin (< 110 lines) bridge that aliases `AgyUI.html`, `AgyUI.el`, `AgyUI.clear`, `AgyUI.iconSvg`, `AgyUI.iconEl`, `AgyUI.apiCall`, `AgyUI.showToast`, `AgyShell.notifyAgent`, and `AgyShell.subscribeStateSyncEvents`, keeping only Context Monitor-specific helpers (`mutateState`, `formatTokens`, `barColor`, `deriveCmVarsFromEditor` for legacy editor-only payloads).
  - `ui/components/context-drawers.js` (406 lines) is split into `ui/components/context-drawers.js` (model profile, prompt-fit advisor, help drawer — `<= 220 lines`) and `ui/components/subagent-tree.js` (subagent hierarchy banner, cards, and drill-down — `<= 190 lines`), or compacted cleanly via `html\`...\`` to `< 250 lines`.
  - `ui/app.js` (434 lines) delegates SSE state events to `AgyShell.subscribeStateSyncEvents` and tab navigation to `<agy-toggle-group>` / `AgyUI.createToggleGroup`, bringing `ui/app.js` under 280 lines.
- **Tradeoffs:** Eliminates ~300 lines of duplicated boilerplate and listener-wiring code while keeping zero build step.

### Approach 2: Keep `innerHTML` String Templates and Only Split Files
- **Why Rejected:** Leaves error-prone manual `esc()` string concatenation and `querySelectorAll` re-binding loops in place.

---

## 4. Detailed Architecture & File Plan

### 4.1 File Size & Responsibility Breakdown

| File | Current Lines | Target Lines | Changes |
| :--- | :---: | :---: | :--- |
| `server.mjs` | 138 | `<= 130` | Format cleanly (no multi-statement single lines); extract MCP tool definitions into `lib/mcp-tools.mjs` (`<= 80 lines`) so `server.mjs` is `<= 80 lines`. |
| `ui/index.html` | 27 | `<= 30` | Ensure `<script defer src="/shell.js">` and `<script defer src="/ui.js">` precede app scripts. |
| `ui/styles.css` | 235 | `<= 190` | Alias `--cm-*` to `--agy-*` tokens from `/shell.css`; remove duplicate `:root[data-theme="light"]` block and duplicate `.agy-icon-btn.spinning`. |
| `ui/components.css` | 360 | `<= 260` | Delete lines 158–225 (duplicate `.agy-badge`, `.agy-btn`, `.agy-icon-btn`, `.agy-count-pill`, `.agy-switch` rules already in `/ui.css`). |
| `ui/core.js` | 273 | `<= 120` | Delegate `html`, `el`, `clear`, `iconSvg`, `iconEl`, `escHtml`, `formatBadgeLabel`, `apiCall`, `showToast`, `notifyAgent` directly to `window.AgyUI` / `window.AgyShell`; register `chevron_right` via `AgyUI.registerIcons`. |
| `ui/app.js` | 434 | `<= 270` | Replace manual `connectStateEvents` (lines 402–430) with `AgyShell.subscribeStateSyncEvents`; use `<agy-toggle-group>` / `AgyUI.createToggleGroup` for `#tab-nav`; move action-handler dispatch (`toggleMcpServer`, `refreshMcpServers`, `toggleOverage`, `closeTerminal`, `restartSidecar`) into component `onClick` callbacks or a concise controller helper. |
| `ui/components/context-tab.js` | 317 | `<= 230` | Rewrite using `AgyUI.html` (`html\`...\``) with inline `onClick` / `onChange` handlers and `<agy-switch>`, eliminating `wireContextInteractiveElements`. |
| `ui/components/context-drawers.js` | 406 | `<= 260` | Rewrite drawers (help drawer, model profile drawer, culprits drawer, subagent tree) using `AgyUI.html` with direct click handlers. |
| `ui/components/mcp-budgets-tab.js` | 125 | `<= 110` | Rewrite using `AgyUI.html` and `<agy-switch>`. |
| `ui/components/diagnostics-tab.js` | 294 | `<= 220` | Rewrite using `AgyUI.html`; map connection status badge states to lowercase `.running` (`Connected`), `.warn` (`Reconnecting`), `.errored` (`Disconnected`). |

### 4.2 Test Verification (`test/`)
- Update Context Monitor's unit test suite (`npm test`) to load `/shell.js` and `/ui.js` (via `antigravity-sidecar-kit`) or `linkedom` in `devDependencies`, verifying:
  - Tab switching via `<agy-toggle-group>` / `createToggleGroup`.
  - Interactive toggles (`<agy-switch>` for MCP servers and AI credits overage).
  - Subagent drill-down, culprits drawer expansion, and diagnostics actions (`restart-sidecar`, `close-terminal`).
  - Zero files exceeding 300 lines.

---

## 5. What Is Left to the Builder
- Whether to keep `context-drawers.js` as one file (`<= 260 lines` once converted to `html\`...\``) or split subagent rendering into `ui/components/subagent-drawer.js` if it approaches 260 lines.
