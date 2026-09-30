/**
 * src/core/types.ts — shared kernel types for muse-ts.
 *
 * Single source of truth for every layer (engine, bridge, capabilities,
 * tui, cli). No runtime imports — types only, so this module is free of
 * side effects and safe to import anywhere without LMK pressure.
 */
export type ApprovalMode = "untrusted" | "on-request" | "never";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ProviderMode = "meta" | "echo" | "local";
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
/** Injection point for the Python JSON-RPC JSONL bridge (see src/bridge/). */
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
    provider?: ProviderMode;
    parallelToolCalls?: boolean;
    sessionId?: string;
    noSessionLog?: boolean;
    bridge?: BridgeToolProvider;
    initialPrompt?: string;
    maxModelSteps?: number;
    resume?: boolean;
}
export interface SessionInfo {
    sessionId: string;
    sessionDir: string;
    sessionFile: string | null;
    workspace: string;
}
/** Fast LMK snapshot: the exact context block needed to resume instantly. */
export interface LmkSnapshot {
    version: 1;
    sessionId: string;
    workspace: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    provider: ProviderMode;
    updatedAt: string;
    messages: ChatMessage[];
}
export interface ResolvedContext {
    workspace: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    approvalMode: ApprovalMode;
    provider: ProviderMode;
    baseUrl?: string;
    sessionId?: string;
    noSessionLog: boolean;
}
