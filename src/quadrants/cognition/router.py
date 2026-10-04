import os
import json
import time
import uuid
import asyncio
import base64
import httpx
from typing import Any, Dict, List, Optional
from pathlib import Path

from .auth import load_auth_file

REQUEST_TIMEOUT_MS = 60000
EXHAUSTION_MS = 3600000
THOUGHT_SIG_MARK = '__sig_'

# Zen free-tier gate compliance (ported from the verified recipe in
# ForeverInLaw/zen-free-tier-headers, mirroring upstream PR #12326).
# The gate requires, per live bisection: a leading `opencode/` User-Agent,
# x-opencode-session (ses_<hex:12><base62:14>), x-opencode-client, the
# current /inference/openai/ path (legacy /zen/ is rate-limited), and >= 2
# core tool names in the body. Auth itself stays the user's own API key.
# Kill-switches: ZEN_REWRITE_URL=0, ZEN_INJECT_TOOLS=0.
OPENCODE_USER_AGENT = os.environ.get("OPENCODE_USER_AGENT", "opencode/1.18.31")
ZEN_CLIENT_NAME = "desktop"
ZEN_REQUIRED_TOOL_NAMES = ("bash", "read")
ZEN_MIN_TOOL_NAMES = 2
ZEN_SESSION_RE = None  # compiled lazily below

_BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_process_session_id = None


def canonicalize_session_id(session_id: str | None = None) -> str:
    """Canonical ses_<hex:12><base62:14> id (sha256 scheme, deterministic)."""
    import hashlib as _hl
    import re as _re
    global ZEN_SESSION_RE
    if ZEN_SESSION_RE is None:
        ZEN_SESSION_RE = _re.compile(r"^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$")
    sid = (session_id or "").strip()
    if sid and ZEN_SESSION_RE.match(sid):
        return sid
    digest = _hl.sha256(f"opencode\x00muse-cli\x00{sid or 'default'}".encode()).digest()
    head = digest[:6].hex()
    tail = "".join(_BASE62_CHARS[b % 62] for b in digest[6:20])
    return f"ses_{head}{tail}"


def process_session_id() -> str:
    """Stable per-process session id (prompt-cache affinity)."""
    global _process_session_id
    if _process_session_id is None:
        _process_session_id = canonicalize_session_id(f"process-{os.getpid()}")
    return _process_session_id


def zen_gate_headers(headers: dict) -> dict:
    """Apply free-tier attribution headers (auth untouched)."""
    ua = headers.get("User-Agent", "") or headers.get("user-agent", "")
    if not (ua.startswith("opencode/") or ua.startswith("claude-cli/")):
        headers["User-Agent"] = OPENCODE_USER_AGENT
    if "x-opencode-session" not in headers:
        headers["x-opencode-session"] = process_session_id()
    if "x-opencode-client" not in headers:
        headers["x-opencode-client"] = ZEN_CLIENT_NAME
    return headers


def rewrite_zen_url(url: str) -> str:
    """Legacy /zen/ inference path -> current /inference/openai/ path."""
    if os.environ.get("ZEN_REWRITE_URL", "1") == "0":
        return url
    return url.replace("/zen/", "/inference/openai/")


def _tool_names(tools: Any) -> list:
    names = []
    if isinstance(tools, list):
        for t in tools:
            if not isinstance(t, dict):
                continue
            if isinstance(t.get("name"), str):
                names.append(t["name"])
            else:
                fn = t.get("function")
                if isinstance(fn, dict) and isinstance(fn.get("name"), str):
                    names.append(fn["name"])
    return names


ZEN_STUB_DESCRIPTION = (
    "Gateway-validation stub, NOT IMPLEMENTED. NEVER call this tool - any "
    "call fails; use a real registered tool instead."
)
ZEN_STUB_PARAMETERS = {
    "type": "object",
    "properties": {
        "command": {"type": "string", "description": "The command to execute"},
    },
    "required": ["command"],
    "additionalProperties": False,
}


def aggregate_sse_chunks(text: str) -> str:
    """Concatenate streamed deltas into plain text.

    Handles OpenAI chat deltas (choices[].delta.content) and the Responses
    API text deltas (response.output_text.delta).
    """
    parts = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            data = json.loads(payload)
        except Exception:
            continue
        try:
            if not isinstance(data, dict):
                continue
            if data.get("type") == "response.output_text.delta" and data.get("delta"):
                parts.append(str(data["delta"]))
                continue
            choices = data.get("choices", [])
            if not choices:
                continue
            delta = choices[0].get("delta", {})
            content = delta.get("content", "")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                parts.extend(
                    b.get("text", "") for b in content if isinstance(b, dict))
        except Exception:
            continue
    return "".join(parts)


def ensure_gate_tools(url: str, body: Any) -> Any:
    """Ensure >= 2 core tool names in chat/responses bodies for the gate.

    Stubs are name-only markers (schemas ignored by the gate) and are never
    registered in the kernel; bodies already carrying enough core names pass
    through untouched. Disable with ZEN_INJECT_TOOLS=0.
    """
    if os.environ.get("ZEN_INJECT_TOOLS", "1") == "0":
        return body
    if not isinstance(body, dict):
        return body
    tools = body.get("tools")
    present = [n for n in _tool_names(tools) if n in ZEN_REQUIRED_TOOL_NAMES]
    missing = [n for n in ZEN_REQUIRED_TOOL_NAMES if n not in present]
    if len(present) >= ZEN_MIN_TOOL_NAMES or not missing:
        return body
    if "/responses" in url:
        stubs = [{"type": "function", "name": n, "description": ZEN_STUB_DESCRIPTION,
                  "parameters": ZEN_STUB_PARAMETERS} for n in missing]
    elif "/chat/completions" in url:
        stubs = [{"type": "function",
                  "function": {"name": n, "description": ZEN_STUB_DESCRIPTION,
                               "parameters": ZEN_STUB_PARAMETERS}} for n in missing]
    else:
        return body
    out = dict(body)
    out["tools"] = list(tools or []) + stubs
    return out

# Antigravity direct-sandbox endpoints in fallback order (daily → autopush
# → prod), ported from opencode-antigravity-auth/src/constants.ts. The local
# connector path (AGY_CONNECTOR_URL) is always tried first for `agy`.
ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com"
ANTIGRAVITY_ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com"
ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com"
ANTIGRAVITY_ENDPOINT_FALLBACKS = (
    ANTIGRAVITY_ENDPOINT_DAILY,
    ANTIGRAVITY_ENDPOINT_AUTOPUSH,
    ANTIGRAVITY_ENDPOINT_PROD,
)
# Hardcoded project id used when no project was discovered (same source).
ANTIGRAVITY_DEFAULT_PROJECT_ID = os.environ.get(
    "AGY_PROJECT_ID", "rising-fact-p41fc"
)

# Scheduling modes (same names as the plugin schema): cache_first keeps the
# primary account (prompt-cache friendly), balance rotates,
# performance_first rotates with a per-process offset for parallel delegates.
SCHEDULING_ALIASES = {
    "sticky": "sticky",
    "round-robin": "round-robin",
    "hybrid": "sticky",
    "cache_first": "sticky",
    "balance": "round-robin",
    "performance_first": "round-robin",
}

def encode_call_id(index: int, thought_signature: Any) -> str:
    base = f"call_{int(time.time() * 1000):x}_{index}"
    if not isinstance(thought_signature, str) or len(thought_signature) == 0:
        return base
    b64_sig = base64.urlsafe_b64encode(thought_signature.encode('utf-8')).decode('utf-8').rstrip("=")
    return f"{base}{THOUGHT_SIG_MARK}{b64_sig}"

def decode_call_id(id_str: str) -> Dict[str, str]:
    if not isinstance(id_str, str):
        return {"id": ""}
    idx = id_str.find(THOUGHT_SIG_MARK)
    if idx < 0:
        return {"id": id_str}
    try:
        base_id = id_str[:idx]
        sig_b64 = id_str[idx + len(THOUGHT_SIG_MARK):]
        pad = len(sig_b64) % 4
        if pad:
            sig_b64 += '=' * (4 - pad)
        sig = base64.urlsafe_b64decode(sig_b64).decode('utf-8')
        if sig:
            return {"id": base_id, "thoughtSignature": sig}
        return {"id": base_id}
    except Exception:
        return {"id": id_str}

def zen_surface_for(model: str) -> str:
    m = model.lower()
    if m.startswith('opencode/'):
        m = m[len('opencode/'):]
    if m.startswith('jev-'):
        return 'systemone'
    if m.startswith('gpt-') or m.startswith('grok-') or m.startswith('muse-spark-'):
        return 'responses'
    if m.startswith('claude-') or m.startswith('qwen3.8-flash') or m.startswith('qwen3.7-max') or m.startswith('qwen3.7-plus') or m.startswith('qwen3.6-plus') or m.startswith('qwen3.5-plus'):
        return 'anthropic'
    if m.startswith('gemini-'):
        return 'google'
    return 'chat'

class ResponseCache:
    def __init__(self):
        self.cache = {}
    def get(self, model, body):
        key = f"{model}:{json.dumps(body, sort_keys=True)}"
        return self.cache.get(key)
    def set(self, model, body, data):
        key = f"{model}:{json.dumps(body, sort_keys=True)}"
        self.cache[key] = data

class RouteLatchManager:
    def __init__(self):
        self.latches = {}
    def should_fast_path(self, model: str, cascade_length: int):
        return {"startTierIdx": 0}
    def restore_primary(self, model: str):
        pass
    def latch_fallback(self, model: str, tier_idx: int, expires_at: int):
        pass

class UnifiedRouter:
    def __init__(self):
        self.cache = ResponseCache()
        self.latch = RouteLatchManager()
        # Per-provider round-robin cursors (in-memory rotation state).
        self._rr_cursors = {}

    def resolve_scheduling(self, providers_config: Any, provider_key: str,
                           routing: Any = None) -> tuple:
        """Return (strategy, pid_offset, slot). Per-call `routing` wins."""
        strategy, pid_offset, slot = "sticky", False, None
        cfg = providers_config or {}
        provider_obj = cfg.get(provider_key, {})
        if isinstance(provider_obj, dict):
            strategy = SCHEDULING_ALIASES.get(
                str(provider_obj.get("scheduling", "sticky")).lower(), "sticky")
            pid_offset = bool(provider_obj.get("pid_offset", False))
        if isinstance(routing, dict):
            if routing.get("scheduling") is not None or routing.get("strategy") is not None:
                raw = str(routing.get("scheduling", routing.get("strategy"))).lower()
                strategy = SCHEDULING_ALIASES.get(raw, "sticky")
            if routing.get("pid_offset") is not None:
                pid_offset = bool(routing.get("pid_offset"))
            if routing.get("slot") is not None:
                try:
                    slot = int(routing.get("slot"))
                except (TypeError, ValueError):
                    slot = None
            if strategy == "round-robin" and str(
                    routing.get("scheduling", routing.get("strategy", ""))).lower() \
                    == "performance_first":
                pid_offset = True
        return strategy, pid_offset, slot

    def order_accounts(self, accounts: List[Any], provider_key: str,
                       strategy: str = "sticky", pid_offset: bool = False,
                       slot: int | None = None) -> List[Any]:
        """Order accounts per scheduling strategy.

        sticky: configured order (exhausted ones are still skipped by the
        caller). round-robin: rotate the start account on every call.
        pid_offset/slot shift the start index so parallel delegates spread
        across accounts (mirrors the plugin's pid_offset behavior).
        """
        n = len(accounts)
        if n <= 1:
            return list(accounts)
        start = 0
        if slot is not None:
            start = (start + slot) % n
        if pid_offset:
            start = (start + int(os.getpid())) % n
        if strategy == "round-robin":
            cursor = self._rr_cursors.get(provider_key, 0)
            start = (start + cursor) % n
            self._rr_cursors[provider_key] = cursor + 1
        return [accounts[(start + i) % n] for i in range(n)]

    def get_endpoints(self, provider_key: str, model: str, is_stream: bool) -> List[str]:
        """Endpoint fallback chain. Direct-sandbox providers try daily →
        autopush → prod; everyone else has a single endpoint."""
        if provider_key == 'agy' or provider_key not in (
                'anthropic', 'google', 'opencode', 'meta'):
            action = "streamGenerateContent?alt=sse" if is_stream \
                else "generateContent"
            return [f"{base}/v1internal:{action}"
                    for base in ANTIGRAVITY_ENDPOINT_FALLBACKS]
        return [self.get_endpoint(provider_key, model, is_stream)]

    async def route(self, provider_key: str, model: str, body: Any, is_stream: bool, providers_config: Any, routing: Any = None) -> Any:
        """Route a call with proxy semantics.

        `routing` (optional delegation context): {"scheduling": ..., "slot":
        int, "pid_offset": bool, "is_child": bool}. `slot` pins a parallel
        delegate to an account offset; `is_child` is recorded for
        plugin-parity (child sessions share the same scheduling here).
        """
        cacheable = not is_stream
        if cacheable:
            cached = self.cache.get(model, body)
            if cached:
                print(f"[Router] Cache hit for {model}")
                return cached

        # jev-* models route to the Zen systemone surface (decisions API);
        # the request body is shaped accordingly in build_request_body.
        cascade = self.build_cascade(model)
        latch_info = self.latch.should_fast_path(model, len(cascade))
        start_tier_idx = latch_info['startTierIdx']

        last_error = ""

        if provider_key == 'agy':
            try:
                delegate_url = os.environ.get("AGY_CONNECTOR_URL", "http://localhost:8080").rstrip("/")
                url_model = self.clean_agy_model(model)
                if not url_model.startswith("antigravity-"):
                    url_model = f"antigravity-{url_model}"
                
                endpoint = f"{delegate_url}/v1beta/models/{url_model}:streamGenerateContent" if is_stream else f"{delegate_url}/v1beta/models/{url_model}:generateContent"
                gemini_body = self.build_request_body('agy', model, body, is_stream)
                
                async with httpx.AsyncClient() as client:
                    resp = await client.post(endpoint, json=gemini_body, timeout=60.0)
                    if resp.status_code < 300:
                        self.latch.restore_primary(model)
                        if not is_stream:
                            data = self.normalize_non_stream('agy', resp.json())
                            if cacheable:
                                self.cache.set(model, body, data)
                            return data
                        return resp
            except Exception:
                pass 

        for tier_idx in range(start_tier_idx, len(cascade)):
            tier_model = cascade[tier_idx]
            accounts = self.get_accounts(providers_config, provider_key)
            strategy, use_pid_offset, slot = self.resolve_scheduling(
                providers_config, provider_key, routing)
            accounts = self.order_accounts(
                accounts, provider_key, strategy, use_pid_offset, slot)

            delegate_base = os.environ.get(
                "AGY_CONNECTOR_URL", "http://localhost:8080").rstrip("/")
            fatal_model_error = False
            for account in accounts:
                if fatal_model_error:
                    break
                if self.is_account_exhausted(account, tier_model):
                    continue
                
                final_key = account.get('api_key') or account.get('access_token') or ''
                
                if provider_key == 'agy' and account.get('refreshToken'):
                    expires_at = account.get('expires_at', 0)
                    if time.time() > expires_at or not final_key:
                        last_error = f"agy OAuth grant expired for {account.get('email', 'account')}"
                        continue

                if not final_key:
                    last_error = f"no credential for provider {provider_key}"
                    continue

                req_body = self.build_request_body(provider_key, tier_model, body, is_stream)
                headers = self.build_headers(provider_key, final_key)

                for endpoint in self.get_endpoints(provider_key, tier_model, is_stream):
                    # Direct-sandbox calls carry the default project; the
                    # local connector owns its own (project stays "").
                    if provider_key == 'agy' and isinstance(req_body, dict) \
                            and "project" in req_body and not req_body["project"] \
                            and not endpoint.startswith(delegate_base):
                        req_body["project"] = ANTIGRAVITY_DEFAULT_PROJECT_ID
                    stream_retried = False
                    freetier_retries = 0
                    try:
                        # Free-tier gate: core tool names ride along on Zen
                        # inference bodies (never registered server-side).
                        send_body = ensure_gate_tools(endpoint, req_body) \
                            if provider_key == 'opencode' else req_body
                        async with httpx.AsyncClient() as client:
                            response = await client.post(endpoint, headers=headers, json=send_body, timeout=REQUEST_TIMEOUT_MS/1000.0)

                        if not response.is_success and response.status_code == 400 \
                                and provider_key == 'opencode' \
                                and endpoint != self.opencode_chat_endpoint() \
                                and 'rotocol' in (response.text or ""):
                            # Wrong Zen surface for this model (e.g.
                            # ModelProtocolUnsupported): one retry on the
                            # chat surface before judging the account.
                            endpoint = self.opencode_chat_endpoint()
                            async with httpx.AsyncClient() as retry_client:
                                retry_body = ensure_gate_tools(endpoint, req_body)
                                response = await retry_client.post(endpoint, headers=headers, json=retry_body, timeout=REQUEST_TIMEOUT_MS/1000.0)

                        if not response.is_success:
                            last_error = f"{response.status_code} {response.reason_phrase}: {response.text}"
                            if response.status_code == 403 and provider_key == 'opencode' \
                                    and not stream_retried \
                                    and endpoint in (self.opencode_chat_endpoint(),
                                                     self.opencode_responses_endpoint()) \
                                    and 'freetier' in (response.text or "").lower() \
                                    and os.environ.get("ZEN_STREAM_WIRE", "1") != "0":
                                # Gated free model: the gate demands a
                                # streaming request. Re-post once with
                                # stream:true on the same surface.
                                stream_retried = True
                                stream_body = dict(send_body)
                                stream_body["stream"] = True
                                try:
                                    async with httpx.AsyncClient() as stream_client:
                                        sresp = await stream_client.post(
                                            endpoint, headers=headers, json=stream_body,
                                            timeout=REQUEST_TIMEOUT_MS / 1000.0)
                                    text = aggregate_sse_chunks(
                                        sresp.text) if sresp.is_success else ""
                                    if text:
                                        data = {"candidates": [{"content": {"parts": [{"text": text}]}}]}
                                        return self._finish_success(
                                            model, tier_idx, cacheable, body, data)
                                    # Stream answered without deltas (plain
                                    # JSON despite the flag): handle normally.
                                    response = sresp
                                except Exception as e:
                                    last_error = str(e)
                            if response.status_code in (403, 429):
                                while response.status_code == 403 and provider_key == 'opencode' \
                                        and 'freetier' in (response.text or "").lower() \
                                        and freetier_retries < 2 \
                                        and os.environ.get("ZEN_FLAP_RETRY", "1") != "0":
                                    # Flapping free-tier gate: the identical
                                    # request often passes on immediate retry.
                                    # Bounded (2) so hard 403s still exhaust.
                                    freetier_retries += 1
                                    try:
                                        delay = max(0.0, float(os.environ.get(
                                            "ZEN_FLAP_DELAY_SEC", "2.0")))
                                        if delay:
                                            await asyncio.sleep(delay)
                                        async with httpx.AsyncClient() as flap_client:
                                            response = await flap_client.post(
                                                endpoint, headers=headers, json=send_body,
                                                timeout=REQUEST_TIMEOUT_MS / 1000.0)
                                        if response.is_success:
                                            return self._finish_success(
                                                model, tier_idx, cacheable, body,
                                                self.normalize_non_stream(
                                                    provider_key, response.json()))
                                        last_error = f"{response.status_code} {response.reason_phrase}: {response.text}"
                                    except Exception as e:
                                        last_error = str(e)
                                        break
                                self.mark_account_exhausted(account, tier_model)
                                continue
                            if response.status_code in (400, 404):
                                # Final for this model (includes a failed
                                # protocol retry).
                                fatal_model_error = True
                                break
                            continue

                        if is_stream:
                            return response
                        else:
                            data = self.normalize_non_stream(provider_key, response.json())
                            return self._finish_success(model, tier_idx, cacheable, body, data)
                    except Exception as e:
                        last_error = str(e)
                        continue
                    
        raise Exception(f"[Router] All accounts/tiers exhausted for {model}. Last error: {last_error}")

    def _finish_success(self, model: str, tier_idx: int, cacheable: bool,
                        body: Any, data: Any) -> Any:
        """Shared success tail: latch accounting, cache, return."""
        if tier_idx > 0:
            self.latch.latch_fallback(model, tier_idx, int(time.time()*1000) + EXHAUSTION_MS)
        else:
            self.latch.restore_primary(model)
        if cacheable:
            self.cache.set(model, body, data)
        return data

    def clean_agy_model(self, model: str) -> str:
        m = model.strip()
        if m.lower().startswith("opencode/"):
            m = m[len("opencode/"):]
        import re
        m = re.sub(r'^models/', '', m, flags=re.IGNORECASE)
        m = re.sub(r'^antigravity-', '', m, flags=re.IGNORECASE)
        return m or "gemini-3.1-pro"

    def build_cascade(self, model: str) -> List[str]:
        m = model.replace("models/", "").replace("antigravity-", "")
        if "gemini-3.1-pro-high" in m:
            return ["gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-3-flash", "gemini-2.5-flash"]
        if "gemini-3.1-pro" in m:
            return ["gemini-3.1-pro-low", "gemini-3-flash", "gemini-2.5-flash"]
        if "gemini-3-pro" in m or "gemini-3.6-flash" in m or "gemini-3.1-pro-high" in m:
            return ["gemini-3-pro-low", "gemini-3-flash", "gemini-2.5-flash"]
        if "gemini-3-flash" in m:
            return ["gemini-3-flash", "gemini-2.5-flash"]
        if "gemini-2.5" in m:
            res = [m if "gemini-2.5-flash" in m else m, "gemini-2.5-flash"]
            return list(dict.fromkeys(res))
        return [model]

    def _auth_file_key(self, provider_key: str) -> str:
        """API key stored in the shared auth file, or '' when absent."""
        try:
            auth = load_auth_file()
            entry = (auth.get("providers", {}) or {}).get(provider_key, {})
            if isinstance(entry, dict):
                return str(entry.get("api_key") or entry.get("access_token") or "").strip()
        except Exception:
            pass
        return ""

    def _accounts_from_sources(self, provider_key: str, env_names: List[str], providers_config: Any) -> List[Any]:
        """Collect accounts: env vars first, then auth file, then explicit config."""
        accounts: List[Any] = []
        for env_name in env_names:
            val = os.environ.get(env_name)
            if val and val.strip():
                accounts.append({"api_key": val.strip(), "source": f"env:{env_name}"})
        file_key = self._auth_file_key(provider_key)
        if file_key and all(a.get("api_key") != file_key for a in accounts):
            accounts.append({"api_key": file_key, "source": "auth-file"})
        if accounts:
            return accounts
        cfg = providers_config or {}
        provider_obj = cfg.get(provider_key, {})
        sub = provider_obj.get("accounts")
        if isinstance(sub, list) and len(sub) > 0:
            return sub
        return [provider_obj]

    def get_accounts(self, providers_config: Any, provider_key: str) -> List[Any]:
        cfg = providers_config or {}
        if provider_key == 'opencode':
            return self._accounts_from_sources('opencode', ['OPENCODE_API_KEY'], cfg)
        if provider_key == 'google':
            return self._accounts_from_sources('google', ['GOOGLE_API_KEY', 'GEMINI_API_KEY'], cfg)
        if provider_key == 'meta':
            return self._accounts_from_sources('meta', ['MUSE_API_KEY'], cfg)
        if provider_key == 'anthropic':
            return self._accounts_from_sources('anthropic', ['ANTHROPIC_API_KEY'], cfg)
        
        if provider_key == 'agy':
            try:
                xdg = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
                accounts_path = Path(xdg) / "opencode" / "antigravity-accounts.json"
                if accounts_path.exists():
                    with open(accounts_path, 'r') as f:
                        parsed = json.load(f)
                        if isinstance(parsed.get('accounts'), list) and len(parsed['accounts']) > 0:
                            return [a for a in parsed['accounts'] if a.get('enabled') is not False]
            except Exception:
                pass
            
            g = cfg.get('agy') or cfg.get('google') or cfg.get('opencode') or {}
            accounts = g.get('accounts')
            if isinstance(accounts, list) and len(accounts) > 0:
                return accounts
            return [g]
            
        provider_obj = cfg.get(provider_key, {})
        accounts = provider_obj.get('accounts')
        if isinstance(accounts, list) and len(accounts) > 0:
            return accounts
        return [provider_obj]

    def meta_base_url(self) -> str:
        return (os.environ.get('MUSE_API_BASE_URL') or 'https://api.meta.ai/v1').rstrip('/')

    def get_endpoint(self, provider_key: str, model: str, is_stream: bool) -> str:
        if provider_key == 'anthropic':
            return "https://api.anthropic.com/v1/messages"
        if provider_key == 'meta':
            return f"{self.meta_base_url()}/chat/completions"
        if provider_key == 'google':
            return f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
        if provider_key == 'opencode':
            base = (os.environ.get('OPENCODE_API_BASE_URL') or 'https://opencode.ai/zen/v1').rstrip('/')
            surface = zen_surface_for(model)
            if surface == 'responses': return rewrite_zen_url(f"{base}/responses")
            if surface == 'anthropic': return rewrite_zen_url(f"{base}/messages")
            if surface == 'systemone': return rewrite_zen_url(f"{base}/systemone")
            if surface == 'google':
                return rewrite_zen_url(f"{base}/models/{model}:streamGenerateContent?alt=sse" if is_stream else f"{base}/models/{model}:generateContent")
            return rewrite_zen_url(f"{base}/chat/completions")
            
        return 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse' if is_stream else 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent'

    def is_account_exhausted(self, account: Any, model: str) -> bool:
        reset_time = account.get(f"rateLimit_{model}", 0)
        return int(time.time() * 1000) < reset_time

    def mark_account_exhausted(self, account: Any, model: str):
        account[f"rateLimit_{model}"] = int(time.time() * 1000) + EXHAUSTION_MS

    def contents_to_messages(self, contents: Any) -> List[Any]:
        if not isinstance(contents, list):
            return []
        msgs = []
        for c in contents:
            o = c or {}
            parts = o.get('parts', '')
            if isinstance(parts, list):
                parts = "".join(str(p) for p in parts)
            msgs.append({'role': 'assistant' if o.get('role') == 'model' else 'user', 'content': parts})
        return msgs

    def contents_to_chat_messages(self, contents: Any) -> List[Any]:
        """contents -> OpenAI-style messages, preserving the system role."""
        if not isinstance(contents, list):
            return []
        msgs = []
        for c in contents:
            o = c or {}
            role = o.get('role', 'user')
            if role == 'model':
                role = 'assistant'
            parts = o.get('parts', '')
            if isinstance(parts, list):
                parts = "".join(str(p) for p in parts)
            elif parts is None:
                parts = ''
            else:
                parts = str(parts)
            content = o.get('content', parts)
            msgs.append({'role': role, 'content': content})
        return msgs

    def build_request_body(self, provider_key: str, model: str, body: Any, is_stream: bool) -> Any:
        m = model.replace("models/", "").replace("antigravity-", "")
        messages = body.get('messages')
        if not isinstance(messages, list):
            if provider_key == 'meta':
                messages = self.contents_to_chat_messages(body.get('contents', []))
            else:
                messages = self.contents_to_messages(body.get('contents', []))

        if provider_key == 'meta':
            req = {"model": m, "messages": messages}
            if is_stream:
                req["stream"] = True
            return req
            
        if provider_key == 'anthropic':
            system_text = ""
            chat_msgs = []
            for m in messages:
                if m.get('role') == 'system':
                    system_text += m.get('content', '') + "\n"
                else:
                    chat_msgs.append({
                        'role': m.get('role', 'user'),
                        'content': m.get('content', '')
                    })
            body_out = {
                "model": model,
                "max_tokens": 8192,
                "messages": chat_msgs,
            }
            if system_text.strip():
                body_out["system"] = system_text.strip()
            if is_stream:
                body_out["stream"] = True
            return body_out

        if provider_key in ('google', 'agy'):
            google_body = self.to_google_body(messages, is_stream, body.get('tools'))
            if provider_key == 'agy':
                return {
                    "project": "",
                    "model": m,
                    "request": google_body,
                    "requestType": "agent",
                    "userAgent": "antigravity",
                    "requestId": f"agent-{uuid.uuid4()}"
                }
            return google_body
            
        surface = zen_surface_for(m)
        if surface == 'systemone':
            # Jev decisions API: conversational context goes in `state`.
            state = "\n\n".join(
                f"{msg.get('role')}: {msg.get('content', '')}" for msg in messages
            )
            return {"model": m, "state": state}
        if surface == 'anthropic':
            return {"model": m, "max_tokens": 8192, "messages": messages, "stream": is_stream}
        if surface == 'google':
            return self.to_google_body(messages, is_stream, body.get('tools'))
        if surface == 'responses':
            return {"model": m, "input": "\n\n".join(f"{msg.get('role')}: {msg.get('content', '')}" for msg in messages)}
            
        # Default OpenAI-style chat surface. Keep the system role intact:
        # folding the system prompt into a user turn collapses instruction
        # following on chat models.
        chat_messages = body.get('messages')
        if not isinstance(chat_messages, list):
            chat_messages = self.contents_to_chat_messages(body.get('contents', []))
        req = {**body, "model": m, "messages": chat_messages}
        req.pop('contents', None)
        if is_stream:
            req['stream'] = True
        return req

    def to_google_body(self, messages, is_stream, tools):
        return {"contents": messages, "generationConfig": {"maxOutputTokens": 8192}}

    def build_headers(self, provider_key: str, key: str) -> dict:
        if provider_key == 'anthropic':
            return {
                'Content-Type': 'application/json',
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
            }
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {key}'
        }
        if provider_key == 'opencode':
            headers = zen_gate_headers(headers)
        if provider_key == 'agy':
            headers['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.6.0 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36"
        return headers

    def opencode_chat_endpoint(self) -> str:
        base = (os.environ.get('OPENCODE_API_BASE_URL') or 'https://opencode.ai/zen/v1').rstrip('/')
        return rewrite_zen_url(f"{base}/chat/completions")

    def opencode_responses_endpoint(self) -> str:
        base = (os.environ.get('OPENCODE_API_BASE_URL') or 'https://opencode.ai/zen/v1').rstrip('/')
        return rewrite_zen_url(f"{base}/responses")

    def normalize_non_stream(self, provider_key: str, resp: Any) -> Any:
        if provider_key == 'opencode':
            # Zen chat/responses surfaces answer in OpenAI shapes; the
            # kernel only reads Gemini-style candidates, so translate.
            try:
                choices = resp.get("choices", [])
                if choices:
                    msg = choices[0].get("message", {})
                    text = msg.get("content", "") or ""
                    if isinstance(text, list):
                        text = "".join(
                            b.get("text", "") for b in text if isinstance(b, dict)
                        )
                    if text:
                        return {"candidates": [{"content": {"parts": [{"text": text}]}}]}
                texts = []
                for block in resp.get("output", []):
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "message":
                        for part in block.get("content", []):
                            if isinstance(part, dict) and part.get("type") in (
                                    "output_text", "text") and part.get("text"):
                                texts.append(part["text"])
                    elif isinstance(block.get("text"), str):
                        texts.append(block["text"])
                if texts:
                    return {"candidates": [{"content": {"parts": [{"text": "\n".join(texts)}]}}]}
            except Exception:
                pass
            return resp
        if provider_key == 'meta':
            # OpenAI chat completions -> shared candidates shape.
            try:
                choices = resp.get("choices", [])
                text = ""
                if choices:
                    msg = choices[0].get("message", {})
                    text = msg.get("content", "") or ""
                    if isinstance(text, list):
                        text = "".join(
                            b.get("text", "") for b in text if isinstance(b, dict)
                        )
                if text:
                    return {"candidates": [{"content": {"parts": [{"text": text}]}}]}
            except Exception:
                pass
            return resp
        if provider_key == 'anthropic':
            # Claude returns {"content": [{"type": "text", "text": "..."}]}
            content_blocks = resp.get("content", [])
            text = "".join(
                b.get("text", "") for b in content_blocks if b.get("type") == "text"
            )
            return {"candidates": [{"content": {"parts": [{"text": text}]}}]}
        return resp
