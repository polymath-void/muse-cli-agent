/**
 * src/gateway/cache.ts — file-backed GET cache: .muse/cache/http/<sha256>.json
 * TTL 1h default, --no-cache override.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface CacheEntry {
  url: string;
  fetchedAt: number;
  body: string;
}

export function cacheFile(workspace: string, url: string): string {
  const h = createHash("sha256").update(url).digest("hex");
  return path.join(path.resolve(workspace), ".muse", "cache", "http", `${h}.json`);
}

export function readCache(workspace: string, url: string, ttlMs = 3_600_000): CacheEntry | null {
  try {
    const raw = fs.readFileSync(cacheFile(workspace, url), "utf-8");
    const e = JSON.parse(raw) as CacheEntry;
    if (e.url !== url) return null;
    if (Date.now() - e.fetchedAt > ttlMs) return null;
    return e;
  } catch {
    return null;
  }
}

export function writeCache(workspace: string, url: string, body: string): void {
  try {
    const p = cacheFile(workspace, url);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ url, fetchedAt: Date.now(), body }), "utf-8");
  } catch {
    /* cache is best-effort */
  }
}
