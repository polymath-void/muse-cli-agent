"""Interactive-path regression: _read_interactive must use the
prompt_toolkit patch_stdout *context manager* (the top-level name is a
module, which crashed real TTY runs with `TypeError: 'module' object
is not callable`)."""
import asyncio

from tui import _read_interactive


class _StubSession:
    async def prompt_async(self, *args, **kwargs):
        return "/quit"


def test_read_interactive_returns_prompt_text():
    assert asyncio.run(_read_interactive(_StubSession())) == "/quit"


def test_patch_stdout_import_is_callable():
    from prompt_toolkit.patch_stdout import patch_stdout
    assert callable(patch_stdout)
