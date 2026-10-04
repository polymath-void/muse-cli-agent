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
import * as os from "node:os";
import * as fs from "node:fs";
import type {
  ApprovalMode,
  ProviderMode,
  ReasoningEffort,
  ResolvedContext,
  MuseSettings,
} from "./types.js";

export const DEFAULT_MODEL = "muse-spark-1.3";
export const DEFAULT_EFFORT: ReasoningEffort = "high";
export const DEFAULT_APPROVAL: ApprovalMode = "on-request";

export function loadSettings(): MuseSettings {
  try {
    const p = path.join(os.homedir(), ".config", "muse", "settings.json");
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as MuseSettings;
    }
  } catch {
    // ignore
  }
  return {};
}

export function resolveWorkspace(explicit?: string): string {
  return path.resolve(explicit ?? process.cwd());
}

export function sessionRootFor(workspace: string): string {
  return path.join(workspace, ".muse", "sessions");
}

/** Fast LMK mirror: per-workspace tmp state, written every turn. */
export function lmkSnapshotPath(workspace: string): string {
  return path.join(workspace, ".muse", "tmp.json");
}

/** Last-used model/gateway/effort memory (restored on restart). */
export function lastModelPath(workspace: string): string {
  return path.join(workspace, ".muse", "last-model.json");
}

export function workflowPath(workspace: string): string {
  return path.join(workspace, "workflow.json");
}

export function graphDbPath(workspace: string): string {
  return path.join(workspace, "agy_nodeos.db");
}

export function daemonLogPath(workspace: string): string {
  return path.join(workspace, "daemon.log");
}

export function hooksPath(workspace: string): string {
  return path.join(workspace, ".agents", "hooks.json");
}

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

export function parseApproval(v: string): ApprovalMode {
  if (v === "untrusted" || v === "on-request" || v === "never") return v;
  throw new Error(`invalid approval mode: ${v}`);
}

export function parseEffort(v: string): ReasoningEffort {
  const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  if ((levels as string[]).includes(v)) return v as ReasoningEffort;
  throw new Error(`invalid reasoning effort: ${v}`);
}

export function parseProvider(v: string): ProviderMode {
  if (v === "meta" || v === "echo" || v === "local") return v;
  throw new Error(`invalid provider: ${v} (want meta|echo|local)`);
}

/** Normalize raw commander globals into a validated ResolvedContext. */
export function resolveContext(raw: RawCliGlobals): ResolvedContext {
  const settings = loadSettings();
  let defaultApproval = DEFAULT_APPROVAL;
  if (settings.permissions?.default_profile === ":auto-review") {
    defaultApproval = "on-request"; // fallback logic if auto-review means something
  }
  let approvalMode = parseApproval(raw.approvalMode ?? defaultApproval);
  if (raw.yolo || raw.disableApproval) approvalMode = "never";
  
  return {
    workspace: resolveWorkspace(raw.workspace),
    model: raw.model ?? settings.model ?? DEFAULT_MODEL,
    reasoningEffort: parseEffort(raw.reasoningEffort ?? settings.reasoning_effort ?? DEFAULT_EFFORT),
    approvalMode,
    provider: parseProvider(raw.provider ?? settings.provider ?? "meta"),
    baseUrl: raw.baseUrl,
    sessionId: raw.sessionId,
    noSessionLog: raw.sessionLog === false,
    settings,
  };
}
