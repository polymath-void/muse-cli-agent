"""Credential + selection config for the cognition quadrant.

Reads API keys from (in precedence order):
  1. environment variables,
  2. the shared auth file (``~/.config/muse/auth.json``),
  3. explicit ``providers_config`` dicts passed by callers.

Persists the last ``provider``/``model`` selection per workspace root
in ``<workspace>/.muse/config.json`` so restarts resume where you left off.
"""

import json
import os
from pathlib import Path

from .auth import load_auth_file, save_auth_file
from .provider import PROVIDERS, provider_key_of

CONFIG_FILE_NAME = "config.json"


def muse_config_dir() -> str:
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if not xdg:
        xdg = str(Path.home() / ".config")
    return str(Path(xdg) / "muse")


def _auth_file_key(provider: str) -> str | None:
    auth = load_auth_file()
    providers = auth.get("providers", {})
    entry = providers.get(provider, {})
    if isinstance(entry, dict):
        key = entry.get("api_key") or entry.get("access_token")
        if key:
            return str(key).strip()
    return None


def key_for_provider(provider: str) -> str | None:
    """Best available API key for a provider (env first, then auth file)."""
    info = PROVIDERS.get(provider, {})
    for env_name in info.get("auth_env", []):
        val = os.environ.get(env_name)
        if val and val.strip():
            return val.strip()
    if provider == "agy":
        return None  # OAuth accounts file / connector, not a static key
    return _auth_file_key(provider)


def load_providers_config() -> dict:
    """Build the router's ``providers_config`` from env + auth file."""
    cfg: dict = {}
    for pname, info in PROVIDERS.items():
        accounts: list = []
        for env_name in info.get("auth_env", []):
            val = os.environ.get(env_name)
            if val and val.strip():
                accounts.append({"api_key": val.strip(), "source": f"env:{env_name}"})
        file_key = _auth_file_key(pname)
        if file_key and all(a.get("api_key") != file_key for a in accounts):
            accounts.append({"api_key": file_key, "source": "auth-file"})
        if accounts:
            cfg[pname] = {"accounts": accounts}
    return cfg


def save_provider_key(provider: str, api_key: str) -> str:
    """Persist a provider API key to the auth file. Returns the file path."""
    key = provider_key_of(provider)
    if not key:
        raise ValueError(f"Unknown provider: {provider}")
    if not api_key or not api_key.strip():
        raise ValueError("Empty API key")
    auth = load_auth_file()
    providers = auth.setdefault("providers", {})
    entry = providers.setdefault(key, {})
    entry["api_key"] = api_key.strip()
    from datetime import datetime, timezone

    entry["updated_at"] = datetime.now(timezone.utc).isoformat()
    return save_auth_file(auth)


def clear_provider_key(provider: str) -> str:
    """Remove a provider key from the auth file. Returns the file path."""
    key = provider_key_of(provider)
    if not key:
        raise ValueError(f"Unknown provider: {provider}")
    auth = load_auth_file()
    providers = auth.get("providers", {})
    if key in providers:
        providers[key].pop("api_key", None)
        providers[key].pop("access_token", None)
    return save_auth_file(auth)


def auth_state(provider: str) -> str:
    """Short auth status string for TUI display: 'env', 'file', 'oauth', '-'."""
    info = PROVIDERS.get(provider, {})
    for env_name in info.get("auth_env", []):
        if provider == "agy":
            continue
        if os.environ.get(env_name):
            return "env"
    if provider == "agy":
        try:
            accounts_path = Path.home() / ".config/opencode/antigravity-accounts.json"
            if accounts_path.exists():
                return "oauth"
        except Exception:
            pass
        return "-"
    if _auth_file_key(provider):
        return "file"
    return "-"


def workspace_config_path(workspace_root: str) -> str:
    return os.path.join(workspace_root, ".muse", CONFIG_FILE_NAME)


def read_last_selection(workspace_root: str) -> dict:
    """Return persisted selection or {} when absent/invalid.

    Shape: {'provider', 'model', 'last_by_provider': {provider: model}}.
    Older files without 'last_by_provider' still load.
    """
    try:
        with open(workspace_config_path(workspace_root), "r", encoding="utf-8") as f:
            data = json.load(f)
        sel = data.get("selection", {})
        if isinstance(sel, dict) and sel.get("provider") and sel.get("model"):
            out = {"provider": sel["provider"], "model": sel["model"]}
            last_map = sel.get("last_by_provider")
            if isinstance(last_map, dict):
                out["last_by_provider"] = {
                    str(k): str(v) for k, v in last_map.items() if v
                }
            return out
    except Exception:
        pass
    return {}


def write_last_selection(workspace_root: str, provider: str, model: str) -> None:
    """Persist the active pair and refresh the per-provider memory."""
    path = workspace_config_path(workspace_root)
    data: dict = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            if not isinstance(data, dict):
                data = {}
    except Exception:
        data = {}
    sel = data.get("selection")
    if not isinstance(sel, dict):
        sel = {}
    last_map = sel.get("last_by_provider")
    if not isinstance(last_map, dict):
        last_map = {}
    last_map[provider] = model
    data["selection"] = {
        "provider": provider,
        "model": model,
        "last_by_provider": last_map,
    }
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


def last_model_for(workspace_root: str, provider: str) -> str | None:
    """Last used model for a provider, or None."""
    sel = read_last_selection(workspace_root)
    return (sel.get("last_by_provider") or {}).get(provider)
