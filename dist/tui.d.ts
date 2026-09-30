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
export type ApprovalMode = "untrusted" | "on-request" | "never";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
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
    function: {
        name: string;
        arguments: string;
    };
}
export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
/** Injection point for the Python JSON-RPC JSONL bridge (see src/index.ts). */
export interface BridgeToolProvider {
    listTools(): Promise<{
        name: string;
        description?: string;
        inputSchema?: unknown;
    }[]>;
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
    maxModelSteps?: number;
}
export interface SessionInfo {
    sessionId: string;
    sessionDir: string;
    sessionFile: string | null;
    workspace: string;
}
export declare const WORKSPACE_TOOL_DEFS: ToolDefinition[];
export declare class MetaChatClient {
    readonly baseUrl: string;
    readonly model: string;
    readonly reasoningEffort: ReasoningEffort;
    readonly parallelToolCalls: boolean;
    private token;
    readonly provider: "meta" | "echo" | "local";
    constructor(opts: {
        token: string;
        baseUrl?: string;
        model?: string;
        reasoningEffort?: ReasoningEffort;
        parallelToolCalls?: boolean;
        provider?: "meta" | "echo" | "local";
    });
    setToken(token: string): void;
    listModels(): Promise<string[]>;
    private buildBody;
    /** Non-streaming single turn. Returns assistant message. */
    chatOnce(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatMessage>;
    /** Streaming turn. Yields text deltas; returns full message via `done()`. */
    chatStream(messages: ChatMessage[], tools: ToolDefinition[]): AsyncGenerator<{
        type: "text";
        delta: string;
    } | {
        type: "tool_calls";
        toolCalls: ToolCall[];
    }, ChatMessage, void>;
}
export declare class WorkspaceTools {
    readonly root: string;
    approvalMode: ApprovalMode;
    constructor(root: string, approvalMode?: ApprovalMode);
    resolve(p: string): string;
    approve(action: string, detail: string): Promise<boolean>;
    readFile(p: string, offset?: number, limit?: number): string;
    writeFile(p: string, content: string): string;
    listDir(p?: string): string;
    bash(command: string, timeoutMs?: number): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
    /** Scoped literal search. Skips .git/node_modules; caps files + matches. */
    search(pattern: string, dir?: string, maxMatches?: number): string;
    /** Execute one model tool call. Returns text for the tool result message. */
    executeToolCall(call: ToolCall, opts?: {
        autoApprove?: boolean;
    }): Promise<string>;
}
export declare function createSession(workspace: string, sessionId?: string): SessionInfo;
export declare function appendSessionLine(session: SessionInfo, record: Record<string, unknown>, noLog?: boolean): void;
/** Best-effort mirror into the Rust-shared XDG history. */
export declare function appendXdgHistory(text: string): void;
export interface SlashCommand {
    name: string;
    description: string;
    usage: string;
}
export declare const SLASH_COMMANDS: SlashCommand[];
/** Parse `/cmd args` → `{ command, arg }`. Returns null when not a slash line. */
export declare function parseSlashInput(text: string): {
    command: string;
    arg: string;
} | null;
/** True for a bare "/" (or "/ "): the user is asking for the command menu. */
export declare function isSlashMenuTrigger(text: string): boolean;
/** Case-insensitive substring filter over command names + descriptions. */
export declare function filterSlashCommands(term: string): SlashCommand[];
/**
 * Interactive "/" menu — no extra dependencies.
 * Uses inquirer's built-in `search` prompt (filter-as-you-type) with an
 * automatic fallback to `select` so offline/older terminals still get a list.
 * Resolves to the chosen command name (without "/"), or null on cancel.
 */
export declare function promptSlashMenu(initialFilter?: string): Promise<string | null>;
export declare function banner(opts: {
    model: string;
    effort: string;
    workspace: string;
    sessionId: string;
    approval: string;
    provider: string;
}): string;
/** Minimal markdown-ish render: code fences dimmed, headers bold. */
export declare function renderAssistant(text: string): string;
export declare function runTui(opts?: TuiOptions): Promise<void>;
