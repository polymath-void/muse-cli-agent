/**
 * src/core/lmk.ts — LMK (Low Memory Killer) protection state.
 *
 * Android may kill the Node process at any time. To survive that, the
 * active conversational state is mirrored to a fast per-workspace
 * `<workspace>/.muse/tmp.json` on every turn. On boot the TUI/CLI loads
 * this snapshot and instantly recovers the exact context block.
 *
 * Design constraints (Termux):
 * - Synchronous atomic writes (tmp file + rename) — never async, never
 *   partial. A killed process must leave either the old or the new file.
 * - Bounded size: messages are capped so tmp.json stays small and fast.
 * - Failures never crash the agent — LMK writes are best-effort.
 */
import type { ChatMessage, LmkSnapshot, ProviderMode, ReasoningEffort } from "./types.js";
export declare function writeLmkSnapshot(workspace: string, snap: Omit<LmkSnapshot, "version" | "updatedAt" | "workspace">): void;
export declare function readLmkSnapshot(workspace: string): LmkSnapshot | null;
export declare function clearLmkSnapshot(workspace: string): void;
/** Convenience: persist the live turn state (call after every message). */
export declare function checkpointTurn(workspace: string, state: {
    sessionId: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    provider: ProviderMode;
    messages: ChatMessage[];
}): void;
