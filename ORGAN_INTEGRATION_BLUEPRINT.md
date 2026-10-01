# Muse-CLI-Agent Organ Integration Blueprint
> Host: `~/Projects/muse-cli-agent/` (muse-ts, native TS, OS-free, Termux LMK-safe)
> Rule: heart stays light. All organs are lazy limbs — never auto-booted, only on explicit task.

## 0. Host Core Verified (do not change)

- `src/index.ts` — CLI entry (`muse-ts`, `exec --json`, `watch`, `bridge`, `serve`). CWD-bound: `agy_nodeos.db, workflow.json, daemon.log` attach to `process.cwd()`.
- `src/core/lmk.ts` — `writeLmkSnapshot/readLmkSnapshot` to `.muse/tmp.json`, sync atomic `write+rename`, cap 100 msgs / 20k chars. Survives kill.
- `src/core/session-store.ts` — `.muse/sessions/YYYY/MM/DD/<id>/session.jsonl`, sync append.
- `src/core/context-manager.ts`, `src/core/config.ts`, `src/core/thought.ts`, `src/core/learnings.ts`
- `src/kernel/index.ts`, `budget.ts::checkBudget`, `permissions.ts::classifyTool`, `trace.ts::appendTrace`, `redactor.ts`
- `src/autonomy/loop.ts::runGoalLoop`, `goal-store.ts::{saveState,appendEvent,heartbeat}` → `.muse/goals/<id>/{state.json,events.jsonl,scratchpad.md}`, circuit-breaker 3 fails.
- `src/companion/memory.ts` → `.muse/memory.md`, `tasks.ts` → `.muse/tasks.json`
- `src/capabilities/nodeos.ts::findBinary,detectNodeOS,runInit` — detects `nodeos` binary + `agy_nodeos.db`, degrades silently.
- `src/cli/watch.ts` — file watcher with SIGINT/SIGTERM cleanup, never keeps process alive.
- `src/gateway/http.ts,cache.ts,security.ts,robots.ts` — HTTP fetch layer.
- `src/services/fs.ts,registry.ts,session.ts,plugins.ts,mentions.ts`
- `src/bridge/` EMPTY, `src/engine/` EMPTY — designated organ slots. Use these, no new top-level dirs.
- `package.json` — zero native deps (commander,inquirer,chalk,marked). No sqlite, no zeromq, no wasm. Keep it that way.
- `workflow.json` — `{"type":"JSON_Task","status":"pending","action":"execute_agents"}` dispatch only.

## 1. Lightness Contract (from AGENTS.md + host code)

1. No `Promise.all()` for tools/network — sequential `for...of` + `await`.
2. No resident daemons/ports/listeners. `watchCommand` cleanup pattern is the only allowed watcher template.
3. Every organ behind lazy `await import()` + explicit trigger: CLI flag (`--swarm`, `--cleave`, `--blast`) OR `workflow.json {status:"pending", action:"<organ>"}` OR `detectNodeOS()===true`.
4. Persist to `.muse/tmp.json` (via `writeLmkSnapshot`) every turn when organ active.
5. Scoped FS only: `fd -t f -e py -e ts --exclude .git --exclude node_modules . ./target` equivalent in TS: `fs.readdir` recursive with ignore list from `polymath-nodeos/polymath_nodeos/daemon.py::AGYRawWatchdog._should_ignore` — `['.jsagent','.agents','__pycache__','.git','node_modules','build','dist','.venv']`.
6. SSE split via `buffer.indexOf("\n\n")`, never `JSON.parse` partial.
7. Native Node only — no proot/Rust/docker/pkg compile. Python organs called via `spawn nodeos/jage` CLI, never linked as binary.
8. QA: `npm run typecheck` + single `node --test tests/*.test.mjs`, never full suite auto-run.

## 2. Organ → Host Mapping (exact sources verified Oct 1)

### O1. Brain spatial graph — `polymath-nodeos/` → `src/engine/spatial.ts` (new) + `src/capabilities/nodeos.ts` (extend)
Sources:
- `polymath-nodeos/polymath_nodeos/nodes_engine.py::NativeNodesEngine,QuadTree,Rectangle`
- `polymath-nodeos/polymath_nodeos/graph_manager.py::AGYGraphManager` tables `nodes(node_id,node_type,name,filepath,hash,x_coord,y_coord)`, `edges(source_id,target_id,relation_type)`
- `polymath-nodeos/polymath_nodeos/jage_engine.py::JageASTEngine`
- `polymath-nodeos/polymath_nodeos/scripts/blast_radius_engine.py,ghost_writer_engine.py,dead_code_engine.py,domino_engine.py,context_engine.py,telemetry.py`
- `polymath-nodeos/polymath_nodeos/cli.py::execute_command(run_blast/run_ghost/run_dead)`
Native adapt:
- Do NOT embed sqlite dep. Reuse existing `agy_nodeos.db` via `findBinary("nodeos")` + `spawnSync("nodeos",["-c","blast",file])` / `ghost` / `search`. Already in `capabilities/nodeos.ts` pattern.
- New `src/engine/spatial.ts` (~120 lines, zero-dep TS port of QuadTree + Hooke repulsion): `export class QuadTree {insert(p):boolean; query(r):Point[]}`, `export function pushHot(x,y,heat):[x,y]`. Imported lazily only by `exec --blast` or autonomy loop when `tokensUsed` spikes.
- `context_engine.py CONTEXT_ENTITY/STATE` → extend `src/companion/memory.ts`: `dedupeNotes(notes:string[]):string[]` using O6 intersection below, write to `.muse/memory.md` only.
- Trigger: `muse-ts exec --json` with `blast|ghost` intent, or `workflow.json action:"blast"`. Idle cost 0.

### O2. Nervous bus — `SyntyEventStream/` → `src/engine/bus.ts` (new)
Sources:
- `SyntyEventStream/models.py::Event(topic,payload,event_id,timestamp)`, `Consumer(consumer_id,group_id,handler)`
- `SyntyEventStream/topic.py::TopicPartition.append/register_consumer/get_events_from/load_recovered_*`
- `SyntyEventStream/broker.py::subscribe/create_topic` + backlog replay `saved_offset<total_events`
- `SyntyEventStream/storage.py::SQLiteStorageAdapter` (`PRAGMA journal_mode=WAL`)
Native adapt:
- `src/engine/bus.ts`: `Map<string,TopicPartition>` in-memory, offsets persisted to `.muse/bus.json` (not new .db) via atomic write like `lmk.ts`. API: `publish(topic,payload)`, `subscribe(topic,groupId,handler)` with replay.
- `storage.py` WAL pattern → reuse `session-store.ts::appendSessionLine` sync append, no sqlite dep.
- `event_broker.py/.ts` dual-stack shape → TS types only.
- Trigger: `autonomy/loop.ts` calls `publish("goal:iter",stepResult)` only when goal active. No loop thread. Subscribers: `trace.ts`, `telemetry_hook` below.

### O3. Reflex cache — `ComputeRes/compute_res/evolvos/reflex_engine.py` → `src/autonomy/reflex.ts` (new)
Source verified via `ComputeRes/test_reflex_engine.py::register_reflex(intent_pattern,reflex_code)->hash`.
Native adapt:
- `src/autonomy/reflex.ts`: `registerReflex(intent:string,code:string):hash`, `matchReflex(intent:string):string|null` backed by `.muse/reflex.json` (not `offline_intents.db`). Exact mirror of `test_reflexes.db` behavior, JSON file to stay light.
- `compute_res/core/broker.py,orchestration/kernel.py,ipc_bus.py,workflow.py` → reference only, DO NOT boot ZeroMQ `ROUTER/DEALER` on Termux. Replace with `bus.ts` queue when local.
- `compute_res/sandbox/wasm_engine.py,wasm_hypervisor.py,runtime.rs` → load ONLY inside cleave-remote path (O4), never auto.
- Trigger: `runGoalLoop` executor checks `matchReflex(objective)` before model call — cache hit saves tokens. Miss → normal path.

### O4. Liquid cleave/snapback — `LiquidRuntime/src_py/` → `src/engine/liquid.ts` (new)
Sources (all stubs verified `print`-only, keep filenames, fill TS bodies):
- `src_py/telemetry.py::SpatialTracker.log_execution(node_id,duration)`, `PhysicsEngine.update_coordinates`
- `src_py/cleaver.py::SwarmCleaver(db_conn).check_distances/cleave_node`
- `src_py/proxy_injector.py::ASTProxyBridge(node_id,remote_url).invoke_remote`
- `src_py/watchdog.py::ElasticSnapback.ping_worker/fallback_to_local`
- `test_liquid_runtime.py` 5-scenario sequence is the spec.
Native adapt:
- `src/engine/liquid.ts`: `logExecution(nodeId,ms)` → `appendTrace` + `Spatial.pushHot` when `ms>500 twice`. `checkDistances():string[]` reads `spatial.ts` drift>1000. `cleaveNode(id)` writes `proxy_<id>.ts` stub that tries `gateway/http.ts` fetch with 2s timeout, catch `Connection refused` → `fallbackToLocal(id)` (delete import, restore local). Mirrors Scenario 4-6.
- `src_ts/*.ts` parity files → merge, do not keep separate.
- Trigger ONLY: `workflow.json {"action":"cleave","target":"<node>","status":"pending"}` OR `muse-ts exec --cleave <node>`. No auto-cleave loop. Child fetch killed on done.

### O5. Swarm mind — `A2A-Swarm/src/` → `src/bridge/swarm.ts` (new)
Sources:
- `src/envelope.py::ENVELOPE_SCHEMA,pack_envelope/unpack_envelope`, types `JOIN,LEAVE,GROUP_PING,PUBLISH,TASK,ACK,RESULT,PING,CFP,BID,AWARD,ROUTE,PROPOSAL,VOTE,CONSENSUS_REACHED`, retry: 2s ACK timeout, 3-5 resends, dedup by `message_id`
- `src/udp_node.py::UDPNode(broadcast_cfp...),NodeProtocol`, Ed25519 sign, `liveness_map,seen_messages,active_bids,pending_tasks,shadow_bridges,active_votes`
- `src/registry.py::registry.db` tables `groups,registry,node_keys,tasks` WAL
- `src/task_injector.py::process_udp_payload`, `src/cli_bridge.py::execute_cli`, `src/persona.py::inject_persona`, `env-tools/llm_bridge.py`
Native adapt:
- `src/bridge/swarm.ts`: verbatim TS port of `ENVELOPE_SCHEMA` + `pack/unpack`. UDP via `node:dgram`, bind `127.255.255.255:9999` (Android blocks `255.255.255.255`), `node:crypto` Ed25519 lazy import. Registry merged to `.muse/swarm.json` (not `registry.db`) to keep CWD-bound single-file rule.
- `task_injector` chain → call existing `WorkspaceTools` + `MetaChatClient` from `tui.ts`, not new executor.
- Socket opens ONLY inside `runSwarm(task)` and `close()` on `CONSENSUS_REACHED` or 5s timeout. Follows `cli/watch.ts` cleanup pattern.
- Trigger ONLY: `muse-ts exec --swarm "task"` OR `workflow.json action:"swarm"`. Verify via existing `A2A-Swarm/test_bidding.py,test_voting.py` logic ported to `tests/swarm.test.mjs` single-run.

### O6. Sync math + dedup — `HealingNodes/THEORY.md` + `SentenceX/x_core.py` → `src/bridge/sync.ts` + `src/core/context-manager.ts`
Sources:
- `HealingNodes/THEORY.md::theta_i=2*pi*i/N, Capture Time+500ms, jitter buffer` (host/client WebSocket audio NOT ported)
- `SentenceX/x_core.py::XCore.find_x(s1,s2)` + `_clean_sentence` (lower/punct/strip stopwords)
Native adapt:
- `src/bridge/sync.ts`: `slotMs(N)=500/N`, `execAt(syncUnixMs,i,N)=syncUnixMs+i*slotMs`. Orchestrator emits absolute time, workers execute locally (like Web Audio synth, not stream). Absorbs Termux jitter, prevents conflicting writes.
- `find_x` → `src/core/context-manager.ts::intersect(a,b)` pure fn for `PROPOSAL/VOTE` merge (`>50%` jury) + `memory.ts` dedup. Zero deps.
- Triggers: only inside `swarm.ts` vote path.

### O7. Onboard + version — `SyntyCode/` + `polymath-jage/` → `src/services/architect.ts` + `jage` bridge
Sources:
- `SyntyCode/syntycode/architect_extractor.py::extract_architect_context`, `decoder.py::DynamicFormatter`, `parsers/*`
- `polymath-jage/bin/jage.js`, `src/core/parser.js,snapshots.js,objects.js,levenshtein.js,graph.js`, `src/commands/push.js,revert.js`
Native adapt:
- `src/services/architect.ts`: `onboardDir(dir)` single-thread `fd` walk, skeleton via regex strip (TS port of `ast.unparse` skeleton), writes to NodeOS graph via `nodeos` CLI if present, else `.muse/graph.json`. Target <30s.
- Jage: `findBinary("jage")` then `spawn("jage",["revert","node",...])` only on `.js/.ts` change. No resident `daemon.js`.
- `advanced-ideas/hyperbolic_db_blueprint.md,cognitive_load_balancer.md,epigenetic_crypto_blueprint.md` → design refs for Phase 2, no code now.

## 3. Impl Phases (native, lightweight, verifiable)

Phase 0 — Bus + spatial skeleton (1-2d):
1. Create `src/engine/bus.ts`, `src/engine/spatial.ts` (zero-dep, lazy).
2. Extend `src/capabilities/nodeos.ts` with `blastRadio(file)`, `ghostNeighbors(file)` wrappers around `spawnSync nodeos -c`.
3. Extend `src/core/context-manager.ts` with `intersect()`.
4. Verify: `npm run typecheck`, `node --test tests/tui-nanos.test.mjs` (single), `muse-ts status`.

Phase 1 — Reflex + liquid telemetry (2-3d):
1. Create `src/autonomy/reflex.ts` (`.muse/reflex.json`), hook into `src/autonomy/loop.ts` executor pre-check.
2. Create `src/engine/liquid.ts::logExecution/updateCoordinates` wired to `kernel/trace.ts`.
3. Verify: `node --test tests/tui-slash.test.mjs`, manual `exec --json "test reflex"`.

Phase 2 — Cleave/snapback bodies (3-5d):
1. Fill `liquid.ts::checkDistances/cleaveNode/fallbackToLocal` + `proxy_<id>.ts` gen.
2. Gate by `workflow.json action:"cleave"`.
3. Verify: kill remote → local fallback, `daemon.log` shows zero downtime.

Phase 3 — Swarm bridge on-demand (1w):
1. Create `src/bridge/swarm.ts`, `src/bridge/sync.ts`.
2. UDP open/close only in run, `127.255.255.255:9999`, sequential bids, `XCore` merge, `theta` slots.
3. Verify: `tests/swarm.test.mjs` single-run, 2-proc alpha/beta.

Phase 4 — LMK hardening:
1. Every organ writes `writeLmkSnapshot` per turn, atomic `bus.json/swarm.json/reflex.json` writes.
2. Adaptive poll 1s→5s, `for...of` only, no `Promise.all`, no docker/proot.
3. Full `npm run typecheck` + QA analyzer if present.

## 4. Resource Budget (enforced)

- Idle `muse-ts` TUI: 1 Node proc, ~20-35MB, 0% CPU (no poll loop unless `watch`).
- `watch`: single `fs.watchFile` 5s idle, burst <2s on save.
- Active organ: short-lived `await import()` + `spawnSync`, killed on done. Never parallel.
- Forbidden auto-run: `nodeos -d` boot (only via `runInit`/hook), `jage daemon.js`, UDP listen, ZeroMQ, Wasmtime, `docker`, `tsc -w`, full `pytest`, unbounded `find/grep`.

## 5. Plan File Dir

This file: `~/Projects/muse-cli-agent/ORGAN_INTEGRATION_BLUEPRINT.md`
Next files (not yet created, await approval):
- `~/Projects/muse-cli-agent/src/engine/bus.ts`
- `~/Projects/muse-cli-agent/src/engine/spatial.ts`
- `~/Projects/muse-cli-agent/src/engine/liquid.ts`
- `~/Projects/muse-cli-agent/src/autonomy/reflex.ts`
- `~/Projects/muse-cli-agent/src/bridge/swarm.ts`
- `~/Projects/muse-cli-agent/src/bridge/sync.ts`
- `~/Projects/muse-cli-agent/src/services/architect.ts`
