/**
 * src/gateway/robots.ts — native robots.txt fetch + 24h cache + Disallow check.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const UA = "Muse-SuperAgent/1.0";

function robotsCacheFile(workspace: string, origin: string): string {
  const h = createHash("sha256").update(origin).digest("hex");
  return path.join(path.resolve(workspace), ".muse", "cache", "robots", `${h}.txt`);
}

export async function fetchRobots(origin: string, workspace: string, timeoutMs = 8000): Promise<string | null> {
  const p = robotsCacheFile(workspace, origin);
  try {
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs < 86_400_000) return fs.readFileSync(p, "utf-8");
  } catch {
    /* miss */
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`${origin}/robots.txt`, {
      signal: ctl.signal,
      headers: { "user-agent": UA },
      redirect: "follow",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const text = (await res.text()).slice(0, 100_000);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, "utf-8");
    } catch {
      /* ignore */
    }
    return text;
  } catch {
    return null;
  }
}

/** True when robots.txt Disallows path for our UA (or *). Fail-open on fetch error. */
export function isDisallowed(robotsText: string | null, urlPath: string): boolean {
  if (!robotsText) return false;
  const lines = robotsText.split("\n").map((l) => l.trim());
  let inScope = false;
  const disallows: string[] = [];
  for (const line of lines) {
    const [rawField, ...rest] = line.split(":");
    const field = (rawField ?? "").trim().toLowerCase();
    const value = rest.join(":").trim();
    if (field === "user-agent") {
      inScope = value === "*" || value.toLowerCase().includes("muse");
    } else if (field === "disallow" && inScope) {
      if (value) disallows.push(value);
    }
  }
  for (const d of disallows) {
    if (d === "/") return true;
    if (urlPath === d || urlPath.startsWith(d.endsWith("/") ? d : d + "/") || urlPath.startsWith(d)) return true;
  }
  return false;
}

export class RobotsBlockedError extends Error {
  constructor(public urlPath: string) {
    super(`ROBOTS_DISALLOW: ${urlPath} is disallowed by robots.txt`);
    this.name = "RobotsBlockedError";
  }
}
