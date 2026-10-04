/**
 * src/services/fs.ts — FsNano: optimized filesystem service.
 *
 * Fixes: sync I/O everywhere, no cache, repeated full scans.
 * - Async APIs (non-blocking TUI), sync fallbacks kept for tool bridge.
 * - mtime-aware LRU for readFile (500 entries) + listDir (200 entries).
 * - Ignore-aware search: .git, node_modules, .muse, dist, + .gitignore rules.
 * - All paths workspace-scoped; escape = throw.
 * - Sleeps after 60s idle (registry) — cache cleared on sleep (LMK friendly).
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Sleepable } from "./registry.js";

const READ_CACHE_MAX = 500;
const LIST_CACHE_MAX = 200;

interface CacheEntry<T> {
  value: T;
  mtimeMs: number;
  lastUse: number;
}

export class FsNano implements Sleepable {
  readonly name = "fs";
  readonly idleTtlMs = 60_000;
  readonly root: string;

  private readCache = new Map<string, CacheEntry<string>>();
  private listCache = new Map<string, CacheEntry<string>>();
  private ignoreRules: RegExp[] = [];
  private ignoreLoadedFor: string | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  wake(): void {
    // lazy — caches stay cold until first use.
  }

  sleep(): void {
    this.readCache.clear();
    this.listCache.clear();
    this.ignoreRules = [];
    this.ignoreLoadedFor = null;
  }

  resolve(p: string): string {
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(this.root, p);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes workspace root: ${p}`);
    }
    return abs;
  }

  // ---- sync core (used by WorkspaceTools bridge) ----

  readFileSync(p: string, offset = 1, limit = 200): string {
    const abs = this.resolve(p);
    const key = `${abs}:${offset}:${limit}`;
    try {
      const st = fs.statSync(abs);
      const hit = this.readCache.get(key);
      if (hit && hit.mtimeMs === st.mtimeMs) {
        hit.lastUse = Date.now();
        return hit.value;
      }
      const raw = fs.readFileSync(abs, "utf-8");
      const lines = raw.split("\n");
      const start = Math.max(1, offset);
      const slice = lines.slice(start - 1, start - 1 + Math.min(Math.max(1, limit), 2000));
      const numbered = slice.map((ln, i) => `${String(start + i).padStart(5)}| ${ln}`);
      const out = numbered.join("\n");
      this.setBounded(this.readCache, key, { value: out, mtimeMs: st.mtimeMs, lastUse: Date.now() }, READ_CACHE_MAX);
      return out;
    } catch (err) {
      this.readCache.delete(key);
      throw err;
    }
  }

  async readFile(p: string, offset = 1, limit = 200): Promise<string> {
    // Async wrapper — same cache, non-blocking stat+read.
    const abs = this.resolve(p);
    const key = `${abs}:${offset}:${limit}`;
    const st = await fsp.stat(abs);
    const hit = this.readCache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs) {
      hit.lastUse = Date.now();
      return hit.value;
    }
    const raw = await fsp.readFile(abs, "utf-8");
    const lines = raw.split("\n");
    const start = Math.max(1, offset);
    const slice = lines.slice(start - 1, start - 1 + Math.min(Math.max(1, limit), 2000));
    const out = slice.map((ln, i) => `${String(start + i).padStart(5)}| ${ln}`).join("\n");
    this.setBounded(this.readCache, key, { value: out, mtimeMs: st.mtimeMs, lastUse: Date.now() }, READ_CACHE_MAX);
    return out;
  }

  listDirSync(p = "."): string {
    const abs = this.resolve(p);
    const key = abs;
    try {
      const st = fs.statSync(abs);
      const hit = this.listCache.get(key);
      if (hit && hit.mtimeMs === st.mtimeMs) {
        hit.lastUse = Date.now();
        return hit.value;
      }
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      // dirs first, alpha — cheaper for model to scan.
      entries.sort((a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      );
      const out = entries.map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`).join("\n");
      this.setBounded(this.listCache, key, { value: out, mtimeMs: st.mtimeMs, lastUse: Date.now() }, LIST_CACHE_MAX);
      return out;
    } catch (err) {
      this.listCache.delete(key);
      throw err;
    }
  }

  async listDir(p = "."): Promise<string> {
    const abs = this.resolve(p);
    const st = await fsp.stat(abs);
    const hit = this.listCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs) {
      hit.lastUse = Date.now();
      return hit.value;
    }
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) =>
      Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    );
    const out = entries.map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`).join("\n");
    this.setBounded(this.listCache, abs, { value: out, mtimeMs: st.mtimeMs, lastUse: Date.now() }, LIST_CACHE_MAX);
    return out;
  }

  /** Scoped literal search. Async, early-exit, ignore-aware. */
  async search(pattern: string, dir = ".", maxMatches = 50): Promise<string> {
    const abs = this.resolve(dir);
    this.ensureIgnoreRules();
    const skip = new Set([".git", "node_modules", ".muse", "dist", ".agent_snapshots"]);
    const results: string[] = [];
    const stack: string[] = [abs];
    let filesScanned = 0;
    while (stack.length > 0 && results.length < maxMatches && filesScanned < 2000) {
      const cur = stack.pop() as string;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fsp.readdir(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (results.length >= maxMatches) break;
        if (skip.has(e.name)) continue;
        const full = path.join(cur, e.name);
        const rel = path.relative(this.root, full);
        if (this.isIgnored(rel)) continue;
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile()) {
          filesScanned++;
          let st: import("node:fs").Stats;
          try {
            st = await fsp.stat(full);
            if (st.size > 512 * 1024) continue;
          } catch {
            continue;
          }
          let text: string;
          try {
            text = await fsp.readFile(full, "utf-8");
          } catch {
            continue;
          }
          // line scan with early exit
          let idx = 0;
          let lineNo = 1;
          // simple split is fine under 512k
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && results.length < maxMatches; i++) {
            if (lines[i].includes(pattern)) {
              results.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`);
            }
            void idx; void lineNo;
          }
        }
      }
    }
    return results.length > 0
      ? results.join("\n")
      : `(no matches for ${JSON.stringify(pattern)} in ${dir})`;
  }

  searchSync(pattern: string, dir = ".", maxMatches = 50): string {
    // Sync fallback for WorkspaceTools bridge — same bounds.
    const abs = this.resolve(dir);
    this.ensureIgnoreRules();
    const skip = new Set([".git", "node_modules", ".muse", "dist", ".agent_snapshots"]);
    const results: string[] = [];
    const stack: string[] = [abs];
    let filesScanned = 0;
    while (stack.length > 0 && results.length < maxMatches && filesScanned < 2000) {
      const cur = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (results.length >= maxMatches) break;
        if (skip.has(e.name)) continue;
        const full = path.join(cur, e.name);
        const rel = path.relative(this.root, full);
        if (this.isIgnored(rel)) continue;
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile()) {
          filesScanned++;
          let text: string;
          try {
            const stat = fs.statSync(full);
            if (stat.size > 512 * 1024) continue;
            text = fs.readFileSync(full, "utf-8");
          } catch {
            continue;
          }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && results.length < maxMatches; i++) {
            if (lines[i].includes(pattern)) {
              results.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`);
            }
          }
        }
      }
    }
    return results.length > 0
      ? results.join("\n")
      : `(no matches for ${JSON.stringify(pattern)} in ${dir})`;
  }

  invalidate(p?: string): void {
    if (!p) {
      this.readCache.clear();
      this.listCache.clear();
      return;
    }
    try {
      const abs = this.resolve(p);
      for (const k of [...this.readCache.keys()]) if (k.startsWith(abs)) this.readCache.delete(k);
      for (const k of [...this.listCache.keys()]) if (k === abs || abs.startsWith(k)) this.listCache.delete(k);
      // parent dir listing changed on write
      try {
        const parent = path.dirname(abs);
        this.listCache.delete(parent);
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }

  private setBounded<T>(map: Map<string, CacheEntry<T>>, key: string, val: CacheEntry<T>, max: number): void {
    map.set(key, val);
    if (map.size <= max) return;
    // evict oldest lastUse
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of map) {
      if (v.lastUse < oldest) { oldest = v.lastUse; oldestKey = k; }
    }
    if (oldestKey !== null) map.delete(oldestKey);
  }

  private ensureIgnoreRules(): void {
    if (this.ignoreLoadedFor === this.root) return;
    this.ignoreLoadedFor = this.root;
    this.ignoreRules = [];
    try {
      const raw = fs.readFileSync(path.join(this.root, ".gitignore"), "utf-8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        // minimal glob → regex: * → .*, trailing / → dir prefix
        const esc = t.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        try {
          this.ignoreRules.push(new RegExp(`(^|/)${esc}(/|$)`));
        } catch { /* ignore bad rule */ }
      }
    } catch { /* no gitignore */ }
  }

  private isIgnored(rel: string): boolean {
    if (!rel) return false;
    for (const re of this.ignoreRules) {
      try {
        if (re.test(rel)) return true;
      } catch { /* ignore */ }
    }
    return false;
  }
}
