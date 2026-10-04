# Muse CLI Agent — Python Hybrid Edition
**Location:** `/data/data/com.termux/files/home/Projects/muse-cli-agent`
**Command:** `muse-cli`

---

## Architecture Overview

The Muse CLI Agent is a native Android Termux Python application rebuilt from a
legacy Node.js/TypeScript monolith. It implements the **QuadTree Kernel Architecture**
where the kernel is the absolute source of truth and all capabilities are attached
as child nodes.

### QuadTree Kernel (`src/kernel.py`)
The root node that orchestrates five quadrant nodes:

| Quadrant | File | Purpose |
|----------|------|---------|
| **Cognition** | `quadrants/cognition/` | API routing, authentication, model selection |
| **Memory** | `quadrants/memory.py` | Episodic chat history with sliding-window truncation |
| **Fleet** | `quadrants/fleet.py` | OS subprocess execution + async BackgroundScheduler |
| **Tools** | `quadrants/tools.py` | Core filesystem ops + dynamic plugin registry |
| **Apex** | `quadrants/apex.py` | 5-Tier metacognitive reasoning engine |

### ReAct Loop (`kernel.chat()`)
The core cognitive loop:
1. User input → appended to Memory
2. Memory context (sliding window, max 4000 tokens) + tool manifest → LLM
3. LLM responds with either text or `TOOL_CALL: <name> <args>`
4. Tool calls are intercepted, executed against `dynamic_tools`, results fed back
5. Loop repeats (max 5 iterations) until LLM produces a final answer
6. Final answer → returned to TUI

### Dynamic Plugin Ecosystem (`src/plugins/`)
The kernel uses `importlib` to hot-load all `.py` files in `plugins/`.
Each plugin exports `register(kernel)` to bind tools into the active graph.

---

## Installed Plugins & Tools (31 total)

### NodeOS Integration (`nodeos_tools.py`)
- `nodeos_search_symbol` — Fast AST symbol lookup via SQLite (replaces grep)
- `nodeos_get_graph` — Spatial graph traversal for codebase topology
- `nodeos_emit_intent` — Drop workflow intents for background daemon
- `nodeos_daemon_status` — Health check on the NodeOS daemon

### Termux Android API (`termux_tools.py`)
- `termux_clipboard_get/set` — Android clipboard access
- `termux_battery_status` — Battery level and charging state
- `termux_toast` — Android toast notifications
- `termux_open_url` — Open URLs via Android Intent
- `sys_info_free` — Memory usage monitoring (LMK awareness)

### Developer Operations (`dev_tools.py`)
- `git_status/add/commit/push` — Full git workflow
- `search_rg` — Targeted ripgrep search
- `search_fd` — File discovery
- `tree_map` — Shallow directory tree
- `python_repl` — Sandboxed Python execution
- `sqlite_inspect` — Raw SQL against agy_nodeos.db

### Web & Information (`web_tools.py`, `web_tool.py`)
- `fetch_url` — HTTP GET
- `search` — Web search
- `weather` — wttr.in integration
- `github_trending` — Trending repos
- `rss_parse` — RSS feed parser

### Cognitive Self-Management (`agent_tools.py`, `core_intel.py`)
- `count_tokens` — Heuristic token estimation
- `compress_memory` — Context history truncation
- `schedule` — Background cron scheduling
- `math` — Safe expression evaluator
- `view_ast` — SyntyCode AST viewer
- `arch_plan` — Use intelligence core to generate a DAG plan
- `arch_grill` — Adversarial design critique
- `arch_reflect` — Log lessons to `.muse/cognition/REFLECT.md`
- `arch_set_persona` — Define context behavior profiles

### Self-Modification (`synty_tool.py`)
- `ingest_architect` — SyntyCode structural mutation

### Internal Kernel Tools
- `route_to_apex` — Trigger the 5-Tier Apex Rage Engine

---

## System Rules
Located at `.agents/rules/muse_native_tools.md`. These rules are loaded into the
kernel at boot and define mandatory behavioral patterns:
- Use NodeOS for spatial context (never unbounded grep)
- Check Termux battery/memory before heavy tasks
- Use the ReAct `TOOL_CALL:` format for tool invocation
- Route complex debugging to the Apex quadrant

---

## TUI (`src/tui.py`)
Interactive prompt built on `prompt_toolkit` (falls back to plain input when
stdin is not a TTY, so pipes keep working):
- up/down navigates persistent history (`~/.config/muse/history`),
- `/` pops up the slash-command menu, `@` pops up file/folder selection,
- `/model <tab>` completes models of the active provider (with variants),
- bottom toolbar always shows `provider • model`,
- `@path` mentions are inlined as bounded `<file>` context blocks.
- `/help`, `/model`, `/provider`, `/login`, `/logout`, `/tools`,
  `/status`, `/clear`, `/apex`, `/exec`, `/quit` slash commands
  (`/models` kept as a hidden catalog alias; `/m`, `/p` shortcuts work).
- `/model` (no args, on a terminal) opens arrow-key radio menus:
  provider list with auth state → that provider's model list with
  variants; `/model <query>` sets directly (`<base> <variant>` supported).
- `/provider` lists providers with auth state; `/model` lists the active
  provider's models and accepts `<base> <variant>` (e.g. `gpt-5.4 mini`).
- `/login` (no args) opens the provider auth picker showing every
  provider's method + state; `/login [provider]` registers directly,
  `/login <provider> --key` pastes a key instead of the browser flow.
  Native flows ported from `backup_ts/src/auth.ts`: opencode runs a
  two-step login (console device code for identity, then a dashboard API
  key paste since Zen inference accepts dashboard keys only — session
  `st_` tokens are rejected API-wide, verified live); google/agy use PKCE
  (browser → localhost:51121 callback → token exchange, also saved to
  `antigravity-accounts.json`); meta uses an RFC 8628 device flow +
  key mint; anthropic is key-only.
- Last provider/model persists per workspace in `.muse/config.json`,
  including per-provider memory (switching back restores its last model).

### Proxy routing (`quadrants/cognition/router.py`)
Mirrors `opencode-antigravity-auth` semantics: per-surface endpoints,
endpoint fallback chain (daily → autopush → prod) for direct-sandbox calls,
account scheduling (`sticky`/`round-robin`/`hybrid` + `pid_offset` + per-call
`slot`), and response caching. Free-tier gate compliance (recipe:
ForeverInLaw/zen-free-tier-headers, cf. upstream PR #12326): `opencode/`
User-Agent, `x-opencode-session`, `x-opencode-client`, `/inference/openai/`
rewrite, real tool schemas incl. `bash`+`read`, wire-stream + bounded flap
retries on FreeTier 403s. Kills: ZEN_REWRITE_URL=0, ZEN_INJECT_TOOLS=0,
ZEN_STREAM_WIRE=0, ZEN_FLAP_RETRY=0.

---

## Running
```bash
muse-cli
```
