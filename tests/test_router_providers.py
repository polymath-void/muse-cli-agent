"""Router provider plumbing (no network: body/endpoint/normalize only)."""
import json

import httpx

from quadrants.cognition.router import UnifiedRouter, zen_surface_for


def _router():
    return UnifiedRouter()


def test_meta_endpoint_uses_configurable_base(monkeypatch):
    r = _router()
    monkeypatch.setenv("MUSE_API_BASE_URL", "https://example.test/v9")
    assert r.get_endpoint("meta", "muse-spark-1.3", False) == (
        "https://example.test/v9/chat/completions"
    )


def test_meta_body_is_openai_chat_with_system_preserved():
    r = _router()
    body = {"contents": [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hi"},
    ]}
    req = r.build_request_body("meta", "muse-spark-1.3", body, False)
    assert req["model"] == "muse-spark-1.3"
    assert {"role": "system", "content": "sys"} in req["messages"]
    assert "stream" not in req
    streamed = r.build_request_body("meta", "muse-spark-1.3", body, True)
    assert streamed["stream"] is True


def test_meta_normalize_openai_choices():
    r = _router()
    resp = {"choices": [{"message": {"content": "hello-meta"}}]}
    out = r.normalize_non_stream("meta", resp)
    parts = out["candidates"][0]["content"]["parts"]
    assert parts == [{"text": "hello-meta"}]


def test_google_accounts_from_env(monkeypatch):
    r = _router()
    monkeypatch.setenv("GOOGLE_API_KEY", "g-key")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    accounts = r.get_accounts({}, "google")
    assert accounts and accounts[0]["api_key"] == "g-key"


def test_opencode_accounts_from_auth_file(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.delenv("OPENCODE_API_KEY", raising=False)
    auth_dir = tmp_path / "muse"
    auth_dir.mkdir(parents=True)
    (auth_dir / "auth.json").write_text(json.dumps(
        {"schema_version": 1, "providers": {"opencode": {"api_key": "file-key"}}}
    ))
    r = _router()
    accounts = r.get_accounts({}, "opencode")
    assert any(a.get("api_key") == "file-key" for a in accounts)


def test_opencode_env_beats_file(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("OPENCODE_API_KEY", "env-key")
    auth_dir = tmp_path / "muse"
    auth_dir.mkdir(parents=True)
    (auth_dir / "auth.json").write_text(json.dumps(
        {"schema_version": 1, "providers": {"opencode": {"api_key": "file-key"}}}
    ))
    r = _router()
    accounts = r.get_accounts({}, "opencode")
    assert accounts[0]["api_key"] == "env-key"
    assert any(a.get("api_key") == "file-key" for a in accounts)


def test_meta_accounts_from_auth_file(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.delenv("MUSE_API_KEY", raising=False)
    auth_dir = tmp_path / "muse"
    auth_dir.mkdir(parents=True)
    (auth_dir / "auth.json").write_text(json.dumps(
        {"schema_version": 1, "providers": {"meta": {"api_key": "m-key"}}}
    ))
    r = _router()
    assert r.get_accounts({}, "meta")[0]["api_key"] == "m-key"


def test_jev_surface_and_endpoint():
    r = _router()
    assert zen_surface_for("jev-1.13-free") == "systemone"
    assert zen_surface_for("opencode/jev-1.13") == "systemone"
    ep = r.get_endpoint("opencode", "jev-1.13-free", False)
    assert ep == "https://opencode.ai/inference/openai/v1/systemone"


def test_jev_request_body_is_decisions_shape():
    r = _router()
    body = {"messages": [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hi"},
    ]}
    req = r.build_request_body("opencode", "jev-1.13-free", body, False)
    assert req["model"] == "jev-1.13-free"
    assert "system: sys" in req["state"] and "user: hi" in req["state"]
    assert "messages" not in req and "stream" not in req


def test_free_model_endpoint_mapping():
    r = _router()
    base = "https://opencode.ai/inference/openai/v1"
    for mid in ("space-bunny-free", "longcat-2.5-preview-free",
                "fledge-alpha-free", "mimo-v2.6-flash-free", "mimo-v2.5-free",
                "ling-3.1-flash-free", "ling-3.0-flash-fin-free",
                "nemotron-3-ultra-free", "nemotron-3.5-lightning-free",
                "deepseek-v4-flash-free"):
        assert r.get_endpoint("opencode", mid, False) == f"{base}/chat/completions", mid
    assert r.get_endpoint(
        "opencode", "muse-spark-1.3-contributor-free", False) == f"{base}/responses"


def test_jev_routes_without_ban(monkeypatch):
    import asyncio

    class FakeResp:
        status_code = 200
        is_success = True

        def json(self):
            return {"decision": "ok"}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None, timeout=None):
            assert url == "https://opencode.ai/inference/openai/v1/systemone"
            return FakeResp()

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: FakeClient())
    r = _router()
    body = {"messages": [{"role": "user", "content": "hi"}]}
    cfg = {"opencode": {"accounts": [{"api_key": "k"}]}}
    out = asyncio.run(r.route("opencode", "jev-1.13-free", body, False, cfg))
    assert out == {"decision": "ok"}


def test_zen_rewrite_disabled_by_env(monkeypatch):
    monkeypatch.setenv("ZEN_REWRITE_URL", "0")
    r = _router()
    assert r.get_endpoint("opencode", "space-bunny-free", False) == \
        "https://opencode.ai/zen/v1/chat/completions"


def test_gate_headers_shape():
    from quadrants.cognition.router import (
        canonicalize_session_id, zen_gate_headers)
    import re
    assert re.match(r"^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$",
                    canonicalize_session_id("anything"))
    assert canonicalize_session_id("ses_0123456789abCDEFGHIJKLMN12") == \
        "ses_0123456789abCDEFGHIJKLMN12"
    h = zen_gate_headers({"Authorization": "Bearer k"})
    assert h["User-Agent"] == "opencode/1.18.31"
    assert re.match(r"^ses_", h["x-opencode-session"])
    assert h["x-opencode-client"] == "desktop"
    assert h["Authorization"] == "Bearer k"


def test_gate_tools_injection_envelopes():
    from quadrants.cognition.router import ensure_gate_tools
    chat = ensure_gate_tools("https://x/chat/completions",
                             {"model": "m", "messages": [], "tools": []})
    names = [t["function"]["name"] for t in chat["tools"]]
    assert names == ["bash", "read"]
    resp = ensure_gate_tools("https://x/responses", {"model": "m"})
    assert [t["name"] for t in resp["tools"]] == ["bash", "read"]
    keep = {"model": "m", "messages": [],
            "tools": [{"type": "function",
                       "function": {"name": "bash"}},
                      {"type": "function",
                       "function": {"name": "read"}}]}
    assert ensure_gate_tools("https://x/chat/completions", keep) is keep


def test_chat_body_preserves_system_role():
    r = _router()
    body = {"contents": [{"role": "system", "content": "sys"},
                         {"role": "user", "content": "hi"}]}
    req = r.build_request_body("opencode", "space-bunny-free", body, False)
    roles = [m["role"] for m in req["messages"]]
    assert roles == ["system", "user"]


def test_models_url_untouched_by_rewrite():
    from quadrants.cognition.provider import OPENCODE_MODELS_URL
    assert "/zen/v1/models" in OPENCODE_MODELS_URL
