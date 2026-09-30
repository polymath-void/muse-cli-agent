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
export declare const DEFAULT_AUTH_BASE_URL: string;
export declare const DEFAULT_API_BASE_URL: string;
/** Mint override observed in binary: TBH_MINT_BASE_URL */
export declare const MINT_BASE_URL: string;
export declare const CLIENT_NAME = "Muse Code";
export declare const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Binary enforces an OAuth response size bound; 1 MiB is a safe cap. */
export declare const OAUTH_SIZE_BOUND_BYTES: number;
export declare const DEFAULT_HTTP_TIMEOUT_MS = 20000;
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
    expires_at?: number;
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
export declare class AuthError extends Error {
    code: string;
    hint?: string;
    constructor(code: string, message: string, hint?: string);
}
export declare function resolveAuthPath(): string;
export declare function loadAuthFile(authPath?: string): AuthFile;
/** Atomic write (tmp + rename), 0600, preserves sibling providers. */
export declare function saveAuthFile(auth: AuthFile, authPath?: string): string;
export declare function getMetaAuth(auth?: AuthFile): MetaProviderAuth | undefined;
export declare function setMetaAuth(meta: MetaProviderAuth, authPath?: string): string;
export declare function clearMetaAuth(authPath?: string): boolean;
export declare function resolveCredential(authPath?: string): CredentialResolution | null;
export declare function credentialSummary(authPath?: string): {
    loggedIn: boolean;
    source: string | null;
    baseUrl: string | null;
    userEmail: string | null;
    obtainedVia: string | null;
    hasRefreshToken: boolean;
    expiresAt: number | null;
};
export declare function discoverProtectedResource(apiBaseUrl: string): Promise<ProtectedResourceMetadata | null>;
export declare function discoverAuthorizationServer(authBaseUrl: string, hintIssuers?: string[]): Promise<AuthorizationServerMetadata>;
export declare function registerClient(registrationEndpoint: string, opts?: {
    redirectUri?: string;
}): Promise<RegistrationResponse>;
export declare function requestDeviceAuthorization(deviceAuthorizationEndpoint: string, clientId: string, scope?: string): Promise<DeviceAuthorizationResponse>;
export declare function pollDeviceToken(tokenEndpoint: string, clientId: string, deviceCode: string, opts?: {
    intervalSec?: number;
    expiresInSec?: number;
    clientSecret?: string;
    onPending?: (elapsedSec: number, intervalSec: number) => void;
    signal?: AbortSignal;
}): Promise<TokenResponse>;
export declare function refreshAccessToken(tokenEndpoint: string, clientId: string, refreshToken: string, clientSecret?: string): Promise<TokenResponse>;
export declare function revokeToken(revocationEndpoint: string, token: string, clientId?: string): Promise<void>;
export declare function mintModelApiKey(mintBaseUrl: string, accessToken: string): Promise<MintedKey>;
export declare function openBrowser(url: string): boolean;
export declare function loginDeviceFlow(opts?: LoginOptions): Promise<{
    meta: MetaProviderAuth;
    authPath: string;
}>;
/** Refresh the stored OAuth grant when a refresh_token exists. */
export declare function refreshStoredGrant(authBaseUrl?: string, authPath?: string): Promise<MetaProviderAuth | null>;
export declare function logout(opts?: {
    revoke?: boolean;
    authBaseUrl?: string;
    authPath?: string;
}): Promise<boolean>;
/** `muse auth set --provider meta --api-key-stdin` equivalent. */
export declare function authSetApiKeyFromStdin(opts?: {
    provider?: string;
    apiBaseUrl?: string;
    authPath?: string;
}): Promise<string>;
