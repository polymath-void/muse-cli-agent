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
import * as fs from "node:fs";
import * as path from "node:path";
import { lmkSnapshotPath } from "./config.js";
const MAX_STORED_MESSAGES = 100;
const MAX_MSG_CHARS = 20_000;
function boundMessages(messages) {
    const tail = messages.slice(-MAX_STORED_MESSAGES);
    return tail.map((m) => ({
        ...m,
        content: typeof m.content === "string" && m.content.length > MAX_MSG_CHARS
            ? m.content.slice(-MAX_MSG_CHARS)
            : m.content,
    }));
}
export function writeLmkSnapshot(workspace, snap) {
    try {
        const dir = path.join(workspace, ".muse");
        fs.mkdirSync(dir, { recursive: true });
        const full = {
            version: 1,
            workspace,
            updatedAt: new Date().toISOString(),
            ...snap,
            messages: boundMessages(snap.messages),
        };
        const target = lmkSnapshotPath(workspace);
        const tmp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(full), "utf-8");
        fs.renameSync(tmp, target);
    }
    catch {
        /* LMK writes must never crash the agent */
    }
}
export function readLmkSnapshot(workspace) {
    try {
        const raw = fs.readFileSync(lmkSnapshotPath(workspace), "utf-8");
        const data = JSON.parse(raw);
        if (!data || data.version !== 1 || !Array.isArray(data.messages))
            return null;
        return data;
    }
    catch {
        return null;
    }
}
export function clearLmkSnapshot(workspace) {
    try {
        fs.rmSync(lmkSnapshotPath(workspace), { force: true });
    }
    catch {
        /* ignore */
    }
}
/** Convenience: persist the live turn state (call after every message). */
export function checkpointTurn(workspace, state) {
    writeLmkSnapshot(workspace, state);
}
//# sourceMappingURL=lmk.js.map