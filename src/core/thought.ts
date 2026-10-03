/**
 * src/core/thought.ts — Internal thought processing (`<thought>` system).
 *
 * The agent reasons inside `<thought>...</thought>` blocks. Thoughts are:
 * - rendered dimmed/collapsed in the TUI (never as primary output),
 * - stripped before session persistence and history retention (token savings).
 *
 * No I/O, no process globals — safe to import in TUI, headless, and tests.
 */

/** Extract the first `<thought>...</thought>` body, or null when absent. */
export function extractThought(raw: string): string | null {
  const m = raw.match(/<thought>([\s\S]*?)<\/thought>/);
  const body = m?.[1]?.trim();
  return body ? body : null;
}

/** Remove all `<thought>...</thought>` blocks, collapse 3+ newlines, trim. */
export function stripThought(content: string): string {
  return content
    .replace(/<thought>[\s\S]*?<\/thought>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Alias used at the persistence boundary (see verification plan). */
export function sanitizeBeforeSave(content: string): string {
  return stripThought(content);
}

/** Truncate a thought preview for the collapsed TUI line. */
export function truncateThought(thought: string, max = 300): string {
  const flat = thought.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

/** Split raw assistant output into dimmed thought + user-visible markdown. */
export function splitThought(raw: string): { thought: string | null; clean: string } {
  return { thought: extractThought(raw), clean: stripThought(raw) };
}

/** System-prompt directive: always reason inside `<thought>` first. */
export const THOUGHT_DIRECTIVE =
  "Before every tool call or final answer, reason briefly inside " +
  "<thought></thought> tags. Keep thoughts concise and internal; put only " +
  "the user-visible result outside the tags.";

/** System-prompt directive: persist durable lessons via the `learn` tool. */
export const LEARNING_DIRECTIVE =
  "On user correction, restated preference, or a recovered mistake, call the " +
  "`learn` tool proactively to persist the lesson (scope: project for " +
  "repo-specific lessons, global for cross-project habits).";

/**
 * Tool catalog directive: the model also sees API tool definitions, but some
 * gateways describe them weakly — so the exact tool names live in the system
 * prompt too. Without this the model invents names like `run_command` and
 * narrates instead of acting.
 */
export const TOOL_CATALOG_DIRECTIVE =
  "Workspace tools (exact names — these are the ONLY tools that exist; never invent others like run_command): " +
  "ast_search {symbol} (zero-cost symbol search, prefer over grep); " +
  "read_file {path,offset,limit}, write_file {path,content}, list_dir {path}; " +
  "bash {command,timeout_ms} (shell in the workspace: mkdir/cp/mv/rm/git/npm/python3 — for ANY shell or file operation call bash); " +
  "search {pattern,dir,max_matches} (literal text search); " +
  "manage_context {action=status|compact|clear}; learn {lesson,scope,category}. " +
  "bridge_*/plugin_* tools exist only when attached. " +
  "When a task needs files or shell, emit the tool call in the SAME turn — do not narrate instead of acting.";
