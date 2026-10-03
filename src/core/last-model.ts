/**
 * src/core/last-model.ts — "remember the last model" memory.
 *
 * The TUI used to reset to `DEFAULT_MODEL` + inferred gateway on every
 * restart, so a session started with `--model gemini-3.1-pro-high` had to be
 * re-flagged each time. This module persists the last working selection to
 * `<workspace>/.muse/last-model.json` (CWD-bound, no hardcoded dirs) and
 * restores it when the corresponding CLI flag was not given.
 *
 * Precedence, by design:
 * - explicit CLI flag (`--model` / `--gateway-id`)  →  wins, and is re-saved
 * - remembered file                                 →  wins over CLI defaults
 * - built-in default                                →  last resort
 *
 * Termux constraints:
 * - Synchronous atomic write (tmp file + rename) so an LMK kill leaves either
 *   the old or the new file, never a truncated one.
 * - Failures are swallowed: a bad/absent memory file must never break boot.
 *
 * No I/O beyond the state file, no process globals — safe to import in tests.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { lastModelPath } from "./config.js";

/** The last working model selection. Strings stay loose on purpose: model ids
 *  are catalog-driven and change without a code release. */
export interface LastModelSelection {
  model: string;
  gatewayId: string;
  reasoningEffort: string;
  /** ISO timestamp of the write; used for staleness hints only. */
  updatedAt?: string;
}

/** Gateways the router knows. An unknown value is ignored rather than fatal. */
const KNOWN_GATEWAYS = new Set(["opencode", "google", "agy", "meta"]);

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Read the remembered selection, or null when absent/corrupt/partial.
 * A partially valid file still yields its valid fields, so a renamed gateway
 * degrades to "remembered model, inferred gateway" instead of no memory.
 */
export function readLastModel(workspace: string): LastModelSelection | null {
  try {
    const raw = fs.readFileSync(lastModelPath(workspace), "utf-8");
    const data = JSON.parse(raw) as Partial<LastModelSelection> | null;
    if (!data || typeof data !== "object") return null;
    const model = nonEmpty(data.model);
    const gatewayId = nonEmpty(data.gatewayId);
    if (!model && !gatewayId) return null;
    return {
      model: model ?? "",
      gatewayId: gatewayId && KNOWN_GATEWAYS.has(gatewayId) ? gatewayId : "",
      reasoningEffort: nonEmpty(data.reasoningEffort) ?? "",
      updatedAt: nonEmpty(data.updatedAt) ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Persist the selection atomically. Ignores empty fields so a half-known
 * selection can never overwrite a complete memory file.
 */
export function writeLastModel(workspace: string, sel: LastModelSelection): void {
  try {
    const model = nonEmpty(sel.model);
    const gatewayId = nonEmpty(sel.gatewayId);
    const reasoningEffort = nonEmpty(sel.reasoningEffort);
    if (!model && !gatewayId) return;
    const full: LastModelSelection = {
      model: model ?? "",
      gatewayId: gatewayId && KNOWN_GATEWAYS.has(gatewayId) ? gatewayId : "",
      reasoningEffort: reasoningEffort ?? "",
      updatedAt: new Date().toISOString(),
    };
    const target = lastModelPath(workspace);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(full), "utf-8");
    fs.renameSync(tmp, target);
  } catch {
    /* memory writes must never crash the agent */
  }
}

/** Forget the remembered selection (used by `/model reset` and tests). */
export function clearLastModel(workspace: string): void {
  try {
    fs.rmSync(lastModelPath(workspace), { force: true });
  } catch {
    /* ignore */
  }
}