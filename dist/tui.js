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
import inquirer from "inquirer";
import chalk from "chalk";
import { resolveCredential, DEFAULT_API_BASE_URL } from "./auth.js";
import { runInit } from "./nodeos.js";
// ---------------------------------------------------------------------------
// Tool definitions exposed to the model (OpenAI-compatible)
// ---------------------------------------------------------------------------
export const WORKSPACE_TOOL_DEFS = [
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
];
// ---------------------------------------------------------------------------
// Meta chat client (OpenAI-compatible /v1/chat/completions + SSE)
// ---------------------------------------------------------------------------
export class MetaChatClient {
    baseUrl;
    model;
    reasoningEffort;
    parallelToolCalls;
    token;
    provider;
    constructor(opts) {
        this.token = opts.token;
        this.baseUrl = (opts.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
        this.model = opts.model ?? "muse-spark-1.3";
        this.reasoningEffort = opts.reasoningEffort ?? "high";
        this.parallelToolCalls = opts.parallelToolCalls ?? false;
        this.provider = opts.provider ?? "meta";
    }
    setToken(token) {
        this.token = token;
    }
    async listModels() {
        if (this.provider !== "meta")
            return [this.model];
        const res = await fetch(`${this.baseUrl}/models`, {
            headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
        });
        if (!res.ok)
            throw new Error(`model list failed: HTTP ${res.status}`);
        const data = (await res.json());
        if (Array.isArray(data.data)) {
            return data.data.map((m) => m.id ?? "").filter(Boolean);
        }
        if (Array.isArray(data.models))
            return data.models;
        return [this.model];
    }
    buildBody(messages, tools, stream) {
        const body = {
            model: this.model,
            messages: messages.map((m) => {
                const out = { role: m.role, content: m.content };
                if (m.name)
                    out.name = m.name;
                if (m.tool_call_id)
                    out.tool_call_id = m.tool_call_id;
                if (m.tool_calls)
                    out.tool_calls = m.tool_calls;
                return out;
            }),
            stream,
        };
        // Meta-specific extensions (ignored by strict OpenAI servers).
        body.reasoning_effort = this.reasoningEffort;
        body.parallel_tool_calls = this.parallelToolCalls;
        if (tools.length > 0)
            body.tools = tools;
        return body;
    }
    /** Non-streaming single turn. Returns assistant message. */
    async chatOnce(messages, tools) {
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
        const data = (await res.json());
        const msg = data.choices?.[0]?.message;
        return {
            role: "assistant",
            content: msg?.content ?? "",
            ...(msg?.tool_calls ? { tool_calls: msg.tool_calls } : {}),
        };
    }
    /** Streaming turn. Yields text deltas; returns full message via `done()`. */
    async *chatStream(messages, tools) {
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
                    const data = (await res.json());
                    const msg = data.choices?.[0]?.message;
                    const content = msg?.content ?? "";
                    if (content)
                        yield { type: "text", delta: content };
                    const full = {
                        role: "assistant",
                        content,
                        ...(msg?.tool_calls ? { tool_calls: msg.tool_calls } : {}),
                    };
                    if (full.tool_calls)
                        yield { type: "tool_calls", toolCalls: full.tool_calls };
                    return full;
                }
                catch {
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
        const toolCallParts = new Map();
        const flushBlock = function* (block) {
            for (const line of block.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:"))
                    continue;
                const payload = trimmed.slice(5).trim();
                if (payload === "[DONE]")
                    continue;
                try {
                    const evt = JSON.parse(payload);
                    const delta = evt.choices?.[0]?.delta;
                    if (typeof delta?.content === "string" && delta.content.length > 0) {
                        content += delta.content;
                        yield { type: "text", delta: delta.content };
                    }
                    for (const tc of delta?.tool_calls ?? []) {
                        const idx = tc.index ?? 0;
                        const prev = toolCallParts.get(idx) ?? { id: "", name: "", args: "" };
                        if (tc.id)
                            prev.id = tc.id;
                        if (tc.function?.name)
                            prev.name = tc.function.name;
                        if (tc.function?.arguments)
                            prev.args += tc.function.arguments;
                        toolCallParts.set(idx, prev);
                    }
                }
                catch {
                    continue;
                }
            }
        };
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let sep;
            while ((sep = buffer.indexOf("\n\n")) !== -1) {
                const block = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                yield* flushBlock(block);
            }
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0)
            yield* flushBlock(buffer);
        const toolCalls = [...toolCallParts.entries()]
            .sort((a, b) => a[0] - b[0])
            .filter(([, p]) => p.name.length > 0)
            .map(([, p], i) => ({
            id: p.id || `call_${i}`,
            type: "function",
            function: { name: p.name, arguments: p.args || "{}" },
        }));
        const full = {
            role: "assistant",
            content,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        };
        if (toolCalls.length > 0)
            yield { type: "tool_calls", toolCalls };
        return full;
    }
}
// ---------------------------------------------------------------------------
// Workspace tools (scoped to workspace root, approval-gated)
// ---------------------------------------------------------------------------
export class WorkspaceTools {
    root;
    approvalMode;
    constructor(root, approvalMode = "on-request") {
        this.root = path.resolve(root);
        this.approvalMode = approvalMode;
    }
    resolve(p) {
        const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(this.root, p);
        const rel = path.relative(this.root, abs);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new Error(`path escapes workspace root: ${p}`);
        }
        return abs;
    }
    async approve(action, detail) {
        if (this.approvalMode === "never")
            return true;
        if (this.approvalMode === "untrusted")
            return false;
        try {
            const { ok } = await inquirer.prompt([
                {
                    type: "confirm",
                    name: "ok",
                    message: `${action} ${detail} ?`,
                    default: false,
                },
            ]);
            return ok;
        }
        catch {
            return false;
        }
    }
    readFile(p, offset = 1, limit = 200) {
        const abs = this.resolve(p);
        const raw = fs.readFileSync(abs, "utf-8");
        const lines = raw.split("\n");
        const start = Math.max(1, offset);
        const slice = lines.slice(start - 1, start - 1 + Math.min(Math.max(1, limit), 2000));
        const numbered = slice.map((ln, i) => `${String(start + i).padStart(5)}| ${ln}`);
        return numbered.join("\n");
    }
    writeFile(p, content) {
        const abs = this.resolve(p);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf-8");
        return `wrote ${content.length} bytes to ${path.relative(this.root, abs) || abs}`;
    }
    listDir(p = ".") {
        const abs = this.resolve(p);
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        return entries
            .map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`)
            .join("\n");
    }
    bash(command, timeoutMs = 10_000) {
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
                if (stdout.length > 200_000)
                    stdout = stdout.slice(-200_000);
            });
            child.stderr.on("data", (d) => {
                stderr += String(d);
                if (stderr.length > 200_000)
                    stderr = stderr.slice(-200_000);
            });
            child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
            child.on("error", (err) => resolve({ stdout, stderr: String(err), exitCode: -1 }));
        });
    }
    /** Scoped literal search. Skips .git/node_modules; caps files + matches. */
    search(pattern, dir = ".", maxMatches = 50) {
        const abs = this.resolve(dir);
        const results = [];
        const skip = new Set([".git", "node_modules", ".muse"]);
        const stack = [abs];
        let filesScanned = 0;
        while (stack.length > 0 && results.length < maxMatches && filesScanned < 2000) {
            const cur = stack.pop();
            let entries;
            try {
                entries = fs.readdirSync(cur, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const e of entries) {
                if (results.length >= maxMatches)
                    break;
                if (skip.has(e.name))
                    continue;
                const full = path.join(cur, e.name);
                if (e.isDirectory()) {
                    stack.push(full);
                }
                else if (e.isFile()) {
                    filesScanned++;
                    let text;
                    try {
                        const stat = fs.statSync(full);
                        if (stat.size > 512 * 1024)
                            continue;
                        text = fs.readFileSync(full, "utf-8");
                    }
                    catch {
                        continue;
                    }
                    const lines = text.split("\n");
                    for (let i = 0; i < lines.length && results.length < maxMatches; i++) {
                        if (lines[i].includes(pattern)) {
                            const rel = path.relative(this.root, full);
                            results.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`);
                        }
                    }
                }
            }
        }
        return results.length > 0
            ? results.join("\n")
            : `(no matches for ${JSON.stringify(pattern)} in ${dir})`;
    }
    /** Execute one model tool call. Returns text for the tool result message. */
    async executeToolCall(call, opts = {}) {
        const name = call.function.name;
        let args = {};
        try {
            args = JSON.parse(call.function.arguments || "{}");
        }
        catch {
            return `error: invalid JSON arguments: ${call.function.arguments.slice(0, 300)}`;
        }
        const str = (v, fallback = "") => typeof v === "string" ? v : fallback;
        const num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
        switch (name) {
            case "read_file": {
                const p = str(args.path);
                if (!p)
                    return "error: read_file requires `path`";
                try {
                    return this.readFile(p, num(args.offset, 1), num(args.limit, 200));
                }
                catch (err) {
                    return `error: ${err.message}`;
                }
            }
            case "list_dir": {
                try {
                    return this.listDir(str(args.path, "."));
                }
                catch (err) {
                    return `error: ${err.message}`;
                }
            }
            case "search": {
                const pattern = str(args.pattern);
                if (!pattern)
                    return "error: search requires `pattern`";
                return this.search(pattern, str(args.dir, "."), num(args.max_matches, 50));
            }
            case "write_file": {
                const p = str(args.path);
                const content = typeof args.content === "string" ? args.content : null;
                if (!p || content === null)
                    return "error: write_file requires `path` + `content`";
                const ok = opts.autoApprove || this.approvalMode === "never"
                    ? true
                    : await this.approve("write_file", p);
                if (!ok)
                    return "denied by approval policy";
                try {
                    return this.writeFile(p, content);
                }
                catch (err) {
                    return `error: ${err.message}`;
                }
            }
            case "bash": {
                const command = str(args.command);
                if (!command)
                    return "error: bash requires `command`";
                const ok = opts.autoApprove || this.approvalMode === "never"
                    ? true
                    : await this.approve("bash", command.slice(0, 120));
                if (!ok)
                    return "denied by approval policy";
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
            default:
                return `error: unknown tool: ${name}`;
        }
    }
}
// ---------------------------------------------------------------------------
// Sessions (CWD-bound JSONL)
// ---------------------------------------------------------------------------
export function createSession(workspace, sessionId) {
    const id = sessionId ?? randomUUID();
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const dir = path.join(workspace, ".muse", "sessions", yyyy, mm, dd, id);
    return { sessionId: id, sessionDir: dir, sessionFile: path.join(dir, "session.jsonl"), workspace };
}
export function appendSessionLine(session, record, noLog = false) {
    if (noLog || !session.sessionFile)
        return;
    try {
        fs.mkdirSync(session.sessionDir, { recursive: true });
        fs.appendFileSync(session.sessionFile, JSON.stringify(record) + "\n", "utf-8");
    }
    catch {
        /* session logging must never crash the TUI */
    }
}
/** Best-effort mirror into the Rust-shared XDG history. */
export function appendXdgHistory(text) {
    try {
        const dir = path.join(os.homedir(), ".local", "share", "muse");
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, "tui-history.jsonl"), JSON.stringify(text) + "\n", "utf-8");
    }
    catch {
        /* ignore */
    }
}
function readWorkflowPending(workspace) {
    try {
        const raw = fs.readFileSync(path.join(workspace, "workflow.json"), "utf-8");
        const data = JSON.parse(raw);
        if (data && typeof data === "object") {
            const status = String(data.status ?? "unknown");
            if (status === "pending" || status === "running") {
                return `${status}: ${String(data.intent ?? data.task ?? "").slice(0, 160)}`;
            }
            return `status=${status}`;
        }
    }
    catch {
        /* no workflow.json in this CWD — fine (dynamic binding) */
    }
    return null;
}
export const SLASH_COMMANDS = [
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
    { name: "init", description: "NodeOS readiness briefing for this workspace", usage: "/init" },
    { name: "boot", description: "boot the NodeOS daemon when offline, then re-check", usage: "/boot" },
    { name: "exit", description: "leave the TUI", usage: "/exit" },
    { name: "quit", description: "leave the TUI (alias)", usage: "/quit" },
];
/** Parse `/cmd args` → `{ command, arg }`. Returns null when not a slash line. */
export function parseSlashInput(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/"))
        return null;
    const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
    return { command: (cmd ?? "").toLowerCase(), arg: rest.join(" ").trim() };
}
/** True for a bare "/" (or "/ "): the user is asking for the command menu. */
export function isSlashMenuTrigger(text) {
    return text.trim() === "/";
}
/** Case-insensitive substring filter over command names + descriptions. */
export function filterSlashCommands(term) {
    const q = term.trim().toLowerCase().replace(/^\/+/, "");
    if (!q)
        return [...SLASH_COMMANDS];
    return SLASH_COMMANDS.filter((c) => c.name.includes(q) || c.description.toLowerCase().includes(q));
}
function slashChoices(cmds = SLASH_COMMANDS) {
    return cmds.map((c) => ({
        name: `/${c.name} — ${c.description}`,
        value: c.name,
    }));
}
/**
 * Interactive "/" menu — no extra dependencies.
 * Uses inquirer's built-in `search` prompt (filter-as-you-type) with an
 * automatic fallback to `select` so offline/older terminals still get a list.
 * Resolves to the chosen command name (without "/"), or null on cancel.
 */
export async function promptSlashMenu(initialFilter) {
    const hint = initialFilter?.trim() ? ` (filter: ${initialFilter.trim()})` : "";
    try {
        const { cmd } = await inquirer.prompt([
            {
                type: "search",
                name: "cmd",
                message: `slash command${hint}`,
                source: async (term) => {
                    const q = term ?? initialFilter ?? "";
                    const matches = filterSlashCommands(q);
                    if (matches.length > 0)
                        return slashChoices(matches);
                    return slashChoices();
                },
            },
        ]);
        return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
    }
    catch {
        /* search unavailable or dismissed — fall back to a plain list */
    }
    try {
        const prefiltered = filterSlashCommands(initialFilter ?? "");
        const { cmd } = await inquirer.prompt([
            {
                type: "select",
                name: "cmd",
                message: `slash command${hint}`,
                choices: slashChoices(prefiltered.length > 0 ? prefiltered : SLASH_COMMANDS),
                pageSize: Math.min(Math.max(SLASH_COMMANDS.length, 8), 16),
            },
        ]);
        return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
export function banner(opts) {
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
function helpText() {
    const rows = SLASH_COMMANDS.map((c) => `  ${chalk.yellow(c.usage.padEnd(22))} ${c.description}`);
    return [
        chalk.bold("Commands:"),
        ...rows,
        "",
        chalk.dim("Tip: type / alone to pick from an interactive menu."),
        chalk.dim("Any other input is sent to the model. Tool calls ask for approval unless mode is `never`."),
    ].join("\n");
}
/** Minimal markdown-ish render: code fences dimmed, headers bold. */
export function renderAssistant(text) {
    const lines = text.split("\n");
    let inFence = false;
    return lines
        .map((ln) => {
        if (ln.trimStart().startsWith("```")) {
            inFence = !inFence;
            return chalk.dim(ln);
        }
        if (inFence)
            return chalk.dim(ln);
        if (/^#{1,4}\s/.test(ln))
            return chalk.bold.white(ln);
        return ln;
    })
        .join("\n");
}
// ---------------------------------------------------------------------------
// Main TUI loop
// ---------------------------------------------------------------------------
export async function runTui(opts = {}) {
    const workspace = path.resolve(opts.workspace ?? process.cwd());
    const approvalMode = opts.approvalMode ?? "on-request";
    const provider = opts.provider ?? "meta";
    let model = opts.model ?? "muse-spark-1.3";
    let effort = opts.reasoningEffort ?? "high";
    // Resolve credentials (env wins).
    let resolved = resolveCredential();
    let baseUrl = opts.baseUrl ?? resolved?.baseUrl ?? DEFAULT_API_BASE_URL;
    if (provider === "meta" && !resolved) {
        console.log(chalk.yellow("Not logged in."), "Run", chalk.cyan("/login"), "or set META_API_KEY. Starting in echo mode for now.");
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
    const tools = new WorkspaceTools(workspace, approvalMode);
    const session = createSession(workspace, opts.sessionId);
    const noLog = opts.noSessionLog ?? false;
    if (!noLog && session.sessionFile) {
        try {
            fs.mkdirSync(session.sessionDir, { recursive: true });
        }
        catch {
            /* ignore */
        }
    }
    console.log(banner({
        model: client.model,
        effort: client.reasoningEffort,
        workspace,
        sessionId: session.sessionId,
        approval: tools.approvalMode,
        provider: client.provider,
    }));
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
    const history = [
        {
            role: "system",
            content: "You are muse-ts, a terminal coding assistant. Be direct, technical, and precise. " +
                "Use workspace tools (read_file, write_file, list_dir, bash, search) to inspect and edit code. " +
                "Scope every search to explicit directories; never scan the whole filesystem. " +
                "Explain plans briefly before running mutating commands.",
        },
    ];
    let queuedInitial = opts.initialPrompt ?? null;
    while (true) {
        let userText;
        if (queuedInitial !== null) {
            userText = queuedInitial;
            queuedInitial = null;
            console.log(chalk.bold.magenta("› ") + userText);
        }
        else {
            try {
                const answer = await inquirer.prompt([
                    {
                        type: "input",
                        name: "q",
                        message: chalk.bold.magenta("›"),
                        prefix: "",
                    },
                ]);
                userText = (answer.q ?? "").trim();
            }
            catch {
                console.log(chalk.dim("\nbye."));
                break;
            }
        }
        if (!userText)
            continue;
        appendXdgHistory(userText);
        // ---- slash commands (explicit only — boot/init never auto-run) ----
        if (userText.startsWith("/")) {
            let parsed = parseSlashInput(userText);
            // Bare "/" → interactive menu so users never have to guess.
            if (!parsed || isSlashMenuTrigger(userText)) {
                const picked = await promptSlashMenu();
                if (!picked)
                    continue;
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
                    if (!picked)
                        continue;
                    command = picked;
                    arg = "";
                }
            }
            if (command === "exit" || command === "quit") {
                console.log(chalk.dim("bye."));
                break;
            }
            else if (command === "help") {
                console.log(helpText());
                continue;
            }
            else if (command === "status") {
                resolved = resolveCredential();
                console.log([
                    `${chalk.dim("auth:")} ${resolved ? `${chalk.green("logged in")} via ${resolved.source}` : chalk.red("logged out")}`,
                    `${chalk.dim("base:")} ${baseUrl}`,
                    `${chalk.dim("model:")} ${client.model}  ${chalk.dim("effort:")} ${client.reasoningEffort}`,
                    `${chalk.dim("session:")} ${session.sessionId}`,
                    `${chalk.dim("workspace:")} ${workspace}`,
                    `${chalk.dim("context:")} ${history.length} messages`,
                ].join("\n"));
                continue;
            }
            else if (command === "clear") {
                history.splice(1);
                console.log(chalk.dim("context cleared."));
                continue;
            }
            else if (command === "model") {
                if (!arg) {
                    console.log(`model: ${chalk.green(client.model)}`);
                    try {
                        const models = await client.listModels();
                        console.log(chalk.dim(models.slice(0, 20).join(", ")));
                    }
                    catch (err) {
                        console.log(chalk.dim(`(model list unavailable: ${err.message})`));
                    }
                }
                else {
                    model = arg;
                    client.model = arg;
                    console.log(`model → ${chalk.green(arg)}`);
                }
                continue;
            }
            else if (command === "effort") {
                const levels = [
                    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
                ];
                if (!arg) {
                    console.log(`effort: ${chalk.green(client.reasoningEffort)}`);
                }
                else if (levels.includes(arg)) {
                    effort = arg;
                    client.reasoningEffort = effort;
                    console.log(`effort → ${chalk.green(arg)}`);
                }
                else {
                    console.log(chalk.red(`unknown effort: ${arg} (want ${levels.join("|")})`));
                }
                continue;
            }
            else if (command === "approval") {
                const modes = ["untrusted", "on-request", "never"];
                if (!arg) {
                    console.log(`approval: ${chalk.green(tools.approvalMode)}`);
                }
                else if (modes.includes(arg)) {
                    tools.approvalMode = arg;
                    console.log(`approval → ${chalk.green(arg)}`);
                }
                else {
                    console.log(chalk.red(`unknown mode: ${arg}`));
                }
                continue;
            }
            else if (command === "tools") {
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
                    }
                    catch (err) {
                        console.log(chalk.red(`bridge list failed: ${err.message}`));
                    }
                }
                continue;
            }
            else if (command === "editor") {
                try {
                    const { text } = await inquirer.prompt([
                        { type: "editor", name: "text", message: "prompt" },
                    ]);
                    if (text.trim().length > 0) {
                        queuedInitial = text.trim();
                    }
                }
                catch {
                    console.log(chalk.dim("(editor cancelled)"));
                }
                continue;
            }
            else if (command === "init") {
                // Explicit readiness briefing for this workspace (no boot).
                await runInit({ target: workspace });
                continue;
            }
            else if (command === "boot") {
                // Explicit daemon boot sequence — the only place boot runs.
                // Same code path as `muse-ts init --boot` (see src/nodeos.ts).
                await runInit({ boot: true, target: workspace });
                continue;
            }
            else if (command === "login" || command === "logout") {
                console.log(chalk.dim(`/${command} runs from the shell in this preview — use:`), chalk.cyan(command === "login" ? "muse-ts login" : "muse-ts logout"));
                continue;
            }
            else {
                console.log(chalk.red(`unknown command: /${command} (pick one below)`));
                const picked = await promptSlashMenu(command);
                if (picked)
                    queuedInitial = `/${picked}`;
                continue;
            }
        }
        // ---- normal turn ----
        history.push({ role: "user", content: userText });
        appendSessionLine(session, { type: "user", ts: new Date().toISOString(), content: userText }, noLog);
        // Refresh credentials each turn (env may change; login may have run elsewhere).
        resolved = resolveCredential();
        if (resolved) {
            client.setToken(resolved.token);
            if (!opts.baseUrl) {
                client.baseUrl = resolved.baseUrl;
                baseUrl = resolved.baseUrl;
            }
            if (client.provider === "echo" && provider === "meta") {
                client.provider = "meta";
                console.log(chalk.dim("(credentials found — leaving echo mode)"));
            }
        }
        const maxSteps = opts.maxModelSteps ?? 8;
        for (let step = 0; step < maxSteps; step++) {
            let defs = [...WORKSPACE_TOOL_DEFS];
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
                                parameters: t.inputSchema ?? {
                                    type: "object",
                                    properties: {},
                                },
                            },
                        });
                    }
                }
                catch {
                    /* bridge failures degrade to workspace-only */
                }
            }
            process.stdout.write(chalk.bold.cyan("\n◈ ") + chalk.dim(`${client.model} · ${client.reasoningEffort}\n`));
            let full;
            try {
                const gen = client.chatStream(history, defs);
                let out = "";
                while (true) {
                    const next = await gen.next();
                    if (next.done) {
                        full = next.value;
                        break;
                    }
                    const evt = next.value;
                    if (evt.type === "text") {
                        out += evt.delta;
                        process.stdout.write(evt.delta);
                    }
                }
                process.stdout.write("\n");
                full = full;
                // Re-render final block with light markdown styling when non-trivial.
                if (out.includes("```") || out.includes("# ")) {
                    console.log(chalk.dim("─ rendered ─"));
                    console.log(renderAssistant(out));
                }
            }
            catch (err) {
                console.log(chalk.red(`\nrequest failed: ${err.message}`));
                break;
            }
            history.push(full);
            appendSessionLine(session, { type: "assistant", ts: new Date().toISOString(), content: full.content, tool_calls: full.tool_calls ?? [] }, noLog);
            if (!full.tool_calls || full.tool_calls.length === 0)
                break;
            // Execute tool calls (sequentially for LMK safety; never parallel).
            for (const call of full.tool_calls) {
                const label = `${call.function.name}(${call.function.arguments.slice(0, 160)})`;
                console.log(chalk.yellow(`\n⚙ tool: ${label}`));
                let result;
                if (call.function.name.startsWith("bridge_") && opts.bridge) {
                    const realName = call.function.name.slice("bridge_".length);
                    try {
                        const args = JSON.parse(call.function.arguments || "{}");
                        const ok = tools.approvalMode === "never"
                            ? true
                            : await tools.approve("bridge", `${realName}`);
                        result = ok ? await opts.bridge.callTool(realName, args) : "denied by approval policy";
                    }
                    catch (err) {
                        result = `error: ${err.message}`;
                    }
                }
                else {
                    result = await tools.executeToolCall(call);
                }
                console.log(chalk.dim(result.slice(0, 2000)));
                history.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: result.slice(0, 20_000),
                });
                appendSessionLine(session, { type: "tool", ts: new Date().toISOString(), name: call.function.name, content: result.slice(0, 20_000) }, noLog);
            }
            // Continue the loop so the model can consume tool results.
            if (step === maxSteps - 1) {
                console.log(chalk.dim("(max model steps reached)"));
            }
        }
    }
    appendSessionLine(session, { type: "session_end", ts: new Date().toISOString() }, noLog);
}
//# sourceMappingURL=tui.js.map