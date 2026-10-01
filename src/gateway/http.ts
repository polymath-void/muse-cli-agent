/**
 * src/gateway/http.ts — Native fetch gateway: AbortController timeout (15s),
 * redirect cap (5), max-body 2MB, allowlist/blocklist hooks, cache, robots.
 */
import { assertUrlAllowed, assertDnsAllowed, fenceWebContent, SsrfBlockedError } from "./security.js";
import { readCache, writeCache } from "./cache.js";
import { fetchRobots, isDisallowed, RobotsBlockedError } from "./robots.js";
import { extractReadable } from "./readability.js";
import { redactSecrets } from "../kernel/redactor.js";

export const UA = "Muse-SuperAgent/1.0";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 5;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface FetchOpts {
  workspace: string;
  timeoutMs?: number;
  noCache?: boolean;
  respectRobots?: boolean;
  selector?: string;
  markdown?: boolean;
  /** Extra allowlisted domains (subdomains included). Empty = allow all public. */
  allowDomains?: string[];
  /** Fetch override for tests (defaults to global fetch). */
  fetcher?: typeof fetch;
  offline?: boolean;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  title: string;
  output: string;
  fromCache: boolean;
  truncated: boolean;
}

function domainAllowed(host: string, allowDomains?: string[]): boolean {
  if (!allowDomains || allowDomains.length === 0) return true;
  const h = host.toLowerCase();
  return allowDomains.some((d) => {
    const dd = d.toLowerCase();
    return h === dd || h.endsWith(`.${dd}`);
  });
}

export async function fetchUrl(rawUrl: string, opts: FetchOpts): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = opts.fetcher ?? fetch;
  const u = assertUrlAllowed(rawUrl);
  if (!domainAllowed(u.hostname, opts.allowDomains)) {
    throw new SsrfBlockedError(`domain not allowlisted: ${u.hostname}`);
  }
  await assertDnsAllowed(u.hostname);

  if (!opts.noCache) {
    const hit = readCache(opts.workspace, rawUrl);
    if (hit) {
      const page = extractReadable(hit.body, opts.selector);
      const body = opts.markdown === false ? page.markdown : page.markdown;
      return {
        url: rawUrl,
        finalUrl: rawUrl,
        title: page.title,
        output: fenceWebContent(rawUrl, body),
        fromCache: true,
        truncated: page.truncated,
      };
    }
  }
  if (opts.offline) {
    throw new Error("OFFLINE: no cached copy available (web gateway returns cached only in --offline mode)");
  }

  if (opts.respectRobots !== false) {
    const robots = await fetchRobots(u.origin, opts.workspace);
    if (isDisallowed(robots, u.pathname || "/")) {
      throw new RobotsBlockedError(u.pathname || "/");
    }
  }

  // Manual redirect loop so the cap + per-hop SSRF checks hold.
  let current = u.toString();
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      res = await fetcher(current, {
        signal: ctl.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/*;q=0.9,*/*;q=0.8" },
        redirect: "manual",
      });
    } finally {
      clearTimeout(t);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, current).toString();
      const nu = assertUrlAllowed(next);
      await assertDnsAllowed(nu.hostname);
      current = next;
      try {
        await res.arrayBuffer();
      } catch {
        /* ignore */
      }
      res = null;
      continue;
    }
    break;
  }
  if (!res) throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BODY_BYTES) throw new Error(`body too large: ${buf.length} > ${MAX_BODY_BYTES}`);
  const text = redactSecrets(buf.toString("utf-8"));
  if (!opts.noCache) writeCache(opts.workspace, rawUrl, text);

  const page = extractReadable(text, opts.selector);
  return {
    url: rawUrl,
    finalUrl: current,
    title: page.title,
    output: fenceWebContent(current, page.markdown),
    fromCache: false,
    truncated: page.truncated,
  };
}
