"""Kernel provider/model selection + config persistence."""
from quadrants.cognition.config import (
    read_last_selection,
    write_last_selection,
)


def _kernel():
    from kernel import QuadTreeKernel
    return QuadTreeKernel()


def test_kernel_defaults():
    from quadrants.cognition.provider import provider_names, resolve_persisted_model
    k = _kernel()
    # Whatever is persisted (or fresh-install fallback), state must be valid
    # under the same resolution the boot path uses.
    assert k.provider in provider_names()
    assert resolve_persisted_model(k.provider, k.model) == k.model
    assert isinstance(k.providers_config, dict)
    assert isinstance(k.quadrants["cognition"].providers_config(), dict)


def test_set_provider_resets_model_and_persists(tmp_path):
    k = _kernel()
    k.workspace_root = str(tmp_path)  # hermetic: no real selection leaks in
    ok, msg = k.set_provider("opencode")
    assert ok is True
    assert k.provider == "opencode"
    assert k.model == "muse-spark-1.3-contributor-free"
    assert "opencode" in msg
    saved = read_last_selection(k.workspace_root)
    assert saved["provider"] == "opencode"
    assert saved["model"] == k.model


def test_set_provider_rejects_unknown():
    k = _kernel()
    before = k.provider
    ok, _ = k.set_provider("nope")
    assert ok is False
    assert k.provider == before


def test_set_model_resolves_variant_pair(tmp_path):
    k = _kernel()
    k.workspace_root = str(tmp_path)
    k.set_provider("google")
    ok, _ = k.set_model("gemini-3.1-pro high")
    assert ok is True
    assert k.model == "gemini-3.1-pro-high"


def test_set_model_rejects_cross_provider_variant(tmp_path):
    k = _kernel()
    k.workspace_root = str(tmp_path)
    k.set_provider("opencode")
    ok, _ = k.set_model("gemini-3.1-pro high")
    assert ok is False


def test_set_model_rejects_unknown(tmp_path):
    k = _kernel()
    k.workspace_root = str(tmp_path)
    before = k.model
    ok, _ = k.set_model("definitely-not-a-model")
    assert ok is False
    assert k.model == before


def test_selection_round_trip_tmp_workspace(tmp_path):
    write_last_selection(str(tmp_path), "meta", "muse-spark-1.3")
    sel = read_last_selection(str(tmp_path))
    assert sel["provider"] == "meta"
    assert sel["model"] == "muse-spark-1.3"
    assert read_last_selection(str(tmp_path / "missing")) == {}


def test_provider_switch_restores_last_model(tmp_path):
    k = _kernel()
    k.workspace_root = str(tmp_path)
    k.set_provider("opencode")
    k.set_model("gpt-5.4 mini")
    assert k.model == "gpt-5.4-mini"
    k.set_provider("google")
    assert k.provider == "google"
    ok, _ = k.set_provider("opencode")
    assert ok is True
    assert k.model == "gpt-5.4-mini"  # last opencode model remembered


def test_last_model_for_tmp_workspace(tmp_path):
    from quadrants.cognition.config import last_model_for
    assert last_model_for(str(tmp_path), "opencode") is None
    write_last_selection(str(tmp_path), "opencode", "gpt-5.4-mini")
    assert last_model_for(str(tmp_path), "opencode") == "gpt-5.4-mini"


def test_model_menu_piped_path_lists_without_changing(tmp_path):
    import asyncio
    from tui import handle_model_menu
    k = _kernel()
    k.workspace_root = str(tmp_path)
    before = (k.provider, k.model)
    asyncio.run(handle_model_menu(k, arg="", session=None))
    assert (k.provider, k.model) == before


def test_bash_read_tools_registered_and_schematized():
    k = _kernel()
    assert "bash" in k.tools.dynamic_tools
    assert "read" in k.tools.dynamic_tools
    schemas = k.get_tool_schemas()
    names = []
    for s in schemas:
        fn = s.get("function", {})
        if isinstance(fn, dict) and fn.get("name"):
            names.append(fn["name"])
    assert "bash" in names and "read" in names
    assert len(schemas) == len(k.tools.dynamic_tools)
