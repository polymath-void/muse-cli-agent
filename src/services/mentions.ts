/**
 * src/services/mentions.ts — MentionNano: @file / @project / @skill expansion.
 *
 * Pure parser + workspace-scoped expander. Zero timers → sleeps immediately.
 * - `@file <path>` → bounded file window (same caps as read_file).
 * - `@project <name>` → <workspace>/Projects/<name> or basename match; ls + README head.
 * - `@skill <name>` → <workspace>/.agents/skills/<name>/SKILL.md or ~/.config/muse/skills/.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Sleepable } from "./registry.js";

export type MentionKind = "file" | "project" | "skill";

export interface Mention {
  kind: MentionKind;
  query: string;
  raw: string;
}

export interface ExpandResult {
  expanded: string;
  contextBlock: string;
  mentions: Mention[];
  errors: string[];
}

// Query grammar: quoted "multi word" supported; bare queries stop at
// whitespace/@/comma/semicolon so `@file a and @project b` parses as two mentions.
const MENTION_RE = /@(file|project|skill)\s+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s@,;\n]+))/gi;

export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const kind = m[1].toLowerCase() as MentionKind;
    const query = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (!query) continue;
    out.push({ kind, query, raw: m[0] });
  }
  return out;
}

export class MentionNano implements Sleepable {
  readonly name = "mentions";
  readonly idleTtlMs = 0; // pure — sleep immediately
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  wake(): void { /* nothing to hold */ }
  sleep(): void { /* nothing to release */ }

  private resolve(p: string): string {
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(this.root, p);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes workspace root: ${p}`);
    }
    return abs;
  }

  expand(text: string): ExpandResult {
    const mentions = parseMentions(text);
    if (mentions.length === 0) {
      return { expanded: text, contextBlock: "", mentions, errors: [] };
    }
    const blocks: string[] = [];
    const errors: string[] = [];
    for (const m of mentions.slice(0, 10)) {
      try {
        if (m.kind === "file") blocks.push(this.expandFile(m.query));
        else if (m.kind === "project") blocks.push(this.expandProject(m.query));
        else blocks.push(this.expandSkill(m.query));
      } catch (err) {
        errors.push(`@${m.kind} ${m.query}: ${(err as Error).message}`);
      }
    }
    const contextBlock = blocks.length > 0
      ? `<mentioned-context>\n${blocks.join("\n\n")}\n</mentioned-context>`
      : "";
    const expanded = contextBlock ? `${contextBlock}\n\n${text}` : text;
    return { expanded, contextBlock, mentions, errors };
  }

  private expandFile(query: string): string {
    const abs = this.resolve(query);
    const raw = fs.readFileSync(abs, "utf-8");
    const lines = raw.split("\n").slice(0, 200);
    const rel = path.relative(this.root, abs) || abs;
    return `--- @file ${rel} (first ${lines.length} lines) ---\n${lines.join("\n")}`;
  }

  private expandProject(query: string): string {
    const q = query.toLowerCase();
    const candidates: string[] = [];
    // <workspace>/Projects/<name>
    candidates.push(path.join(this.root, "Projects", query));
    // <workspace>/<name>
    candidates.push(path.join(this.root, query));
    // basename scan of <workspace>/Projects (bounded 200)
    try {
      const projs = path.join(this.root, "Projects");
      for (const e of fs.readdirSync(projs, { withFileTypes: true }).slice(0, 200)) {
        if (e.isDirectory() && e.name.toLowerCase().includes(q)) {
          candidates.push(path.join(projs, e.name));
        }
      }
    } catch { /* no Projects dir */ }
    for (const c of candidates) {
      let st: fs.Stats;
      try {
        st = fs.statSync(c);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      // verify inside workspace
      this.resolve(path.relative(this.root, c) || ".");
      const entries = fs.readdirSync(c, { withFileTypes: true }).slice(0, 60)
        .map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`).join("\n");
      let readme = "";
      for (const r of ["README.md", "readme.md", "agent.md", "package.json"]) {
        try {
          const rp = path.join(c, r);
          if (fs.statSync(rp).isFile()) {
            readme = `\n--- ${r} head ---\n${fs.readFileSync(rp, "utf-8").split("\n").slice(0, 40).join("\n")}`;
            break;
          }
        } catch { /* next */ }
      }
      const rel = path.relative(this.root, c);
      return `--- @project ${rel} ---\n${entries}${readme}`.slice(0, 6000);
    }
    throw new Error(`project not found: ${query}`);
  }

  private expandSkill(query: string): string {
    const q = query.replace(/[^a-zA-Z0-9-_]/g, "");
    const candidates: string[] = [
      path.join(this.root, ".agents", "skills", q, "SKILL.md"),
      path.join(this.root, ".agents", "skills", query, "SKILL.md"),
      path.join(os.homedir(), ".config", "muse", "skills", q, "SKILL.md"),
    ];
    // scan workspace skills dir for partial match
    try {
      const dir = path.join(this.root, ".agents", "skills");
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).slice(0, 100)) {
        if (e.isDirectory() && e.name.toLowerCase().includes(query.toLowerCase())) {
          candidates.push(path.join(dir, e.name, "SKILL.md"));
        }
      }
    } catch { /* none */ }
    for (const c of candidates) {
      try {
        if (!fs.statSync(c).isFile()) continue;
        const body = fs.readFileSync(c, "utf-8").slice(0, 4000);
        return `--- @skill ${q} (${c}) ---\n${body}`;
      } catch { /* next */ }
    }
    throw new Error(`skill not found: ${query}`);
  }
}
