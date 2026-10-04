/**
 * src/gateway/security.ts — SSRF blocker + prompt-injection fence.
 * Blocks: loopback (127/8, ::1), link-local (169.254/16), private RFC1918
 * (10/8, 172.16/12, 192.168/16), multicast/reserved, non-http(s) schemes,
 * credentials in URL, and DNS that resolves to a blocked IP.
 */
import * as dns from "node:dns";

export class SsrfBlockedError extends Error {
  constructor(public detail: string) {
    super(`SSRF_BLOCKED: ${detail}`);
    this.name = "SsrfBlockedError";
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

const BLOCKED_V4 = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "0.0.0.0/8",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "100.64.0.0/10",
  "192.0.2.0/24",
  "198.51.100.0/24",
  "203.0.113.0/24",
];

const BLOCKED_HOST_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

export function isBlockedIp(ip: string): boolean {
  const norm = ip.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/^::ffff:/, "");
  if (norm === "::1" || norm === "::" || norm.startsWith("fe80:") || norm.startsWith("fc") || norm.startsWith("fd") || norm.startsWith("ff")) {
    return true;
  }
  if (BLOCKED_HOST_RE.test(norm)) return true;
  for (const cidr of BLOCKED_V4) {
    if (inCidr(norm, cidr)) return true;
  }
  // Decimal/octal/hex localhost tricks (2130706433, 0x7f000001, 0177.0.0.1)
  if (/^\d+$/.test(norm) && Number(norm) >>> 0 === 2130706433) return true;
  if (/^0x[0-9a-f]+$/i.test(norm)) return true;
  return false;
}

export function assertUrlAllowed(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfBlockedError(`invalid URL: ${raw.slice(0, 120)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfBlockedError(`scheme not allowed: ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new SsrfBlockedError("credentials in URL are not allowed");
  }
  const host = u.hostname.toLowerCase();
  if (!host) throw new SsrfBlockedError("empty hostname");
  if (BLOCKED_HOST_RE.test(host)) {
    throw new SsrfBlockedError(`host blocked: ${host}`);
  }
  // Literal-IP hosts are checked synchronously; DNS names at fetch time.
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    if (isBlockedIp(host)) throw new SsrfBlockedError(`IP blocked: ${host}`);
  }
  if (/^0x/i.test(host) || /^0\d/.test(host) || /^\d+$/.test(host)) {
    throw new SsrfBlockedError(`obfuscated IP blocked: ${host}`);
  }
  return u;
}

/** Resolve a hostname and throw if ANY resolved address is blocked. */
export async function assertDnsAllowed(hostname: string): Promise<void> {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    if (isBlockedIp(hostname)) throw new SsrfBlockedError(`IP blocked: ${hostname}`);
    return;
  }
  let addrs: string[] = [];
  try {
    addrs = await dns.promises.lookup(hostname, { all: true }).then((r) => r.map((x) => x.address));
  } catch {
    return; // DNS failure surfaces as a fetch error, not SSRF.
  }
  for (const a of addrs) {
    if (isBlockedIp(a)) throw new SsrfBlockedError(`DNS for ${hostname} resolves to blocked IP ${a}`);
  }
}

/** Wrap web output so the model treats it as data, never instructions. */
export function fenceWebContent(source: string, body: string): string {
  return `<untrusted-web-content source="${source}">\n${body}\n</untrusted-web-content>`;
}
