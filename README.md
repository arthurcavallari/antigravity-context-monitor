# Antigravity Context Monitor

Real-time context window breakdown, prompt & thinking effort advisor, MCP server lifecycle controller, and 5-hour/weekly plan usage telemetry sidecar for **Google Antigravity**.

Mounts natively in Antigravity's Auxiliary (right-hand) Pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) and syncs automatically with your active conversation and editor theme (dark, light, high-contrast, and custom theme seeds).

---

## Features

### 1. Context Tab
- **Exact Working Memory Breakdown**: Computes live context consumption (`inputTokens + cacheReadTokens`) across `Messages`, `System tools`, `System prompt`, `Skills`, `MCP tools (eager)`, `MCP tools (deferred)`, and `Free space (to compact)`.
- **Cortex Harness vs. Native Window**: Tracks usage against the 256k Cortex autocompact ceiling (`maxContextTokens`) alongside the 1.0M native Gemini burst window (or 200k Claude window), with expandable model profile specs.
- **Compaction Checkpoint Inspector**: Lists session autocompact checkpoints with pre/post token counts, tokens saved, and expandable `<summary>` inspection.
- **Prompt & Thinking Effort Fit Advisor**: Analyzes per-turn trajectory telemetry to surface when a prompt is over-provisioned (`unused_effort`, `loop_tax`, `housekeeping`) or under-provisioned (`thrashing`), with phase-split bars comparing planning/edits against routine file/command read loops.
- **Largest Items in Context**: Highlights the top 5 largest active conversation steps (with file/command descriptions and relative bars) and system prompt sections.
- **Turn Performance Strip**: Displays latest-turn TTFT, streaming throughput (`tok/s`), dual-segment output vs. reasoning ratio, compaction counter, and API retry counts.
- **Dual Plan Usage & AI Credits**: Side-by-side 5-hour and weekly quota progress bars with reset countdowns for both Gemini and Claude/GPT model groups, plus live Google One AI Credit balance, session burn, and one-click Overage toggle.

### 2. MCP & Budgets Tab
- **Customization Token Budgets**: Tracks live token consumption against configured `customizationTokenBudget` (Skills) and `rulesTokenBudget` (Rules), plus single-message input cap.
- **Live MCP Server Controls**: Lists all configured standalone and plugin MCP servers with eager vs. deferred tool counts, estimated token footprint, error diagnostics, individual enable/disable switches, and per-server or global reload actions.

### 3. Diagnostics Tab
- **Opt-In Memory-Safe Log Tailer**: 80-line ring buffer tailing Language Server diagnostic logs (with severity highlighting for HTTP `429` / `RESOURCE_EXHAUSTED` and auto-scroll lock). Off by default to conserve memory.
- **Background Terminal Reaper**: Inspects active background terminals (`PID`, title, workspace) with one-click process termination.
- **Sidecar Process Matrix**: Displays running/errored status and ports for all registered Antigravity sidecars with one-click restart controls.

---

## Requirements

- **Google Antigravity** (2.0 Desktop / IDE with `SidecarManager` support)
- **Node.js** `>= 20.0.0` (zero external npm dependencies; uses built-in `sidecar_sdk` injected by Antigravity)

---

## Installation

### Option A: 1-Click Install via Antigravity Hangar (Recommended)

If you use [**Antigravity Hangar**](https://github.com/arthurcavallari/antigravity-hangar) (`npx antigravity-hangar`), open the **`🧩 Extensions -> Discover`** tab inside Hangar and click **Install** on **Context & Quota Monitor**—or keep it pinned in Hangar's top split-pane while switching between project-specific sidecars below in `0ms`.

### Option B: Standalone CLI (`npx` or `git clone`)

```bash
# 1-command install via npx
npx antigravity-context-monitor

# Or clone and link locally
git clone https://github.com/arthurcavallari/antigravity-context-monitor.git
cd antigravity-context-monitor
npm run setup
```

What `setup` does:
1. Validates all required sidecar manifest, backend, and UI assets.
2. Runs the unit test suite (`npm test`).
3. Links `~/.gemini/config/sidecars/context-monitor` to your package checkout (using an NTFS directory junction on Windows or directory symlink on macOS/Linux, copying out of ephemeral `_npx` caches automatically).
4. Enables `sidecars["context-monitor"]` in `~/.gemini/config/config.json` (preserving any existing `projectId` and writing UTF-8 without BOM).
5. Hot-reloads the sidecar via the Language Server `ManageSidecar` RPC when invoked inside an active Antigravity session.

### Uninstallation

```bash
npm run uninstall
```

Removes the `~/.gemini/config/sidecars/context-monitor` link, sets `sidecars["context-monitor"].enabled = false` in `~/.gemini/config/config.json` (preserving `projectId`), and disables the sidecar via RPC.

---

## Development & Testing

Run the automated test suite:

```bash
npm test
```

### Project Layout

```text
antigravity-context-monitor/
├── package.json
├── sidecar.json                  # Antigravity Auxiliary Pane sidecar manifest
├── hub-manifest.json             # Hangar / Sidecar Hub marketplace manifest
├── setup.mjs                     # Cross-platform junction/symlink installer & RPC enabler
├── server.mjs                    # Thin SidecarApp routing entrypoint
├── lib/
│   ├── constants.mjs             # Ceilings, category metadata & JSON config helpers
│   ├── theme.mjs                 # Host theme seed resolver, contrast detector & CSS proxy
│   ├── rpc-client.mjs            # Connect RPC client for Antigravity Language Server
│   ├── session-resolver.mjs      # Active trajectory selection & model metadata resolution
│   ├── context-telemetry.mjs     # Context window breakdown & telemetry orchestrator
│   ├── turn-insights.mjs         # Turn performance metrics & customization token budgets
│   ├── context-inspector.mjs     # Compaction checkpoint history & largest context items
│   ├── effort-advisor.mjs        # Model & thinking effort fit classifier
│   ├── plan-quota.mjs            # 5h/weekly plan usage & Google One AI Credits controller
│   ├── mcp-manager.mjs           # MCP server toggle/refresh & customization catalog
│   └── diagnostics.mjs           # 80-line ring-buffer log tailer, terminals & sidecars
├── ui/
│   ├── index.html                # Auxiliary Pane shell markup
│   ├── styles.css                # Core theme-adaptive layout & surface styles
│   ├── components.css            # Tab bar, drawer, badge, card & log console styles
│   ├── core.js                   # Authenticated fetch wrapper, theme sync & UI utilities
│   ├── app.js                    # Frontend controller & root event delegation
│   └── components/
│       ├── context-tab.js        # Tab 1: Header, context window, perf strip & plan usage
│       ├── context-drawers.js    # Expandable drawers (profile, MCP, compactions, fit, culprits)
│       ├── mcp-budgets-tab.js    # Tab 2: Skills/Rules budgets & MCP server matrix
│       └── diagnostics-tab.js    # Tab 3: Log tailer, terminals & sidecars
└── test/
    ├── context-telemetry.test.mjs
    ├── plan-quota.test.mjs
    ├── turn-insights.test.mjs
    ├── effort-advisor.test.mjs
    ├── mcp-diagnostics.test.mjs
    └── theme.test.mjs
```

---

## License

[MIT](./LICENSE)
