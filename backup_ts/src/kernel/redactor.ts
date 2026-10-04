/**
 * src/kernel/redactor.ts — secret redaction for logs, web content, trace.
 * Patterns: sk-*, ghp_*, AKIA*, -----BEGIN * PRIVATE KEY-----, Bearer tokens,
 * api keys in query strings, xoxb/xoxp slack tokens, npm_ tokens.
 */

const PATTERNS: { re: RegExp; label: string }[] = [
  { re: /sk-[A-Za-z0-9-_]{8,}/g, label: "[REDACTED]" },
  { re: /ghp_[A-Za-z0-9]{8,}/g, label: "[REDACTED]" },
  { re: /gho_[A-Za-z0-9]{8,}/g, label: "[REDACTED]" },
  { re: /AKIA[0-9A-Z]{16}/g, label: "[REDACTED]" },
  { re: /xox[bpas]-[A-Za-z0-9-]{8,}/g, label: "[REDACTED]" },
  { re: /npm_[A-Za-z0-9]{8,}/g, label: "[REDACTED]" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: "[REDACTED-PRIVATE-KEY]" },
  { re: /Bearer\s+[A-Za-z0-9\-._~+/=]{12,}/g, label: "Bearer [REDACTED]" },
  { re: /([?&](?:api[_-]?key|token|secret|password)=)[^&\s"']+/gi, label: "$1[REDACTED]" },
  { re: /(["']?(?:api[_-]?key|password|secret)["']?\s*[:=]\s*["']?)[^"'\s,}]{8,}/gi, label: "$1[REDACTED]" },
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, p.label);
  }
  return out;
}

/** Redact args object for trace logging (shallow-clone + redact string values). */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" ? redactSecrets(v) : v;
  }
  return out;
}

/** Stable short hash of args (FNV-1a hex) for trace.jsonl argsHash. */
export function hashArgs(args: unknown): string {
  const s = typeof args === "string" ? args : JSON.stringify(args ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
