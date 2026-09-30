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
import { WORKSPACE_TOOL_DEFS, type BridgeToolProvider } from "./tui.js";
import { runInit } from "./nodeos.js";
/**
 * Spawns `python3 <script> [...args]` and speaks JSON-RPC 2.0 / JSONL.
 * Compatible with MCP-style servers (initialize, tools/list, tools/call)
 * and any generic `method`/`params` server.
 */
export declare class JsonRpcStdioClient implements BridgeToolProvider {
    readonly scriptPath: string;
    readonly scriptArgs: string[];
    readonly pythonBin: string;
    private child;
    private nextId;
    private pending;
    private buffer;
    private closed;
    constructor(scriptPath: string, scriptArgs?: string[], pythonBin?: string);
    get running(): boolean;
    start(): void;
    private onData;
    request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
    notify(method: string, params?: unknown): void;
    initialize(): Promise<unknown>;
    listTools(): Promise<{
        name: string;
        description?: string;
        inputSchema?: unknown;
    }[]>;
    callTool(name: string, args: Record<string, unknown>): Promise<string>;
    close(): Promise<void>;
}
export { runInit };
export declare function main(argv?: string[]): Promise<void>;
export { WORKSPACE_TOOL_DEFS };
