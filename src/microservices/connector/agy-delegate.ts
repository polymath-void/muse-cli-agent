/**
 * src/microservices/connector/agy-delegate.ts — delegate `agy` gateway to
 * the local agy-connector FastAPI router (default http://localhost:8080).
 *
 * Why delegation (not a native re-port):
 * - agy-connector already owns OAuth refresh (refreshToken → access_token via
 *   oauth2.googleapis.com), per-account per-model `rateLimitResetTimes`,
 *   `cachedQuota.resetTime` parsing, thinking-patch cascade, in-memory
 *   exact-hash cache, and RouteLatch fast-path + optimistic probe. Re-porting
 *   all of that natively duplicates state and drifts (see router.ts notes).
 * - The TS `UnifiedRouter` native `agy` path has no refresh and stale cascades, so try
 *   delegation first when the connector is reachable. Null = offline → native.
 *
 * Lightness contract (Termux LMK-safe):
 * - Zero deps, global fetch only, no background tasks/ports/listeners.
 * - Called lazily via `await import('./agy-delegate.js')` only when
 *   `providerKey === 'agy'`. Idle cost 0.
 * - Sequential fetch only, AbortController timeouts, SSE split via `\n\n`.
 * - Returns `null` on network failure so the caller falls back to native.
 *   HTTP 4xx/5xx returns the Response (caller decides).
 */

const CONNECTOR_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_000;

/** Base URL for the local connector. Env-overridable, no hardcoding. */
export function agyConnectorBase(): string {
  return (process.env.AGY_CONNECTOR_URL ?? "http://localhost:8080").replace(/\/+$/, "");
}

/** Strip gateway prefixes to the canonical clean model (`agy_connector.py:get_cascade_for_model`). */
export function cleanAgyModel(model: string): string {
  let m = String(model ?? "").trim();
  if (m.toLowerCase().startsWith("opencode/")) m = m.slice("opencode/".length);
  m = m.replace(/^models\//i, "").replace(/^antigravity-/i, "");
  return m || "gemini-3.1-pro";
}

/** URL model slug: connector accepts both, verify suite uses `antigravity-` prefix. */
export function agyUrlModel(model: string): string {
  const clean = cleanAgyModel(model);
  if (clean.toLowerCase().startsWith("antigravity-")) return clean;
  return `antigravity-${clean}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Fast probe for `muse-ts status` / diagnostics. Never throws. */
export async function isAgyConnectorAvailable(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${agyConnectorBase()}/status`, { method: "GET" }, timeoutMs);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * POST the inner Gemini body to the connector.
 * @param geminiBody the `{ contents, generationConfig, systemInstruction? }` object
 *   (NOT the antigravity envelope — the connector wraps it per-tier itself).
 * @returns fetch Response on any HTTP reply, or `null` when the connector is
 *   unreachable (refused/timeout) so the caller can fall back to native.
 */
export async function fetchAgyConnector(
  model: string,
  geminiBody: Record<string, unknown>,
  isStream: boolean,
  timeoutMs = CONNECTOR_TIMEOUT_MS,
): Promise<Response | null> {
  const base = agyConnectorBase();
  const urlModel = encodeURIComponent(agyUrlModel(model));
  const url = isStream
    ? `${base}/v1beta/models/${urlModel}:streamGenerateContent`
    : `${base}/v1beta/models/${urlModel}:generateContent`;
  try {
    return await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify(geminiBody),
      },
      timeoutMs,
    );
  } catch {
    return null;
  }
}
