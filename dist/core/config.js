/**
 * src/core/config.ts — CWD-bound path resolution + runtime context.
 *
 * NodeOS architecture (mandatory):
 * - Workspace resolves dynamically via process.cwd() or --workspace.
 * - agy_nodeos.db, workflow.json, daemon.log, .agents/hooks.json always
 *   attach relative to the runtime CWD. Nothing is hardcoded.
 * - Credentials live in XDG config (src/core/auth.ts) — never in CWD.
 */
import * as path from "node:path";
export const DEFAULT_MODEL = "muse-spark-1.3";
export const DEFAULT_EFFORT = "high";
export const DEFAULT_APPROVAL = "on-request";
export function resolveWorkspace(explicit) {
    return path.resolve(explicit ?? process.cwd());
}
export function sessionRootFor(workspace) {
    return path.join(workspace, ".muse", "sessions");
}
/** Fast LMK mirror: per-workspace tmp state, written every turn. */
export function lmkSnapshotPath(workspace) {
    return path.join(workspace, ".muse", "tmp.json");
}
export function workflowPath(workspace) {
    return path.join(workspace, "workflow.json");
}
export function graphDbPath(workspace) {
    return path.join(workspace, "agy_nodeos.db");
}
export function daemonLogPath(workspace) {
    return path.join(workspace, "daemon.log");
}
export function hooksPath(workspace) {
    return path.join(workspace, ".agents", "hooks.json");
}
export function parseApproval(v) {
    if (v === "untrusted" || v === "on-request" || v === "never")
        return v;
    throw new Error(`invalid approval mode: ${v}`);
}
export function parseEffort(v) {
    const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    if (levels.includes(v))
        return v;
    throw new Error(`invalid reasoning effort: ${v}`);
}
export function parseProvider(v) {
    if (v === "meta" || v === "echo" || v === "local")
        return v;
    throw new Error(`invalid provider: ${v} (want meta|echo|local)`);
}
/** Normalize raw commander globals into a validated ResolvedContext. */
export function resolveContext(raw) {
    let approvalMode = parseApproval(raw.approvalMode ?? DEFAULT_APPROVAL);
    if (raw.yolo || raw.disableApproval)
        approvalMode = "never";
    return {
        workspace: resolveWorkspace(raw.workspace),
        model: raw.model ?? DEFAULT_MODEL,
        reasoningEffort: parseEffort(raw.reasoningEffort ?? DEFAULT_EFFORT),
        approvalMode,
        provider: parseProvider(raw.provider ?? "meta"),
        baseUrl: raw.baseUrl,
        sessionId: raw.sessionId,
        noSessionLog: raw.sessionLog === false,
    };
}
//# sourceMappingURL=config.js.map