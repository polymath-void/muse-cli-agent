"""Slash parsing + @mention helpers (pure, offline)."""
from tui import (
    extract_mentions,
    filter_slash_commands,
    is_slash_menu_trigger,
    load_mention_context,
    parse_slash_input,
)


def test_parse_cmd_with_arg():
    assert parse_slash_input("/model foo") == {"command": "model", "arg": "foo"}


def test_parse_cmd_bare():
    assert parse_slash_input("/boot") == {"command": "boot", "arg": ""}


def test_parse_case_insensitive():
    assert parse_slash_input("/MODEL x") == {"command": "model", "arg": "x"}


def test_parse_non_slash_is_none():
    assert parse_slash_input("hello") is None
    assert parse_slash_input("") is None


def test_bare_slash_is_menu_trigger():
    assert is_slash_menu_trigger("/") is True
    assert is_slash_menu_trigger("/help") is False
    assert is_slash_menu_trigger("hello") is False


def test_filter_all_on_empty():
    from tui import SLASH_COMMANDS
    assert len(filter_slash_commands("")) == len(SLASH_COMMANDS)


def test_filter_prefix_and_miss():
    names = filter_slash_commands("mod")
    assert names == ["model"]
    assert filter_slash_commands("no-such-command-xyz") == []


def test_menu_lists_single_model_entry():
    from tui import SLASH_COMMANDS
    model_entries = [c for c in SLASH_COMMANDS if "model" in c]
    assert model_entries == ["model"]


def test_resolve_command_aliases_and_prefix():
    from tui import resolve_command
    assert resolve_command("models") == "models"  # hidden alias still works
    assert resolve_command("m") == "m"
    assert resolve_command("model") == "model"
    assert resolve_command("mod") == "model"
    assert resolve_command("quit") == "quit"  # intercepted earlier in the loop
    assert resolve_command("no-such-command-xyz") is None


def test_extract_mentions_order_dedup():
    assert extract_mentions("fix @a.py and @b.py then @a.py") == ["a.py", "b.py"]
    assert extract_mentions("no mentions") == []


def test_load_mention_context_file_and_missing(tmp_path, monkeypatch):
    f = tmp_path / "note.txt"
    f.write_text("hello-context")
    monkeypatch.chdir(tmp_path)
    block = load_mention_context(["note.txt", "ghost.txt"], cwd=".")
    assert "hello-context" in block
    assert "not found" in block


def test_load_mention_context_dir(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "x.py").write_text("x")
    block = load_mention_context(["sub"], cwd=".")
    assert "x.py" in block
