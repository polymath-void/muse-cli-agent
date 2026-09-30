#!/usr/bin/env node
/**
 * src/index.ts — muse-ts: native TypeScript CLI coding assistant.
 *
 * OS-free replacement path for the Rust binary (`muse`). Talks to the Meta
 * Model API directly (https://api.meta.ai/v1) and authenticates via the
 * native device flow in src/auth.ts. No Rust required at runtime.
 *
 * Python JSON-RPC JSONL interop (both directions):
 *  1. Client mode (`bridge` command + TUI `bridge` tools): spawns a Python
 *     JSON-RPC 2.0 server over stdio (one JSON object per line, exactly like
 *     MCP servers, e.g. termux-mcp) and forwards tools/list + tools/call.
 *  2. Server mode (`serve` command): serves a minimal MSP-compatible
 *     JSON-RPC 2.0 host over stdio (JSONL) so a Python driver can call
 *     initialize / model/list / session/start / turn/start.
 *
 * NodeOS architecture (mandatory):
 * - Workspace resolves dynamically via process.cwd() or --workspace.
 * - agy_nodeos.db, workflow.json, daemon.log, .agents/hooks.json always
 *   attach relative to the runtime CWD. Nothing is hardcoded.
 * - `init` performs the /init readiness flow for the active CWD.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import chalk from "chalk";
import {
  loginDeviceFlow,
  logout as authLogout,
  authSetApiKeyFromStdin,
  credentialSummary,
  resolveCredential,
  DEFAULT_API_BASE_URL,
  AuthError,
} from "./auth.js";
import {
  runTui,
  MetaChatClient,
  WORKSPACE_TOOL_DEFS,
  WorkspaceTools,
  type ApprovalMode,
  type ReasoningEffort,
  type ChatMessage,
  type BridgeToolProvider,
  type ToolDefinition,
  type ToolCall,
} from "./tui.js";
import { runInit } from "./nodeos.js";
import { watchCommand } from "./cli/watch.js";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio (JSONL) — Python bridge client
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

/**
 * Spawns `python3 <script> [...args]` and speaks JSON-RPC 2.0 / JSONL.
 * Compatible with MCP-style servers (initialize, tools/list, tools/call)
 * and any generic `method`/`params` server.
 */
export class JsonRpcStdioClient implements BridgeToolProvider {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private buffer = "";
  private closed = false;

  constructor(
    readonly command: string,
    readonly args: string[] = [],
  ) {}

  get running(): boolean {
    return this.child !== null && !this.closed;
  }

  start(): void {
    if (this.child) return;
    this.child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });
    this.closed = false;
    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk) => this.onData(String(chunk)));
    this.child.stderr.setEncoding("utf-8");
    this.child.stderr.on("data", () => {
      /* Python logs stay on stderr; ignore here (callers may tap) */
    });
    this.child.on("close", (code) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`bridge exited (code ${code})`));
      }
      this.pending.clear();
    });
    this.child.on("error", (err) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      // Response to a pending request.
      if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error)) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          p.reject(new Error(`bridge error ${msg.error.code}: ${msg.error.message}`));
        } else {
          p.resolve(msg.result);
        }
        continue;
      }
      // Server notification / request — no-op (MCP servers rarely call back).
    }
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.child || this.closed) {
      throw new Error("bridge is not running");
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child!.stdin.write(JSON.stringify(req) + "\n");
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.child || this.closed) return;
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }) + "\n",
    );
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "muse-ts", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return result;
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    const result = (await this.request("tools/list", {})) as {
      tools?: { name: string; description?: string; inputSchema?: unknown }[];
    };
    return Array.isArray(result.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: { type?: string; text?: string }[];
    };
    if (Array.isArray(result.content)) {
      return result.content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
    }
    return JSON.stringify(result).slice(0, 20_000);
  }

  async close(): Promise<void> {
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    const child = this.child;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// MSP-compatible stdio host (minimal subset, JSONL)
// ---------------------------------------------------------------------------

interface MspSession {
  id: string;
  workspace: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  messages: ChatMessage[];
  createdAt: string;
}

async function runServe(opts: {
  noSessionLog?: boolean;
  disableWrite?: boolean;
  disableShell?: boolean;
  trustWorkspace?: boolean;
}): Promise<void> {
  void opts;
  const sessions = new Map<string, MspSession>();
  let buffer = "";
  process.stdin.setEncoding("utf-8");

  const send = (id: number | string | null, result?: unknown, error?: { code: number; message: string }) => {
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id };
    if (error) msg.error = error;
    else msg.result = result ?? null;
    process.stdout.write(JSON.stringify(msg) + "\n");
  };

  const handle = async (raw: JsonRpcRequest & { id: number | string }): Promise<void> => {
    const { id, method, params } = raw;
    const p = (params ?? {}) as Record<string, unknown>;
    try {
      switch (method) {
        case "initialize": {
          send(id, {
            protocolVersion: "msp/1",
            serverInfo: { name: "muse-ts", version: "1.0.0", rustFree: true },
            capabilities: { streaming: false, tools: true },
          });
          break;
        }
        case "model/list": {
          const resolved = resolveCredential();
          if (!resolved) {
            send(id, undefined, { code: -32001, message: "not logged in" });
            break;
          }
          const client = new MetaChatClient({
            token: resolved.token,
            baseUrl: String(p.baseUrl ?? resolved.baseUrl),
            model: "muse-spark-1.3",
          });
          try {
            const models = await client.listModels();
            send(id, { models });
          } catch (err) {
            send(id, undefined, { code: -32002, message: (err as Error).message });
          }
          break;
        }
        case "session/start": {
          const workspace = path.resolve(String(p.workspace ?? process.cwd()));
          const s: MspSession = {
            id: randomUUID(),
            workspace,
            model: String(p.model ?? "muse-spark-1.3"),
            reasoningEffort: (String(p.reasoningEffort ?? "high") as ReasoningEffort) ?? "high",
            messages: [
              { role: "system", content: String(p.systemPrompt ?? "You are muse-ts, a terminal coding assistant.") },
            ],
            createdAt: new Date().toISOString(),
          };
          sessions.set(s.id, s);
          send(id, { sessionId: s.id, workspace: s.workspace, model: s.model });
          break;
        }
        case "session/list": {
          send(id, {
            sessions: [...sessions.values()].map((s) => ({
              id: s.id,
              workspace: s.workspace,
              model: s.model,
              messageCount: s.messages.length,
            })),
          });
          break;
        }
        case "turn/start": {
          const s = sessions.get(String(p.sessionId ?? ""));
          if (!s) {
            send(id, undefined, { code: -32003, message: "unknown session" });
            break;
          }
          const prompt = String(p.prompt ?? "");
          if (!prompt) {
            send(id, undefined, { code: -32602, message: "prompt is required" });
            break;
          }
          const resolved = resolveCredential();
          if (!resolved) {
            send(id, undefined, { code: -32001, message: "not logged in" });
            break;
          }
          s.messages.push({ role: "user", content: prompt });
          const client = new MetaChatClient({
            token: resolved.token,
            baseUrl: resolved.baseUrl,
            model: s.model,
            reasoningEffort: s.reasoningEffort,
          });
          const reply = await client.chatOnce(s.messages, []);
          s.messages.push(reply);
          send(id, { text: reply.content, model: s.model });
          break;
        }
        case "usage/read": {
          send(id, { sessions: sessions.size, note: "usage accounting is client-side in muse-ts" });
          break;
        }
        default: {
          send(id, undefined, { code: -32601, message: `method not found: ${method}` });
        }
      }
    } catch (err) {
      send(id, undefined, { code: -32603, message: (err as Error).message });
    }
  };

  process.stdin.on("data", (chunk) => {
    buffer += String(chunk);
    let nl: number;
    // Support both JSONL and LSP Content-Length framing.
    while (true) {
      if (buffer.startsWith("Content-Length:")) {
        const sep = buffer.indexOf("\r\n\r\n");
        if (sep === -1) return;
        const header = buffer.slice(0, sep);
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        const len = m ? Number(m[1]) : -1;
        if (len < 0 || buffer.length < sep + 4 + len) return;
        const body = buffer.slice(sep + 4, sep + 4 + len);
        buffer = buffer.slice(sep + 4 + len);
        try {
          const msg = JSON.parse(body) as JsonRpcRequest & { id: number | string };
          if (msg.method && msg.id !== undefined) void handle(msg);
        } catch {
          /* ignore malformed frame */
        }
        continue;
      }
      nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcRequest & { id: number | string };
        if (msg.method && msg.id !== undefined) void handle(msg);
      } catch {
        /* ignore malformed line */
      }
    }
  });

  await new Promise<void>((resolve) => {
    process.stdin.on("close", () => resolve());
    process.stdin.on("end", () => resolve());
  });
}

// ---------------------------------------------------------------------------
// NodeOS readiness lives in src/nodeos.ts (shared by CLI + TUI).
// runInit is imported above; `muse-ts init` stays a thin wrapper so
// `/init` and `/boot` in the TUI run the exact same sequence.
// ---------------------------------------------------------------------------

export { runInit };


// ---------------------------------------------------------------------------
// CLI definition (commander)
// ---------------------------------------------------------------------------

function parseApproval(v: string): ApprovalMode {
  if (v === "untrusted" || v === "on-request" || v === "never") return v;
  throw new Error(`invalid approval mode: ${v}`);
}

function parseEffort(v: string): ReasoningEffort {
  const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  if ((levels as string[]).includes(v)) return v as ReasoningEffort;
  throw new Error(`invalid reasoning effort: ${v}`);
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("muse-ts")
    .description("muse-ts — interactive terminal coding agent (native TypeScript, no Rust)")
    .version("1.0.0")
    .option("--provider <mode>", "startup provider: echo, meta, or local", "meta")
    .option("--model <model>", "model id for non-echo providers")
    .option("--reasoning-effort <effort>", "meta reasoning effort", "high")
    .option("--base-url <url>", "override the Meta provider base URL")
    .option("--workspace <path>", "workspace root for tools (default: CWD)")
    .option("--approval-mode <mode>", "tool approval mode: untrusted|on-request|never", "on-request")
    .option("--parallel-tool-calls", "enable Meta API parallel tool calls")
    .option("--no-parallel-tool-calls", "disable Meta API parallel tool calls")
    .option("--bridge-script <path>", "Python JSON-RPC JSONL server to attach as tools")
    .option("--session-id <uuid>", "use a specific session id")
    .option("--no-session-log", "do not persist session logs to disk")
    .option("--yolo", "disable approval (alias for --approval-mode never)")
    .option("--disable-approval", "disable approval prompts")
    .option("--trust-workspace", "trust workspace (accepted for Rust-CLI compat)")
    .option("--disable-sandbox", "accepted for Rust-CLI compat (no sandbox in TS preview)")
    .argument("[prompt]", "initial prompt; starts the interactive TUI with this message queued");

  program
    .command("login")
    .description("Log in with your Meta account: approve a code in your browser (native TS device flow)")
    .option("--auth-base-url <url>", "override OAuth base URL")
    .option("--api-base-url <url>", "override Model API base URL")
    .option("--no-open-browser", "do not auto-open the verification URL")
    .action(async (cmdOpts: { authBaseUrl?: string; apiBaseUrl?: string; openBrowser?: boolean }) => {
      try {
        console.log(chalk.bold.cyan("Meta login (device flow, native TypeScript)"));
        const { meta, authPath } = await loginDeviceFlow({
          authBaseUrl: cmdOpts.authBaseUrl,
          apiBaseUrl: cmdOpts.apiBaseUrl,
          openBrowser: cmdOpts.openBrowser,
          onStatus: (m) => console.log(chalk.dim(`… ${m}`)),
          onDeviceCode: (info) => {
            console.log("");
            console.log(`  ${chalk.dim("1. Open:")} ${chalk.cyan.underline(info.verificationUriComplete)}`);
            console.log(`  ${chalk.dim("2. Code:")} ${chalk.bold.yellow(info.userCode)}`);
            console.log("");
          },
        });
        console.log(chalk.green("Login complete."));
        console.log(`${chalk.dim("stored:")} ${authPath}`);
        if (meta.user_email) console.log(`${chalk.dim("account:")} ${meta.user_email}`);
      } catch (err) {
        if (err instanceof AuthError) {
          console.error(chalk.red(`login failed [${err.code}]: ${err.message}`));
          if (err.hint) console.error(chalk.dim(err.hint));
        } else {
          console.error(chalk.red(`login failed: ${(err as Error).message}`));
        }
        process.exitCode = 1;
      }
    });

  program
    .command("logout")
    .description("Remove stored Meta credentials")
    .option("--no-revoke", "skip server-side revocation")
    .action(async (cmdOpts: { revoke?: boolean }) => {
      const ok = await authLogout({ revoke: cmdOpts.revoke });
      console.log(ok ? chalk.green("Logged out.") : chalk.dim("No stored login found."));
    });

  program
    .command("status")
    .description("Show auth + provider status (no secrets)")
    .action(() => {
      const s = credentialSummary();
      console.log(
        [
          `${chalk.dim("logged in:")} ${s.loggedIn ? chalk.green("yes") : chalk.red("no")}`,
          `${chalk.dim("source:")} ${s.source ?? "-"}`,
          `${chalk.dim("base:")} ${s.baseUrl ?? "-"}`,
          `${chalk.dim("account:")} ${s.userEmail ?? "-"}`,
          `${chalk.dim("obtained_via:")} ${s.obtainedVia ?? "-"}`,
        ].join("\n"),
      );
    });

  const auth = program.command("auth").description("Store provider API credentials");
  auth
    .command("set")
    .description("Save provider credentials (key via stdin only)")
    .option("--provider <provider>", "provider", "meta")
    .option("--api-key-stdin", "read the API key from stdin")
    .action(async (cmdOpts: { provider?: string; apiKeyStdin?: boolean }) => {
      if (!cmdOpts.apiKeyStdin) {
        console.error(chalk.red("refusing: API key must come from --api-key-stdin (never the command line)"));
        process.exitCode = 2;
        return;
      }
      try {
        const p = await authSetApiKeyFromStdin({ provider: cmdOpts.provider });
        console.log(chalk.green(`saved → ${p}`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });

  program
    .command("models")
    .description("List Meta models")
    .action(async () => {
      const resolved = resolveCredential();
      if (!resolved) {
        console.error(chalk.red("not logged in — run `muse-ts login` or set META_API_KEY"));
        process.exitCode = 1;
        return;
      }
      const client = new MetaChatClient({ token: resolved.token, baseUrl: resolved.baseUrl });
      try {
        const models = await client.listModels();
        for (const m of models) console.log(m);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });

  program
    .command("watch [target]")
    .description("Live-stream an agent's background execution process")
    .action(async (target?: string) => {
      await watchCommand(target);
    });

  program
    .command("exec")
    .description("Run one prompt non-interactively (headless)")
    .option("--json", "emit machine-readable JSONL events on stdout")
    .option("--prompt-file <path>", "read the prompt from a file")
    .option("--max-model-steps <n>", "cap model steps (0 = uncapped)", "0")
    .argument("[prompt]", "prompt text")
    .action(async (promptArg: string | undefined, cmdOpts: { json?: boolean; promptFile?: string; maxModelSteps?: string }) => {
      let prompt = promptArg ?? "";
      if (cmdOpts.promptFile) {
        prompt = fs.readFileSync(path.resolve(cmdOpts.promptFile), "utf-8");
      }
      if (!prompt.trim()) {
        console.error(chalk.red("exec requires a prompt argument or --prompt-file"));
        process.exitCode = 2;
        return;
      }
      const global = program.opts() as Record<string, unknown>;
      const resolved = resolveCredential();
      if (!resolved) {
        console.error(chalk.red("not logged in — run `muse-ts login` or set META_API_KEY"));
        process.exitCode = 1;
        return;
      }
      const client = new MetaChatClient({
        token: resolved.token,
        baseUrl: String(global.baseUrl ?? resolved.baseUrl),
        model: String(global.model ?? "muse-spark-1.3"),
        reasoningEffort: parseEffort(String(global.reasoningEffort ?? "high")),
        parallelToolCalls: Boolean(global.parallelToolCalls),
      });
      const emit = (obj: unknown) => {
        if (cmdOpts.json) console.log(JSON.stringify(obj));
      };
      try {
        let bridgeClient: JsonRpcStdioClient | undefined;
        if (global.bridgeScript) {
          bridgeClient = new JsonRpcStdioClient(String(global.bridgeScript));
          try {
            bridgeClient.start();
            await bridgeClient.initialize();
          } catch (err) {
            if (cmdOpts.json) emit({ type: "error", message: `bridge attach failed: ${(err as Error).message}` });
            else console.error(chalk.red(`bridge attach failed: ${(err as Error).message}`));
            process.exitCode = 1;
            return;
          }
        }

        let defs: ToolDefinition[] = [...WORKSPACE_TOOL_DEFS];
        if (bridgeClient) {
          try {
            const bt = await bridgeClient.listTools();
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
          } catch { /* ignore */ }
        }

        let approvalStr = String(global.approvalMode ?? "on-request");
        if (global.yolo || global.disableApproval) approvalStr = "never";
        const approvalMode = parseApproval(approvalStr);
        const workspace = path.resolve(String(global.workspace ?? process.cwd()));
        const tools = new WorkspaceTools(workspace, approvalMode);

        // Uncapped by default (user: ignore max step count). Only cap if explicitly passed >0.
        const maxStepsRaw = Number(cmdOpts.maxModelSteps ?? 0);
        const maxSteps = maxStepsRaw > 0 ? maxStepsRaw : Number.POSITIVE_INFINITY;
        if (!Number.isFinite(maxSteps)) emit({ type: "uncapped" });
        const execSystemPrompt =
          "You are muse-ts in WORKER MODE — invoked headlessly by an external orchestrator agent. " +
          "Execute the given task precisely and efficiently. " +
          "Use tools immediately without asking questions. Do NOT greet or chit-chat. " +
          "Scope all file operations to the workspace directory. Never scan the whole filesystem. " +
          "Complete the task in as few steps as possible, then stop.";

        // Expand inline mentions (@file / @project / @skill)
        let execPrompt = prompt;
        try {
          const { MentionNano } = await import("./services/mentions.js");
          const mentionNano = new MentionNano(workspace);
          const mx = mentionNano.expand(prompt);
          if (mx.contextBlock) execPrompt = mx.expanded;
        } catch (err) {
          if (!cmdOpts.json) console.log(chalk.red(`mention expand failed: ${(err as Error).message}`));
        }

        let messages: ChatMessage[] = [
          { role: "system", content: execSystemPrompt },
          { role: "user", content: execPrompt },
        ];
        
        emit({ type: "turn_start", model: client.model });
        for (let step = 0; ; step++) {
          if (step >= maxSteps) break;
          const reply = await client.chatOnce(messages, defs);
          messages.push(reply);

          if (reply.content) {
            if (cmdOpts.json) emit({ type: "message", role: "assistant", content: reply.content });
            else console.log(reply.content);
          }

          if (!reply.tool_calls || reply.tool_calls.length === 0) break;

          for (const call of reply.tool_calls) {
            const label = `${call.function.name}(${call.function.arguments.slice(0, 160)})`;
            if (!cmdOpts.json) console.log(chalk.yellow(`\n⚙ tool: ${label}`));
            let result: string;
            if (call.function.name.startsWith("bridge_") && bridgeClient) {
              const realName = call.function.name.slice("bridge_".length);
              try {
                const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
                const ok = tools.approvalMode === "never" ? true : await tools.approve("bridge", realName);
                result = ok ? await bridgeClient.callTool(realName, args) : "denied by approval policy";
              } catch (err) {
                result = `error: ${(err as Error).message}`;
              }
            } else {
              result = await tools.executeToolCall(call, { autoApprove: false });
            }
            if (!cmdOpts.json) console.log(chalk.dim(result.slice(0, 2000)));
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: result.slice(0, 20_000),
            });
          }
        }
        if (cmdOpts.json) emit({ type: "turn_end" });
        if (bridgeClient) await bridgeClient.close().catch(() => {});
      } catch (err) {
        if (cmdOpts.json) emit({ type: "error", message: (err as Error).message });
        else console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });

  program
    .command("bridge")
    .description("Talk to a Python JSON-RPC JSONL server over stdio")
    .requiredOption("--script <path>", "Python script to spawn")
    .option("--method <method>", "single method to call (default: tools/list)", "tools/list")
    .option("--params <json>", "params JSON for --method", "{}")
    .option("--interactive", "REPL: read method lines from stdin")
    .action(async (cmdOpts: { script: string; method: string; params: string; interactive?: boolean }) => {
      const bridge = new JsonRpcStdioClient(cmdOpts.script);
      try {
        bridge.start();
        await bridge.initialize();
      } catch (err) {
        console.error(chalk.red(`bridge start failed: ${(err as Error).message}`));
        process.exitCode = 1;
        return;
      }
      try {
        if (cmdOpts.interactive) {
          console.log(chalk.dim("bridge REPL — type: <method> [json-params]  (empty line quits)"));
          const readline = await import("node:readline");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) break;
            const [method, ...rest] = trimmed.split(/\s+/);
            let params: unknown = {};
            try {
              params = rest.length > 0 ? JSON.parse(rest.join(" ")) : {};
            } catch {
              console.log(chalk.red("bad params JSON"));
              continue;
            }
            try {
              const result = await bridge.request(method, params);
              console.log(JSON.stringify(result, null, 2));
            } catch (err) {
              console.log(chalk.red((err as Error).message));
            }
          }
          rl.close();
        } else {
          let params: unknown = {};
          try {
            params = JSON.parse(cmdOpts.params);
          } catch {
            console.error(chalk.red("bad --params JSON"));
            process.exitCode = 2;
            return;
          }
          const result = await bridge.request(cmdOpts.method, params);
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      } finally {
        await bridge.close();
      }
    });

  program
    .command("serve")
    .description("Serve a minimal MSP-compatible JSON-RPC host over stdio (JSONL)")
    .option("--no-session-log", "memory-only sessions")
    .action(async (cmdOpts: { sessionLog?: boolean }) => {
      await runServe({ noSessionLog: cmdOpts.sessionLog === false });
    });

  program
    .command("init")
    .description("NodeOS readiness briefing for this workspace (CWD-bound)")
    .option("--boot", "boot the NodeOS daemon if offline")
    .option("--target <path>", "workspace to inspect (default: CWD)")
    .action(async (cmdOpts: { boot?: boolean; target?: string }) => {
      await runInit({ boot: cmdOpts.boot, target: cmdOpts.target });
    });

  program.action(async (prompt: string | undefined) => {
    const global = program.opts() as {
      provider?: string;
      model?: string;
      reasoningEffort?: string;
      baseUrl?: string;
      workspace?: string;
      approvalMode?: string;
      parallelToolCalls?: boolean;
      bridgeScript?: string;
      sessionId?: string;
      sessionLog?: boolean;
      yolo?: boolean;
      disableApproval?: boolean;
    };
    const provider = (global.provider ?? "meta") as "meta" | "echo" | "local";
    let approvalMode: ApprovalMode;
    try {
      approvalMode = parseApproval(global.approvalMode ?? "on-request");
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 2;
      return;
    }
    if (global.yolo || global.disableApproval) approvalMode = "never";
    let effort: ReasoningEffort;
    try {
      effort = parseEffort(global.reasoningEffort ?? "high");
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 2;
      return;
    }

    let bridge: BridgeToolProvider | undefined;
    let bridgeClient: JsonRpcStdioClient | undefined;
    if (global.bridgeScript) {
      bridgeClient = new JsonRpcStdioClient(global.bridgeScript);
      try {
        bridgeClient.start();
        await bridgeClient.initialize();
        console.log(chalk.dim(`bridge attached: ${global.bridgeScript}`));
        bridge = bridgeClient;
      } catch (err) {
        console.error(chalk.red(`bridge attach failed: ${(err as Error).message}`));
        process.exitCode = 1;
        return;
      }
    }
    try {
      await runTui({
        model: global.model,
        reasoningEffort: effort,
        baseUrl: global.baseUrl,
        workspace: global.workspace,
        approvalMode,
        provider,
        parallelToolCalls: global.parallelToolCalls,
        sessionId: global.sessionId,
        noSessionLog: global.sessionLog === false,
        bridge,
        initialPrompt: prompt,
        yolo: Boolean(global.yolo || global.disableApproval),
      });
    } finally {
      if (bridgeClient) await bridgeClient.close().catch(() => {});
    }
  });

  await program.parseAsync(argv);
}

// Direct execution (`tsx src/index.ts …` or compiled `dist/index.js`).
const invokedAsScript =
  process.argv[1] &&
  (process.argv[1].endsWith("/index.ts") ||
    process.argv[1].endsWith("/index.js") ||
    process.argv[1].endsWith("\\index.ts") ||
    process.argv[1].endsWith("\\index.js") || process.argv[1].endsWith("muse-cli"));
if (invokedAsScript) {
  main().catch((err) => {
    console.error(chalk.red(err?.message ?? String(err)));
    process.exitCode = 1;
  });
}

export { WORKSPACE_TOOL_DEFS };
