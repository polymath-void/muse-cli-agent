/**
 * src/core/session-store.ts — local session persistence (JSONL, CWD-bound).
 *
 * Sessions live under:
 *   <workspace>/.muse/sessions/YYYY/MM/DD/<sessionId>/session.jsonl
 *
 * This store powers:
 * - `resume <session_id>` without any legacy Rust backend,
 * - `sessions` listing for the TUI `/resume` picker,
 * - the LMK snapshot (fast tmp.json) which points at the same history.
 *
 * All writes are synchronous appends so an LMK kill can never corrupt the
 * log. Reads scan the date-sharded tree (bounded) and replay message-class
 * records into ChatMessage[].
 */
import type { ChatMessage, SessionInfo } from "./types.js";
export declare function createSession(workspace: string, sessionId?: string): SessionInfo;
export declare function appendSessionLine(session: SessionInfo, record: Record<string, unknown>, noLog?: boolean): void;
/** Locate a session dir by id anywhere under the date-sharded tree. */
export declare function findSessionDir(workspace: string, sessionId: string): string | null;
export interface SessionMeta {
    id: string;
    dir: string;
    file: string;
    updatedAt: string;
    messageCount: number;
    preview: string;
}
/** Newest-first session listing (bounded scan, newest 50). */
export declare function listSessions(workspace: string, limit?: number): SessionMeta[];
/** Replay a persisted session.jsonl into ChatMessage[] (system re-seeded by caller). */
export declare function loadSessionMessages(workspace: string, sessionId: string): ChatMessage[] | null;
/** Best-effort mirror into the Rust-shared XDG history. */
export declare function appendXdgHistory(text: string): void;
