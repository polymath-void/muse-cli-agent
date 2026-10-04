"""Proxy routing: endpoint fallbacks, account scheduling, delegation context."""
import inspect

import httpx
import pytest

from quadrants.cognition import router as R


@pytest.fixture(autouse=True)
def _clean_env(tmp_path, monkeypatch):
    """Isolate routing tests from real credentials and auth files."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    for var in ("GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENCODE_API_KEY",
                "ANTHROPIC_API_KEY", "MUSE_API_KEY", "AGY_CONNECTOR_URL"):
        monkeypatch.delenv(var, raising=False)


def _router():
    return R.UnifiedRouter()


# ── Endpoint fallback chain ───────────────────────────────────────────

def test_antigravity_constants_match_plugin():
    assert R.ANTIGRAVITY_ENDPOINT_DAILY == \
        "https://daily-cloudcode-pa.sandbox.googleapis.com"
    assert R.ANTIGRAVITY_ENDPOINT_AUTOPUSH == \
        "https://autopush-cloudcode-pa.sandbox.googleapis.com"
    assert R.ANTIGRAVITY_ENDPOINT_PROD == "https://cloudcode-pa.googleapis.com"
    assert R.ANTIGRAVITY_DEFAULT_PROJECT_ID == "rising-fact-p41fc"


def test_agy_endpoints_fall_back_daily_first():
    eps = _router().get_endpoints("agy", "gemini-3-flash", False)
    assert len(eps) == 3
    assert eps[0].startswith(R.ANTIGRAVITY_ENDPOINT_DAILY)
    assert eps[1].startswith(R.ANTIGRAVITY_ENDPOINT_AUTOPUSH)
    assert eps[2].startswith(R.ANTIGRAVITY_ENDPOINT_PROD)
    assert eps[0].endswith("/v1internal:generateContent")


def test_google_has_single_endpoint():
    eps = _router().get_endpoints("google", "gemini-2.5-flash", False)
    assert len(eps) == 1
    assert "generativelanguage" in eps[0]


# ── Scheduling ────────────────────────────────────────────────────────

def _accts():
    return [{"api_key": "k1"}, {"api_key": "k2"}, {"api_key": "k3"}]


def test_sticky_keeps_configured_order():
    r = _router()
    assert [a["api_key"] for a in r.order_accounts(_accts(), "google")] == \
        ["k1", "k2", "k3"]


def test_round_robin_rotates_start():
    r = _router()
    first = [a["api_key"] for a in r.order_accounts(_accts(), "google", "round-robin")]
    second = [a["api_key"] for a in r.order_accounts(_accts(), "google", "round-robin")]
    assert first == ["k1", "k2", "k3"]
    assert second == ["k2", "k3", "k1"]


def test_slot_pins_delegate_offset():
    r = _router()
    got = [a["api_key"] for a in r.order_accounts(_accts(), "google", "sticky", False, slot=2)]
    assert got == ["k3", "k1", "k2"]


def test_pid_offset_spreads_processes(monkeypatch):
    import os as _os
    r = _router()
    monkeypatch.setattr(_os, "getpid", lambda: 7)  # 7 % 3 == 1
    got = [a["api_key"] for a in r.order_accounts(_accts(), "google", "sticky", True)]
    assert got == ["k2", "k3", "k1"]


def test_resolve_scheduling_defaults_and_overrides():
    r = _router()
    assert r.resolve_scheduling({}, "google") == ("sticky", False, None)
    cfg = {"google": {"scheduling": "balance"}}
    assert r.resolve_scheduling(cfg, "google") == ("round-robin", False, None)
    cfg = {"google": {"scheduling": "performance_first"}}
    strat, pid, _slot = r.resolve_scheduling(cfg, "google")
    assert (strat, pid) == ("round-robin", False)
    out = r.resolve_scheduling(cfg, "google",
                               {"scheduling": "sticky", "slot": 1})
    assert out == ("sticky", False, 1)
    assert r.resolve_scheduling({}, "google", {"scheduling": "bogus"})[0] == "sticky"


# ── Route loop: accounts + endpoint fallback + project ───────────────

class _FakeResp:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code = status
        self.payload = payload if payload is not None else {}
        self.reason_phrase = "OK" if status < 300 else "Error"
        self.text = text if text else ("" if status < 300 else "err")
        self.is_success = status < 300

    def json(self):
        return self.payload


class _FakeClient:
    """AsyncClient double: script = list of _FakeResp | Exception."""
    posted = []

    def __init__(self, script):
        self.script = script  # shared queue: each post consumes one entry

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, headers=None, json=None, timeout=None):
        _FakeClient.posted.append({"url": url, "headers": headers, "json": json})
        nxt = self.script.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def _patch_client(monkeypatch, script):
    _FakeClient.posted = []
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda *a, **k: _FakeClient(script))


def _ok_payload(text="hi"):
    return {"candidates": [{"content": {"parts": [{"text": text}]}}]}


def test_rate_limited_account_falls_to_next(monkeypatch):
    import asyncio
    _patch_client(monkeypatch, [
        _FakeResp(429), _FakeResp(200, _ok_payload()),
    ])
    r = _router()
    body = {"contents": [{"role": "user", "content": "x"}],
            "tools": [{"t": 1}]}
    cfg = {"google": {"accounts": [{"api_key": "k1"}, {"api_key": "k2"}]}}
    out = asyncio.run(r.route("google", "gemini-2.5-flash", body, False, cfg))
    assert out == _ok_payload()
    keys = [p["headers"]["Authorization"] for p in _FakeClient.posted]
    assert keys == ["Bearer k1", "Bearer k2"]


def test_endpoint_fallback_on_connection_error(monkeypatch):
    import asyncio
    _patch_client(monkeypatch, [
        httpx.ConnectError("down"), _FakeResp(200, _ok_payload()),
    ])
    r = _router()
    body = {"contents": [{"role": "user", "content": "x"}],
            "tools": [{"t": 1}]}
    cfg = {"custom": {"accounts": [{"api_key": "k"}]}}
    out = asyncio.run(r.route("custom", "m", body, False, cfg))
    assert out == _ok_payload()
    urls = [p["url"] for p in _FakeClient.posted]
    assert len(urls) == 2
    assert urls[0].startswith(R.ANTIGRAVITY_ENDPOINT_DAILY)
    assert urls[1].startswith(R.ANTIGRAVITY_ENDPOINT_AUTOPUSH)


def test_direct_sandbox_carries_default_project(monkeypatch):
    import asyncio
    # Connector down -> generic loop falls back to direct-sandbox endpoints.
    _patch_client(monkeypatch, [
        httpx.ConnectError("conn down"), _FakeResp(200, _ok_payload()),
    ])
    monkeypatch.setenv("AGY_CONNECTOR_URL", "http://127.0.0.1:9")
    r = _router()
    body = {"contents": [{"role": "user", "content": "x"}],
            "tools": [{"t": 1}]}
    cfg = {"agy": {"accounts": [{"api_key": "k"}]}}
    asyncio.run(r.route("agy", "gemini-3-flash", body, False, cfg))
    assert len(_FakeClient.posted) == 2
    direct = _FakeClient.posted[1]
    assert direct["url"].startswith(R.ANTIGRAVITY_ENDPOINT_DAILY)
    assert direct["json"]["project"] == "rising-fact-p41fc"


def test_pkce_scopes_match_plugin_constants():
    from quadrants.cognition.device_auth import (
        ANTIGRAVITY_SCOPES, build_google_auth_url)
    assert "https://www.googleapis.com/auth/cclog" in ANTIGRAVITY_SCOPES
    assert "https://www.googleapis.com/auth/experimentsandconfigs" in \
        ANTIGRAVITY_SCOPES
    url = build_google_auth_url("c", "s")
    assert "cclog" in url and "experimentsandconfigs" in url


def test_routing_context_plumbing_signatures():
    from kernel import QuadTreeKernel
    from quadrants.cognition import CognitionNode
    assert "routing" in inspect.signature(R.UnifiedRouter.route).parameters
    assert "routing" in inspect.signature(CognitionNode.handle).parameters
    assert "routing" in inspect.signature(QuadTreeKernel.chat).parameters


def test_opencode_chat_normalize_to_candidates():
    r = _router()
    resp = {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}
    out = r.normalize_non_stream("opencode", resp)
    assert out == {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}


def test_opencode_responses_normalize_to_candidates():
    r = _router()
    resp = {"output": [
        {"type": "message",
         "content": [{"type": "output_text", "text": "hello"}]},
    ]}
    out = r.normalize_non_stream("opencode", resp)
    parts = out["candidates"][0]["content"]["parts"]
    assert parts == [{"text": "hello"}]


def test_protocol_fallback_retries_chat_surface(monkeypatch):
    import asyncio

    def proto_400(url):
        return _FakeResp(400, {}, text="ModelProtocolUnsupported")

    _patch_client(monkeypatch, [
        proto_400("responses"), _FakeResp(200, _ok_payload()),
    ])
    r = _router()
    body = {"contents": [{"role": "user", "content": "x"}],
            "tools": [{"t": 1}]}
    cfg = {"opencode": {"accounts": [{"api_key": "k"}]}}
    out = asyncio.run(
        r.route("opencode", "muse-spark-1.3-contributor-free", body, False, cfg))
    assert out == _ok_payload()
    urls = [p["url"] for p in _FakeClient.posted]
    assert urls[0].endswith("/responses")
    assert urls[1].endswith("/chat/completions")


def test_aggregate_sse_chunks():
    from quadrants.cognition.router import aggregate_sse_chunks
    sse = (
        ": ping\n"
        'data: {"choices": [{"delta": {"content": "Hel"}}]}\n'
        'data: {"choices": [{"delta": {"content": "lo"}}]}\n'
        'data: {"choices": [{"delta": {}}]}\n'
        "data: [DONE]\n"
        "garbage line\n"
        'data: not-json\n'
    )
    assert aggregate_sse_chunks(sse) == "Hello"
    assert aggregate_sse_chunks("") == ""
    assert aggregate_sse_chunks("no data lines") == ""


def test_freetier_403_retries_wire_stream(monkeypatch):
    import asyncio
    sse = 'data: {"choices": [{"delta": {"content": "ok"}}]}\ndata: [DONE]\n'
    _patch_client(monkeypatch, [
        _FakeResp(403, {}, text='{"type":"error","error":{"type":"FreeTierError"}}'),
        _FakeResp(200, {}, text=sse),
    ])
    r = _router()
    body = {"contents": [{"role": "user", "content": "x"}],
            "tools": [{"t": 1}]}
    cfg = {"opencode": {"accounts": [{"api_key": "k"}]}}
    out = asyncio.run(r.route("opencode", "space-bunny-free", body, False, cfg))
    assert out == {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
    posts = _FakeClient.posted
    assert len(posts) == 2
    assert posts[1]["json"].get("stream") is True


def test_plain_403_does_not_stream_retry(monkeypatch):
    import asyncio
    _patch_client(monkeypatch, [_FakeResp(403, {}, text="forbidden")])
    r = _router()
    body = {"contents": [{"role": "user", "content": "x"}],
            "tools": [{"t": 1}]}
    cfg = {"opencode": {"accounts": [{"api_key": "k"}]}}
    try:
        asyncio.run(r.route("opencode", "space-bunny-free", body, False, cfg))
        raise AssertionError("expected exhaustion")
    except Exception as e:
        assert "exhausted" in str(e)
    assert len(_FakeClient.posted) == 1


def test_freetier_403_retries_stream_on_responses(monkeypatch):
    import asyncio
    sse = ('data: {"type": "response.output_text.delta", "delta": "hi"}\n'
           "data: [DONE]\n")
    _patch_client(monkeypatch, [
        _FakeResp(403, {}, text='{"type":"error","error":{"type":"FreeTierError"}}'),
        _FakeResp(200, {}, text=sse),
    ])
    r = _router()
    body = {"contents": [{"role": "user", "content": "x"}],
            "tools": [{"t": 1}]}
    cfg = {"opencode": {"accounts": [{"api_key": "k"}]}}
    out = asyncio.run(
        r.route("opencode", "muse-spark-1.3-contributor-free", body, False, cfg))
    assert out == {"candidates": [{"content": {"parts": [{"text": "hi"}]}}]}
    posts = _FakeClient.posted
    assert len(posts) == 2
    assert posts[0]["url"].endswith("/responses")
    assert posts[1]["url"].endswith("/responses")
    assert posts[1]["json"].get("stream") is True


def _ft403():
    return _FakeResp(403, {}, text='{"type":"error","error":{"type":"FreeTierError"}}')


def test_freetier_flap_retry_succeeds(monkeypatch):
    monkeypatch.setenv("ZEN_FLAP_DELAY_SEC", "0")
    import asyncio
    _patch_client(monkeypatch, [
        _ft403(), _ft403(), _ft403(), _FakeResp(200, _ok_payload()),
    ])
    r = _router()
    body = {"contents": [{"role": "user", "content": "x"}],
            "tools": [{"t": 1}]}
    cfg = {"opencode": {"accounts": [{"api_key": "k"}]}}
    out = asyncio.run(r.route("opencode", "space-bunny-free", body, False, cfg))
    assert out == _ok_payload()
    posts = _FakeClient.posted
    assert len(posts) == 4
    assert posts[1]["json"].get("stream") is True
    assert posts[2]["json"].get("stream") is not True
    assert posts[3]["json"].get("stream") is not True


def test_freetier_persistent_403_exhausts_bounded(monkeypatch):
    monkeypatch.setenv("ZEN_FLAP_DELAY_SEC", "0")
    import asyncio
    _patch_client(monkeypatch, [_ft403()] * 10)
    r = _router()
    body = {"contents": [{"role": "user", "content": "x"}],
            "tools": [{"t": 1}]}
    cfg = {"opencode": {"accounts": [{"api_key": "k"}]}}
    try:
        asyncio.run(r.route("opencode", "space-bunny-free", body, False, cfg))
        raise AssertionError("expected exhaustion")
    except Exception as e:
        assert "exhausted" in str(e)
    # initial + wire-stream + 2 flap retries, then exhausted
    assert len(_FakeClient.posted) == 4
