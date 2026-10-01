# Muse Super-Agent: Native Zero-MCP Monolithic Architecture — Ultimate Implementation Plan

## Goal Description
Evolve Muse from a stateless orchestrated worker into a standalone, monolithic super-agent with Native Zero-MCP Built-in Features. No external MCP servers, no network sidecars, no Python dependencies. All capabilities ship as first-party TypeScript modules inside the existing Node.js CLI, using only Node 22+ natives + 3 minimal zero-dependency-vendored libs. Targets: fully offline-capable autonomy, 30+ day long-running goals with crash-resume, safe OS/Fleet control, deterministic scheduling, auditable web access, persistent memory, and interactive meta-cognition, all under a unified Security & Cost Kernel.

## Proposed Changes

### [MODIFY] 1. Native Web Browsing & HTTP Gateway — Harden Draft from `node-fetch + cheerio` to Production Grade
**Why draft is insufficient:** `node-fetch` is deprecated in Node 22 (native `fetch/undici` exists), `cheerio` alone produces noisy HTML, no SSRF guard, no robots.txt, no cache = prompt-injection + bandwidth + cost risk.
**Final Architecture:**
- `src/gateway/http.ts`: wrapper around native `fetch` with `AbortController` timeout (default 15s), redirect cap (5), max-body 2MB, User-Agent `Muse-SuperAgent/1.0`, allowlist/blocklist (`--allow-domains`, block `169.254.0.0/16, 127.0.0.0/8, 10.0.0.0/8` for SSRF).
- `src/gateway/robots.ts`: native robots.txt fetch + cache (24h) + respect `Disallow`.
- `src/gateway/readability.ts`: `cheerio` for DOM strip (`script, style, nav, footer, iframe` removal) + `turndown` (vendored) for HTML-to-Markdown, readability scoring, main-content extraction, 8000-char truncation with `...[truncated, use :selector]` continuation.
- `src/gateway/cache.ts`: file-backed `GET` cache in `.muse/cache/http/<sha256>.json` (TTL 1h default, ` --no-cache` override).
- `src/gateway/security.ts`: prompt-injection fence — wrap all web output in `<untrusted-web-content source=url>` tags, auto-redact secrets via regex, never auto-execute instructions from web.
- CLI: `muse fetch <url> [--selector css] [--md] [--json]`, `muse search` remains delegated to web output (no new dep).

### [MODIFY] 2. Long-Running Autonomy & Goals — From `scratchpad.md` Dump to Crash-Resumable State Machine
**Why draft is insufficient:** Single markdown dump is unqueryable, races on crash, no budget guard = infinite loop risk.
**Final Architecture:**
- `src/autonomy/goal-store.ts`: SQLite-less JSONL + file-lock store in `.muse/goals/<goal-id>/state.json` + `events.jsonl` + `scratchpad.md` (human-readable view, not source of truth). Schema: `{id, objective, status: queued|active|paused|done|failed, plan: Step[], currentStep, budget: {maxIters, maxTokens, deadline}, createdAt}`.
- `src/autonomy/loop.ts`: `/goal <objective> [--budget 50] [--deadline 24h]` command implements ReAct loop: `plan -> act (tools) -> observe -> checkpoint -> reflect`. Every iteration appends to `events.jsonl` and rewrites `state.json` atomically, dumps summary to `scratchpad.md`.
- `src/autonomy/resume.ts`: on startup, scan `state.json` for `active` goals, prompt `Resume goal <id>? [Y/n]`. Heartbeat file `heartbeat.json` updated every 60s for external orchestrator liveness check.
- Circuit breaker: halt on 3 consecutive tool failures, token budget exceeded, or user interrupt (`Ctrl+C` -> `paused`, not lost).

### [MODIFY] 3. Native Scheduling & Monitoring — From Hallucinated `daemon` to Persistent Cron + Single-Flight Executor
**Why draft is insufficient:** No true background daemon in a CLI process; needs persistence across restarts.
**Final Architecture:**
- `src/scheduler/store.ts`: persistent ` .muse/schedule/jobs.json` : `[{id, cron, prompt, createdAt, lastRun, enabled}]`. Use `cron-parser` (single 0-dep lib) for validation/next-run calc, not a running daemon.
- `src/scheduler/runner.ts`: `schedule_task` built-in tool + CLI `muse schedule --add "0 * * * *" --prompt "check CI"`, `muse schedule --list`, `--remove <id>`, `--run <id>`. Check on every CLI invocation + `muse daemon --poll 60` opt-in foreground looper for fleet boxes. Single-flight via `jobs.lock` file.
- `src/scheduler/monitor.ts`: `muse watch <cmd> --every 5m --on-fail "notify"` with log to `.muse/schedule/runs/<job-id>.log`, exit-code alerting.
- No new background process by default to preserve Zero-MCP monolith constraint.

### [MODIFY] 4. Advanced Git & OS Fleet Management — From Raw Shell to Structured, Audited Wrappers
**Why draft is insufficient:** Raw `exec` is unsafe for fleet ops, unparseable output, no dry-run.
**Final Architecture:**
- `src/fleet/git.ts`: structured wrappers `gitStatus(), gitDiff(), gitCommit(), gitBranch(), gitLog(), gitPush()` using `simple-git` semantics re-implemented natively via `spawnSync('git', args)` + Zod parsers returning JSON, never raw string. Enforce: `push` requires `--allow-push` or `fleet.allowPush=true`, `checkout --force` / `reset --hard` / `clean -fd` require `--force` + confirmation.
- `src/fleet/os.ts`: allowlisted `exec` gateway: `pwd, ls, cat, node --version` always allowed; `rm, sudo, chmod, ssh, docker` require Tier-2 approval + `--yes`. All calls logged to `.muse/audit/exec.log` with `{timestamp, cmd, cwd, exitCode, durationMs}`.
- `src/fleet/fleet.ts`: `muse fleet --host user@host -- cmd` via native `ssh` spawn, `muse fleet --all -- "git pull"` fan-out with JSON aggregated results table.
- CLI: `muse git <subcommand> --json`, `muse exec -- <cmd>` with dry-run preview.

### [MODIFY] 5. Interactive Meta-Cognition — From Flat Slash Commands to Layered Cognitive Controller
**Why draft is insufficient:** `/grill-me, /persona, /plan` as prompts are stateless and forgetful.
**Final Architecture:**
- `src/cognition/persona.ts`: `/persona <name> [--reset]` as system-prompt overlay stack (`socratic-reviewer, staff-engineer, ruthless-pm`), stored in `.muse/cognition/persona.json`, injected above all tool calls, auto-cleared on goal completion.
- `src/cognition/planner.ts`: `/plan <task>` generates DAG `plan.md` (`- [ ] Step 1 [depends: none] [risk: low]`) requiring explicit `/approve` before any `fleet/os` Tier-2 execution. Re-planning diffs old vs new.
- `src/cognition/grill.ts`: `/grill-me` adversarial reviewer loop: spawns 3-pass critique (correctness, edge-cases, simplicity) using same model with `persona=socratic-reviewer`, outputs `GRILL.md` with must-fix vs nice-to-have, blocks `done` until must-fix resolved.
- `src/cognition/reflect.ts`: post-task `REFLECT.md` auto-append: what worked, token cost, lesson candidate for `LEARNINGS.md`.

### [NEW] 6. Persistent Semantic Memory Kernel (The Missing Super-Agent Brain)
- `src/memory/kernel.ts`: 3-tier memory: `1) .muse/MEMORY.md` (long-term facts, max 200 lines, auto-pruned), `2) .muse/goals/<id>/scratchpad.md` (working memory), `3) LEARNINGS.md` (durable lessons via existing `learn` tool).
- Auto-recall: on every prompt, inject top-10 relevant `MEMORY.md` lines via keyword scoring (no vector DB to preserve Zero-MCP). `muse remember <fact>`, `muse recall <query>`, `muse forget <pattern>`.
- Consolidation job: scheduled `0 2 * * *` to summarize `events.jsonl` -> `MEMORY.md` prune.

### [NEW] 7. Zero-MCP Plugin & Skill System (Monolithic Extensibility Without Servers)
- `src/skills/manifest.ts`: ` .muse/skills/<skill>/SKILL.md + skill.json` (`{name, version, tools: [], promptOverlay}`) auto-discovered at startup. Pure TS functions with Zod input/output schemas, registered into same tool dispatcher as gateway/fleet/scheduler.
- `muse skill --create <name>`, `muse skill --list`, hot-reload without restart. Enables future `pdf, csv, k8s` skills without MCP overhead.

### [NEW] 8. Sandboxed Code Execution & Self-Repair Harness
- `src/sandbox/run.ts`: `muse run --js "code"` via `node:vm` timeout 5s + `muse test` harness that runs `npm test` capture, parses failures, feeds back into autonomy loop for self-fix (max 3 retries). No arbitrary host write outside `workspaceRoot` (path jail via `path.resolve` check).

### [NEW] 9. Observability, Cost & Token Governance Kernel (Mandatory for Autonomy)
- `src/kernel/trace.ts`: every tool call -> `.muse/audit/trace.jsonl` (`{ts, tool, argsHash, tokensIn/Out, durationMs}`).
- `src/kernel/budget.ts`: global `muse.config.json: {maxTokensPerGoal: 100k, maxCostUsd: 2.00}` circuit-breaker halts `/goal` and `daemon` loops, prints `BUDGET_EXCEEDED` report.
- `muse stats --today` shows spend table. Prevents runaway autonomy billing.

### [NEW] 10. Security & Trust Kernel (Non-Negotiable for Web + Fleet Super-Agent)
- `src/kernel/permissions.ts`: 3 tiers: `Tier0: read-only (always allow), Tier1: local write (auto-allow in workspace), Tier2: network/fleet/git-push/exec-rm (require explicit --yes / /approve)`.
- `src/kernel/redactor.ts`: secret regex (`sk-*, ghp_*, AKIA*, -----BEGIN`) redacted from logs, web content, and `trace.jsonl`.
- `INSTRUCTIONS.md` hardening: `UNTRUSTED` web content can never override Tier2 permissions or persona.

## Verification Plan
1. **Zero-MCP Purity:** `npm ls --prod` must show only `cheerio, turndown, cron-parser` added; `node --test`, `tsc --noEmit`, `npm run build` all green; binary runs offline with `--offline` flag (web gateway returns cached only).
2. **Gateway:** `muse fetch https://example.com --md` returns Markdown <8k chars wrapped in `<untrusted-web-content>`; `muse fetch http://169.254.169.254/` blocked with `SSRF_BLOCKED`; robots.txt `Disallow` respected; second fetch hits cache (<50ms).
3. **Autonomy:** `muse goal "create hello.txt" --budget 10` creates `.muse/goals/<id>/state.json + events.jsonl + scratchpad.md`; `kill -9` mid-run then `muse goal --resume <id>` completes without duplication; exceeding `--budget 2` halts with `BUDGET_EXCEEDED`.
4. **Scheduling:** `muse schedule --add "* * * * *" --prompt "ping"`, `--list` shows nextRun, `muse daemon --poll 5` executes twice with logs in `runs/`; restart preserves `jobs.json`; overlapping runs single-flight (no duplicate `runs`).
5. **Fleet & Git:** `muse git status --json` returns valid JSON; `muse exec -- "rm -rf /"` requires `--yes` and is denied outside workspace; `muse fleet --host fake -- "ls"` aggregates JSON with per-host exit codes; all writes appear in `.muse/audit/exec.log`.
6. **Cognition & Memory:** `/persona staff-engineer` persists in `persona.json` and changes tone; `/plan build API` creates blocking `plan.md` requiring `/approve`; `/grill-me` produces `GRILL.md` with must-fix; `muse remember X` survives restart and `muse recall X` retrieves it.
7. **Kernel:** `muse stats --today` reports tokens matching `trace.jsonl` sum; secret `sk-test-12345` in web page appears as `[REDACTED]` in logs; Tier2 action without approval aborts with `APPROVAL_REQUIRED`.

