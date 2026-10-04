"""Login persistence: save / state / clear provider keys (isolated HOME)."""
from quadrants.cognition import config as C


def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    for var in ("OPENCODE_API_KEY", "MUSE_API_KEY", "GOOGLE_API_KEY",
                "GEMINI_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(var, raising=False)


def test_save_login_round_trip(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    path = C.save_provider_key("opencode", "  secret-123  ")
    assert "auth.json" in path
    assert C.auth_state("opencode") == "file"
    cfg = C.load_providers_config()
    assert cfg["opencode"]["accounts"][0]["api_key"] == "secret-123"


def test_env_outranks_file_in_state(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    C.save_provider_key("google", "file-key")
    monkeypatch.setenv("GOOGLE_API_KEY", "env-key")
    assert C.auth_state("google") == "env"
    cfg = C.load_providers_config()
    assert cfg["google"]["accounts"][0]["api_key"] == "env-key"


def test_logout_clears_file_key(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    C.save_provider_key("meta", "m-key")
    assert C.auth_state("meta") == "file"
    C.clear_provider_key("meta")
    assert C.auth_state("meta") == "-"


def test_login_rejects_unknown_provider(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    try:
        C.save_provider_key("nope", "x")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError")


def test_every_provider_declares_auth_method():
    from quadrants.cognition.provider import PROVIDERS
    for name, info in PROVIDERS.items():
        assert info.get("auth_method"), name


def test_login_options_cover_all_providers():
    from tui import login_options
    from quadrants.cognition.provider import provider_names
    opts = login_options()
    assert [k for k, _ in opts] == provider_names()
    assert all("auth:" in label for _, label in opts)


def test_login_piped_prints_table_without_state_change():
    import asyncio
    from tui import handle_login
    from kernel import QuadTreeKernel
    k = QuadTreeKernel()
    before = (k.provider, k.model)
    asyncio.run(handle_login(k, arg="", session=None))
    assert (k.provider, k.model) == before


def test_login_unknown_provider_errors_cleanly():
    import asyncio
    from tui import handle_login
    from kernel import QuadTreeKernel
    k = QuadTreeKernel()
    asyncio.run(handle_login(k, arg="nope", session=None))


def test_sort_free_models_first():
    from quadrants.cognition.provider import sort_models_for_display
    out = sort_models_for_display([
        "gpt-5.4", "muse-spark-1.3-contributor-free",
        "claude-sonnet-4-5", "jev-1.13-free", "gpt-5.4",
    ])
    assert out == [
        "jev-1.13-free", "muse-spark-1.3-contributor-free",
        "claude-sonnet-4-5", "gpt-5.4",
    ]


def test_opencode_combined_flow_keeps_session_and_key(tmp_path, monkeypatch):
    import asyncio
    _isolate(tmp_path, monkeypatch)
    from quadrants.cognition import device_auth as D
    from tui import handle_login
    monkeypatch.setattr(D, "open_browser", lambda url: True)

    def fake_device(on_status=None, on_device_code=None,
                    open_browser_flag=True, stop=None, console_server=None):
        if on_status:
            on_status("fake device step")
        return D.set_provider_auth("opencode", {
            "access_token": "st_fake", "refresh_token": "rt_fake",
            "obtained_via": "device_code",
        })
    monkeypatch.setattr(D, "login_opencode_device_flow", fake_device)
    monkeypatch.setattr(D, "mint_zen_api_key",
                        lambda *a, **k: ("oc_sk_fake", "sk_fake1", "svcacct_1", "org_1"))

    class StubSession:
        async def prompt_async(self, *args, **kwargs):
            return "dash-key-9"

    from kernel import QuadTreeKernel
    k = QuadTreeKernel()
    k.workspace_root = str(tmp_path)
    asyncio.run(handle_login(k, arg="opencode", session=StubSession()))
    entry = D.get_provider_auth("opencode")
    # Auto-mint succeeded: minted key stored, device session retained,
    # dashboard identifiers merged for reuse on next login.
    assert entry["api_key"] == "oc_sk_fake"
    assert entry["access_token"] == "st_fake"
    assert entry["obtained_via"] == "device_code"
    assert entry["org_id"] == "org_1"
    assert entry["service_account_id"] == "svcacct_1"
    assert entry["service_key_id"] == "sk_fake1"


def test_opencode_mint_failure_falls_back_to_paste(tmp_path, monkeypatch):
    import asyncio
    _isolate(tmp_path, monkeypatch)
    from quadrants.cognition import device_auth as D
    from tui import handle_login
    monkeypatch.setattr(D, "open_browser", lambda url: True)

    def fake_device(on_status=None, on_device_code=None,
                    open_browser_flag=True, stop=None, console_server=None):
        return D.set_provider_auth("opencode", {
            "access_token": "st_fake", "obtained_via": "device_code",
        })
    monkeypatch.setattr(D, "login_opencode_device_flow", fake_device)

    def boom(*a, **k):
        raise D.AuthError("console_no_org", "no org")
    monkeypatch.setattr(D, "mint_zen_api_key", boom)

    class StubSession:
        async def prompt_async(self, *args, **kwargs):
            return "dash-key-9"

    from kernel import QuadTreeKernel
    k = QuadTreeKernel()
    k.workspace_root = str(tmp_path)
    asyncio.run(handle_login(k, arg="opencode", session=StubSession()))
    entry = D.get_provider_auth("opencode")
    assert entry["api_key"] == "dash-key-9"


def test_opencode_key_only_skips_device(tmp_path, monkeypatch):
    import asyncio
    _isolate(tmp_path, monkeypatch)
    from quadrants.cognition import device_auth as D
    from tui import handle_login
    monkeypatch.setattr(D, "open_browser", lambda url: True)

    def boom(*a, **k):
        raise AssertionError("device flow must not run with --key")
    monkeypatch.setattr(D, "login_opencode_device_flow", boom)

    class StubSession:
        async def prompt_async(self, *args, **kwargs):
            return "dash-key-9"

    from kernel import QuadTreeKernel
    k = QuadTreeKernel()
    k.workspace_root = str(tmp_path)
    asyncio.run(handle_login(k, arg="opencode --key", session=StubSession()))
    assert D.get_provider_auth("opencode")["api_key"] == "dash-key-9"
