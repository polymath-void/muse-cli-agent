"""Provider catalog: per-provider models, variants, resolution."""
from quadrants.cognition import provider as P


def test_provider_names_cover_all_gateways():
    for name in ("google", "opencode", "meta", "agy", "anthropic"):
        assert name in P.provider_names()


def test_models_for_gateway_are_provider_scoped():
    google = P.models_for_gateway("google")
    opencode = P.models_for_gateway("opencode")
    assert "gemini-2.5-flash" in google
    assert "muse-spark-1.3-contributor-free" in opencode
    assert "gemini-2.5-flash" not in opencode
    assert P.models_for_gateway("nope") == []


def test_gateway_for_model_routes_gpt_to_opencode():
    assert P.gateway_for_model("gpt-5.4") == "opencode"
    assert P.gateway_for_model("gemini-2.5-flash") == "google"
    assert P.gateway_for_model("claude-sonnet-4-5") == "agy"


def test_expand_variants_base_first():
    variants = P.expand_variants("gemini-3.1-pro")
    assert variants[0] == "gemini-3.1-pro"
    assert "gemini-3.1-pro-high" in variants
    assert "gemini-3.1-pro-low" in variants
    assert P.expand_variants("unknown-9") == ["unknown-9"]


def test_resolve_exact_case_insensitive():
    assert P.resolve_model("google", "GEMINI-2.5-flash") == "gemini-2.5-flash"


def test_resolve_base_variant_pair():
    assert P.resolve_model("google", "gemini-3.1-pro high") == "gemini-3.1-pro-high"
    assert P.resolve_model("opencode", "gpt-5.4 mini") == "gpt-5.4-mini"


def test_resolve_unambiguous_prefix():
    assert P.resolve_model("google", "gemini-2.5-flash-l") == "gemini-2.5-flash-lite"


def test_resolve_unknown_is_none():
    assert P.resolve_model("google", "definitely-not-a-model") is None
    assert P.resolve_model("no-provider", "x") is None
    assert P.resolve_model("google", "") is None


def test_default_model_for():
    assert P.default_model_for("google") == "gemini-2.5-flash"
    assert P.default_model_for("nope") == ""


def test_fetch_opencode_models_offline_fallback(tmp_path, monkeypatch):
    monkeypatch.setenv("MUSE_MODELS_CACHE", str(tmp_path / "models.json"))
    monkeypatch.setattr(P, "OPENCODE_MODELS_URL", "http://127.0.0.1:1/models")
    models = P.fetch_opencode_models(timeout=2.0)
    assert "muse-spark-1.3-contributor-free" in models


def test_catalog_source_static_when_offline(tmp_path, monkeypatch):
    monkeypatch.setenv("MUSE_MODELS_CACHE", str(tmp_path / "models.json"))
    monkeypatch.setattr(P, "OPENCODE_MODELS_URL", "http://127.0.0.1:1/models")
    ids, source = P.catalog_with_source("opencode", timeout=2.0)
    assert source == "static"
    assert "muse-spark-1.3-contributor-free" in ids


def test_catalog_source_cache_without_network(tmp_path, monkeypatch):
    cache = tmp_path / "models.json"
    cache.write_text('["live-model-a", "live-model-b"]')
    monkeypatch.setenv("MUSE_MODELS_CACHE", str(cache))
    monkeypatch.setattr(P, "OPENCODE_MODELS_URL", "http://127.0.0.1:1/models")
    ids, source = P.catalog_with_source("opencode", timeout=2.0)
    assert source == "cache"
    assert ids == ["live-model-a", "live-model-b"]


def test_catalog_source_non_opencode_is_static():
    ids, source = P.catalog_with_source("google")
    assert source == "static"
    assert "gemini-2.5-flash" in ids


def test_resolve_persisted_model_prefers_static():
    from quadrants.cognition.provider import resolve_persisted_model
    assert resolve_persisted_model("google", "gemini-2.5-flash") == "gemini-2.5-flash"
    assert resolve_persisted_model("google", "nope-not-a-model") is None


def test_resolve_persisted_model_uses_live_cache(tmp_path, monkeypatch):
    import json
    from quadrants.cognition.provider import resolve_persisted_model
    cache = tmp_path / "models.json"
    cache.write_text(json.dumps(["space-bunny-free"]))
    monkeypatch.setenv("MUSE_MODELS_CACHE", str(cache))
    assert resolve_persisted_model("opencode", "space-bunny-free") == "space-bunny-free"
    assert resolve_persisted_model("opencode", "ghost-model") is None
    assert resolve_persisted_model("google", "space-bunny-free") is None
