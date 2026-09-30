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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { sessionRootFor } from "./config.js";
export function createSession(workspace, sessionId) {
    const id = sessionId ?? randomUUID();
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const dir = path.join(sessionRootFor(workspace), yyyy, mm, dd, id);
    return { sessionId: id, sessionDir: dir, sessionFile: path.join(dir, "session.jsonl"), workspace };
}
export function appendSessionLine(session, record, noLog = false) {
    if (noLog || !session.sessionFile)
        return;
    try {
        fs.mkdirSync(session.sessionDir, { recursive: true });
        fs.appendFileSync(session.sessionFile, JSON.stringify(record) + "\n", "utf-8");
    }
    catch {
        /* session logging must never crash the agent */
    }
}
/** Locate a session dir by id anywhere under the date-sharded tree. */
export function findSessionDir(workspace, sessionId) {
    const root = sessionRootFor(workspace);
    if (!fs.existsSync(root))
        return null;
    // Fast path: walk at most 3 levels (YYYY/MM/DD/<id>).
    const years = safeDirs(root);
    for (const y of years) {
        for (const m of safeDirs(path.join(root, y))) {
            for (const d of safeDirs(path.join(root, y, m))) {
                const candidate = path.join(root, y, m, d, sessionId);
                if (fs.existsSync(path.join(candidate, "session.jsonl")))
                    return candidate;
                // Also accept a prefix match (short ids).
                try {
                    for (const e of fs.readdirSync(path.join(root, y, m, d), { withFileTypes: true })) {
                        if (e.isDirectory() && e.name.startsWith(sessionId)) {
                            const p = path.join(root, y, m, d, e.name);
                            if (fs.existsSync(path.join(p, "session.jsonl")))
                                return p;
                        }
                    }
                }
                catch {
                    /* keep scanning */
                }
            }
        }
    }
    return null;
}
function safeDirs(dir) {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    }
    catch {
        return [];
    }
}
/** Newest-first session listing (bounded scan, newest 50). */
export function listSessions(workspace, limit = 50) {
    const root = sessionRootFor(workspace);
    const out = [];
    if (!fs.existsSync(root))
        return out;
    const files = [];
    for (const y of safeDirs(root)) {
        for (const m of safeDirs(path.join(root, y))) {
            for (const d of safeDirs(path.join(root, y, m))) {
                const dayDir = path.join(root, y, m, d);
                for (const s of safeDirs(dayDir)) {
                    const f = path.join(dayDir, s, "session.jsonl");
                    try {
                        const st = fs.statSync(f);
                        files.push({ file: f, dir: path.join(dayDir, s), mtime: st.mtimeMs });
                    }
                    catch {
                        /* skip */
                    }
                }
            }
        }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(0, limit)) {
        try {
            const lines = fs.readFileSync(f.file, "utf-8").split("\n").filter(Boolean);
            let preview = "";
            let count = 0;
            for (const ln of lines) {
                try {
                    const rec = JSON.parse(ln);
                    if (rec.type === "user" || rec.type === "assistant") {
                        count++;
                        if (!preview && rec.type === "user" && typeof rec.content === "string") {
                            preview = rec.content.slice(0, 120);
                        }
                    }
                }
                catch {
                    /* skip bad line */
                }
            }
            out.push({
                id: path.basename(f.dir),
                dir: f.dir,
                file: f.file,
                updatedAt: new Date(f.mtime).toISOString(),
                messageCount: count,
                preview,
            });
        }
        catch {
            /* skip */
        }
    }
    return out;
}
/** Replay a persisted session.jsonl into ChatMessage[] (system re-seeded by caller). */
export function loadSessionMessages(workspace, sessionId) {
    const dir = findSessionDir(workspace, sessionId);
    if (!dir)
        return null;
    try {
        const lines = fs.readFileSync(path.join(dir, "session.jsonl"), "utf-8").split("\n");
        const messages = [];
        for (const ln of lines) {
            if (!ln.trim())
                continue;
            try {
                const rec = JSON.parse(ln);
                if (rec.type === "user" && typeof rec.content === "string") {
                    messages.push({ role: "user", content: rec.content });
                }
                else if (rec.type === "assistant" && typeof rec.content === "string") {
                    messages.push({
                        role: "assistant",
                        content: rec.content,
                        ...(rec.tool_calls ? { tool_calls: rec.tool_calls } : {}),
                    });
                }
                else if (rec.type === "tool" && typeof rec.content === "string") {
                    messages.push({
                        role: "tool",
                        content: rec.content,
                        ...(rec.tool_call_id ? { tool_call_id: rec.tool_call_id } : {}),
                        ...(rec.name ? { name: rec.name } : {}),
                    });
                }
            }
            catch {
                /* skip malformed line */
            }
        }
        return messages;
    }
    catch {
        return null;
    }
}
/** Best-effort mirror into the Rust-shared XDG history. */
export function appendXdgHistory(text) {
    try {
        const dir = path.join(os.homedir(), ".local", "share", "muse");
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, "tui-history.jsonl"), JSON.stringify(text) + "\n", "utf-8");
    }
    catch {
        /* ignore */
    }
}
//# sourceMappingURL=session-store.js.map