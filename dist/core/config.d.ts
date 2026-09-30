/**
 * src/core/config.ts — CWD-bound path resolution + runtime context.
 *
 * NodeOS architecture (mandatory):
 * - Workspace resolves dynamically via process.cwd() or --workspace.
 * - agy_nodeos.db, workflow.json, daemon.log, .agents/hooks.json always
 *   attach relative to the runtime CWD. Nothing is hardcoded.
 * - Credentials live in XDG config (src/core/auth.ts) — never in CWD.
 */
import type { ApprovalMode, ProviderMode, ReasoningEffort, ResolvedContext } from "./types.js";
export declare const DEFAULT_MODEL = "muse-spark-1.3";
export declare const DEFAULT_EFFORT: ReasoningEffort;
export declare const DEFAULT_APPROVAL: ApprovalMode;
export declare function resolveWorkspace(explicit?: string): string;
export declare function sessionRootFor(workspace: string): string;
/** Fast LMK mirror: per-workspace tmp state, written every turn. */
export declare function lmkSnapshotPath(workspace: string): string;
export declare function workflowPath(workspace: string): string;
export declare function graphDbPath(workspace: string): string;
export declare function daemonLogPath(workspace: string): string;
export declare function hooksPath(workspace: string): string;
export interface RawCliGlobals {
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
    trustWorkspace?: boolean;
}
export declare function parseApproval(v: string): ApprovalMode;
export declare function parseEffort(v: string): ReasoningEffort;
export declare function parseProvider(v: string): ProviderMode;
/** Normalize raw commander globals into a validated ResolvedContext. */
export declare function resolveContext(raw: RawCliGlobals): ResolvedContext;
