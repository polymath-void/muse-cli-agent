"""
Muse CLI Agent — Interactive Terminal Interface.

Interactive layer (prompt_toolkit when available):
- up/down navigates persistent history (``~/.config/muse/history``),
- ``/`` pops up the slash-command menu with descriptions,
- ``@`` pops up file/folder selection relative to the working directory,
- ``/model <tab>`` completes models of the active provider (with variants),
- ``/provider`` / ``/login`` complete provider names,
- bottom toolbar always shows ``provider • model``.

Non-interactive fallback: when stdin is not a TTY (pipes, CI) or
prompt_toolkit is missing, input falls back to a plain readline-style
``console.input`` loop so ``printf ... | muse-cli`` keeps working.
"""
import asyncio
import getpass
import os
import re
import sys
from datetime import datetime
from pathlib import Path

from rich.console import Console
from rich.theme import Theme

try:
    from prompt_toolkit import PromptSession
    from prompt_toolkit.completion import Completer, Completion
    from prompt_toolkit.history import FileHistory
    HAS_PTK = True
except ImportError:  # pragma: no cover - fallback path
    PromptSession = None
    Completer = object
    Completion = None
    FileHistory = None
    HAS_PTK = False

MUSE_THEME = Theme({
    "muse": "bold cyan",
    "user": "bold green",
    "dim": "dim white",
    "err": "bold red",
    "cmd": "bold yellow",
    "info": "italic blue",
    "tool": "bold magenta",
    "success": "bold green",
})

console = Console(theme=MUSE_THEME)


# ──────────────────────────────────────────────
# Slash Commands
# ──────────────────────────────────────────────

SLASH_COMMANDS = {
    "help":     "Show available commands",
    "model":    "Pick a provider, then a model (arrow-key menus)",
    "provider": "List or switch providers",
    "login":    "Browser/device login per provider (/login [provider] [--key])",
    "logout":   "Remove the stored API key for a provider",
    "tools":    "List all registered tools",
    "status":   "Show kernel status",
    "clear":    "Clear conversation memory",
    "apex":     "Route a task to the Apex Rage Engine",
    "exec":     "Run a shell command",
    "quit":     "Exit Muse CLI",
}


# ──────────────────────────────────────────────
# Pure helpers (unit-tested, no I/O)
# ──────────────────────────────────────────────

def parse_slash_input(text: str) -> dict | None:
    """Parse '/cmd args' -> {'command', 'arg'}. None for non-slash input."""
    if not text or not text.startswith("/"):
        return None
    body = text[1:].strip()
    if not body:
        return {"command": "", "arg": ""}
    parts = body.split(None, 1)
    return {"command": parts[0].lower(), "arg": parts[1] if len(parts) > 1 else ""}


def is_slash_menu_trigger(text: str) -> bool:
    """A bare '/' opens the command menu instead of sending a prompt."""
    return text == "/"


def filter_slash_commands(prefix: str) -> list:
    """Slash commands starting with prefix (case-insensitive), sorted."""
    p = (prefix or "").lower()
    return sorted([c for c in SLASH_COMMANDS if c.startswith(p)])


MENTION_RE = re.compile(r"@([^\s@]+)")


def extract_mentions(text: str) -> list:
    """Return @path mentions in order of appearance (deduped)."""
    seen = []
    for m in MENTION_RE.finditer(text or ""):
        path = m.group(1).rstrip(".,;:!?)")
        if path and path not in seen:
            seen.append(path)
    return seen


def load_mention_context(paths: list, cwd: str = ".", limit_files: int = 5,
                         limit_chars: int = 20000) -> str:
    """Read mentioned files into a bounded context block (missing -> note)."""
    blocks = []
    for rel in paths[:limit_files]:
        abs_path = os.path.join(cwd, os.path.expanduser(rel))
        if os.path.isdir(abs_path):
            try:
                entries = sorted(os.listdir(abs_path))[:50]
                blocks.append(f"<file {rel}/>\n" + "\n".join(entries) + f"\n</file>")
            except OSError as e:
                blocks.append(f"<file {rel}/>unreadable: {e}</file>")
        elif os.path.isfile(abs_path):
            try:
                with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read(limit_chars + 1)
                if len(content) > limit_chars:
                    content = content[:limit_chars] + "\n…(truncated)"
                blocks.append(f"<file {rel}>\n{content}\n</file>")
            except OSError as e:
                blocks.append(f"<file {rel}/>unreadable: {e}</file>")
        else:
            blocks.append(f"<file {rel}/>not found</file>")
    return "\n".join(blocks)


# ──────────────────────────────────────────────
# Completion
# ──────────────────────────────────────────────

def _complete_paths(fragment: str, cap: int = 50) -> list:
    """Filesystem completions for an @fragment. Returns (text, kind)."""
    base_dir, partial = os.path.split(fragment)
    search_dir = os.path.join(os.getcwd(), base_dir) if base_dir else os.getcwd()
    try:
        entries = sorted(os.listdir(search_dir))
    except OSError:
        return []
    out = []
    for entry in entries:
        if entry.startswith(".") and not partial.startswith("."):
            continue
        if not entry.startswith(partial):
            continue
        full = os.path.join(base_dir, entry) if base_dir else entry
        kind = "dir" if os.path.isdir(os.path.join(search_dir, entry)) else "file"
        if kind == "dir":
            full += "/"
        out.append((full, kind))
        if len(out) >= cap:
            break
    return out


class MuseCompleter(Completer):
    """Popup completion for /, @paths, /model, /provider, /login."""

    def __init__(self, kernel_getter):
        # kernel_getter: () -> kernel (late binding; kernel outlives session)
        self._kernel = kernel_getter

    def _model_candidates(self) -> list:
        try:
            from quadrants.cognition.provider import (
                expand_variants,
                models_for_gateway,
            )
            kernel = self._kernel()
            provider = getattr(kernel, "provider", "google")
            catalog = models_for_gateway(provider)
            cands = list(catalog)
            for base in catalog:
                for variant in expand_variants(base)[1:]:
                    if variant not in cands:
                        cands.append(variant)
            return cands
        except Exception:
            return []

    def _provider_candidates(self) -> list:
        try:
            from quadrants.cognition.provider import provider_names
            return provider_names()
        except Exception:
            return ["google", "opencode", "meta", "agy", "anthropic"]

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor or ""
        if Completion is None:
            return

        # `/model <partial>` -> model popup for the active provider.
        m = re.match(r"^/(?:model|m)\s+(\S*)$", text)
        if m:
            frag = m.group(1).lower()
            for cand in self._model_candidates():
                if cand.lower().startswith(frag):
                    yield Completion(
                        cand, start_position=-len(m.group(1)),
                        display=cand, display_meta="model",
                    )
            return

        # `/provider|/login|/logout <partial>` -> provider popup.
        m = re.match(r"^/(?:provider|p|login|logout)\s*(\S*)$", text)
        if m and " " in text:
            frag = (m.group(1) or "").lower()
            for cand in self._provider_candidates():
                if cand.startswith(frag):
                    yield Completion(
                        cand, start_position=-len(m.group(1) or ""),
                        display=cand, display_meta="provider",
                    )
            return

        # `/<partial>` -> slash command popup.
        if text.startswith("/") and " " not in text:
            frag = text[1:].lower()
            for name in filter_slash_commands(frag):
                yield Completion(
                    "/" + name, start_position=-len(text),
                    display="/" + name,
                    display_meta=SLASH_COMMANDS[name],
                )
            return

        # `@<partial>` -> file/folder popup (may follow any text).
        m = re.search(r"@(\S*)$", text)
        if m:
            frag = m.group(1)
            for full, kind in _complete_paths(frag):
                yield Completion(
                    full, start_position=-len(frag),
                    display=full, display_meta=kind,
                )


def history_path() -> str:
    from quadrants.cognition.config import muse_config_dir
    d = muse_config_dir()
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "history")


def build_session(kernel):
    """Create the interactive prompt session (history + completer + toolbar)."""
    def _toolbar():
        provider = getattr(kernel, "provider", "?")
        model = getattr(kernel, "model", "?")
        ntools = len(getattr(getattr(kernel, "tools", None), "dynamic_tools", {}) or {})
        return f" {provider} • {model} • {ntools} tools "

    return PromptSession(
        history=FileHistory(history_path()),
        completer=MuseCompleter(lambda: kernel),
        complete_while_typing=True,
        bottom_toolbar=_toolbar,
    )


def interactive_available() -> bool:
    return bool(HAS_PTK and sys.stdin.isatty())


# ──────────────────────────────────────────────
# Display helpers
# ──────────────────────────────────────────────

def print_banner(kernel):
    """Print a clean startup banner."""
    from env import PLATFORM

    tool_count = len(kernel.tools.dynamic_tools)
    quadrants = len(kernel.quadrants)
    platform_label = "Termux" if PLATFORM["is_termux"] else PLATFORM["system"]

    console.print()
    console.print("  [muse]✦ muse-cli[/]  [dim]·[/]  interactive coding agent", highlight=False)
    console.print(
        f"  [dim]{platform_label} · {PLATFORM['machine']} · "
        f"{quadrants} quadrants · {tool_count} tools[/]",
        highlight=False
    )
    provider = getattr(kernel, "provider", "google")
    model = getattr(kernel, "model", "gemini-2.5-flash")
    console.print(f"  [dim]{provider} · {model}[/]", highlight=False)
    console.print(f"  [dim]session {datetime.now().strftime('%H:%M:%S')}  ·  "
                  f"type [cmd]/help[/cmd] for commands  ·  ↑/↓ history  ·  Ctrl+C exits[/]")
    console.print("  " + "─" * 50, style="dim")
    console.print()


def _print_columns(items: list, cols: int = 3, term_width: int = 80):
    width = 2
    if items:
        width = min(max(len(str(i)) for i in items), 30) + 2
    cols = max(1, min(cols, term_width // (width + 2)))
    rows = (len(items) + cols - 1) // cols
    for i in range(rows):
        parts = []
        for c in range(cols):
            idx = i + c * rows
            if idx < len(items):
                label = str(items[idx])
                if len(label) > width - 2:
                    label = label[: width - 5] + "…"
                parts.append(f"  [tool]{label:<{width}}[/]")
        console.print("".join(parts), highlight=False)


def handle_help(**_):
    """Display available slash commands."""
    console.print()
    for cmd, desc in SLASH_COMMANDS.items():
        console.print(f"  [cmd]/{cmd:<10}[/]  {desc}")
    console.print()


def handle_provider(kernel, arg="", **_):
    """List providers (with auth state) or switch to one."""
    from quadrants.cognition.config import auth_state
    from quadrants.cognition.provider import PROVIDER_ORDER, get_provider

    if arg:
        ok, msg = kernel.set_provider(arg)
        style = "success" if ok else "err"
        console.print(f"  [{style}]{msg}[/]")
        if ok:
            console.print(f"  [dim]tip: /model to pick a {kernel.provider} model[/]")
        return
    console.print()
    for name in PROVIDER_ORDER:
        info = get_provider(name)
        marker = "●" if name == getattr(kernel, "provider", "") else "○"
        console.print(
            f"  [cmd]{marker} {name:<10}[/]  {info['label']:<22}  [dim]auth: {auth_state(name)}[/]"
        )
    console.print("\n  [dim]usage: /provider <name>[/]")
    console.print()


async def radio_menu(title: str, text: str, values: list) -> str | None:
    """Arrow-key radio selection. Returns the chosen value, None on cancel.

    Returns None when dialogs are unavailable (non-TTY) so callers can
    fall back to typed selection.
    """
    try:
        from prompt_toolkit.shortcuts import radiolist_dialog
        if not sys.stdin.isatty():
            return None
        return await radiolist_dialog(title=title, text=text, values=values).run_async()
    except Exception:
        return None


async def fallback_numbered_pick(session, options: list, prompt="  number> ") -> str | None:
    """Typed-number fallback when radio dialogs are unavailable."""
    console.print()
    for i, (value, label) in enumerate(options, 1):
        console.print(f"  [cmd]{i:>3}[/]  {label}")
    console.print()
    try:
        if session is not None and hasattr(session, "prompt_async"):
            raw = await session.prompt_async(prompt)
        else:
            loop = asyncio.get_event_loop()
            raw = await loop.run_in_executor(None, lambda: console.input(prompt))
    except (EOFError, KeyboardInterrupt):
        return None
    raw = (raw or "").strip()
    if raw.isdigit() and 1 <= int(raw) <= len(options):
        return options[int(raw) - 1][0]
    for value, label in options:
        if raw.lower() in (value.lower(), label.lower()):
            return value
    return None


def _print_model_catalog(kernel):
    """Print the active provider's static catalog (piped/non-TTY use)."""
    from quadrants.cognition.provider import (
        expand_variants,
        models_for_gateway,
        sort_models_for_display,
    )

    provider = getattr(kernel, "provider", "google")
    catalog = models_for_gateway(provider)
    current = getattr(kernel, "model", "")
    console.print(f"\n  [dim]models for {provider} (current: {current}):[/]")
    _print_columns(sort_models_for_display(catalog))
    variant_bases = [b for b in catalog if len(expand_variants(b)) > 1]
    if variant_bases:
        console.print(
            f"\n  [dim]variants: /model {' | /model '.join(variant_bases[:4])} <variant>[/]"
        )
    console.print()


async def handle_model_menu(kernel, arg="", session=None, **_):
    """Unified /model flow: a query sets directly, bare opens cascade menus."""
    from quadrants.cognition.config import auth_state
    from quadrants.cognition.provider import (
        PROVIDER_ORDER,
        expand_variants,
        get_provider,
        models_for_gateway,
        sort_models_for_display,
    )

    provider = getattr(kernel, "provider", "google")
    if arg:
        ok, msg = kernel.set_model(arg)
        style = "success" if ok else "err"
        console.print(f"  [{style}]{msg}[/]")
        if not ok:
            console.print("  [dim]tip: /model with no args opens the picker[/]")
        return

    interactive = session is not None and interactive_available()

    # ── Step 1: provider ──
    if interactive:
        values = []
        for name in PROVIDER_ORDER:
            info = get_provider(name)
            current = "  (current)" if name == provider else ""
            values.append((
                name,
                f"{name} — {info['label']}  [auth: {auth_state(name)}]{current}",
            ))
        picked = await radio_menu("muse-cli · model", "Select provider (up/down + Enter):", values)
        if picked is None:
            picked = await fallback_numbered_pick(
                session,
                [(n, f"{n} — {get_provider(n)['label']}") for n in PROVIDER_ORDER],
                prompt="  provider (number or name)> ",
            )
        if not picked:
            console.print("  [dim]model picker cancelled[/]")
            return
        if picked != provider:
            ok, msg = kernel.set_provider(picked)
            console.print(f"  [dim]{msg}[/]")
            provider = picked
    else:
        console.print("\n  [dim]providers:[/]")
        for name in PROVIDER_ORDER:
            mark = "●" if name == provider else "○"
            console.print(f"  [cmd]{mark} {name}[/]")
        _print_model_catalog(kernel)
        console.print("  [dim]tip: run on a terminal for the arrow-key picker[/]")
        return

    # ── Step 2: model of the picked provider ──
    try:
        from quadrants.cognition.provider import catalog_with_source
        catalog, source = catalog_with_source(provider, timeout=15.0)
    except Exception:
        catalog, source = models_for_gateway(provider), "static"
    current = getattr(kernel, "model", "")
    ordered = []
    for base in catalog:
        if base not in ordered:
            ordered.append(base)
        for variant in expand_variants(base)[1:]:
            if variant not in ordered:
                ordered.append(variant)
    ordered = sort_models_for_display(ordered)
    values = [
        (mid, f"{mid}  (current)" if mid == current else mid) for mid in ordered
    ]
    source_tag = {"live": "live", "cache": "cached",
                  "static": "bundled"}.get(source, source)
    choice = await radio_menu(
        "muse-cli · model",
        f"Select {provider} model [{source_tag}] (up/down + Enter):", values
    )
    if choice is None:
        choice = await fallback_numbered_pick(
            session, [(mid, mid) for mid in ordered], prompt="  model (number or name)> "
        )
    if not choice:
        console.print("  [dim]model picker cancelled[/]")
        return
    ok, msg = kernel.set_model(choice)
    style = "success" if ok else "err"
    console.print(f"  [{style}]{msg}[/]")


def handle_model(kernel, arg="", **_):
    """Sync wrapper: direct set, or printed catalog when piped."""
    if arg:
        ok, msg = kernel.set_model(arg)
        style = "success" if ok else "err"
        console.print(f"  [{style}]{msg}[/]")
        return
    _print_model_catalog(kernel)


def handle_models(kernel, arg="", **_):
    """Show the full model catalog with its provenance (live/cache/static)."""
    from quadrants.cognition.provider import (
        catalog_with_source,
        provider_key_of,
        sort_models_for_display,
    )

    raw = (arg.strip() or getattr(kernel, "provider", "google"))
    provider = provider_key_of(raw) or raw
    console.print(f"\n  [dim]fetching catalog for {provider}...[/]")
    try:
        catalog, source = catalog_with_source(provider, timeout=15.0)
    except Exception as e:
        console.print(f"  [err]catalog error: {e}[/]")
        return
    tag = {"live": "live from opencode.ai", "cache": "24h cache",
           "static": "static fallback (offline)"}.get(source, source)
    console.print(f"  [dim]{len(catalog)} models ({tag}):[/]")
    _print_columns(sort_models_for_display(catalog))
    console.print()


def login_options() -> list:
    """Pure helper: (provider key, menu label) for the login picker."""
    from quadrants.cognition.config import auth_state
    from quadrants.cognition.provider import PROVIDER_ORDER, get_provider

    options = []
    for name in PROVIDER_ORDER:
        info = get_provider(name) or {}
        method = info.get("auth_method", "API key")
        options.append((
            name,
            f"{name} — {info.get('label', name)}  [{method}] (auth: {auth_state(name)})",
        ))
    return options


def _print_login_table():
    """Print every provider with its auth method and state (piped use)."""
    console.print()
    for _key, label in login_options():
        # markup=False: labels contain literal "[API key]"-style brackets.
        console.print(f"  {label}", highlight=False, markup=False)
    console.print("  [dim]usage: /login <provider>  ·  /login <provider> --key pastes a key; "
                  "anthropic is key-only[/]")
    console.print()


async def _pick_login_provider(session) -> str | None:
    """Arrow-key provider picker for /login. None on cancel/unavailable."""
    values = [(key, label) for key, label in login_options()]
    picked = await radio_menu(
        "muse-cli · login", "Select provider to register (up/down + Enter):", values
    )
    if picked is None:
        picked = await fallback_numbered_pick(
            session, values, prompt="  provider (number or name)> "
        )
    return picked


async def _run_native_flow(kernel, provider: str):
    """Run a browser/device login flow in a worker thread (cancellable)."""
    import threading
    from quadrants.cognition import device_auth as _da

    flows = {
        "opencode": _da.login_opencode_device_flow,
        "google": _da.login_google_pkce_flow,
        "agy": _da.login_agy_pkce_flow,
        "meta": _da.login_meta_device_flow,
    }
    flow_fn = flows.get(provider)
    if flow_fn is None:
        console.print(f"  [err]no native flow for '{provider}'[/]")
        return
    stop = threading.Event()
    console.print(f"  [dim]starting {provider} browser login — Ctrl+C cancels[/]")
    try:
        entry, path = await asyncio.to_thread(
            flow_fn,
            lambda m: console.print(f"  [dim]{m}[/]"),
            lambda info: (
                console.print(),
                console.print(f"  [cmd]approve in browser — code: {info['user_code']}[/]"),
                console.print(f"  [dim]{info['verification_uri_complete']}[/]"),
                console.print(),
            ),
            True,
            stop,
        )
    except (KeyboardInterrupt, asyncio.CancelledError):
        stop.set()
        console.print("\n  [dim]login cancelled[/]")
        return
    except Exception as e:
        code = getattr(e, "code", "error")
        console.print(f"  [err]login failed [{code}]: {e}[/]")
        hint = getattr(e, "hint", "")
        if hint:
            console.print(f"  [dim]{hint}[/]")
        return
    kernel.refresh_providers_config()
    email = (entry or {}).get("user_email", "")
    who = f" as {email}" if email and email != "unknown" else ""
    console.print(f"  [success]✓[/] {provider} login complete{who} → [dim]{path}[/]")


async def _login_with_key(kernel, target: str, session=None):
    """Paste-an-API-key flow (key-only providers, or `<provider> --key`)."""
    from quadrants.cognition.config import auth_state, save_provider_key
    from quadrants.cognition.provider import get_provider

    info = get_provider(target) or {}
    env_names = info.get("auth_env", [])
    import os as _os
    if any(_os.environ.get(n) for n in env_names) and auth_state(target) == "env":
        console.print(f"  [dim]{target} already authed via env ({'/'.join(env_names)})[/]")
        return
    prompt_text = f"  {target} API key (input hidden): "
    try:
        if session is not None and hasattr(session, "prompt_async"):
            key = await session.prompt_async(prompt_text, is_password=True)
        else:
            key = await asyncio.get_event_loop().run_in_executor(
                None, lambda: getpass.getpass(prompt_text)
            )
    except (EOFError, KeyboardInterrupt):
        console.print("\n  [dim]login cancelled[/]")
        return
    if not key or not key.strip():
        console.print("  [dim]empty key — nothing stored[/]")
        return
    try:
        path = save_provider_key(target, key.strip())
        kernel.refresh_providers_config()
        console.print(f"  [success]✓[/] {target} key stored → [dim]{path}[/]")
    except Exception as e:
        console.print(f"  [err]login failed: {e}[/]")


async def _login_opencode_dashboard(kernel, session=None):
    """Zen takes dashboard API keys only: open the console, then paste.

    (The console device flow issues `st_` session tokens, which Zen's
    inference API rejects on every surface — verified live.)
    """
    from quadrants.cognition.device_auth import open_browser

    url = "https://opencode.ai/console"
    console.print("  [dim]sign in to OpenCode Zen, add billing, copy your API key:[/]")
    console.print(f"  [cmd]{url}[/]")
    if open_browser(url):
        console.print("  [dim]browser opened — copy the key, then paste below[/]")
    else:
        console.print("  [dim](could not auto-open a browser — open the URL manually)[/]")
    await _login_with_key(kernel, "opencode", session)


async def _login_opencode_combined(kernel, session=None, key_only: bool = False):
    """Full opencode login: device flow (identity) + minted Zen key (calls).

    The device session alone cannot call Zen, so a service-account key is
    minted right after approval and stored as the API key. If minting fails
    (e.g. billing not set up), falls back to manual dashboard-key paste.
    """
    from quadrants.cognition import device_auth as _da
    from quadrants.cognition.config import save_provider_key

    if not key_only:
        await _run_native_flow(kernel, "opencode")
        try:
            entry = _da.get_provider_auth("opencode")
            session_token = entry.get("access_token", "")
            if not session_token:
                raise _da.AuthError("no_session", "device login produced no session")
            import functools
            mint = functools.partial(
                _da.mint_zen_api_key,
                session_token,
                org_id=entry.get("org_id"),
                account_id=entry.get("service_account_id"),
            )
            token, key_id, acct_id, org_id = await asyncio.to_thread(mint)
            save_provider_key("opencode", token)
            _da.set_provider_auth("opencode", {
                "org_id": org_id,
                "service_account_id": acct_id,
                "service_key_id": key_id,
                "service_key_name": "muse-cli-zen",
                "console_url": _da.OPENCODE_CONSOLE_URL,
            })
            kernel.refresh_providers_config()
            console.print("  [dim]zen API key minted automatically "
                          f"(id ends …{key_id[-4:] if key_id else '????'}); "
                          "revoke superseded keys in the console[/]")
            console.print(f"  [success]✓[/] opencode login complete → [dim]zen calls enabled[/]")
            return
        except Exception as e:
            code = getattr(e, "code", "error")
            console.print(f"  [dim]auto-mint failed [{code}] — paste a key instead[/]")
            hint = getattr(e, "hint", "")
            if hint:
                console.print(f"  [dim]{hint}[/]")
    await _login_opencode_dashboard(kernel, session)


async def handle_login(kernel, arg="", session=None, **_):
    """Register provider auth: picker menu, or /login [provider] directly."""
    from quadrants.cognition.provider import PROVIDER_ORDER, provider_key_of

    words = (arg or "").split()
    target = provider_key_of(words[0]) if words else None
    if words and not target:
        console.print(f"  [err]unknown provider '{words[0]}' — try: {', '.join(PROVIDER_ORDER)}[/]")
        return
    if target is None:
        if session is None or not interactive_available():
            _print_login_table()
            return
        target = await _pick_login_provider(session)
        if not target:
            console.print("  [dim]login cancelled[/]")
            return

    # Native browser/device auth flows (ported from backup_ts/src/auth.ts).
    if target == "anthropic":
        console.print("  [dim]anthropic has no browser flow — paste a console key.[/]")
        await _login_with_key(kernel, target, session)
        return
    if target == "opencode":
        await _login_opencode_combined(
            kernel, session,
            key_only=len(words) > 1 and words[1] in ("--key", "key"),
        )
        return
    if len(words) > 1 and words[1] in ("--key", "key"):
        await _login_with_key(kernel, target, session)
        return
    await _run_native_flow(kernel, target)


def handle_logout(kernel, arg="", **_):
    """Remove a stored provider key: /logout [provider]."""
    from quadrants.cognition.config import clear_provider_key
    from quadrants.cognition.provider import provider_key_of

    target = provider_key_of(arg) if arg else getattr(kernel, "provider", "google")
    if not target:
        console.print(f"  [err]unknown provider '{arg}'[/]")
        return
    try:
        path = clear_provider_key(target)
        kernel.refresh_providers_config()
        console.print(f"  [dim]{target} key removed → {path}[/]")
    except Exception as e:
        console.print(f"  [err]logout failed: {e}[/]")


def handle_tools(kernel, **_):
    """List all registered dynamic tools."""
    console.print()
    tools = sorted(kernel.tools.dynamic_tools.keys())
    _print_columns(tools)
    console.print(f"\n  [dim]{len(tools)} tools registered[/]")
    console.print()


def handle_status(kernel, **_):
    """Show kernel status."""
    console.print()
    console.print(f"  state:     [success]{kernel.state}[/]")
    console.print(f"  provider:  {getattr(kernel, 'provider', '?')}  [dim]({getattr(kernel, 'model', '?')})[/]")
    console.print(f"  quadrants: {', '.join(kernel.quadrants.keys())}")
    console.print(f"  plugins:   {', '.join(kernel.plugins.keys())}")
    console.print(f"  tools:     {len(kernel.tools.dynamic_tools)}")
    console.print(f"  memory:    {len(kernel.memory.history)} messages")
    try:
        alive = kernel.fleet.scheduler._thread.is_alive()
    except Exception:
        alive = False
    console.print(f"  scheduler: {'[success]alive[/]' if alive else '[err]dead[/]'}")
    console.print()


def handle_clear(kernel, **_):
    """Clear conversation memory."""
    kernel.memory.clear()
    console.print("  [dim]memory cleared[/]")


async def handle_apex(kernel, arg="", **_):
    """Route task to Apex engine."""
    if not arg:
        console.print("  [err]usage: /apex <task description>[/]")
        return
    console.print("  [tool]routing to apex...[/]")
    result = kernel.route_message("apex", arg)
    console.print(f"  {result}")


async def handle_exec(kernel, arg="", **_):
    """Run a shell command via fleet."""
    if not arg:
        console.print("  [err]usage: /exec <command>[/]")
        return
    console.print(f"  [dim]$ {arg}[/]")
    result = kernel.fleet.run_command(arg)
    console.print(result)


COMMAND_HANDLERS = {
    "help": handle_help,
    "model": handle_model_menu,
    "m": handle_model_menu,
    "provider": handle_provider,
    "p": handle_provider,
    "models": handle_models,
    "login": handle_login,
    "logout": handle_logout,
    "tools": handle_tools,
    "status": handle_status,
    "clear": handle_clear,
    "apex": handle_apex,
    "exec": handle_exec,
}


# ──────────────────────────────────────────────
# Fuzzy Command Matching
# ──────────────────────────────────────────────

def match_command(text: str) -> list[str]:
    """Return commands that start with the given prefix."""
    return [c for c in SLASH_COMMANDS if c.startswith(text)]


def resolve_command(cmd: str) -> str | None:
    """Resolve typed input to a handler key.

    Exact handler names/aliases win (so hidden aliases like 'models',
    'm', 'p' keep working); otherwise a unique SLASH_COMMANDS prefix
    resolves, anything else is None (unknown/ambiguous).
    """
    if cmd in COMMAND_HANDLERS:
        return cmd
    matches = match_command(cmd)
    if len(matches) == 1:
        return matches[0]
    return None


# ──────────────────────────────────────────────
# Main Loop
# ──────────────────────────────────────────────

async def _read_interactive(session) -> str:
    from prompt_toolkit.patch_stdout import patch_stdout
    with patch_stdout():
        return await session.prompt_async("  › ")


async def chat_loop(kernel):
    """Core interactive loop (prompt_toolkit when on a TTY, else plain)."""
    session = build_session(kernel) if interactive_available() else None
    loop = asyncio.get_event_loop()

    while True:
        try:
            if session is not None:
                try:
                    user_input = await _read_interactive(session)
                except (EOFError, KeyboardInterrupt):
                    console.print("\n  [dim]goodbye[/]\n")
                    break
            else:
                user_input = await loop.run_in_executor(
                    None, lambda: console.input("[user] › [/]")
                )
        except (EOFError, KeyboardInterrupt):
            console.print("\n  [dim]goodbye[/]\n")
            break

        text = user_input.strip()
        if not text:
            continue

        # Bare "/" opens the menu listing instead of hitting the model.
        if is_slash_menu_trigger(text):
            handle_help()
            continue

        # ── Slash commands ──
        if text.startswith("/"):
            parsed = parse_slash_input(text)
            cmd = parsed["command"]
            arg = parsed["arg"]

            if cmd in ("quit", "exit", "q"):
                console.print("  [dim]goodbye[/]\n")
                break

            matches = match_command(cmd)
            canonical = resolve_command(cmd)
            if canonical is None:
                if len(matches) > 1:
                    console.print(f"  [dim]did you mean: {', '.join('/' + m for m in matches)}?[/]")
                else:
                    console.print(f"  [err]unknown command: /{cmd}[/]  [dim](try /help)[/]")
                continue

            handler = COMMAND_HANDLERS.get(canonical)
            if handler:
                if asyncio.iscoroutinefunction(handler):
                    await handler(kernel=kernel, arg=arg, session=session)
                else:
                    handler(kernel=kernel, arg=arg, session=session)
            continue

        # ── @file mentions → bounded context ──
        mentions = extract_mentions(text)
        if mentions:
            block = load_mention_context(mentions, cwd=os.getcwd())
            if block:
                text = block + "\n\n" + text

        # ── Chat ──
        if hasattr(kernel, "chat"):
            console.print("  [dim]thinking...[/]", end="\r")
            try:
                response = await kernel.chat(text)
                console.print(" " * 40, end="\r")
                console.print(f"  [muse]muse[/]  {response}")
            except Exception as e:
                console.print(f"  [err]error: {e}[/]")
        else:
            console.print(f"  [muse]echo[/]  {text}")

        console.print()


def run(kernel):
    """Entry point for the TUI."""
    print_banner(kernel)
    try:
        asyncio.run(chat_loop(kernel))
    except KeyboardInterrupt:
        console.print("\n  [dim]goodbye[/]\n")
