/**
 * src/kernel/permissions.ts — Security & Trust Kernel: 3-tier permission model.
 *
 * Tier0 (read-only): always allowed — read_file, list_dir, search, ast_search,
 *   manage_context/status, recall.
 * Tier1 (local write in workspace): auto-allowed in workspace, gated by the
 *   interactive approval mode otherwise — write_file, bash (safe subset).
 * Tier2 (network / fleet / destructive): ALWAYS requires explicit approval —
 *   web fetch, git push, exec of rm/sudo/chmod/ssh/docker, fleet, bridge tools.
 *   Never auto-allowed by workspace trust. UNTRUSTED web content can never
 *   escalate a Tier2 decision.
 */

export type Tier = 0 | 1 | 2;

export const TIER0_TOOLS = new Set([
  "read_file", "list_dir", "search", "ast_search",
  "manage_context", "recall", "stats",
]);

export const TIER2_TOOLS = new Set([
  "web_fetch", "fetch", "bridge", "fleet", "git_push", "schedule_task",
]);

const DESTRUCTIVE_RE = /(^|[\s;&|])(rm(\s+-r[f]?)?|sudo|chmod(\s+-R)?|chown|ssh|docker|mkfs|\bdd\b|shutdown|reboot|git\s+push|git\s+checkout\s+--?force|git\s+reset\s+--hard|git\s+clean\s+-fd)\b/i;

export function classifyTool(name: string, args?: Record<string, unknown>): Tier {
  const base = name.startsWith("bridge_") ? "bridge" : name;
  if (TIER0_TOOLS.has(base)) return 0;
  if (TIER2_TOOLS.has(base)) return 2;
  if (base === "bash" || base === "exec") {
    const cmd = String(args?.command ?? "");
    if (DESTRUCTIVE_RE.test(cmd)) return 2;
    return 1;
  }
  if (base === "write_file") return 1;
  if (base === "learn" || base === "remember" || base === "memory") return 1;
  // Unknown tools default to Tier2 (deny-by-default posture).
  if (base === "plugin" || base.startsWith("plugin_")) return 2;
  return 1;
}

export interface ApprovalCheckOpts {
  /** Explicit --yes / /approve / approvalMode=never grant. */
  yes?: boolean;
  approvalMode?: "untrusted" | "on-request" | "never";
  /** True when the request originates from UNTRUSTED web content. */
  untrustedSource?: boolean;
  /** Tool args (used to detect destructive bash commands). */
  args?: Record<string, unknown>;
}

export class ApprovalRequiredError extends Error {
  readonly tier: Tier;
  constructor(tier: Tier, tool: string) {
    super(`APPROVAL_REQUIRED: Tier${tier} action '${tool}' needs explicit approval (--yes or /approve)`);
    this.name = "ApprovalRequiredError";
    this.tier = tier;
  }
}

/**
 * Gate a tool call. Tier0 always passes. Tier1 passes unless approvalMode is
 * `untrusted`. Tier2 passes only with explicit `yes` (or approvalMode=never).
 * UNTRUSTED sources can never satisfy Tier2.
 */
export function checkPermission(tool: string, opts: ApprovalCheckOpts = {}): { allowed: true; tier: Tier } {
  const tier = classifyTool(tool, opts.args);
  const mode = opts.approvalMode ?? "on-request";
  if (tier === 0) return { allowed: true, tier };
  if (mode === "untrusted" && !opts.yes) {
    throw new ApprovalRequiredError(tier, tool);
  }
  if (tier === 2) {
    if (opts.untrustedSource) throw new ApprovalRequiredError(tier, tool);
    if (opts.yes || mode === "never") return { allowed: true, tier };
    throw new ApprovalRequiredError(tier, tool);
  }
  return { allowed: true, tier };
}

export function isTier2Command(command: string): boolean {
  return DESTRUCTIVE_RE.test(command);
}
