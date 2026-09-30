/**
 * src/auth.ts — Native TypeScript Meta API authentication pipeline.
 *
 * Replaces the Rust binary (`$PREFIX/lib/muse/muse`) `login` flow with a
 * pure-TypeScript OAuth 2.0 Device Authorization Grant (RFC 8628) client.
 *
 * Evidence-grounded against the shipped Rust binary:
 * - default OAuth base:            https://auth.meta.com
 * - default Model API base:        https://api.meta.ai/v1
 * - device auth endpoint (suffix): /oidc/device/authorization/
 * - device token endpoint (suffix):/oidc/device/token/
 * - grant: urn:ietf:params:oauth:grant-type:device_code
 * - registration client_name:      "Muse Code"
 * - discovery: .well-known/oauth-protected-resource,
 *              .well-known/oauth-authorization-server,
 *              .well-known/openid-configuration
 * - TokenResponse: access_token, token_type, expires_in, refresh_token, scope
 * - MintedKey: api_key, require_payment, action_url, user_*, subs_*
 * - auth.json schema: { schema_version: 1,
 *     providers: { meta: { access_token, refresh_token?, expires_at?,
 *       obtained_via, api_key, api_base_url, user_full_name, user_email,
 *       user_avatar_url?, mechanism, record_version?, server_name?,
 *       resource_url_sha256?, issuer?, client_id?, registered_redirect_uri? } } }
 * - META_API_KEY env always takes priority over account login.
 *
 * NodeOS compliance:
 * - Zero hardcoded workspace directories. Credentials live in XDG config
 *   (`$XDG_CONFIG_HOME/muse/auth.json` or `~/.config/muse/auth.json`) for
 *   byte-compat with the Rust binary. NodeOS CWD-bound artifacts
 *   (agy_nodeos.db, workflow.json, daemon.log) are NOT touched here; they
 *   are handled by src/index.ts `init` and src/tui.ts sessions.
 *
 * Transport: global fetch (Node >= 18) with timeout + 1 MiB OAuth size bound.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_AUTH_BASE_URL =
  process.env.MUSE_AUTH_BASE_URL ?? "https://auth.meta.com";
export const DEFAULT_API_BASE_URL =
  process.env.MUSE_API_BASE_URL ?? "https://api.meta.ai/v1";
/** Mint override observed in binary: TBH_MINT_BASE_URL */
export const MINT_BASE_URL =
  process.env.TBH_MINT_BASE_URL ?? "https://api.meta.ai";
export const CLIENT_NAME = "Muse Code";
export const DEVICE_GRANT =
  "urn:ietf:params:oauth:grant-type:device_code";
/** Binary enforces an OAuth response size bound; 1 MiB is a safe cap. */
export const OAUTH_SIZE_BOUND_BYTES = 1024 * 1024;
export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

const AUTH_JSON_SCHEMA_VERSION = 1;
const MECHANISM_OAUTH = "oauth";
const OBTAINED_VIA_DEVICE_CODE = "device_code";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  [k: string]: unknown;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  device_authorization_endpoint?: string;
  scopes_supported?: string[];
  [k: string]: unknown;
}

export interface RegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_expires_at?: number;
  [k: string]: unknown;
}

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface MintedKey {
  api_key: string;
  require_payment?: boolean;
  action_url?: string;
  user_full_name?: string;
  user_email?: string;
  user_avatar_url?: string;
  is_subs_active?: boolean;
  subs_tier_id?: string;
  subs_tier_name?: string;
  is_subs_upgrade_available?: boolean;
  has_payment_method?: boolean;
  can_subscribe?: boolean;
  [k: string]: unknown;
}

export interface MetaProviderAuth {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // unix seconds
  obtained_via?: string;
  api_key?: string;
  api_base_url?: string;
  user_full_name?: string;
  user_email?: string;
  user_avatar_url?: string;
  mechanism?: string;
  record_version?: number;
  server_name?: string;
  resource_url_sha256?: string;
  issuer?: string;
  client_id?: string;
  registered_redirect_uri?: string;
  [k: string]: unknown;
}

export interface AuthFile {
  schema_version: number;
  providers: Record<string, MetaProviderAuth>;
}

export interface CredentialResolution {
  /** Bearer token to use for Model API calls. */
  token: string;
  source: "env:META_API_KEY" | "auth.json:api_key" | "auth.json:access_token";
  baseUrl: string;
  meta?: MetaProviderAuth;
}

export interface LoginEvents {
  onStatus?: (msg: string) => void;
  onDeviceCode?: (info: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
  }) => void;
}

export interface LoginOptions extends LoginEvents {
  authBaseUrl?: string;
  apiBaseUrl?: string;
  mintBaseUrl?: string;
  /** Poll interval floor in seconds (server `interval` wins when larger). */
  pollIntervalSec?: number;
  /** Open the verification URL in a browser (default true). */
  openBrowser?: boolean;
  /** Extra scope to request (default: none — server default). */
  scope?: string;
}

export class AuthError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------
// Storage (XDG, Rust-compatible)
// ---------------------------------------------------------------------------

export function resolveAuthPath(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");
  return path.join(xdg, "muse", "auth.json");
}

export function loadAuthFile(authPath?: string): AuthFile {
  const p = authPath ?? resolveAuthPath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(raw) as AuthFile;
    if (
      typeof data !== "object" ||
      data === null ||
      typeof data.schema_version !== "number" ||
      typeof data.providers !== "object" ||
      data.providers === null
    ) {
      return { schema_version: AUTH_JSON_SCHEMA_VERSION, providers: {} };
    }
    return data;
  } catch {
    return { schema_version: AUTH_JSON_SCHEMA_VERSION, providers: {} };
  }
}

/** Atomic write (tmp + rename), 0600, preserves sibling providers. */
export function saveAuthFile(auth: AuthFile, authPath?: string): string {
  const p = authPath ?? resolveAuthPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  // Drop undefined values to match Rust skip_serializing_if behaviour.
  const cleaned = JSON.parse(JSON.stringify(auth)) as AuthFile;
  cleaned.schema_version = AUTH_JSON_SCHEMA_VERSION;
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cleaned, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best-effort on odd filesystems */
  }
  fs.renameSync(tmp, p);
  return p;
}

export function getMetaAuth(auth?: AuthFile): MetaProviderAuth | undefined {
  const file = auth ?? loadAuthFile();
  return file.providers["meta"];
}

export function setMetaAuth(meta: MetaProviderAuth, authPath?: string): string {
  const file = loadAuthFile(authPath);
  file.providers["meta"] = meta;
  return saveAuthFile(file, authPath);
}

export function clearMetaAuth(authPath?: string): boolean {
  const file = loadAuthFile(authPath);
  if (!("meta" in file.providers)) return false;
  delete file.providers["meta"];
  saveAuthFile(file, authPath);
  return true;
}

// ---------------------------------------------------------------------------
// Credential resolution (META_API_KEY always wins)
// ---------------------------------------------------------------------------

export function resolveCredential(authPath?: string): CredentialResolution | null {
  const envKey = (process.env.META_API_KEY ?? "").trim();
  if (envKey.length > 0) {
    return {
      token: envKey,
      source: "env:META_API_KEY",
      baseUrl: process.env.MUSE_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    };
  }
  const meta = getMetaAuth(loadAuthFile(authPath));
  if (!meta) return null;
  const baseUrl = meta.api_base_url?.trim() || DEFAULT_API_BASE_URL;
  if (meta.api_key && meta.api_key.trim().length > 0) {
    return { token: meta.api_key.trim(), source: "auth.json:api_key", baseUrl, meta };
  }
  if (meta.access_token && meta.access_token.trim().length > 0) {
    return {
      token: meta.access_token.trim(),
      source: "auth.json:access_token",
      baseUrl,
      meta,
    };
  }
  return null;
}

export function credentialSummary(authPath?: string): {
  loggedIn: boolean;
  source: string | null;
  baseUrl: string | null;
  userEmail: string | null;
  obtainedVia: string | null;
  hasRefreshToken: boolean;
  expiresAt: number | null;
} {
  const resolved = resolveCredential(authPath);
  if (!resolved) {
    return {
      loggedIn: false,
      source: null,
      baseUrl: null,
      userEmail: null,
      obtainedVia: null,
      hasRefreshToken: false,
      expiresAt: null,
    };
  }
  return {
    loggedIn: true,
    source: resolved.source,
    baseUrl: resolved.baseUrl,
    userEmail: resolved.meta?.user_email ?? null,
    obtainedVia: resolved.meta?.obtained_via ?? (resolved.source.startsWith("env:") ? "env" : null),
    hasRefreshToken: Boolean(resolved.meta?.refresh_token),
    expiresAt: resolved.meta?.expires_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers (bounded, timed)
// ---------------------------------------------------------------------------

async function fetchBounded(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    const len = res.headers.get("content-length");
    if (len && Number(len) > OAUTH_SIZE_BOUND_BYTES) {
      throw new AuthError(
        "oauth_size_bound",
        "response body exceeds the OAuth size bound",
      );
    }
    return res;
  } catch (err: unknown) {
    if ((err as Error)?.name === "AbortError") {
      throw new AuthError("timeout", `request to ${url} timed out`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonBounded<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (text.length > OAUTH_SIZE_BOUND_BYTES) {
    throw new AuthError(
      "oauth_size_bound",
      "response body exceeds the OAuth size bound",
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AuthError(
      "invalid_json",
      `endpoint returned non-JSON (HTTP ${res.status})`,
    );
  }
}

function joinUrl(base: string, p: string): string {
  if (/^https?:\/\//i.test(p)) return p;
  const b = base.replace(/\/+$/, "");
  const suffix = p.startsWith("/") ? p : `/${p}`;
  return b + suffix;
}

function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

// ---------------------------------------------------------------------------
// Discovery (RFC 9728 + RFC 8414 + OIDC Discovery, with hardcoded fallback)
// ---------------------------------------------------------------------------

export async function discoverProtectedResource(
  apiBaseUrl: string,
): Promise<ProtectedResourceMetadata | null> {
  const origin = originOf(apiBaseUrl);
  const candidates = [
    `${origin}/.well-known/oauth-protected-resource`,
    `${apiBaseUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetchBounded(url, {
        headers: { accept: "application/json" },
        timeoutMs: 10_000,
      });
      if (!res.ok) continue;
      const meta = await readJsonBounded<ProtectedResourceMetadata>(res);
      if (meta && typeof (meta as { resource?: unknown }).resource === "string") {
        return meta;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function discoverAuthorizationServer(
  authBaseUrl: string,
  hintIssuers?: string[],
): Promise<AuthorizationServerMetadata> {
  const bases = [
    ...(hintIssuers ?? []).filter((s) => /^https?:\/\//i.test(s)),
    authBaseUrl,
  ];
  const tried: string[] = [];
  for (const base of bases) {
    const clean = base.replace(/\/+$/, "");
    for (const wellKnown of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]) {
      const url = clean + wellKnown;
      tried.push(url);
      try {
        const res = await fetchBounded(url, {
          headers: { accept: "application/json" },
          timeoutMs: 10_000,
        });
        if (!res.ok) continue;
        const meta = await readJsonBounded<AuthorizationServerMetadata>(res);
        if (meta && typeof meta.issuer === "string" && meta.issuer.length > 0) {
          return normaliseServerMetadata(meta, clean);
        }
      } catch {
        continue;
      }
    }
  }
  // Hardcoded fallback grounded in binary strings.
  const clean = authBaseUrl.replace(/\/+$/, "");
  return {
    issuer: clean,
    device_authorization_endpoint: `${clean}/oidc/device/authorization/`,
    token_endpoint: `${clean}/oidc/device/token/`,
    registration_endpoint: `${clean}/oidc/register`,
    revocation_endpoint: `${clean}/oidc/revoke`,
  };
}

function normaliseServerMetadata(
  meta: AuthorizationServerMetadata,
  base: string,
): AuthorizationServerMetadata {
  const out: AuthorizationServerMetadata = { ...meta };
  // Fill device endpoints when the server omits them but follows Meta paths.
  if (!out.device_authorization_endpoint) {
    out.device_authorization_endpoint = `${base}/oidc/device/authorization/`;
  }
  if (!out.token_endpoint) {
    out.token_endpoint = `${base}/oidc/device/token/`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

export async function registerClient(
  registrationEndpoint: string,
  opts: { redirectUri?: string } = {},
): Promise<RegistrationResponse> {
  const redirectUri =
    opts.redirectUri ?? "http://127.0.0.1:0/callback";
  const bodies: Record<string, unknown>[] = [
    {
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: [DEVICE_GRANT, "refresh_token"],
      response_types: ["none"],
      token_endpoint_auth_method: "none",
    },
    // Minimal retry for strict servers.
    {
      client_name: CLIENT_NAME,
      grant_types: [DEVICE_GRANT, "refresh_token"],
      token_endpoint_auth_method: "none",
    },
  ];
  let lastError = "";
  for (const body of bodies) {
    const res = await fetchBounded(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
      continue;
    }
    const data = await readJsonBounded<RegistrationResponse>(res);
    if (!data.client_id || data.client_id.length === 0) {
      lastError = "the registration response carried an empty client_id";
      continue;
    }
    return data;
  }
  // Final fallback: some Meta deployments accept an unregistered public
  // client id. There is no evidence for a static id in the binary, so fail
  // loudly instead of guessing one.
  throw new AuthError(
    "registration_failed",
    `client registration failed at ${registrationEndpoint}: ${lastError}`,
    "Check network access to auth.meta.com, then retry `login`.",
  );
}

// ---------------------------------------------------------------------------
// Device authorization (RFC 8628 §3.1)
// ---------------------------------------------------------------------------

export async function requestDeviceAuthorization(
  deviceAuthorizationEndpoint: string,
  clientId: string,
  scope?: string,
): Promise<DeviceAuthorizationResponse> {
  const form = new URLSearchParams();
  form.set("client_id", clientId);
  if (scope && scope.length > 0) form.set("scope", scope);
  const res = await fetchBounded(deviceAuthorizationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    if (res.status === 404) {
      throw new AuthError(
        "device_endpoint_missing",
        "device authorization endpoint not found (unlanded or gated off)",
        text,
      );
    }
    throw new AuthError(
      "device_authorization_failed",
      `device authorization failed: HTTP ${res.status} ${text}`,
    );
  }
  const data = await readJsonBounded<DeviceAuthorizationResponse>(res);
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new AuthError(
      "device_authorization_malformed",
      "device authorization response missing user_code or verification_uri",
    );
  }
  if (!data.verification_uri_complete) {
    data.verification_uri_complete = data.verification_uri;
  }
  if (!Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    data.expires_in = 600;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Device token polling (RFC 8628 §3.5)
// ---------------------------------------------------------------------------

export async function pollDeviceToken(
  tokenEndpoint: string,
  clientId: string,
  deviceCode: string,
  opts: {
    intervalSec?: number;
    expiresInSec?: number;
    clientSecret?: string;
    onPending?: (elapsedSec: number, intervalSec: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<TokenResponse> {
  let intervalSec = Math.max(1, Math.floor(opts.intervalSec ?? 5));
  const deadline = Date.now() + (opts.expiresInSec ?? 600) * 1000;
  const started = Date.now();

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new AuthError("login_cancelled", "Login cancelled.");
    }
    await sleep(intervalSec * 1000);
    if (opts.signal?.aborted) {
      throw new AuthError("login_cancelled", "Login cancelled.");
    }
    const form = new URLSearchParams();
    form.set("grant_type", DEVICE_GRANT);
    form.set("device_code", deviceCode);
    form.set("client_id", clientId);
    if (opts.clientSecret) form.set("client_secret", opts.clientSecret);

    let res: Response;
    try {
      res = await fetchBounded(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    } catch (err) {
      // Transient network error: keep polling until expiry.
      opts.onPending?.(Math.floor((Date.now() - started) / 1000), intervalSec);
      void err;
      continue;
    }
    if (res.ok) {
      const data = await readJsonBounded<TokenResponse>(res);
      if (!data.access_token) {
        throw new AuthError("token_malformed", "token response missing access_token");
      }
      return data;
    }
    let code = "";
    try {
      const body = await readJsonBounded<{ error?: string; error_description?: string }>(
        res,
      );
      code = body.error ?? "";
      if (code === "authorization_pending") {
        opts.onPending?.(Math.floor((Date.now() - started) / 1000), intervalSec);
        continue;
      }
      if (code === "slow_down") {
        intervalSec += 5;
        opts.onPending?.(Math.floor((Date.now() - started) / 1000), intervalSec);
        continue;
      }
      if (code === "access_denied") {
        throw new AuthError("login_denied", "login request was denied");
      }
      if (code === "expired_token") {
        throw new AuthError(
          "login_expired",
          "login request expired before acceptance",
          "Run `login` again to get a fresh code.",
        );
      }
      throw new AuthError(
        "token_failed",
        `login request failed: ${code || `HTTP ${res.status}`}`,
      );
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError("token_failed", `login request failed: HTTP ${res.status}`);
    }
  }
  throw new AuthError(
    "login_expired",
    "timed out before acceptance",
    "Run `login` again to get a fresh code.",
  );
}

// ---------------------------------------------------------------------------
// Refresh / revoke
// ---------------------------------------------------------------------------

export async function refreshAccessToken(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
  clientSecret?: string,
): Promise<TokenResponse> {
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("client_id", clientId);
  if (clientSecret) form.set("client_secret", clientSecret);
  const res = await fetchBounded(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new AuthError(
      "refresh_failed",
      `your saved login is no longer valid. Log in again or use a different account. (${text || `HTTP ${res.status}`})`,
    );
  }
  return readJsonBounded<TokenResponse>(res);
}

export async function revokeToken(
  revocationEndpoint: string,
  token: string,
  clientId?: string,
): Promise<void> {
  const form = new URLSearchParams();
  form.set("token", token);
  if (clientId) form.set("client_id", clientId);
  try {
    await fetchBounded(revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      timeoutMs: 10_000,
    });
  } catch {
    // Revocation is best-effort; local logout proceeds regardless.
  }
}

// ---------------------------------------------------------------------------
// Model API key minting (Meta-specific, after OAuth)
// ---------------------------------------------------------------------------

export async function mintModelApiKey(
  mintBaseUrl: string,
  accessToken: string,
): Promise<MintedKey> {
  const base = mintBaseUrl.replace(/\/+$/, "");
  // Observed suffix is `muse-code/key`; the versioned base already ends in
  // /v1, so try the unversioned host form first, then the /v1 form.
  const candidates = [`${base}/muse-code/key`, `${base}/v1/muse-code/key`];
  let lastError = "";
  for (const url of candidates) {
    for (const method of ["POST", "GET"] as const) {
      try {
        const res = await fetchBounded(url, {
          method,
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: "application/json",
            ...(method === "POST" ? { "content-type": "application/json" } : {}),
          },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        if (res.status === 404) {
          lastError = `HTTP 404 at ${url}`;
          break; // try next URL, not next method
        }
        if (!res.ok) {
          const text = (await res.text()).slice(0, 500);
          if (/onboarding|dev\.meta\.ai/i.test(text)) {
            throw new AuthError(
              "onboarding_required",
              "your Meta account isn't set up for Model API yet — finish onboarding at https://dev.meta.ai, then log in again.",
            );
          }
          lastError = `HTTP ${res.status}: ${text}`;
          continue;
        }
        const data = await readJsonBounded<MintedKey>(res);
        if (!data.api_key) {
          lastError = "mint response missing api_key";
          continue;
        }
        if (data.require_payment) {
          const action =
            data.action_url ??
            "https://accountscenter.meta.com/muse_code/?ep=no_payg";
          throw new AuthError(
            "payment_required",
            `Muse Code requires a payment method — subscribe at ${action}, then log in again.`,
          );
        }
        return data;
      } catch (err) {
        if (err instanceof AuthError) throw err;
        lastError = (err as Error).message;
      }
    }
  }
  throw new AuthError("mint_failed", `Model API key mint failed: ${lastError}`);
}

// ---------------------------------------------------------------------------
// Browser opener (Termux-aware)
// ---------------------------------------------------------------------------

export function openBrowser(url: string): boolean {
  const testOpener = process.env.TBH_TEST_BROWSER_OPENER;
  if (testOpener && testOpener.length > 0) {
    try {
      const r = spawnSync(testOpener, [url], { stdio: "ignore", shell: true });
      if (r.status === 0) return true;
    } catch {
      /* fall through */
    }
  }
  const candidates: string[][] = [
    ["termux-open-url", url],
    ["xdg-open", url],
    ["open", url],
  ];
  for (const [cmd, arg] of candidates) {
    try {
      const r = spawnSync(cmd, [arg], { stdio: "ignore" });
      if (r.status === 0) return true;
    } catch {
      continue;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Full login pipeline
// ---------------------------------------------------------------------------

export async function loginDeviceFlow(
  opts: LoginOptions = {},
): Promise<{ meta: MetaProviderAuth; authPath: string }> {
  const status = opts.onStatus ?? (() => {});
  const authBase = (opts.authBaseUrl ?? DEFAULT_AUTH_BASE_URL).replace(/\/+$/, "");
  const apiBase = (opts.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  const mintBase = (opts.mintBaseUrl ?? MINT_BASE_URL).replace(/\/+$/, "");

  status("Discovering Meta OAuth endpoints…");
  const prm = await discoverProtectedResource(apiBase);
  const server = await discoverAuthorizationServer(
    authBase,
    prm?.authorization_servers,
  );
  console.log("SERVER METADATA:", server);
  if (!server.device_authorization_endpoint || !server.token_endpoint) {
    throw new AuthError(
      "device_endpoint_missing",
      "device authorization endpoint not found (unlanded or gated off)",
    );
  }

  status("Registering device client…");
  let clientId = "";
  let clientSecret: string | undefined;
  let registeredRedirect: string | undefined;
  if (server.registration_endpoint) {
    try {
      const reg = await registerClient(server.registration_endpoint);
      clientId = reg.client_id;
      clientSecret = reg.client_secret;
      registeredRedirect = "http://127.0.0.1:0/callback";
    } catch (err) {
      // Registration is expected on Meta; fail loudly (no static id guess).
      throw err;
    }
  } else {
    // Fallback if Meta removes dynamic registration in this environment.
    clientId = "muse-cli";
  }

  status("Requesting device code…");
  const device = await requestDeviceAuthorization(
    server.device_authorization_endpoint,
    clientId,
    opts.scope,
  );
  const complete = device.verification_uri_complete ?? device.verification_uri;
  opts.onDeviceCode?.({
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    verificationUriComplete: complete,
  });

  if (opts.openBrowser !== false) {
    openBrowser(complete);
  }

  status("Waiting for browser approval…");
  const token = await pollDeviceToken(
    server.token_endpoint,
    clientId,
    device.device_code,
    {
      intervalSec: Math.max(
        device.interval ?? 5,
        opts.pollIntervalSec ?? 5,
      ),
      expiresInSec: device.expires_in,
      clientSecret,
    },
  );

  status("Minting Model API key…");
  const minted = await mintModelApiKey(mintBase, token.access_token);

  const nowSec = Math.floor(Date.now() / 1000);
  const meta: MetaProviderAuth = {
    access_token: token.access_token,
    ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
    ...(token.expires_in
      ? { expires_at: nowSec + token.expires_in }
      : {}),
    obtained_via: OBTAINED_VIA_DEVICE_CODE,
    api_key: minted.api_key,
    api_base_url: apiBase,
    ...(minted.user_full_name ? { user_full_name: minted.user_full_name } : {}),
    ...(minted.user_email ? { user_email: minted.user_email } : {}),
    ...(minted.user_avatar_url
      ? { user_avatar_url: minted.user_avatar_url }
      : {}),
    mechanism: MECHANISM_OAUTH,
    record_version: 1,
    server_name: "meta",
    resource_url_sha256: createHash("sha256").update(apiBase).digest("hex"),
    issuer: server.issuer,
    client_id: clientId,
    ...(registeredRedirect ? { registered_redirect_uri: registeredRedirect } : {}),
  };
  const authPath = setMetaAuth(meta);
  return { meta, authPath };
}

/** Refresh the stored OAuth grant when a refresh_token exists. */
export async function refreshStoredGrant(
  authBaseUrl?: string,
  authPath?: string,
): Promise<MetaProviderAuth | null> {
  const file = loadAuthFile(authPath);
  const meta = file.providers["meta"];
  if (!meta?.refresh_token) return null;
  const authBase = (authBaseUrl ?? DEFAULT_AUTH_BASE_URL).replace(/\/+$/, "");
  const server = await discoverAuthorizationServer(authBase);
  if (!server.token_endpoint || !meta.client_id) return null;
  const token = await refreshAccessToken(
    server.token_endpoint,
    meta.client_id,
    meta.refresh_token,
  );
  const nowSec = Math.floor(Date.now() / 1000);
  meta.access_token = token.access_token;
  if (token.refresh_token) meta.refresh_token = token.refresh_token;
  if (token.expires_in) meta.expires_at = nowSec + token.expires_in;
  saveAuthFile(file, authPath);
  return meta;
}

export async function logout(opts: {
  revoke?: boolean;
  authBaseUrl?: string;
  authPath?: string;
} = {}): Promise<boolean> {
  const file = loadAuthFile(opts.authPath);
  const meta = file.providers["meta"];
  if (!meta) return false;
  if (opts.revoke !== false) {
    try {
      const authBase = (opts.authBaseUrl ?? DEFAULT_AUTH_BASE_URL).replace(/\/+$/, "");
      const server = await discoverAuthorizationServer(authBase);
      if (server.revocation_endpoint) {
        if (meta.access_token) {
          await revokeToken(server.revocation_endpoint, meta.access_token, meta.client_id);
        }
        if (meta.refresh_token) {
          await revokeToken(server.revocation_endpoint, meta.refresh_token, meta.client_id);
        }
      }
    } catch {
      /* local logout proceeds */
    }
  }
  return clearMetaAuth(opts.authPath);
}

/** `muse auth set --provider meta --api-key-stdin` equivalent. */
export async function authSetApiKeyFromStdin(opts: {
  provider?: string;
  apiBaseUrl?: string;
  authPath?: string;
} = {}): Promise<string> {
  const provider = opts.provider ?? "meta";
  if (provider !== "meta") {
    throw new AuthError("provider_unsupported", `unknown provider: ${provider}`);
  }
  const key = await readAllStdin();
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new AuthError("empty_key", "no API key received on stdin");
  }
  const file = loadAuthFile(opts.authPath);
  const prev = file.providers["meta"] ?? {};
  file.providers["meta"] = {
    ...prev,
    api_key: trimmed,
    api_base_url:
      prev.api_base_url ?? opts.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    mechanism: prev.mechanism ?? MECHANISM_OAUTH,
    obtained_via: prev.obtained_via ?? "api_key_stdin",
  };
  return saveAuthFile(file, opts.authPath);
}

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(
        new AuthError(
          "stdin_required",
          "API key must be piped via --api-key-stdin (never passed on the command line)",
        ),
      );
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        reject(new AuthError("key_too_large", "stdin API key exceeds 64 KiB"));
        process.stdin.destroy();
      }
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", (e) => reject(e));
  });
}
