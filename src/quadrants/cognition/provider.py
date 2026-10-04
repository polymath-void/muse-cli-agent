"""Provider-based model catalog for Muse CLI Agent.

Each provider owns its model list, default model, and auth sources.
The opencode provider additionally supports a live model listing
(public ``/v1/models`` endpoint) with a 24h file cache and a static
fallback so the TUI works fully offline.
"""

import json
import os
import time
from pathlib import Path

PROVIDER_ORDER = ["google", "opencode", "meta", "agy", "anthropic"]

PROVIDERS = {
    "google": {
        "label": "Google Gemini",
        "default_model": "gemini-2.5-flash",
        "auth_env": ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        "auth_method": "Browser (PKCE)",
        "models": [
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
            "gemini-2.5-pro",
            "gemini-3-flash",
            "gemini-3.1-pro",
            "gemini-3.1-pro-high",
            "gemini-3.1-pro-low",
            "gemini-3-pro",
            "gemini-3-pro-low",
            "gemini-3.5-flash",
            "gemini-3.5-flash-lite",
            "gemini-3.6-flash",
            "gemini-3.7-flash",
            "gemini-3.8-flash",
        ],
    },
    "opencode": {
        "label": "OpenCode Zen",
        "default_model": "muse-spark-1.3-contributor-free",
        "auth_env": ["OPENCODE_API_KEY"],
        "auth_method": "Device + key",
        "models": [
            "muse-spark-1.3-contributor-free",
            "muse-spark-1.2-contributor-free",
            "muse-spark-1.3",
            "muse-spark-1.2",
            "opencode/claude-sonnet-4.5",
            "opencode/grok-code",
            "opencode/qwen3-coder",
            "opencode/kimi-k2",
            "opencode/deepseek-v3.1",
            "opencode/cursor-ide",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.4-nano",
            "gpt-5.4-pro",
            "gpt-5.1-codex",
            "gpt-5.1-codex-mini",
            "claude-sonnet-4-5",
            "claude-opus-4-5",
            "grok-4.7",
            "kimi-k2.5",
            "qwen3.8-flash",
            "qwen3.8-max",
        ],
    },
    "meta": {
        "label": "Meta Muse",
        "default_model": "muse-spark-1.3",
        "auth_env": ["MUSE_API_KEY"],
        "auth_method": "Device code",
        "models": [
            "muse-spark-1.3",
            "muse-spark-1.2",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.4-nano",
            "gpt-5.1-codex",
            "gpt-5",
            "gpt-5-mini",
        ],
    },
    "agy": {
        "label": "Antigravity Connector",
        "default_model": "claude-sonnet-4-5",
        "auth_env": ["AGY_CONNECTOR_URL"],
        "auth_method": "Browser (PKCE)",
        "models": [
            "claude-sonnet-4-5",
            "claude-sonnet-4-6",
            "claude-opus-4-1",
            "claude-4.5-sonnet",
            "claude-3.7-sonnet",
            "gemini-3.1-pro",
            "gemini-3-flash",
        ],
    },
    "anthropic": {
        "label": "Anthropic Direct",
        "default_model": "claude-sonnet-4-5",
        "auth_env": ["ANTHROPIC_API_KEY"],
        "auth_method": "API key",
        "models": [
            "claude-sonnet-4-5",
            "claude-sonnet-4-6",
            "claude-opus-4-1",
            "claude-haiku-4-5",
        ],
    },
}

# Model variants: base model -> selectable suffix options.
# `/model <base> <variant>` resolves to `<base>-<variant>`.
MODEL_VARIANTS = {
    "gemini-3.1-pro": ["high", "low"],
    "gemini-3-pro": ["low"],
    "gemini-3.1-pro-high": [],
    "gemini-3.1-pro-low": [],
    "gpt-5.4": ["mini", "nano", "pro"],
    "gpt-5.1": ["codex", "codex-mini", "codex-max"],
    "gpt-5": ["mini", "nano", "codex"],
    "gpt-5.5": ["pro"],
    "claude-sonnet-4": ["5", "6"],
    "claude-opus-4": ["5", "6", "7", "8"],
}


def resolve_model_alias(model: str) -> str:
    return model


def provider_names() -> list:
    """Ordered provider keys."""
    return list(PROVIDER_ORDER)


def get_provider(name: str) -> dict | None:
    """Case-insensitive provider lookup. Returns None for unknown names."""
    if not name:
        return None
    key = name.strip().lower()
    if key in PROVIDERS:
        return PROVIDERS[key]
    for pname, info in PROVIDERS.items():
        if info.get("label", "").lower() == key:
            return info
    return None


def provider_key_of(name: str) -> str | None:
    """Canonical provider key for a name or label. None if unknown."""
    if not name:
        return None
    key = name.strip().lower()
    if key in PROVIDERS:
        return key
    for pname, info in PROVIDERS.items():
        if info.get("label", "").lower() == key:
            return pname
    return None


def gateway_for_model(model: str) -> str:
    m = model.lower()
    if m.startswith('gemini') or 'google' in m:
        return 'google'
    if m.startswith('claude') or 'anthropic' in m or 'agy' in m:
        return 'agy'
    if m.startswith('opencode') or '/opencode' in m or 'muse-spark' in m:
        return 'opencode'
    if m.startswith('gpt') or 'openai' in m:
        # GPT-family models are served through the OpenCode Zen gateway
        # (responses surface). There is no standalone GPT endpoint here.
        return 'opencode'
    return 'opencode'


def models_for_gateway(gw: str) -> list:
    info = get_provider(gw)
    if info:
        return list(info["models"])
    return []


def expand_variants(model: str) -> list:
    """Return selectable variants for a base model id.

    Always includes the base id itself first; variant entries follow
    as ``<base>-<variant>``. Unknown bases return ``[model]``.
    """
    base = model.strip()
    variants = MODEL_VARIANTS.get(base, [])
    out = [base]
    for v in variants:
        candidate = f"{base}-{v}"
        if candidate not in out:
            out.append(candidate)
    return out


def _catalog_ids(provider: str) -> list:
    info = get_provider(provider)
    return list(info["models"]) if info else []


def resolve_model(provider: str, query: str) -> str | None:
    """Resolve a user query to a canonical model id for a provider.

    Accepts an exact id (case-insensitive), ``<base> <variant>`` pairs,
    and unambiguous prefixes. Returns None when nothing matches.
    """
    if not query:
        return None
    catalog = _catalog_ids(provider)
    if not catalog:
        return None
    lowered = {c.lower(): c for c in catalog}

    q = query.strip()
    if q.lower() in lowered:
        return lowered[q.lower()]

    def _strip_ns(mid: str) -> str:
        return mid.split("/", 1)[1] if "/" in mid else mid

    # `<base> <variant>` pair, e.g. "gemini-3.1-pro high".
    # Both the base and the composed id must belong to this provider's
    # catalog — otherwise a cross-provider typo would silently "resolve".
    parts = q.split()
    if len(parts) == 2:
        base, variant = parts
        if base.lower() in lowered or any(
            _strip_ns(c).lower() == base.lower() for c in catalog
        ):
            for candidate in expand_variants(base):
                if candidate.lower().endswith(f"-{variant.lower()}"):
                    if candidate.lower() in lowered:
                        return lowered[candidate.lower()]
                    return None
        return None

    # Unambiguous prefix match (ignores an `opencode/` namespace prefix).
    ql = q.lower()
    matches = [c for c in catalog if _strip_ns(c).lower().startswith(ql)]
    if len(matches) == 1:
        return matches[0]
    # Prefer an exact stripped-namespace hit on ambiguity.
    exact = [c for c in matches if _strip_ns(c).lower() == ql]
    if exact:
        return exact[0]
    return None


def default_model_for(provider: str) -> str:
    info = get_provider(provider)
    if info:
        return info["default_model"]
    return ""


def resolve_persisted_model(provider: str, model: str) -> str | None:
    """Resolve a persisted selection without network.

    Static catalog first; then an exact (case-insensitive) hit against the
    cached live OpenCode list, so live-only ids survive restarts offline.
    Returns None when the id is unknown everywhere.
    """
    resolved = resolve_model(provider, model)
    if resolved:
        return resolved
    if (provider_key_of(provider) or provider) != "opencode":
        return None
    try:
        cache = models_cache_path()
        if os.path.exists(cache) and \
                time.time() - os.path.getmtime(cache) < MODELS_CACHE_TTL_SEC:
            with open(cache, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                want = (model or "").strip().lower()
                for mid in data:
                    if isinstance(mid, str) and mid.lower() == want:
                        return mid
    except Exception:
        pass
    return None


def sort_models_for_display(ids: list) -> list:
    """Free-tier models first, alphabetical within each group.

    `-free` suffixed ids lead so the no-cost options are always on top;
    everything else follows alphabetically. Dedupes while preserving order.
    """
    seen = list(dict.fromkeys(ids))
    return sorted(seen, key=lambda m: (not m.endswith("-free"), m.lower()))


# ── Live OpenCode model listing (cached) ──────────────────────────────

OPENCODE_MODELS_URL = os.environ.get(
    "OPENCODE_MODELS_URL", "https://opencode.ai/zen/v1/models"
)
MODELS_CACHE_TTL_SEC = 24 * 3600


def models_cache_path() -> str:
    override = os.environ.get("MUSE_MODELS_CACHE")
    if override:
        return override
    xdg = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return str(Path(xdg) / "muse" / "models-opencode.json")


def fetch_opencode_models(timeout: float = 15.0) -> list:
    """Live OpenCode model ids, cached for 24h. Falls back to static list."""
    ids, _source = _load_opencode_catalog(timeout=timeout)
    return ids


def _load_opencode_catalog(timeout: float = 15.0) -> tuple:
    """Return (model ids, source) where source is live/cache/static.

    - live: fresh HTTPS response from the Zen models endpoint,
    - cache: 24h file cache (no request made),
    - static: bundled fallback (endpoint unreachable AND no cache).
    """
    static = list(PROVIDERS["opencode"]["models"])
    cache = models_cache_path()
    try:
        if os.path.exists(cache) and time.time() - os.path.getmtime(cache) < MODELS_CACHE_TTL_SEC:
            with open(cache, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list) and data:
                return (data, "cache")
    except Exception:
        pass
    try:
        import httpx

        resp = httpx.get(OPENCODE_MODELS_URL, timeout=timeout)
        if resp.status_code < 300:
            payload = resp.json()
            items = payload.get("data", []) if isinstance(payload, dict) else []
            ids = sorted({m.get("id") for m in items if isinstance(m, dict) and m.get("id")})
            if ids:
                try:
                    os.makedirs(os.path.dirname(cache), exist_ok=True)
                    with open(cache, "w", encoding="utf-8") as f:
                        json.dump(ids, f)
                except Exception:
                    pass
                return (ids, "live")
    except Exception:
        pass
    return (static, "static")


def catalog_with_source(provider: str, timeout: float = 15.0) -> tuple:
    """(model ids, source) for a provider; only opencode can be live."""
    key = provider_key_of(provider) or provider
    if key == "opencode":
        return _load_opencode_catalog(timeout=timeout)
    return (_catalog_ids(key), "static")


def live_models_for(provider: str, timeout: float = 15.0) -> list:
    """Model list for a provider; opencode goes live, others are static."""
    key = provider_key_of(provider) or provider
    if key == "opencode":
        return fetch_opencode_models(timeout=timeout)
    return _catalog_ids(key)
