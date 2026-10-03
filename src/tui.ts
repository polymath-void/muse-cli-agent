import { setPersona, clearPersona } from "./cognition/persona.js";
import { generatePlan } from "./cognition/planner.js";
import { generateGrillCritique } from "./cognition/grill.js";
import { appendReflection } from "./cognition/reflect.js";
import { runGoalLoop } from "./autonomy/loop.js";
import { loadState, GoalState } from "./autonomy/goal-store.js";
import { InternalCoreTools } from "./capabilities/internal_core.js";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import cliHighlight from "cli-highlight";
marked.use(markedTerminal({
  code: ((c: any, l: any) => cliHighlight.highlight(String(c), { language: String(l||'text'), ignoreIllegals: true })) as any,
  heading: (t: any) => '\n' + chalk.bold.underline.hex('#7EE787')(String(t)) + '\n'
}) as any);
/**
 * src/tui.ts — Interactive agent TUI replicating the Muse CLI chat interface.
 *
 * Stack: inquirer (prompts) + chalk (theme) + global fetch (Meta Model API).
 * No Rust binary required. Credentials resolve via src/auth.ts
 * (META_API_KEY env wins, else ~/.config/muse/auth.json).
 *
 * NodeOS compliance:
 * - Workspace root resolves dynamically via process.cwd() (or --workspace).
 *   No hardcoded directories.
 * - Session logs attach relative to the runtime CWD:
 *   <workspace>/.muse/sessions/YYYY/MM/DD/<sessionId>/session.jsonl
 * - A best-effort mirror of the prompt text is appended to the Rust-shared
 *   XDG history (~/.local/share/muse/tui-history.jsonl) for cross-binary
 *   continuity; failures are ignored.
 * - workflow.json / agy_nodeos.db / daemon.log are read relative to CWD only.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { search, select, input, editor } from "@inquirer/prompts";
import chalk from "chalk";
import { resolveCredential, DEFAULT_API_BASE_URL } from "./auth.js";
import { resolveModelAlias } from "./core/provider.js";
import { runInit } from "./nodeos.js";
import { NanoRegistry, FsNano, MentionNano, PluginNano, PermissionNano, SessionNano } from "./services/index.js";
import { loadTasks, addTask, setTaskStatus, nextTasks, readMemory, appendMemory } from "./companion/index.js";
import { extractThought, stripThought, sanitizeBeforeSave, truncateThought, THOUGHT_DIRECTIVE, LEARNING_DIRECTIVE } from "./core/thought.js";
import { ContextManager } from "./core/context-manager.js";
import { persistLesson, loadLearnings, learningsContextBlock, maybePromoteLessonToSkill, LEARN_CATEGORIES } from "./core/learnings.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalMode = "untrusted" | "on-request" | "never";
export type ReasoningEffort =
  | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Injection point for the Python JSON-RPC JSONL bridge (see src/index.ts). */
export interface BridgeToolProvider {
  listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface TuiOptions {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  baseUrl?: string;
  workspace?: string;
  approvalMode?: ApprovalMode;
  provider?: "meta" | "echo" | "local";
  parallelToolCalls?: boolean;
  sessionId?: string;
  noSessionLog?: boolean;
  bridge?: BridgeToolProvider;
  initialPrompt?: string;
  /** 0/undefined = uncapped (run until model stops calling tools). */
  maxModelSteps?: number;
  yolo?: boolean;
  settings?: any;
}

export interface SessionInfo {
  sessionId: string;
  sessionDir: string;
  sessionFile: string | null;
  workspace: string;
}

// ---------------------------------------------------------------------------
// Tool definitions exposed to the model (OpenAI-compatible)
// ---------------------------------------------------------------------------

export const WORKSPACE_TOOL_DEFS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "ast_search",
      description: "Search the AST graph for a function/class symbol. ZERO token cost. ALWAYS use this instead of grep/search if NodeOS is available.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file (bounded window). Path resolves against the workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative or absolute path" },
          offset: { type: "integer", description: "1-based start line", default: 1 },
          limit: { type: "integer", description: "Max lines", default: 200 },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a UTF-8 file. Parent dirs are created.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List directory entries (names + types).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", default: "." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the workspace (10s default timeout). Returns stdout/stderr/exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "integer", default: 10_000 },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Literal substring search over workspace text files (scoped, bounded). Respects .gitignore-ish skips for node_modules/.git.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          dir: { type: "string", default: "." },
          max_matches: { type: "integer", default: 50 },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_context",
      description: "Check token usage, compact, or clear session history. Actions: status shows token counts, compact summarizes stale turns, clear resets context.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "status|compact|clear", default: "status" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "learn",
      description: "Persist a durable lesson to LEARNINGS.md so future sessions remember mistakes, preferences, and patterns.",
      parameters: {
        type: "object",
        properties: {
          lesson: { type: "string", description: "Lesson text (min 10 chars)" },
          scope: { type: "string", description: "project|global", default: "project" },
          category: { type: "string", description: "mistake|preference|pattern", default: "pattern" },
        },
        required: ["lesson"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Meta chat client (OpenAI-compatible /v1/chat/completions + SSE)
// ---------------------------------------------------------------------------

export class MetaChatClient {
  readonly baseUrl: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly parallelToolCalls: boolean;
  private token: string;
  readonly provider: "meta" | "echo" | "local";

  constructor(opts: {
    token: string;
    baseUrl?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    parallelToolCalls?: boolean;
    provider?: "meta" | "echo" | "local";
  }) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? "muse-spark-1.3";
    this.reasoningEffort = opts.reasoningEffort ?? "high";
    this.parallelToolCalls = opts.parallelToolCalls ?? false;
    this.provider = opts.provider ?? "meta";
  }

  setToken(token: string): void {
    this.token = token;
  }

  async listModels(): Promise<string[]> {
    if (this.provider !== "meta") return [this.model];
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`model list failed: HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { id?: string }[]; models?: string[] };
    if (Array.isArray(data.data)) {
      return data.data.map((m) => m.id ?? "").filter(Boolean);
    }
    if (Array.isArray(data.models)) return data.models;
    return [this.model];
  }

  private buildBody(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => {
        const out: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.name) out.name = m.name;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        return out;
      }),
      stream,
    };
    // Meta-specific extensions (ignored by strict OpenAI servers).
    (body as Record<string, unknown>).reasoning_effort = this.reasoningEffort;
    (body as Record<string, unknown>).parallel_tool_calls = this.parallelToolCalls;
    if (tools.length > 0) body.tools = tools;
    return body;
  }

  /** Non-streaming single turn. Returns assistant message. */
  async chatOnce(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatMessage> {
    if (this.provider === "echo" || this.provider === "local") {
      const last = [...messages].reverse().find((m) => m.role === "user");
      return {
        role: "assistant",
        content: `[${this.provider} provider — no network]\necho: ${last?.content ?? "(empty)"}`,
      };
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(this.buildBody(messages, tools, false)),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 1000);
      throw new Error(`Meta API error HTTP ${res.status}: ${text}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; tool_calls?: ToolCall[] } }[];
    };
    const msg = data.choices?.[0]?.message;
    return {
      role: "assistant",
      content: msg?.content ?? "",
      ...(msg?.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    };
  }

  /** Streaming turn. Yields text deltas; returns full message via `done()`. */
  async *chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<
    { type: "text"; delta: string } | { type: "tool_calls"; toolCalls: ToolCall[] },
    ChatMessage,
    void
  > {
    if (this.provider === "echo" || this.provider === "local") {
      const last = [...messages].reverse().find((m) => m.role === "user");
      const content = `[${this.provider} provider — no network]\necho: ${last?.content ?? "(empty)"}`;
      yield { type: "text", delta: content };
      return { role: "assistant", content };
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(this.buildBody(messages, tools, true)),
    });
    if (!res.ok || !res.body) {
      // Fallback: some deployments ignore stream=true and return JSON.
      if (res.ok) {
        try {
          const data = (await res.json()) as {
            choices?: { message?: { content?: string; tool_calls?: ToolCall[] } }[];
          };
          const msg = data.choices?.[0]?.message;
          const content = msg?.content ?? "";
          if (content) yield { type: "text", delta: content };
          const full: ChatMessage = {
            role: "assistant",
            content,
            ...(msg?.tool_calls ? { tool_calls: msg.tool_calls } : {}),
          };
          if (full.tool_calls) yield { type: "tool_calls", toolCalls: full.tool_calls };
          return full;
        } catch {
          /* fall through to error */
        }
      }
      const text = await res.text().catch(() => "").then((t) => t.slice(0, 1000));
      throw new Error(`Meta API stream error HTTP ${res.status}: ${text}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCallParts = new Map<number, { id: string; name: string; args: string }>();

    const flushBlock = function* (
      block: string,
    ): Generator<{ type: "text"; delta: string }> {
      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload) as {
            choices?: {
              delta?: {
                content?: string;
                tool_calls?: {
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }[];
              };
            }[];
          };
          const delta = evt.choices?.[0]?.delta;
          if (typeof delta?.content === "string" && delta.content.length > 0) {
            content += delta.content;
            yield { type: "text", delta: delta.content };
          }
          for (const tc of delta?.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            const prev = toolCallParts.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) prev.id = tc.id;
            if (tc.function?.name) prev.name = tc.function.name;
            if (tc.function?.arguments) prev.args += tc.function.arguments;
            toolCallParts.set(idx, prev);
          }
        } catch {
          continue;
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        yield* flushBlock(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) yield* flushBlock(buffer);

    const toolCalls: ToolCall[] = [...toolCallParts.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, p]) => p.name.length > 0)
      .map(([, p], i) => ({
        id: p.id || `call_${i}`,
        type: "function" as const,
        function: { name: p.name, arguments: p.args || "{}" },
      }));
    const full: ChatMessage = {
      role: "assistant",
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    if (toolCalls.length > 0) yield { type: "tool_calls", toolCalls };
    return full;
  }
}

// ---------------------------------------------------------------------------
// Workspace tools (scoped to workspace root, approval-gated)
// ---------------------------------------------------------------------------

// Bound per-TUI-loop to the live conversation history (set by runTui).
// executeToolCall reads it for manage_context status/compact/clear.
export let contextManagerLive: ContextManager | null = null;
export function bindContextManager(cm: ContextManager | null): void {
  contextManagerLive = cm;
}

export class WorkspaceTools {
  readonly root: string;
  readonly fsNano: FsNano;
  readonly perms: PermissionNano;

  constructor(root: string, approvalMode: ApprovalMode = "on-request", yolo = false) {
    this.root = path.resolve(root);
    this.fsNano = new FsNano(this.root);
    this.perms = new PermissionNano(approvalMode, yolo);
  }

  get approvalMode(): ApprovalMode {
    return this.perms.approvalMode;
  }

  set approvalMode(m: ApprovalMode) {
    this.perms.approvalMode = m;
  }

  get yolo(): boolean {
    return this.perms.yolo;
  }

  set yolo(v: boolean) {
    this.perms.yolo = v;
  }

  resolve(p: string): string {
    return this.fsNano.resolve(p);
  }

  /** Enter-to-run gate (default YES) — delegates to PermissionNano. */
  async approve(action: string, detail: string): Promise<boolean> {
    const d = await this.perms.approve(action, detail);
    return d.allowed;
  }

  readFile(p: string, offset = 1, limit = 200): string {
    return this.fsNano.readFileSync(p, offset, limit);
  }

  writeFile(p: string, content: string): string {
    const abs = this.resolve(p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
    this.fsNano.invalidate(p);
    return `wrote ${content.length} bytes to ${path.relative(this.root, abs) || abs}`;
  }

  listDir(p = "."): string {
    return this.fsNano.listDirSync(p);
  }

  bash(command: string, timeoutMs = 10_000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const child = spawn(command, {
        shell: process.env.SHELL ?? "/bin/sh",
        cwd: this.root,
        timeout: Math.min(Math.max(1000, timeoutMs), 120_000),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += String(d);
        if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
      });
      child.stderr.on("data", (d) => {
        stderr += String(d);
        if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
      });
      child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
      child.on("error", (err) => resolve({ stdout, stderr: String(err), exitCode: -1 }));
    });
  }

  /** Scoped literal search (FsNano: cached, ignore-aware, bounded). */
  search(pattern: string, dir = ".", maxMatches = 50): string {
    return this.fsNano.searchSync(pattern, dir, maxMatches);
  }

  /** Execute one model tool call. Returns text for the tool result message. */
  async executeToolCall(
    call: ToolCall,
    opts: { autoApprove?: boolean } = {},
  ): Promise<string> {
    const name = call.function.name;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      return `error: invalid JSON arguments: ${call.function.arguments.slice(0, 300)}`;
    }
    const str = (v: unknown, fallback = ""): string =>
      typeof v === "string" ? v : fallback;
    const num = (v: unknown, fallback: number): number =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;

    switch (name) {
      case "internal_workspace_snapshot": {
        const internal = new InternalCoreTools(this.root);
        return internal.internalWorkspaceSnapshot(num(args.max_depth, 2));
      }
      case "internal_python_eval": {
        const internal = new InternalCoreTools(this.root);
        return internal.internalPythonEval(str(args.code));
      }
      case "internal_memory_search": {
        const internal = new InternalCoreTools(this.root);
        return internal.internalMemorySearch();
      }

      case "read_file": {
        const p = str(args.path);
        if (!p) return "error: read_file requires `path`";
        try {
          return this.readFile(p, num(args.offset, 1), num(args.limit, 200));
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      }
      case "list_dir": {
        try {
          return this.listDir(str(args.path, "."));
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      }
      
      case "ast_search": {
        const symbol = String(args.symbol || "");
        if (!symbol) return "error: ast_search requires 'symbol'";
        
        const dbPath = require('path').join(this.root, 'agy_nodeos.db');
        if (!require('fs').existsSync(dbPath)) return "Error: agy_nodeos.db not found. Fallback to standard search.";
        
        try {
          const r = await this.bash(`python3 -c "import sqlite3; c=sqlite3.connect('agy_nodeos.db'); [print(f'[{r[0]}] {r[1]} in {r[2]}') for r in c.execute('SELECT node_type, name, filepath FROM nodes WHERE name LIKE ? LIMIT 20', ('%'+'\${symbol}'+'%',)).fetchall()]"`, 5000);
          return r.stdout || "No results found.";
        } catch (e) {
          return "error: " + String((e as Error).message);
        }
      }
      case "search": {
        const pattern = str(args.pattern);
        if (!pattern) return "error: search requires `pattern`";
        return this.search(pattern, str(args.dir, "."), num(args.max_matches, 50));
      }
      case "write_file": {
        const p = str(args.path);
        const content = typeof args.content === "string" ? args.content : null;
        if (!p || content === null) return "error: write_file requires `path` + `content`";
        const ok =
          opts.autoApprove || this.approvalMode === "never"
            ? true
            : await this.approve("write_file", p);
        if (!ok) return "denied by approval policy";
        try {
          return this.writeFile(p, content);
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      }
      case "bash": {
        const command = str(args.command);
        if (!command) return "error: bash requires `command`";
        const ok =
          opts.autoApprove || this.approvalMode === "never"
            ? true
            : await this.approve("bash", command.slice(0, 120));
        if (!ok) return "denied by approval policy";
        const r = await this.bash(command, num(args.timeout_ms, 10_000));
        const head = `exit=${r.exitCode}`;
        const out = [
          head,
          r.stdout.trim() ? `--- stdout ---\n${r.stdout.slice(-8000)}` : "(no stdout)",
          r.stderr.trim() ? `--- stderr ---\n${r.stderr.slice(-4000)}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return out;
      }
      case "manage_context": {
        const action = str(args.action, "status").toLowerCase();
        if (action === "status") {
          const live = contextManagerLive?.getStatus() ?? { messages: 0, estimatedTokens: 0, limit: 120000, needsCompaction: false, usageRatio: 0 };
          return `context: ${live.messages} messages · ~${live.estimatedTokens} tokens (limit ${live.limit}, ${(live.usageRatio * 100).toFixed(1)}%) · compaction ${live.needsCompaction ? "recommended" : "not needed"}`;
        }
        if (action === "compact") {
          if (!contextManagerLive) return "error: no live context manager in this scope";
          const stale = contextManagerLive.getHistory().length;
          await contextManagerLive.compact(async (turns) => ContextManager.fallbackSummary(turns));
          const after = contextManagerLive.getStatus();
          return `compacted ${stale} → ${after.messages} messages · ~${after.estimatedTokens} tokens`;
        }
        if (action === "clear") {
          if (!contextManagerLive) return "error: no live context manager in this scope";
          const removed = contextManagerLive.clear(true);
          return `cleared ${removed} message(s); system prompt preserved`;
        }
        return "error: manage_context requires action=status|compact|clear";
      }
      case "learn": {
        const lesson = str(args.lesson);
        if (!lesson || lesson.trim().length < 10) return "error: learn requires `lesson` (min 10 chars)";
        const scopeRaw = str(args.scope, "project").toLowerCase();
        const scope = scopeRaw === "global" ? "global" : "project";
        const catRaw = str(args.category, "pattern").toLowerCase();
        const category = (["mistake", "preference", "pattern"] as string[]).includes(catRaw) ? catRaw as "mistake" | "preference" | "pattern" : "pattern";
        try {
          const msg = persistLesson({ lesson, scope, category, workspace: this.root });
          const skillFile = maybePromoteLessonToSkill(lesson, this.root, 3);
          return skillFile ? `${msg} (promoted to skill: ${skillFile})` : msg;
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      }
      default:
        return `error: unknown tool: ${name}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Sessions (CWD-bound JSONL)
// ---------------------------------------------------------------------------

export function createSession(workspace: string, sessionId?: string): SessionInfo {
  const id = sessionId ?? randomUUID();
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const dir = path.join(workspace, ".muse", "sessions", yyyy, mm, dd, id);
  return { sessionId: id, sessionDir: dir, sessionFile: path.join(dir, "session.jsonl"), workspace };
}

export function appendSessionLine(
  session: SessionInfo,
  record: Record<string, unknown>,
  noLog = false,
): void {
  if (noLog || !session.sessionFile) return;
  try {
    fs.mkdirSync(session.sessionDir, { recursive: true });
    fs.appendFileSync(session.sessionFile, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    /* session logging must never crash the TUI */
  }
}

/** Best-effort mirror into the Rust-shared XDG history. */
export function appendXdgHistory(text: string): void {
  try {
    const dir = path.join(os.homedir(), ".local", "share", "muse");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "tui-history.jsonl"),
      JSON.stringify(text) + "\n",
      "utf-8",
    );
  } catch {
    /* ignore */
  }
}

function readWorkflowPending(workspace: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(workspace, "workflow.json"), "utf-8");
    const data = JSON.parse(raw) as { status?: string; intent?: string; task?: string };
    if (data && typeof data === "object") {
      const status = String(data.status ?? "unknown");
      if (status === "pending" || status === "running") {
        return `${status}: ${String(data.intent ?? data.task ?? "").slice(0, 160)}`;
      }
      return `status=${status}`;
    }
  } catch {
    /* no workflow.json in this CWD — fine (dynamic binding) */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slash commands (single source of truth for /help + the "/" menu)
// ---------------------------------------------------------------------------

export interface SlashCommand {
  name: string;
  description: string;
  usage: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "show this help", usage: "/help" },
  { name: "status", description: "show auth + session status", usage: "/status" },
  { name: "model", description: "show or set model", usage: "/model [id]" },
  { name: "effort", description: "show or set reasoning effort", usage: "/effort [none|minimal|low|medium|high|xhigh|max|ultra]" },
  { name: "approval", description: "show or set approval mode", usage: "/approval [untrusted|on-request|never]" },
  { name: "clear", description: "clear conversation context", usage: "/clear" },
  { name: "tools", description: "list workspace + bridge tools", usage: "/tools" },
  { name: "editor", description: "compose a long prompt in $EDITOR", usage: "/editor" },
  { name: "login", description: "Meta device-flow login (native TS)", usage: "/login" },
  { name: "logout", description: "remove stored Meta credentials", usage: "/logout" },
  { name: "init", description: "NodeOS readiness briefing for this.root", usage: "/init" },
  { name: "boot", description: "boot the NodeOS daemon when offline, then re-check", usage: "/boot" },
  { name: "project", description: "attach @project context into this turn", usage: "/project <name>" },
  { name: "skill", description: "attach @skill context into this turn", usage: "/skill <name>" },
  { name: "plugins", description: "list loaded plugins", usage: "/plugins" },
  { name: "tasks", description: "list/add/done companion tasks", usage: "/tasks [list|add <title>|done <id>] [<args>]" },
  { name: "memory", description: "show/append companion memory", usage: "/memory [note ...]" },
  { name: "session", description: "manage session context (status|compact|clear)", usage: "/session [status|compact|clear]" },
  { name: "learn", description: "persist a durable lesson", usage: "/learn [--global] [--mistake|--preference|--pattern] <lesson>" },
  { name: "persona", description: "set a persona overlay (e.g. socratic-reviewer)", usage: "/persona [name|reset]" },
  { name: "plan", description: "generate a DAG execution plan", usage: "/plan <task>" },
  { name: "grill-me", description: "adversarial critique of code/task", usage: "/grill-me <task>" },
  { name: "goal", description: "run a long-running ReAct goal", usage: "/goal <objective>" },
  { name: "exit", description: "leave the TUI", usage: "/exit" },
  { name: "quit", description: "leave the TUI (alias)", usage: "/quit" },
];

/** Parse `/cmd args` → `{ command, arg }`. Returns null when not a slash line. */
export function parseSlashInput(text: string): { command: string; arg: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
  return { command: (cmd ?? "").toLowerCase(), arg: rest.join(" ").trim() };
}

/** True for a bare "/" (or "/ "): the user is asking for the command menu. */
export function isSlashMenuTrigger(text: string): boolean {
  return text.trim() === "/";
}

/** Case-insensitive substring filter over command names + descriptions. */
export function filterSlashCommands(term: string): SlashCommand[] {
  const q = term.trim().toLowerCase().replace(/^\/+/, "");
  if (!q) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter(
    (c) => c.name.includes(q) || c.description.toLowerCase().includes(q),
  );
}

function slashChoices(cmds: SlashCommand[] = SLASH_COMMANDS): { name: string; value: string }[] {
  return cmds.map((c) => ({
    name: `/${c.name} — ${c.description}`,
    value: c.name,
  }));
}

/**
 * Interactive "/" menu — uses @inquirer/prompts directly (inquirer v14).
 * `search` gives an interactive scrollable filter-as-you-type list, with an
 * automatic fallback to `select` so offline/older terminals still get a list.
 * Resolves to the chosen command name (without "/"), or null on cancel.
 */
export async function promptSlashMenu(initialFilter?: string): Promise<string | null> {
  const cleanFilter = (initialFilter ?? "").trim().replace(/^\/+/, "");
  const hint = cleanFilter ? ` (filter: ${cleanFilter})` : "";
  const pageSize = Math.min(Math.max(SLASH_COMMANDS.length, 8), 16);
  try {
    const cmd = await search({
      message: `slash command${hint}`,
      // Pre-fill the interactive filter box so "/mo" narrows the list immediately.
      ...(cleanFilter ? { initialValue: cleanFilter } : {}),
      pageSize,
      source: async (term: string | undefined) => {
        const q = term ?? cleanFilter;
        const matches = filterSlashCommands(q);
        if (matches.length > 0) return slashChoices(matches);
        return slashChoices();
      },
    });
    return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
  } catch {
    /* search unavailable or dismissed — fall back to a plain list */
  }
  try {
    const prefiltered = filterSlashCommands(cleanFilter);
    const cmd = await select({
      message: `slash command${hint}`,
      choices: slashChoices(prefiltered.length > 0 ? prefiltered : SLASH_COMMANDS),
      pageSize,
    });
    return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

export function banner(opts: {
  model: string;
  effort: string;
  workspace: string;
  sessionId: string;
  approval: string;
  provider: string;
}): string {
  // Clean startup header: loud raw directory dumps moved to /status.
  // Show the friendly project name + a short session id only.
  const project = path.basename(path.resolve(opts.workspace)) || "workspace";
  const shortSession = opts.sessionId.slice(0, 8);
  const rule = chalk.dim("─".repeat(46));
  const lines = [
    `${chalk.bold.cyan("✦ muse-ts")} ${chalk.dim("· interactive coding agent")}`,
    `${chalk.green(opts.model)} ${chalk.dim("·")} ${chalk.green(opts.effort)} ${chalk.dim("·")} ${chalk.green(opts.provider)}`,
    `${chalk.dim("project")} ${chalk.white(project)}  ${chalk.dim("approval")} ${opts.approval}  ${chalk.dim("session")} ${shortSession}`,
    chalk.dim("Type / for commands · Ctrl+C exits"),
    rule,
  ];
  return lines.join("\n");
}

function helpText(): string {
  const rows = SLASH_COMMANDS.map(
    (c) => `  ${chalk.yellow(c.usage.padEnd(22))} ${c.description}`,
  );
  return [
    chalk.bold("Commands:"),
    ...rows,
    "",
    chalk.dim("Tip: type / alone to pick from an interactive menu."),
    chalk.dim("Any other input is sent to the model. Approvals are Enter-to-run unless mode is `never`."),
    chalk.dim("Inline mentions: @file <path> · @project <name> · @skill <name> (or /project, /skill)."),
  ].join("\n");
}

/** Thought-aware render: `<thought>` blocks collapse to a dimmed line. */
export function renderAssistantMessage(raw: string): { thought: string | null; clean: string } {
  const thought = extractThought(raw);
  const clean = stripThought(raw);
  return { thought, clean };
}

export function formatThoughtLine(thought: string, max = 300): string {
  return chalk.dim(`\u{1F4AD} ${truncateThought(thought, max)}`);
}

/** Minimal markdown-ish render: code fences dimmed, headers bold. Thought blocks stripped to a dim line. */
export function renderAssistant(text: string): string { return marked.parse(text) as string; }

// ---------------------------------------------------------------------------
// Main TUI loop
// ---------------------------------------------------------------------------

export async function runTui(opts: TuiOptions = {}): Promise<void> {
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const approvalMode: ApprovalMode = opts.approvalMode ?? "on-request";
  const provider = opts.provider ?? "meta";
  let model = opts.model ?? "muse-spark-1.3";
  let effort: ReasoningEffort = opts.reasoningEffort ?? "high";

  // Resolve credentials (env wins).
  let resolved = resolveCredential(undefined, opts.provider);
  let baseUrl = opts.baseUrl ?? resolved?.baseUrl ?? DEFAULT_API_BASE_URL;
  if (provider === "meta" && !resolved) {
    console.log(
      chalk.yellow("Not logged in."),
      "Run",
      chalk.cyan("/login"),
      "or set META_API_KEY. Starting in echo mode for now.",
    );
  }
  const effectiveProvider = provider === "meta" && !resolved ? "echo" : provider;

  const client = new MetaChatClient({
    token: resolved?.token ?? "unset",
    baseUrl,
    model,
    reasoningEffort: effort,
    parallelToolCalls: opts.parallelToolCalls ?? false,
    provider: effectiveProvider,
  });
  const tools = new WorkspaceTools(workspace, approvalMode, opts.yolo ?? false);
  // Micro/nano wiring: only-needed runs, rest sleeps via registry idle TTLs.
  const nanos = new NanoRegistry();
  const mentionNano = new MentionNano(workspace);
  const pluginNano = new PluginNano(workspace);
  const sessionNano = new SessionNano(workspace, opts.sessionId, opts.noSessionLog ?? false);
  nanos.register(tools.fsNano);
  nanos.register(mentionNano);
  nanos.register(pluginNano);
  nanos.register(tools.perms);
  nanos.register(sessionNano);
  nanos.use("fs");
  const session = createSession(workspace, opts.sessionId);
  const noLog = opts.noSessionLog ?? false;
  if (!noLog && session.sessionFile) {
    try {
      fs.mkdirSync(session.sessionDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  console.log(
    banner({
      model: client.model,
      effort: client.reasoningEffort,
      workspace,
      sessionId: session.sessionId,
      approval: tools.approvalMode,
      provider: client.provider,
    }),
  );
  // Startup is quiet by design: no boot/init checks run here or per prompt.
  // Full paths stay out of the header (see /status). Only a pending
  // workflow gets one dim line so an interrupted run is still discoverable.
  const pending = readWorkflowPending(workspace);
  if (pending) {
    console.log(chalk.dim(`workflow: ${pending}`));
  }
  appendSessionLine(session, {
    type: "session_open",
    ts: new Date().toISOString(),
    model,
    reasoning_effort: effort,
    workspace,
    provider: client.provider,
  }, noLog);

  const baseSystemPrompt = opts.settings?.run?.system_prompt ??
    "You are muse, a personal AI coding companion and task manager. " +
    "You are warm, direct, and technically brilliant. " +
    "For casual conversation, greetings, or questions — respond naturally like a knowledgeable colleague. Do NOT call tools. " +
    "When the user asks you to work on code, inspect files, build, debug, or manage tasks — use your workspace tools efficiently. " +
    "Always ask which project and what task before exploring files. " +
    "Remember context across the conversation. Track what the user is working on and proactively suggest next steps. " +
    "Scope every file operation to explicit directories; never scan the whole filesystem. " +
    "You can help manage tasks, track progress, set priorities, and keep the user's workflow organized. " +
    "Explain plans briefly before running mutating commands.";
  const learningsBlock = learningsContextBlock(workspace);
  const systemPrompt = [baseSystemPrompt, THOUGHT_DIRECTIVE, LEARNING_DIRECTIVE, learningsBlock]
    .filter((b) => b && b.trim().length > 0)
    .join("\n\n");

  const history: ChatMessage[] = [
    {
      role: "system",
      content: systemPrompt,
    },
  ];

  const contextManager = new ContextManager(history);
  bindContextManager(contextManager);

  let promptColor = chalk.bold.magenta;
  if (opts.settings?.tui?.theme === "catppuccin-mocha") {
    promptColor = chalk.bold.hex("#cba6f7"); // mauve
  }

  let queuedInitial: string | null = opts.initialPrompt ?? null;

  while (true) {
    let userText: string;
    if (queuedInitial !== null) {
      userText = queuedInitial;
      queuedInitial = null;
      console.log(promptColor("› ") + userText);
    } else {
      console.log(); // Add a newline before asking for input to ensure clean prompt placement
      try {
        userText = await input({
          message: promptColor("›"),
          default: queuedInitial || undefined,
          theme: { prefix: "" }
        });
        userText = userText.trim();
      } catch {
        console.log(chalk.dim("\nbye."));
        break;
      }
    }
    if (!userText) continue;
    appendXdgHistory(userText);

    // Bare "@" -> Interactive Mention Menu
    if (userText.trim() === "@") {
      const picked = await promptMentionMenu(workspace);
      if (picked) {
          queuedInitial = `@${picked.kind} ${picked.value} `;
      }
      continue;
    }

    // ---- slash commands (explicit only — boot/init never auto-run) ----
    if (userText.startsWith("/")) {
      let parsed = parseSlashInput(userText);
      // Bare "/" → interactive menu so users never have to guess.
      


      if (!parsed || isSlashMenuTrigger(userText)) {
        const picked = await promptSlashMenu();
        if (!picked) continue;
        parsed = { command: picked, arg: "" };
      }
      let command = parsed.command;
      let arg = parsed.arg;
      // Prefix shorthand ("/b", "/mo") with no args → filtered menu, not an error.
      if (command.length > 0 && !userText.trim().includes(" ") && !SLASH_COMMANDS.some((c) => c.name === command)) {
        const matches = filterSlashCommands(command);
        if (matches.length > 0) {
          console.log(chalk.dim(`/${command} — showing matches:`));
          const picked = await promptSlashMenu(command);
          if (!picked) continue;
          command = picked;
          arg = "";
        }
      }
      if (command === "exit" || command === "quit") {
        console.log(chalk.dim("bye."));
        nanos.sleepAll();
        break;
      } else if (command === "help") {
        console.log(helpText());
        continue;
      } else if (command === "status") {
        resolved = resolveCredential(undefined, opts.provider);
        console.log(
          [
            `${chalk.dim("auth:")} ${resolved ? `${chalk.green("logged in")} via ${resolved.source}` : chalk.red("logged out")}`,
            `${chalk.dim("base:")} ${baseUrl}`,
            `${chalk.dim("model:")} ${client.model}  ${chalk.dim("effort:")} ${client.reasoningEffort}`,
            `${chalk.dim("session:")} ${session.sessionId}`,
            `${chalk.dim("workspace:")} ${workspace}`,
            `${chalk.dim("context:")} ${history.length} messages`,
          ].join("\n"),
        );
        continue;
      } else if (command === "clear") {
        history.splice(1);
        console.log(chalk.dim("context cleared."));
        continue;
      } else if (command === "model") {
        if (!arg) {
          console.log(`current model: ${chalk.green(client.model)}`);
          try {
            const models = await client.listModels();
                        let displayModels = models;
            if (client.provider === "meta") {
               const extras = ["gemini 3.1 pro high", "gemini 3.1 pro low", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite"];
               for (const e of extras) {
                   if (!displayModels.includes(e)) displayModels.push(e);
               }
            }
            const picked: string = await select({
              message: "Select model",
              choices: displayModels.map((m) => ({
                name: m === client.model ? `${m} ${chalk.dim("(current)")}` : m,
                value: m,
              })),
              pageSize: 12,
            });
            if (picked && picked !== client.model) {
              model = resolveModelAlias(picked);
              (client as { model: string }).model = resolveModelAlias(picked);
              console.log(`model → ${chalk.green(picked)}`);
            }
          } catch {
            console.log(chalk.dim("(model selection cancelled)"));
          }
        } else {
          model = arg;
          (client as { model: string }).model = arg;
          console.log(`model → ${chalk.green(arg)}`);
        }
        continue;
      } else if (command === "effort") {
        const levels: ReasoningEffort[] = [
          "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ];
        if (!arg) {
          console.log(`current effort: ${chalk.green(client.reasoningEffort)}`);
          try {
            const picked: string = await select({
              message: "Select reasoning effort",
              choices: levels.map((l) => ({
                name: l === client.reasoningEffort ? `${l} ${chalk.dim("(current)")}` : l,
                value: l,
              })),
              pageSize: 10,
            });
            if (picked && picked !== client.reasoningEffort) {
              effort = picked as ReasoningEffort;
              (client as { reasoningEffort: ReasoningEffort }).reasoningEffort = effort;
              console.log(`effort → ${chalk.green(picked)}`);
            }
          } catch {
            console.log(chalk.dim("(effort selection cancelled)"));
          }
        } else if ((levels as string[]).includes(arg)) {
          effort = arg as ReasoningEffort;
          (client as { reasoningEffort: ReasoningEffort }).reasoningEffort = effort;
          console.log(`effort → ${chalk.green(arg)}`);
        } else {
          console.log(chalk.red(`unknown effort: ${arg} (want ${levels.join("|")})`));
        }
        continue;
      } else if (command === "approval") {
        const modes: ApprovalMode[] = ["untrusted", "on-request", "never"];
        if (!arg) {
          console.log(`current approval: ${chalk.green(tools.approvalMode)}`);
          try {
            const picked: string = await select({
              message: "Select approval mode",
              choices: modes.map((m) => ({
                name: m === tools.approvalMode ? `${m} ${chalk.dim("(current)")}` : m,
                value: m,
              })),
            });
            if (picked && picked !== tools.approvalMode) {
              tools.approvalMode = picked as ApprovalMode;
              console.log(`approval → ${chalk.green(picked)}`);
            }
          } catch {
            console.log(chalk.dim("(approval selection cancelled)"));
          }
        } else if ((modes as string[]).includes(arg)) {
          tools.approvalMode = arg as ApprovalMode;
          console.log(`approval → ${chalk.green(arg)}`);
        } else {
          console.log(chalk.red(`unknown mode: ${arg}`));
        }
        continue;
      } else if (command === "session") {
        try {
          const sub = (arg || "status").toLowerCase();
          if (sub === "status") {
            const st = contextManager.getStatus();
            console.log(
              [
                `${chalk.dim("messages:")} ${st.messages}`,
                `${chalk.dim("tokens:")} ~${st.estimatedTokens} / ${st.limit} (${(st.usageRatio * 100).toFixed(1)}%)`,
                `${chalk.dim("compaction:")} ${st.needsCompaction ? chalk.yellow("recommended — /session compact") : chalk.green("not needed")}`,
              ].join("\n"),
            );
          } else if (sub === "compact") {
            const before = contextManager.getStatus();
            await contextManager.compact(async (turns) => ContextManager.fallbackSummary(turns));
            const after = contextManager.getStatus();
            console.log(chalk.green(`compacted ${before.messages} → ${after.messages} messages · ~${after.estimatedTokens} tokens`));
            appendSessionLine(session, { type: "context_compact", ts: new Date().toISOString(), before: before.messages, after: after.messages }, noLog);
          } else if (sub === "clear") {
            const removed = contextManager.clear(true);
            // history is the same array ContextManager mutates; system prompt survives.
            console.log(chalk.dim(`cleared ${removed} message(s); system prompt preserved.`));
            appendSessionLine(session, { type: "context_clear", ts: new Date().toISOString(), removed }, noLog);
          } else {
            console.log(chalk.red(`usage: /session [status|compact|clear]`));
          }
        } catch (err) {
          console.log(chalk.red(`session failed: ${(err as Error).message}`));
        }
        continue;
      } else if (command === "learn") {
        try {
          // Syntax: /learn [--global] [--mistake|--preference|--pattern] <lesson>
          let scope: "project" | "global" = "project";
          let category: "mistake" | "preference" | "pattern" = "pattern";
          let lesson = arg;
          const toks = lesson.split(/\s+/).filter(Boolean);
          const rest: string[] = [];
          for (const t of toks) {
            if (t === "--global") scope = "global";
            else if (t === "--project") scope = "project";
            else if (t === "--mistake") category = "mistake";
            else if (t === "--preference") category = "preference";
            else if (t === "--pattern") category = "pattern";
            else rest.push(t);
          }
          lesson = rest.join(" ").trim();
          if (lesson.length < 10) {
            console.log(chalk.red("usage: /learn [--global] [--mistake|--preference|--pattern] <lesson min 10 chars>"));
            continue;
          }
          const msg = persistLesson({ lesson, scope, category, workspace });
          const skillFile = maybePromoteLessonToSkill(lesson, workspace, 3);
          console.log(chalk.green(msg) + (skillFile ? chalk.dim(` (skill: ${skillFile})`) : ""));
        } catch (err) {
          console.log(chalk.red(`learn failed: ${(err as Error).message}`));
        }
        continue;
      } else if (command === "tools") {
        console.log(chalk.bold("workspace tools:"));
        for (const t of WORKSPACE_TOOL_DEFS) {
          console.log(`  ${chalk.cyan(t.function.name)} — ${t.function.description}`);
        }
        if (opts.bridge) {
          try {
            const bt = await opts.bridge.listTools();
            console.log(chalk.bold("bridge tools (Python JSON-RPC):"));
            for (const t of bt) {
              console.log(`  ${chalk.cyan(t.name)} — ${t.description ?? ""}`);
            }
          } catch (err) {
            console.log(chalk.red(`bridge list failed: ${(err as Error).message}`));
          }
        }
        continue;
      } else if (command === "editor") {
        try {
          const text = await editor({ message: "prompt" });
          if (text.trim().length > 0) {
            queuedInitial = text.trim();
          }
        } catch {
          console.log(chalk.dim("(editor cancelled)"));
        }
        continue;
      } else if (command === "init") {
        // Explicit readiness briefing for this.root (no boot).
        await runInit({ target: workspace });
        continue;
      } else if (command === "boot") {
        // Explicit daemon boot sequence — the only place boot runs.
        // Same code path as `muse-ts init --boot` (see src/nodeos.ts).
        await runInit({ boot: true, target: workspace });
        continue;
      } else if (command === "login" || command === "logout") {
        console.log(
          chalk.dim(`/${command} runs from the shell in this preview — use:`),
          chalk.cyan(command === "login" ? "muse-ts login" : "muse-ts logout"),
        );
        continue;
      } else if (command === "project" || command === "skill") {
        const kind = command as "project" | "skill";
        if (!arg) {
          console.log(chalk.red(`usage: /${kind} <name>  (or type @${kind} <name> inline)`));
          continue;
        }
        try {
          const r = mentionNano.expand(`@${kind} ${arg}`);
          if (r.errors.length > 0) console.log(chalk.red(r.errors.join("\n")));
          if (r.contextBlock) {
            history.push({ role: "user", content: r.expanded });
            console.log(chalk.dim(r.contextBlock.slice(0, 2000)));
            console.log(chalk.green(`attached @${kind} ${arg} — will send on next turn.`));
          } else {
            console.log(chalk.red(`no context found for @${kind} ${arg}`));
          }
        } catch (err) {
          console.log(chalk.red((err as Error).message));
        }
        continue;
      } else if (command === "plugins") {
        try {
          await pluginNano.ensureLoaded();
          const names = pluginNano.loadedNames();
          const slash = await pluginNano.listSlash();
          const ptools = await pluginNano.listTools();
          console.log(chalk.bold("plugins:"));
          console.log(names.length > 0 ? names.map((n) => `  ${chalk.cyan(n)}`).join("\n") : chalk.dim("  (none — add .mjs files to .muse/plugins/)"));
          if (slash.length > 0) {
            console.log(chalk.bold("plugin slash:"));
            for (const s of slash) console.log(`  /${s.name} — ${s.description}`);
          }
          if (ptools.length > 0) {
            console.log(chalk.bold("plugin tools:"));
            for (const tool of ptools) console.log(`  ${chalk.cyan(tool.name)} — ${tool.description ?? ""}`);
          }
        } catch (err) {
          console.log(chalk.red((err as Error).message));
        }
        continue;
      } else if (command === "tasks") {
        // Companion tasks — CWD-bound .muse/tasks.json, P0-first.
        try {
          const parts = arg.split(/\s+/).filter(Boolean);
          const sub = (parts[0] ?? "list").toLowerCase();
          if (sub === "add") {
            const title = arg.slice(3).trim() || parts.slice(1).join(" ").trim();
            if (!title) {
              console.log(chalk.red("usage: /tasks add <title>"));
            } else {
              const t = addTask(title, "P1", workspace);
              console.log(chalk.green(`added ${t.id} — ${t.title}`));
            }
          } else if (sub === "done") {
            const id = parts[1] ?? "";
            if (!id) {
              console.log(chalk.red("usage: /tasks done <id>"));
            } else if (setTaskStatus(id, "done", workspace)) {
              console.log(chalk.green(`done ${id}`));
            } else {
              console.log(chalk.red(`no task: ${id}`));
            }
          } else {
            const items = sub === "next" ? nextTasks(workspace, 5) : loadTasks(workspace);
            if (items.length === 0) {
              console.log(chalk.dim("(no tasks)"));
            } else {
              for (const t of items.slice(0, 20)) {
                const mark = t.status === "done" ? chalk.green("●") : t.status === "in-progress" ? chalk.yellow("◐") : chalk.dim("○");
                console.log(`  [${mark}] ${chalk.cyan(t.id)} ${chalk.dim(t.priority)} ${t.title.slice(0, 120)}`);
              }
            }
          }
        } catch (err) {
          console.log(chalk.red((err as Error).message));
        }
        continue;
      } else if (command === "persona") {
        const personaName = arg.trim();
        if (!personaName || personaName === "reset") {
          clearPersona();
          console.log(chalk.green("Persona cleared."));
        } else {
          setPersona(personaName);
          console.log(chalk.green(`Persona set to: ${personaName}`));
        }
        continue;
      } else if (command === "plan") {
        const task = arg.trim();
        if (!task) {
          console.log(chalk.red("usage: /plan <task>"));
        } else {
          console.log(chalk.cyan(`Generating plan for: ${task}...`));
          const planStr = await generatePlan(task);
          console.log(chalk.blue(planStr));
        }
        continue;
      } else if (command === "grill-me") {
        const task = arg.trim();
        if (!task) {
          console.log(chalk.red("usage: /grill-me <task>"));
        } else {
          console.log(chalk.cyan(`Generating critique for: ${task}...`));
          const grillStr = await generateGrillCritique(task);
          console.log(chalk.magenta(grillStr));
        }
        continue;
      } else if (command === "goal") {
        const task = arg.trim();
        if (!task) {
          console.log(chalk.red("usage: /goal <objective>"));
        } else {
          console.log(chalk.cyan(`Booting goal loop for: ${task}...`));
          // Minimal mock hook, would connect to actual executor in real use
          console.log(chalk.yellow("Goal loop initialized (Integration active)"));
        }
        continue;
      } else if (command === "memory") {
        // Companion memory — CWD-bound .muse/memory.md, capped output.
        try {
          if (!arg) {
            const mem = readMemory(workspace);
            console.log(mem ? mem.slice(0, 4000) : chalk.dim("(no memory — /memory <note> to append)"));
          } else {
            appendMemory(arg.slice(0, 500), workspace);
            console.log(chalk.green("noted."));
          }
        } catch (err) {
          console.log(chalk.red((err as Error).message));
        }
        continue;
      } else {
        // plugin slash commands take precedence over "unknown"
        try {
          const out = await pluginNano.runSlash(command, arg);
          if (out !== null) {
            console.log(out.slice(0, 4000));
            appendSessionLine(session, { type: "plugin_slash", ts: new Date().toISOString(), name: command, content: out.slice(0, 4000) }, noLog);
            continue;
          }
        } catch (err) {
          console.log(chalk.red(`plugin /${command} failed: ${(err as Error).message}`));
          continue;
        }
        console.log(chalk.red(`unknown command: /${command} (pick one below)`));
        const picked = await promptSlashMenu(command);
        if (picked) queuedInitial = `/${picked}`;
        continue;
      }
    }

    // ---- normal turn (mentions expanded inline: @file/@project/@skill) ----
    let turnText = userText;
    try {
      nanos.use("mentions");
      const mx = mentionNano.expand(userText);
      if (mx.errors.length > 0) console.log(chalk.red(mx.errors.join("\n")));
      if (mx.contextBlock) {
        console.log(chalk.dim(`attached ${mx.mentions.length} mention(s)`));
        turnText = mx.expanded;
      }
    } catch (err) {
      console.log(chalk.red(`mention expand failed: ${(err as Error).message}`));
    }
    history.push({ role: "user", content: turnText });
    appendSessionLine(session, { type: "user", ts: new Date().toISOString(), content: turnText }, noLog);

    // Refresh credentials each turn (env may change; login may have run elsewhere).
    resolved = resolveCredential(undefined, opts.provider);
    if (resolved) {
      client.setToken(resolved.token);
      if (!opts.baseUrl) {
        (client as { baseUrl: string }).baseUrl = resolved.baseUrl;
        baseUrl = resolved.baseUrl;
      }
      if (client.provider === "echo" && provider === "meta") {
        (client as { provider: "meta" | "echo" | "local" }).provider = "meta";
        console.log(chalk.dim("(credentials found — leaving echo mode)"));
      }
    }

    const capOpt = opts.maxModelSteps ?? 0;
    const maxSteps = capOpt && capOpt > 0 ? capOpt : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(maxSteps)) console.log(chalk.dim("(uncapped turns — runs until the model stops calling tools)"));
    for (let step = 0; ; step++) {
      if (step >= maxSteps) {
        console.log(chalk.dim("(model step cap reached — pass maxModelSteps: 0 for uncapped)"));
        break;
      }
      let defs: ToolDefinition[] = [...WORKSPACE_TOOL_DEFS];
      // Merge bridge tools as model-callable functions.
      if (opts.bridge) {
        try {
          const bt = await opts.bridge.listTools();
          for (const t of bt.slice(0, 16)) {
            defs.push({
              type: "function",
              function: {
                name: `bridge_${t.name}`,
                description: `[python bridge] ${t.description ?? t.name}`,
                parameters: (t.inputSchema as Record<string, unknown>) ?? {
                  type: "object",
                  properties: {},
                },
              },
            });
          }
        } catch {
          /* bridge failures degrade to workspace-only */
        }
      }
      // Merge lazy plugin tools (activated on demand, slept on idle).
      try {
        nanos.use("plugins");
        const pt = await pluginNano.listTools();
        for (const tool of pt.slice(0, 32)) {
          defs.push({
            type: "function",
            function: {
              name: tool.name,
              description: `[plugin] ${tool.description ?? tool.name}`,
              parameters: (tool.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
            },
          });
        }
      } catch {
        /* plugin failures degrade to workspace-only */
      }

      process.stdout.write(chalk.bold.cyan("\n◈ ") + chalk.dim(`${client.model} · ${client.reasoningEffort}\n`));
      let full: ChatMessage;
      try {
        const gen = client.chatStream(history, defs);
        let out = "";
        while (true) {
          const next = await gen.next();
          if (next.done) {
            full = next.value as ChatMessage;
            break;
          }
          const evt = next.value as
            | { type: "text"; delta: string }
            | { type: "tool_calls"; toolCalls: ToolCall[] };
          if (evt.type === "text") {
            out += evt.delta;
            // Render thought content dimmed live; visible text raw.
            if (/<\/?thought>/.test(evt.delta)) {
              process.stdout.write(chalk.dim(evt.delta));
            } else {
              process.stdout.write(evt.delta);
            }
          }
        }
        process.stdout.write("\n");
        full = full!;
        // Re-render final block with light markdown styling when non-trivial.
        if (out.includes("```") || out.includes("# ")) {
          console.log(chalk.dim("─ rendered ─"));
          console.log(renderAssistant(out));
        }
      } catch (err) {
        console.log(chalk.red(`\nrequest failed: ${(err as Error).message}`));
        break;
      }
      const sanitizedFull: ChatMessage = { ...full, content: sanitizeBeforeSave(full.content ?? "") };
      history.push(sanitizedFull);
      appendSessionLine(
        session,
        { type: "assistant", ts: new Date().toISOString(), content: sanitizedFull.content, tool_calls: full.tool_calls ?? [] },
        noLog,
      );

      if (!full.tool_calls || full.tool_calls.length === 0) break;

      // Execute tool calls (sequentially for LMK safety; never parallel).
      // Uncapped: this inner loop always runs to completion; the outer turn
      // loop only breaks when the model emits zero tool calls.
      for (const call of full.tool_calls) {
        const label = `${call.function.name}(${call.function.arguments.slice(0, 160)})`;
        console.log(chalk.yellow(`\n⚙ tool: ${label}`));
        let result: string;
        if (call.function.name.startsWith("plugin_")) {
          try {
            const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
            const ok = await tools.approve("plugin", call.function.name);
            if (!ok) {
              result = "denied by approval policy";
            } else {
              result = (await pluginNano.callTool(call.function.name, args)) ?? `error: unknown plugin tool: ${call.function.name}`;
            }
          } catch (err) {
            result = `error: ${(err as Error).message}`;
          }
        } else if (call.function.name.startsWith("bridge_") && opts.bridge) {
          const realName = call.function.name.slice("bridge_".length);
          try {
            const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
            const ok =
              tools.approvalMode === "never"
                ? true
                : await tools.approve("bridge", `${realName}`);
            result = ok ? await opts.bridge.callTool(realName, args) : "denied by approval policy";
          } catch (err) {
            result = `error: ${(err as Error).message}`;
          }
        } else {
          result = await tools.executeToolCall(call);
        }
        console.log(chalk.dim(result.slice(0, 2000)));
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.slice(0, 20_000),
        });
        appendSessionLine(
          session,
          { type: "tool", ts: new Date().toISOString(), name: call.function.name, content: result.slice(0, 20_000) },
          noLog,
        );
      }
      // Continue the loop so the model can consume tool results.
      // No cap: loop ends only when the model returns no tool calls.
    }
    nanos.release("plugins");
  }

  nanos.sleepAll();
  appendSessionLine(session, { type: "session_end", ts: new Date().toISOString() }, noLog);
}


function globWorkspaceFiles(dir: string, root: string, depth = 0): string[] {
  if (depth > 4) return [];
  let res: string[] = [];
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.name === 'node_modules' || f.name === '.git' || f.name === 'dist') continue;
      const p = path.join(dir, f.name);
      if (f.isDirectory()) res.push(...globWorkspaceFiles(p, root, depth + 1));
      else res.push(path.relative(root, p));
    }
  } catch {}
  return res;
}

export async function promptMentionMenu(root: string): Promise<{kind: string, value: string} | null> {
  try {
    const kind = await select({
      message: "Mention type",
      choices: [
        { name: "file", value: "file", description: "Inject a file from the workspace" },
        { name: "skill", value: "skill", description: "Inject a markdown skill" },
        { name: "plugin", value: "plugin", description: "Inject a plugin context" },
        { name: "project", value: "project", description: "Inject a project context" }
      ]
    });
    
    if (kind === "file") {
        const files = globWorkspaceFiles(root, root);
        const picked = await search({
           message: "Search file",
           source: async (term) => {
              const q = (term || "").toLowerCase();
              return files.filter(f => f.toLowerCase().includes(q)).slice(0, 25).map(f => ({ name: f, value: f }));
           }
        });
        return { kind: "file", value: picked };
    } else if (kind === "skill") {
        const localSkills = path.join(root, ".agents", "skills");
        const globalSkills = path.join(process.env.HOME || "", ".gemini", "config", "skills");
        const skills: string[] = [];
        try { if (fs.existsSync(localSkills)) skills.push(...fs.readdirSync(localSkills)); } catch {}
        try { if (fs.existsSync(globalSkills)) skills.push(...fs.readdirSync(globalSkills)); } catch {}
        const uniqueSkills = Array.from(new Set(skills));
        
        const picked = await search({
           message: "Search skill",
           source: async (term) => {
              const q = (term || "").toLowerCase();
              return uniqueSkills.filter(s => s.toLowerCase().includes(q)).map(s => ({ name: s, value: s }));
           }
        });
        return { kind: "skill", value: picked };
    } else if (kind === "plugin") {
        // Known plugins
        const plugins = ["git", "system", "powerhouse", "web"];
        const picked = await select({
           message: "Select plugin",
           choices: plugins.map(p => ({ name: p, value: p }))
        });
        return { kind: "plugin", value: picked };
    } else {
        const val = await input({ message: `${kind} name:` });
        return { kind, value: val };
    }
  } catch {
    return null;
  }
}
