"""Native OAuth login flows: PKCE, callback server, device polling (offline)."""
import json
import threading
import urllib.request

import httpx
import pytest

from quadrants.cognition import device_auth as D


class _FakeResp:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code = status
        self._payload = payload if payload is not None else {}
        self.text = text
        self.headers = {}

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def test_generate_pkce_rfc7636_vector():
    # RFC 7636 Appendix B: verifier -> known S256 challenge.
    import hashlib, base64
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    expect = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    assert expect == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    v, c = D.generate_pkce()
    assert len(v) >= 43
    check = base64.urlsafe_b64encode(
        hashlib.sha256(v.encode()).digest()).decode().rstrip("=")
    assert check == c


def test_google_auth_url_shape():
    url = D.build_google_auth_url("challenge123", "muse-google")
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "code_challenge=challenge123" in url
    assert "code_challenge_method=S256" in url
    assert "state=muse-google" in url
    assert "redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback" in url
    assert "access_type=offline" in url
    assert D.ANTIGRAVITY_CLIENT_ID in url


def _free_port():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_up(port, timeout=10.0):
    import socket as _s
    import time as _t
    deadline = _t.time() + timeout
    while _t.time() < deadline:
        try:
            c = _s.create_connection(("127.0.0.1", port), timeout=1)
            c.close()
            return True
        except OSError:
            _t.sleep(0.1)
    return False


def test_callback_server_round_trip():
    port = _free_port()
    holder = {}
    def run():
        holder["out"] = D.wait_for_oauth_callback(port=port, timeout_sec=20)
    t = threading.Thread(target=run, daemon=True)
    t.start()
    assert _wait_up(port), "callback server did not start"
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/nope")
        raise AssertionError("expected HTTP 404")
    except urllib.error.HTTPError as e:
        assert e.code == 404
    with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/oauth-callback?code=abc123&state=s1") as r:
        body = r.read().decode()
        assert r.status == 200
        assert "successful" in body
    t.join(timeout=10)
    assert holder["out"] == ("abc123", "s1")


def test_callback_server_rejects_missing_code_then_recovers():
    port = _free_port()
    holder = {}
    def run():
        holder["out"] = D.wait_for_oauth_callback(port=port, timeout_sec=20)
    t = threading.Thread(target=run, daemon=True)
    t.start()
    assert _wait_up(port), "callback server did not start"
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/oauth-callback")
        raise AssertionError("expected HTTP 400")
    except urllib.error.HTTPError as e:
        assert e.code == 400
    with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/oauth-callback?code=zz9") as r:
        assert r.status == 200
    t.join(timeout=10)
    assert holder["out"] == ("zz9", "")


def test_poll_pending_then_success(monkeypatch):
    monkeypatch.setattr(D.time, "sleep", lambda _s: None)
    calls = {"n": 0}

    def fake_post(url, content=None, headers=None, timeout=None):
        calls["n"] += 1
        if calls["n"] < 3:
            return _FakeResp(400, {"error": "authorization_pending"})
        return _FakeResp(200, {"access_token": "at-1",
                               "refresh_token": "rt-1",
                               "expires_in": 3600})
    monkeypatch.setattr(httpx, "post", fake_post)
    seen = []
    out = D.poll_device_token("https://x.test/token", "cid", "dev",
                              interval_sec=0, expires_in_sec=30,
                              on_pending=lambda e, i: seen.append(e))
    assert out["access_token"] == "at-1"
    assert calls["n"] == 3
    assert len(seen) == 2


def test_poll_slow_down_then_denied(monkeypatch):
    monkeypatch.setattr(D.time, "sleep", lambda _s: None)
    seq = [{"error": "slow_down"}, {"error": "access_denied"}]

    def fake_post(url, content=None, headers=None, timeout=None):
        return _FakeResp(400, seq.pop(0))
    monkeypatch.setattr(httpx, "post", fake_post)
    with pytest.raises(D.AuthError) as ei:
        D.poll_device_token("https://x.test/token", "cid", "dev",
                            interval_sec=0, expires_in_sec=30)
    assert ei.value.code == "login_denied"


def test_poll_honours_stop_event(monkeypatch):
    def fake_post(url, content=None, headers=None, timeout=None):
        return _FakeResp(400, {"error": "authorization_pending"})
    monkeypatch.setattr(httpx, "post", fake_post)
    stop = threading.Event()
    stop.set()
    with pytest.raises(D.AuthError) as ei:
        D.poll_device_token("https://x.test/token", "cid", "dev",
                            interval_sec=0, expires_in_sec=30, stop=stop)
    assert ei.value.code == "login_cancelled"


def test_device_authorization_malformed(monkeypatch):
    monkeypatch.setattr(httpx, "post",
                        lambda *a, **k: _FakeResp(200, {"user_code": "x"}))
    with pytest.raises(D.AuthError) as ei:
        D.request_device_authorization("https://x.test/dev", "cid")
    assert ei.value.code == "device_authorization_malformed"


def test_discovery_falls_back_without_network(monkeypatch):
    def boom(*a, **k):
        raise httpx.ConnectError("down")
    monkeypatch.setattr(httpx, "get", boom)
    server = D.discover_auth_server("https://auth.meta.com")
    assert server["device_authorization_endpoint"] == \
        "https://auth.meta.com/oidc/device/authorization/"
    assert D.discover_protected_resource("https://api.meta.ai/v1") is None


def test_open_browser_test_hook(monkeypatch):
    monkeypatch.setenv("MUSE_TEST_BROWSER_OPENER", "true")
    assert D.open_browser("https://example.test") is True
    monkeypatch.setenv("MUSE_TEST_BROWSER_OPENER", "false")
    monkeypatch.setattr(D.shutil, "which", lambda _c: None)
    assert D.open_browser("https://example.test") is False


def test_save_antigravity_account_round_trip(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    p1 = D.save_antigravity_account("a@x.test", "rt-1")
    data = json.loads(open(p1).read())
    assert data["accounts"][0]["email"] == "a@x.test"
    D.save_antigravity_account("a@x.test", "rt-2")
    data = json.loads(open(p1).read())
    assert len(data["accounts"]) == 1
    assert data["accounts"][0]["refreshToken"] == "rt-2"


def test_set_provider_auth_merges(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    D.set_provider_auth("opencode", {"api_key": "k1"})
    D.set_provider_auth("opencode", {"user_email": "e@x"})
    entry = D.get_provider_auth("opencode")
    assert entry["api_key"] == "k1" and entry["user_email"] == "e@x"


class _Resp:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code = status
        self._payload = payload if payload is not None else {}
        self.text = text
        self.headers = {}

    def json(self):
        return self._payload


def _mint_harness(monkeypatch, orgs, accounts, new_account_id="svcacct_9",
                  token="oc_sk_test123"):
    calls = []

    def fake_get(url, headers=None, timeout=None):
        calls.append(("GET", url))
        if url.endswith("/api/orgs"):
            return _Resp(200, orgs)
        if url.endswith("/api/service-accounts"):
            return _Resp(200, {"items": accounts})
        raise AssertionError(f"unexpected GET {url}")

    def fake_post(url, headers=None, json=None, timeout=None):
        calls.append(("POST", url, (json or {}).get("name")))
        if url.endswith("/api/service-accounts"):
            return _Resp(200, {"id": new_account_id})
        if "/keys" in url:
            return _Resp(200, {"token": token, "key": {"id": "sk_9"}})
        raise AssertionError(f"unexpected POST {url}")

    import httpx as _hx
    monkeypatch.setattr(_hx, "get", fake_get)
    monkeypatch.setattr(_hx, "post", fake_post)
    return calls


def test_mint_reuses_named_account(monkeypatch):
    calls = _mint_harness(
        monkeypatch,
        [{"id": "org_1"}],
        [{"account": {"id": "svcacct_1", "name": "muse-cli"}}],
    )
    token, kid, aid, oid = D.mint_zen_api_key("st_x")
    assert (token, kid, aid, oid) == ("oc_sk_test123", "sk_9", "svcacct_1", "org_1")
    assert not [c for c in calls if c[0] == "POST" and c[1].endswith("/api/service-accounts")]


def test_mint_creates_missing_account(monkeypatch):
    calls = _mint_harness(monkeypatch, [{"id": "org_1"}], [])
    _token, _kid, aid, oid = D.mint_zen_api_key("st_x")
    assert (aid, oid) == ("svcacct_9", "org_1")
    assert ("POST", "https://opencode.ai/console/api/service-accounts", "muse-cli") in calls


def test_mint_stored_ids_skip_discovery(monkeypatch):
    calls = _mint_harness(
        monkeypatch,
        [{"id": "org_1"}],
        [{"account": {"id": "svcacct_1", "name": "muse-cli"}}],
    )
    token, kid, aid, oid = D.mint_zen_api_key(
        "st_x", org_id="org_9", account_id="svcacct_9")
    assert (aid, oid) == ("svcacct_9", "org_9")
    assert token == "oc_sk_test123"
    assert not [c for c in calls if c[0] == "GET"]


def test_mint_no_org_errors(monkeypatch):
    _mint_harness(monkeypatch, [], [])
    with pytest.raises(D.AuthError) as ei:
        D.mint_zen_api_key("st_x")
    assert ei.value.code == "console_no_org"


def test_mint_rejects_non_key_token(monkeypatch):
    _mint_harness(monkeypatch, [{"id": "org_1"}], [], token="st_notakey")
    with pytest.raises(D.AuthError) as ei:
        D.mint_zen_api_key("st_x")
    assert ei.value.code == "console_key_failed"
