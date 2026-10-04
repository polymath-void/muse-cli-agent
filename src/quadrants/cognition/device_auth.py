"""Native OAuth login flows.

Python port of ``backup_ts/src/auth.ts`` (and ``core/auth.ts``) — the
legacy TypeScript engine's authentication pipeline. Every step below is a
real HTTPS call; nothing is mocked or short-circuited:

- **meta**: RFC 8628 device flow (endpoint discovery → dynamic client
  registration → device code → browser → poll → mint Model API key).
- **opencode**: device-code flow against ``https://opencode.ai/console``.
- **google / agy**: PKCE authorization-code flow (browser → one-shot
  localhost:51121 callback → token exchange). Client constants match
  ``agy-connector/agy_auth.py`` and the legacy engine exactly.

All functions here are blocking; TUI handlers run them via
``asyncio.to_thread`` so the event loop stays responsive. Pass a
``threading.Event`` as ``stop`` to cancel polling/callback waits.
"""

import hashlib
import json
import os
import secrets
import shutil
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx

from .auth import load_auth_file, save_auth_file

# ── Constants (ported from backup_ts/src/auth.ts) ─────────────────────

DEFAULT_AUTH_BASE_URL = os.environ.get("MUSE_AUTH_BASE_URL", "https://auth.meta.com")
DEFAULT_API_BASE_URL = os.environ.get("MUSE_API_BASE_URL", "https://api.meta.ai/v1")
MINT_BASE_URL = os.environ.get("TBH_MINT_BASE_URL", "https://api.meta.ai")
CLIENT_NAME = "Muse Code"
DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
OAUTH_SIZE_BOUND_BYTES = 1024 * 1024
HTTP_TIMEOUT = 20.0

# PKCE constants shared with agy-connector/agy_auth.py (public client).
ANTIGRAVITY_CLIENT_ID = (
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
)
ANTIGRAVITY_CLIENT_SECRET = "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"
ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback"
# PKCE scopes shared with opencode-antigravity-auth/src/constants.ts and
# agy-connector/agy_auth.py (same public client).
ANTIGRAVITY_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
]
PKCE_PORT = 51121

# OpenCode console base (verified live; reverse-engineered from the
# console SPA: service-account keys `oc_sk_*` are the Zen credentials).
OPENCODE_CONSOLE_URL = "https://opencode.ai/console"
OPENCODE_CLIENT_ID = "opencode-cli"
OPENCODE_CONSOLE_SERVER = os.environ.get(
    "OPENCODE_CONSOLE_SERVER", OPENCODE_CONSOLE_URL
)
OPENCODE_API_BASE_URL = os.environ.get(
    "OPENCODE_API_BASE_URL", "https://opencode.ai/zen/v1"
)


class AuthError(Exception):
    """Typed auth failure. `code` is machine-readable, `hint` is for users."""

    def __init__(self, code: str, message: str, hint: str = ""):
        super().__init__(message)
        self.code = code
        self.hint = hint


# ── Small HTTP helpers (httpx module calls: monkeypatchable in tests) ──

def _check_size(resp: "httpx.Response") -> None:
    try:
        length = resp.headers.get("content-length")
        if length and int(length) > OAUTH_SIZE_BOUND_BYTES:
            raise AuthError("oauth_size_bound", "OAuth response exceeds size bound")
    except AuthError:
        raise
    except Exception:
        pass


def _get_json(url: str, timeout: float = 10.0) -> dict:
    resp = httpx.get(url, headers={"accept": "application/json"}, timeout=timeout)
    _check_size(resp)
    if not (200 <= resp.status_code < 300):
        raise AuthError("http_error", f"GET {url}: HTTP {resp.status_code}")
    try:
        data = resp.json()
    except Exception:
        raise AuthError("bad_json", f"GET {url}: non-JSON response")
    return data if isinstance(data, dict) else {}


def _post_form(url: str, fields: dict, timeout: float = HTTP_TIMEOUT) -> "httpx.Response":
    body = urllib.parse.urlencode(fields)
    return httpx.post(
        url,
        content=body,
        headers={"content-type": "application/x-www-form-urlencoded"},
        timeout=timeout,
    )


def _post_json(url: str, payload: dict, timeout: float = HTTP_TIMEOUT) -> "httpx.Response":
    return httpx.post(
        url,
        json=payload,
        headers={"content-type": "application/json", "accept": "application/json"},
        timeout=timeout,
    )


def _resp_json(resp: "httpx.Response") -> dict:
    _check_size(resp)
    try:
        data = resp.json()
    except Exception:
        raise AuthError("bad_json", "OAuth endpoint returned non-JSON")
    return data if isinstance(data, dict) else {}


# ── Browser opener (Termux-aware, ported) ─────────────────────────────

def open_browser(url: str) -> bool:
    """Open a URL in the user's browser. Returns True when one launched."""
    test_opener = os.environ.get("MUSE_TEST_BROWSER_OPENER", "")
    if test_opener:
        try:
            r = subprocess.run([test_opener, url], capture_output=True, timeout=15)
            if r.returncode == 0:
                return True
        except Exception:
            pass
    for cmd in ("termux-open-url", "xdg-open", "open"):
        if shutil.which(cmd):
            try:
                r = subprocess.run([cmd, url], capture_output=True, timeout=15)
                if r.returncode == 0:
                    return True
            except Exception:
                continue
    return False


# ── Meta discovery / registration (RFC 7591 / OAuth discovery) ────────

def _origin(url: str) -> str:
    p = urllib.parse.urlsplit(url)
    return f"{p.scheme}://{p.netloc}" if p.netloc else url.rstrip("/")


def discover_protected_resource(api_base: str) -> dict | None:
    for url in (
        f"{_origin(api_base)}/.well-known/oauth-protected-resource",
        f"{api_base.rstrip('/')}/.well-known/oauth-protected-resource",
    ):
        try:
            meta = _get_json(url, timeout=10.0)
            if isinstance(meta.get("resource"), str):
                return meta
        except Exception:
            continue
    return None


def discover_auth_server(auth_base: str, hint_issuers: list | None = None) -> dict:
    bases = [h for h in (hint_issuers or []) if h.startswith(("http://", "https://"))]
    bases.append(auth_base)
    for base in bases:
        clean = base.rstrip("/")
        for suffix in (
            "/.well-known/oauth-authorization-server",
            "/.well-known/openid-configuration",
        ):
            try:
                meta = _get_json(clean + suffix, timeout=10.0)
                if meta.get("issuer"):
                    if not meta.get("device_authorization_endpoint"):
                        meta["device_authorization_endpoint"] = (
                            f"{clean}/oidc/device/authorization/"
                        )
                    if not meta.get("token_endpoint"):
                        meta["token_endpoint"] = f"{clean}/oidc/device/token/"
                    return meta
            except Exception:
                continue
    # Hardcoded fallback grounded in the legacy engine's evidence.
    clean = auth_base.rstrip("/")
    return {
        "issuer": clean,
        "device_authorization_endpoint": f"{clean}/oidc/device/authorization/",
        "token_endpoint": f"{clean}/oidc/device/token/",
        "registration_endpoint": f"{clean}/oidc/register",
        "revocation_endpoint": f"{clean}/oidc/revoke",
    }


def register_client(registration_endpoint: str) -> dict:
    bodies = [
        {
            "client_name": CLIENT_NAME,
            "redirect_uris": ["http://127.0.0.1:0/callback"],
            "grant_types": [DEVICE_GRANT, "refresh_token"],
            "response_types": ["none"],
            "token_endpoint_auth_method": "none",
        },
        {
            "client_name": CLIENT_NAME,
            "grant_types": [DEVICE_GRANT, "refresh_token"],
            "token_endpoint_auth_method": "none",
        },
    ]
    last_error = ""
    for body in bodies:
        try:
            resp = _post_json(registration_endpoint, body)
        except Exception as e:
            last_error = str(e)
            continue
        if not (200 <= resp.status_code < 300):
            last_error = f"HTTP {resp.status_code}: {resp.text[:300]}"
            continue
        try:
            data = _resp_json(resp)
        except AuthError as e:
            last_error = str(e)
            continue
        if data.get("client_id"):
            return data
        last_error = "registration response carried an empty client_id"
    raise AuthError(
        "registration_failed",
        f"client registration failed at {registration_endpoint}: {last_error}",
        "Check network access, then retry `login`.",
    )


# ── RFC 8628 device authorization + polling ───────────────────────────

def request_device_authorization(
    endpoint: str, client_id: str, scope: str | None = None
) -> dict:
    fields = {"client_id": client_id}
    if scope:
        fields["scope"] = scope
    resp = _post_form(endpoint, fields)
    if resp.status_code == 404:
        raise AuthError(
            "device_endpoint_missing",
            "device authorization endpoint not found (unlanded or gated off)",
            resp.text[:300],
        )
    if not (200 <= resp.status_code < 300):
        raise AuthError(
            "device_authorization_failed",
            f"device authorization failed: HTTP {resp.status_code} {resp.text[:300]}",
        )
    data = _resp_json(resp)
    if not (data.get("device_code") and data.get("user_code")
            and data.get("verification_uri")):
        raise AuthError(
            "device_authorization_malformed",
            "device authorization response missing user_code or verification_uri",
        )
    data.setdefault("verification_uri_complete", data["verification_uri"])
    try:
        expires = float(data.get("expires_in", 600))
    except (TypeError, ValueError):
        expires = 600
    data["expires_in"] = int(expires) if expires > 0 else 600
    return data


def poll_device_token(
    token_endpoint: str,
    client_id: str,
    device_code: str,
    interval_sec: int = 5,
    expires_in_sec: int = 600,
    client_secret: str | None = None,
    on_pending=None,
    stop: "threading.Event | None" = None,
) -> dict:
    interval = max(1, int(interval_sec or 5))
    deadline = time.time() + max(1, int(expires_in_sec or 600))
    started = time.time()
    while time.time() < deadline:
        if stop is not None and stop.is_set():
            raise AuthError("login_cancelled", "Login cancelled.")
        time.sleep(interval)
        if stop is not None and stop.is_set():
            raise AuthError("login_cancelled", "Login cancelled.")
        fields = {
            "grant_type": DEVICE_GRANT,
            "device_code": device_code,
            "client_id": client_id,
        }
        if client_secret:
            fields["client_secret"] = client_secret
        try:
            resp = _post_form(token_endpoint, fields)
        except Exception:
            if on_pending:
                on_pending(int(time.time() - started), interval)
            continue
        if 200 <= resp.status_code < 300:
            data = _resp_json(resp)
            if not data.get("access_token"):
                raise AuthError("token_malformed", "token response missing access_token")
            return data
        try:
            code = (_resp_json(resp).get("error") or "")
        except AuthError:
            raise AuthError("token_failed", f"login request failed: HTTP {resp.status_code}")
        if code == "authorization_pending":
            if on_pending:
                on_pending(int(time.time() - started), interval)
            continue
        if code == "slow_down":
            interval += 5
            if on_pending:
                on_pending(int(time.time() - started), interval)
            continue
        if code == "access_denied":
            raise AuthError("login_denied", "login request was denied")
        if code == "expired_token":
            raise AuthError(
                "login_expired", "login request expired before acceptance",
                "Run `login` again to get a fresh code.",
            )
        raise AuthError("token_failed", f"login request failed: {code or 'HTTP error'}")
    raise AuthError(
        "login_expired", "timed out before acceptance",
        "Run `login` again to get a fresh code.",
    )


def refresh_access_token(
    token_endpoint: str, client_id: str, refresh_token: str,
    client_secret: str | None = None,
) -> dict:
    fields = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
    }
    if client_secret:
        fields["client_secret"] = client_secret
    resp = _post_form(token_endpoint, fields)
    if not (200 <= resp.status_code < 300):
        raise AuthError(
            "refresh_failed",
            "your saved login is no longer valid. Log in again or use a "
            f"different account. ({resp.text[:300] or f'HTTP {resp.status_code}'})",
        )
    return _resp_json(resp)


# ── Meta Model API key minting ────────────────────────────────────────

def mint_model_api_key(mint_base: str, access_token: str) -> dict:
    base = mint_base.rstrip("/")
    last_error = ""
    for url in (f"{base}/muse-code/key", f"{base}/v1/muse-code/key"):
        for method in ("POST", "GET"):
            try:
                headers = {
                    "authorization": f"Bearer {access_token}",
                    "accept": "application/json",
                }
                if method == "POST":
                    resp = httpx.post(url, headers=headers, content="{}",
                                      timeout=HTTP_TIMEOUT)
                else:
                    resp = httpx.get(url, headers=headers, timeout=HTTP_TIMEOUT)
            except Exception as e:
                last_error = str(e)
                continue
            if resp.status_code == 404:
                last_error = f"HTTP 404 at {url}"
                break
            if not (200 <= resp.status_code < 300):
                text = resp.text[:500]
                import re as _re
                if _re.search(r"onboarding|dev\.meta\.ai", text, _re.I):
                    raise AuthError(
                        "onboarding_required",
                        "your Meta account isn't set up for Model API yet — finish "
                        "onboarding at https://dev.meta.ai, then log in again.",
                    )
                last_error = f"HTTP {resp.status_code}: {text}"
                continue
            data = _resp_json(resp)
            if not data.get("api_key"):
                last_error = "mint response missing api_key"
                continue
            if data.get("require_payment"):
                action = data.get("action_url") or \
                    "https://accountscenter.meta.com/muse_code/?ep=no_payg"
                raise AuthError(
                    "payment_required",
                    "Muse Code requires a payment method — subscribe at "
                    f"{action}, then log in again.",
                )
            return data
    raise AuthError("mint_failed", f"Model API key mint failed: {last_error}")


# ── PKCE authorization-code flow (google / agy) ───────────────────────

def generate_pkce() -> tuple:
    """RFC 7636 S256 pair. Returns (verifier, challenge)."""
    verifier = secrets.token_urlsafe(32)
    challenge = hashlib.sha256(verifier.encode()).digest()
    import base64
    challenge_b64 = base64.urlsafe_b64encode(challenge).decode().rstrip("=")
    return verifier, challenge_b64


def build_google_auth_url(challenge: str, state: str) -> str:
    params = urllib.parse.urlencode({
        "client_id": ANTIGRAVITY_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": ANTIGRAVITY_REDIRECT_URI,
        "scope": " ".join(ANTIGRAVITY_SCOPES),
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    })
    return f"https://accounts.google.com/o/oauth2/v2/auth?{params}"


_SUCCESS_PAGE = (
    "<!DOCTYPE html><html><body style=\"font-family:sans-serif;"
    "text-align:center;padding:4rem\"><h1>Authentication successful!</h1>"
    "<p>You can close this tab and return to your terminal.</p>"
    "</body></html>"
)


def wait_for_oauth_callback(
    port: int = PKCE_PORT, timeout_sec: int = 300,
    stop: "threading.Event | None" = None,
) -> tuple:
    """One-shot localhost callback server. Returns (code, state)."""
    result: dict = {}

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            if url.path != "/oauth-callback":
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Not found")
                return
            qs = urllib.parse.parse_qs(url.query)
            code = (qs.get("code") or [""])[0]
            if not code:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"No authorization code received.")
                return
            result["code"] = code
            result["state"] = (qs.get("state") or [""])[0]
            body = _SUCCESS_PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    try:
        server = HTTPServer(("127.0.0.1", port), _Handler)
    except OSError as e:
        import errno
        if e.errno in (errno.EADDRINUSE, 98, 48):
            raise AuthError(
                "port_in_use",
                f"Port {port} is already in use. Close other auth sessions and retry.",
            )
        raise
    server.timeout = 1.0
    deadline = time.time() + timeout_sec
    try:
        while time.time() < deadline and "code" not in result:
            if stop is not None and stop.is_set():
                raise AuthError("login_cancelled", "Login cancelled.")
            try:
                server.handle_request()
            except OSError:
                continue
    finally:
        server.server_close()
    if "code" not in result:
        raise AuthError("login_expired", "Timed out waiting for OAuth callback (5 min)")
    return result["code"], result["state"]


def exchange_auth_code(code: str, verifier: str) -> dict:
    resp = _post_form("https://oauth2.googleapis.com/token", {
        "client_id": ANTIGRAVITY_CLIENT_ID,
        "client_secret": ANTIGRAVITY_CLIENT_SECRET,
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": ANTIGRAVITY_REDIRECT_URI,
        "code_verifier": verifier,
    })
    if not (200 <= resp.status_code < 300):
        raise AuthError(
            "token_exchange_failed",
            f"Token exchange failed: HTTP {resp.status_code} {resp.text[:300]}",
        )
    return _resp_json(resp)


def fetch_user_email(access_token: str) -> str | None:
    try:
        resp = httpx.get(
            "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=15.0,
        )
        if 200 <= resp.status_code < 300:
            return _resp_json(resp).get("email")
    except Exception:
        pass
    return None


# ── Credential storage ──────────────────────────────────────────────

def antigravity_accounts_path() -> str:
    return str(
        os.path.join(os.path.expanduser("~"), ".config", "opencode",
                     "antigravity-accounts.json")
    )


def save_antigravity_account(email: str, refresh_token: str) -> str:
    """Upsert into antigravity-accounts.json (agy-connector compatible)."""
    path = antigravity_accounts_path()
    data: dict = {"version": 4, "accounts": []}
    try:
        with open(path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            data.update(loaded)
        if not isinstance(data.get("accounts"), list):
            data["accounts"] = []
    except Exception:
        pass
    accounts = data["accounts"]
    existing = next((a for a in accounts
                     if isinstance(a, dict) and a.get("email") == email), None)
    if existing:
        existing["refreshToken"] = refresh_token
        existing["enabled"] = True
    else:
        accounts.append({
            "email": email,
            "refreshToken": refresh_token,
            "addedAt": int(time.time() * 1000),
            "enabled": True,
            "rateLimitResetTimes": {},
        })
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    return path


def set_provider_auth(provider: str, entry: dict, auth_path: str | None = None) -> str:
    """Merge one provider entry into the shared auth file."""
    auth = load_auth_file(auth_path)
    providers = auth.setdefault("providers", {})
    merged = providers.setdefault(provider, {})
    if isinstance(merged, dict):
        merged.update(entry)
    else:
        providers[provider] = dict(entry)
    return save_auth_file(auth, auth_path)


def get_provider_auth(provider: str, auth_path: str | None = None) -> dict:
    auth = load_auth_file(auth_path)
    entry = (auth.get("providers", {}) or {}).get(provider, {})
    return dict(entry) if isinstance(entry, dict) else {}


def _stamp() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


# ── Full login pipelines ────────────────────────────────────────────

def login_meta_device_flow(
    on_status=None, on_device_code=None, open_browser_flag: bool = True,
    stop: "threading.Event | None" = None,
    auth_base: str | None = None, api_base: str | None = None,
    mint_base: str | None = None, scope: str | None = None,
) -> tuple:
    """Meta RFC 8628 device flow → minted API key in auth.json `meta`."""
    tell = on_status or (lambda _m: None)
    auth_b = (auth_base or DEFAULT_AUTH_BASE_URL).rstrip("/")
    api_b = (api_base or DEFAULT_API_BASE_URL).rstrip("/")
    mint_b = (mint_base or MINT_BASE_URL).rstrip("/")

    tell("Discovering Meta OAuth endpoints…")
    prm = discover_protected_resource(api_b)
    hints = prm.get("authorization_servers") if prm else None
    server = discover_auth_server(
        auth_b, [h for h in hints if isinstance(h, str)] if hints else None
    )
    if not server.get("device_authorization_endpoint") or not server.get("token_endpoint"):
        raise AuthError(
            "device_endpoint_missing",
            "device authorization endpoint not found (unlanded or gated off)",
        )

    tell("Registering device client…")
    client_id, client_secret = "", None
    if server.get("registration_endpoint"):
        reg = register_client(server["registration_endpoint"])
        client_id = reg["client_id"]
        client_secret = reg.get("client_secret")
    else:
        client_id = "muse-cli"

    tell("Requesting device code…")
    device = request_device_authorization(
        server["device_authorization_endpoint"], client_id, scope
    )
    complete = device.get("verification_uri_complete") or device["verification_uri"]
    if on_device_code:
        on_device_code({
            "user_code": device["user_code"],
            "verification_uri": device["verification_uri"],
            "verification_uri_complete": complete,
        })
    if open_browser_flag:
        open_browser(complete)

    tell("Waiting for browser approval…")
    token = poll_device_token(
        server["token_endpoint"], client_id, device["device_code"],
        interval_sec=max(device.get("interval", 5), 5),
        expires_in_sec=device.get("expires_in", 600),
        client_secret=client_secret, stop=stop,
    )

    tell("Minting Model API key…")
    minted = mint_model_api_key(mint_b, token["access_token"])

    now = int(time.time())
    entry = {"access_token": token["access_token"]}
    if token.get("refresh_token"):
        entry["refresh_token"] = token["refresh_token"]
    if token.get("expires_in"):
        try:
            entry["expires_at"] = now + int(token["expires_in"])
        except (TypeError, ValueError):
            pass
    entry.update({
        "obtained_via": "device_code",
        "api_key": minted["api_key"],
        "api_base_url": api_b,
        "mechanism": "oauth",
        "record_version": 1,
        "server_name": "meta",
        "resource_url_sha256": hashlib.sha256(api_b.encode()).hexdigest(),
        "issuer": server.get("issuer", ""),
        "client_id": client_id,
        "updated_at": _stamp(),
    })
    for field in ("user_full_name", "user_email", "user_avatar_url"):
        if minted.get(field):
            entry[field] = minted[field]
    path = set_provider_auth("meta", entry)
    return entry, path


def login_opencode_device_flow(
    on_status=None, on_device_code=None, open_browser_flag: bool = True,
    stop: "threading.Event | None" = None,
    console_server: str | None = None,
) -> tuple:
    """OpenCode console device-code flow → session tokens in auth.json.

    NOTE: the issued `st_` session token authenticates the console identity
    but Zen's inference API only accepts dashboard API keys, so TUI login
    follows this with a dashboard-key paste (see tui.handle_login).
    """
    tell = on_status or (lambda _m: None)
    base = (console_server or OPENCODE_CONSOLE_SERVER).rstrip("/")

    tell("Requesting OpenCode device code…")
    resp = _post_form(f"{base}/auth/device/code", {"client_id": OPENCODE_CLIENT_ID})
    if not (200 <= resp.status_code < 300):
        raise AuthError(
            "opencode_device_code_failed",
            f"Device code request failed: HTTP {resp.status_code} {resp.text[:300]}",
        )
    device = _resp_json(resp)
    if not (device.get("device_code") and device.get("user_code")
            and device.get("verification_uri")):
        raise AuthError(
            "device_authorization_malformed",
            "device authorization response missing user_code or verification_uri",
        )
    complete = device.get("verification_uri_complete") or device["verification_uri"]
    if complete.startswith("/"):
        complete = "https://opencode.ai" + complete
    verify = device["verification_uri"]
    if verify.startswith("/"):
        verify = "https://opencode.ai" + verify
    if on_device_code:
        on_device_code({
            "user_code": device["user_code"],
            "verification_uri": verify,
            "verification_uri_complete": complete,
        })
    if open_browser_flag:
        open_browser(complete)

    tell("Waiting for OpenCode authorization…")
    token = poll_device_token(
        f"{base}/auth/device/token", OPENCODE_CLIENT_ID, device["device_code"],
        interval_sec=device.get("interval", 5) or 5,
        expires_in_sec=600, stop=stop,
    )
    tell("Authenticated successfully")
    now = int(time.time())
    entry = {"access_token": token["access_token"]}
    if token.get("refresh_token"):
        entry["refresh_token"] = token["refresh_token"]
    if token.get("expires_in"):
        try:
            entry["expires_at"] = now + int(token["expires_in"])
        except (TypeError, ValueError):
            pass
    entry.update({
        "obtained_via": "device_code",
        "mechanism": "oauth",
        "server_name": "opencode",
        "client_id": OPENCODE_CLIENT_ID,
        "updated_at": _stamp(),
    })
    path = set_provider_auth("opencode", entry)
    return entry, path


def _console_headers(session_token: str, org_id: str | None = None) -> dict:
    headers = {
        "Authorization": f"Bearer {session_token}",
        "Content-Type": "application/json",
    }
    if org_id:
        headers["x-org-id"] = org_id
    return headers


def console_list_orgs(session_token: str) -> list:
    """Orgs visible to the console session. Raises AuthError when rejected."""
    resp = httpx.get(
        f"{OPENCODE_CONSOLE_URL}/api/orgs",
        headers=_console_headers(session_token), timeout=HTTP_TIMEOUT,
    )
    if resp.status_code == 401:
        raise AuthError("console_unauthorized", "console session was rejected")
    if not (200 <= resp.status_code < 300):
        raise AuthError(
            "console_orgs_failed",
            f"org listing failed: HTTP {resp.status_code} {resp.text[:200]}",
        )
    _check_size(resp)
    try:
        data = resp.json()
    except Exception:
        raise AuthError("bad_json", "org listing returned non-JSON")
    items = data if isinstance(data, list) else data.get("items", [])
    if not isinstance(items, list):
        return []
    return [o for o in items if isinstance(o, dict) and o.get("id")]


def mint_zen_api_key(
    session_token: str, org_id: str | None = None,
    account_name: str = "muse-cli", key_name: str = "muse-cli-zen",
    account_id: str | None = None,
) -> tuple:
    """Mint an `oc_sk_*` Zen service key via the console API.

    Reuses a same-named service account when present (or the given
    `account_id`); each call creates one fresh key (revoke superseded keys
    in the console). Returns (api_key_token, key_id, account_id, org_id).
    The token is shown once — callers must store it immediately and never
    print it.
    """
    if org_id is None:
        orgs = console_list_orgs(session_token)
        if not orgs:
            raise AuthError(
                "console_no_org",
                "no console organization found for this login",
                "Create an organization at opencode.ai/console first.",
            )
        org_id = orgs[0]["id"]
    headers = _console_headers(session_token, org_id)

    resolved_account_id = account_id or ""
    if not resolved_account_id:
        resp = httpx.get(
            f"{OPENCODE_CONSOLE_URL}/api/service-accounts",
            headers=headers, timeout=HTTP_TIMEOUT,
        )
        if resp.status_code == 400 and "org" in resp.text.lower():
            raise AuthError(
                "console_org_required",
                "console requires an organization context",
                "Create or join an org at opencode.ai/console first.",
            )
        if not (200 <= resp.status_code < 300):
            raise AuthError(
                "console_accounts_failed",
                f"service-account listing failed: HTTP {resp.status_code}",
            )
        payload = _resp_json(resp)
        items = payload.get("items", []) if isinstance(payload, dict) else []
        for entry in items:
            acct = entry.get("account", entry) if isinstance(entry, dict) else {}
            if isinstance(acct, dict) and acct.get("name") == account_name and acct.get("id"):
                resolved_account_id = acct["id"]
                break
    if not resolved_account_id:
        resp = httpx.post(
            f"{OPENCODE_CONSOLE_URL}/api/service-accounts",
            headers=headers, json={"name": account_name}, timeout=HTTP_TIMEOUT,
        )
        if not (200 <= resp.status_code < 300):
            raise AuthError(
                "console_account_failed",
                f"service-account creation failed: HTTP {resp.status_code} "
                f"{resp.text[:200]}",
            )
        resolved_account_id = _resp_json(resp).get("id", "")
        if not resolved_account_id:
            raise AuthError("console_account_failed", "account creation returned no id")

    resp = httpx.post(
        f"{OPENCODE_CONSOLE_URL}/api/service-accounts/{resolved_account_id}/keys",
        headers=headers, json={"name": key_name}, timeout=HTTP_TIMEOUT,
    )
    if not (200 <= resp.status_code < 300):
        raise AuthError(
            "console_key_failed",
            f"API-key creation failed: HTTP {resp.status_code} {resp.text[:200]}",
            "The console may require billing details first.",
        )
    data = _resp_json(resp)
    token = data.get("token", "")
    key = data.get("key", {}) if isinstance(data.get("key"), dict) else {}
    if not token.startswith("oc_sk_"):
        raise AuthError("console_key_failed", "key creation returned no usable token")
    return token, key.get("id", ""), resolved_account_id, org_id


def _login_pkce_base(
    provider: str, state: str, tell, on_device_code, open_browser_flag, stop
) -> tuple:
    tell("Generating PKCE challenge…")
    verifier, challenge = generate_pkce()
    auth_url = build_google_auth_url(challenge, state)
    if on_device_code:
        on_device_code({
            "user_code": "(browser login)",
            "verification_uri": auth_url,
            "verification_uri_complete": auth_url,
        })
    if open_browser_flag:
        open_browser(auth_url)
    tell(f"Waiting for browser login on localhost:{PKCE_PORT}…")
    code, _state = wait_for_oauth_callback(port=PKCE_PORT, stop=stop)
    tell("Exchanging authorization code for tokens…")
    token = exchange_auth_code(code, verifier)
    if not token.get("refresh_token"):
        raise AuthError(
            "token_malformed", "token response missing refresh_token",
            "Retry the login and approve the consent screen.",
        )
    email = fetch_user_email(token.get("access_token", "")) or "unknown"
    tell(f"Authenticated as {email}")
    save_antigravity_account(email, token["refresh_token"])
    now = int(time.time())
    entry = {
        "access_token": token.get("access_token", ""),
        "refresh_token": token["refresh_token"],
        "obtained_via": "pkce_auth_code",
        "mechanism": "oauth",
        "server_name": provider,
        "client_id": ANTIGRAVITY_CLIENT_ID,
        "user_email": email,
        "updated_at": _stamp(),
    }
    try:
        entry["expires_at"] = now + int(token.get("expires_in") or 3600)
    except (TypeError, ValueError):
        entry["expires_at"] = now + 3600
    if provider in ("google", "agy"):
        entry["api_key"] = token.get("access_token", "")
    path = set_provider_auth(provider, entry)
    return entry, path


def login_google_pkce_flow(
    on_status=None, on_device_code=None, open_browser_flag: bool = True,
    stop: "threading.Event | None" = None,
) -> tuple:
    """Google PKCE login → auth.json `google` + antigravity-accounts.json."""
    tell = on_status or (lambda _m: None)
    return _login_pkce_base("google", "muse-google", tell,
                            on_device_code, open_browser_flag, stop)


def login_agy_pkce_flow(
    on_status=None, on_device_code=None, open_browser_flag: bool = True,
    stop: "threading.Event | None" = None,
) -> tuple:
    """Antigravity PKCE login → auth.json `agy` + antigravity-accounts.json."""
    tell = on_status or (lambda _m: None)
    return _login_pkce_base("agy", "muse-agy", tell,
                            on_device_code, open_browser_flag, stop)
