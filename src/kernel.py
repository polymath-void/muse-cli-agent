import os
import importlib.util
from typing import Any
from quadrants.cognition import CognitionNode
from quadrants.cognition.config import (
    last_model_for,
    load_providers_config,
    read_last_selection,
    write_last_selection,
)
from quadrants.cognition.provider import (
    default_model_for,
    provider_key_of,
    resolve_model,
    resolve_persisted_model,
)
from quadrants.memory import MemoryNode
from quadrants.fleet import FleetNode
from quadrants.tools import ToolsNode
from quadrants.apex import ApexNode
from governance.trace import TraceKernel
from governance.budget import BudgetKernel
from governance.permissions import PermissionsKernel
from governance.redactor import RedactorKernel


class QuadTreeKernel:
    def __init__(self):
        self.state = "INITIALIZED"
        self.plugins = {}
        self.workspace_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

        # Governance & Security Kernels
        self.trace = TraceKernel(self.workspace_root)
        self.budget = BudgetKernel(self.workspace_root)
        self.permissions = PermissionsKernel()
        self.redactor = RedactorKernel()

        # Router credentials (env + auth file) shared with cognition.
        self.providers_config = load_providers_config()

        # Active provider/model with workspace-persisted resume.
        self.provider = "google"
        self.model = "gemini-2.5-flash"
        saved = read_last_selection(self.workspace_root)
        if saved:
            pkey = provider_key_of(saved.get("provider", ""))
            if pkey:
                self.provider = pkey
                remembered = saved.get("model", "")
                self.model = resolve_persisted_model(pkey, remembered) or \
                    resolve_model(pkey, last_model_for(self.workspace_root, pkey) or "")
                if not self.model:
                    self.model = default_model_for(pkey) or self.model

        # Load capabilities
        self.memory = MemoryNode(self)
        self.fleet = FleetNode()
        self.tools = ToolsNode()
        self.tools_node = self.tools
        self.apex = ApexNode(self)

        self.quadrants = {
            "cognition": CognitionNode(self),
            "memory": self.memory,
            "fleet": self.fleet,
            "tools": self.tools,
            "apex": self.apex,
        }

        # Dynamically load plugins
        self._load_plugins()

        # Register internal quadrant tools after plugins
        self._register_internal_tools()

        # Load system rules
        self._system_rules = self._load_system_rules()

        self.state = "READY"

    # ── Provider / model selection (validated, persisted) ──

    def refresh_providers_config(self) -> dict:
        """Reload router credentials after login/logout. Returns the config."""
        self.providers_config = load_providers_config()
        return self.providers_config

    def set_provider(self, name: str) -> tuple:
        """Switch provider; restores its last model (or default). (ok, msg)"""
        pkey = provider_key_of(name or "")
        if not pkey:
            return (False, f"Unknown provider '{name}'.")
        self.provider = pkey
        remembered = last_model_for(self.workspace_root, pkey)
        self.model = resolve_persisted_model(pkey, remembered or "") if remembered else None
        if not self.model:
            self.model = default_model_for(pkey)
        write_last_selection(self.workspace_root, self.provider, self.model)
        return (True, f"provider → {pkey} · model → {self.model}")

    def set_model(self, query: str) -> tuple:
        """Resolve + set a model for the current provider. (ok, msg)."""
        resolved = resolve_model(self.provider, query or "")
        if not resolved and self.provider == "opencode":
            # Static catalog can lag the live Zen list; accept exact live ids
            # (served from the 24h cache when present — no network otherwise).
            try:
                from quadrants.cognition.provider import fetch_opencode_models
                ql = (query or "").strip().lower()
                hit = [m for m in fetch_opencode_models() if m.lower() == ql]
                resolved = hit[0] if hit else None
            except Exception:
                resolved = None
        if not resolved:
            return (False, f"Unknown model '{query}' for provider '{self.provider}'.")
        self.model = resolved
        write_last_selection(self.workspace_root, self.provider, self.model)
        return (True, f"model → {self.model}")

    def _load_plugins(self, plugin_dir="plugins"):
        if not os.path.exists(plugin_dir):
            return

        for filename in sorted(os.listdir(plugin_dir)):
            if filename.endswith(".py") and not filename.startswith("__"):
                plugin_name = filename[:-3]
                filepath = os.path.join(plugin_dir, filename)

                spec = importlib.util.spec_from_file_location(plugin_name, filepath)
                if spec and spec.loader:
                    try:
                        module = importlib.util.module_from_spec(spec)
                        spec.loader.exec_module(module)

                        if hasattr(module, "register"):
                            module.register(self)
                            self.plugins[plugin_name] = module
                    except Exception as e:
                        print(f"[Kernel] Warning: Failed to load plugin {plugin_name}: {e}")

    def _register_internal_tools(self):
        """Register tools that bridge into quadrant nodes directly."""
        def route_to_apex(task_description: str) -> str:
            return self.apex.handle(task_description)

        def bash(command: str) -> str:
            """Run a shell command and return its output."""
            return self.fleet.run_command(command)

        def read(path: str) -> str:
            """Read a file and return its contents."""
            return self.tools.read_file(path)

        self.tools.add_tool("route_to_apex", route_to_apex)
        self.tools.add_tool("bash", bash)
        self.tools.add_tool("read", read)

    def get_tool_schemas(self) -> list:
        """Minimal OpenAI function schemas for registered tools.

        Names/descriptions ride along on Zen calls (the free-tier gate
        counts core names like bash/read); the ReAct loop still drives
        execution through TOOL_CALL: lines.
        """
        schemas = []
        for name in sorted(self.tools.dynamic_tools.keys()):
            func = self.tools.dynamic_tools[name]
            doc = (func.__doc__ or "").strip().split("\n")[0] if func.__doc__ else name
            schemas.append({
                "type": "function",
                "function": {
                    "name": name,
                    "description": doc,
                    "parameters": {"type": "object", "properties": {}},
                },
            })
        return schemas

    def _load_system_rules(self) -> str:
        """Load .agents/rules/muse_native_tools.md as the core system prompt."""
        rules_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            ".agents", "rules", "muse_native_tools.md"
        )
        if os.path.exists(rules_path):
            with open(rules_path, "r") as f:
                return f.read()
        return ""

    def route_message(self, quadrant_name, message):
        if quadrant_name in self.quadrants:
            if hasattr(self.quadrants[quadrant_name], "handle"):
                return self.quadrants[quadrant_name].handle(message)
            return f"{quadrant_name} received message, but has no handle method."
        return None

    def get_tool_manifest(self) -> str:
        """Generate a concise tool listing for the system prompt."""
        lines = []
        for name in sorted(self.tools.dynamic_tools.keys()):
            func = self.tools.dynamic_tools[name]
            doc = (func.__doc__ or "").strip().split("\n")[0] if func.__doc__ else ""
            lines.append(f"- {name}: {doc}" if doc else f"- {name}")
        return "\n".join(lines)

    async def chat(self, user_text: str, routing: Any = None) -> str:
        """
        Core ReAct loop: memory -> LLM -> tool execution -> memory -> repeat.
        Binds the TUI input to cognition, tools, and memory in a tight cycle.
        `routing` is an optional delegation context for parallel delegates.
        """
        # Redact secrets from user input before memory
        safe_user_text = self.redactor.redact(user_text)
        self.memory.append_message("user", safe_user_text)

        max_iterations = 5
        provider = getattr(self, "provider", "google")
        model = getattr(self, "model", "gemini-2.5-flash")

        for iteration in range(max_iterations):
            # Budget circuit breaker
            if not self.budget.add_usage(500): # heuristic token charge
                budget_err = "BUDGET_EXCEEDED: Token or cost limit reached. Halting loop."
                self.memory.append_message("system", budget_err)
                return budget_err

            context = self.memory.get_context(max_tokens=4000)

            tool_manifest = self.get_tool_manifest()
            system_prompt = (
                "You are Muse, an elite Anthropic Claude-based AI agent running natively on Android Termux.\n"
                "You are an expert architecture intelligence system.\n\n"
                f"=== NATIVE TOOLS ({len(self.tools.dynamic_tools)} available) ===\n"
                f"{tool_manifest}\n\n"
                "=== TOOL PROTOCOL ===\n"
                "To use a tool, output exactly on its own line:\n"
                "TOOL_CALL: <tool_name> <arg1>|<arg2>|...\n\n"
                "You may call multiple tools (one per line). After tools execute,\n"
                "their results are fed back to you. Then answer the user.\n"
                "If no tool is needed, answer the user directly.\n\n"
                "=== ARCHITECTURE & SYSTEM RULES ===\n"
                f"{self._system_rules}\n"
            )

            body = {
                "contents": [{"role": "system", "content": system_prompt}] + context,
                "tools": self.get_tool_schemas(),
            }

            try:
                import time
                t_start = time.time()
                response = await self.quadrants["cognition"].router.route(
                    provider, model, body, False,
                    getattr(self, "providers_config", None) or {},
                    routing,
                )
                t_duration = (time.time() - t_start) * 1000

                # Extract text from response
                response_text = ""
                if isinstance(response, dict):
                    candidates = response.get("candidates", [])
                    if candidates:
                        parts = candidates[0].get("content", {}).get("parts", [])
                        response_text = "".join(p.get("text", "") for p in parts)
                    elif "text" in response:
                        response_text = response["text"]
                elif isinstance(response, str):
                    response_text = response
                else:
                    response_text = str(response)

                response_text = self.redactor.redact(response_text)

            except Exception as e:
                response_text = f"Error during cognition: {str(e)}"

            # Check for tool calls in the response
            if "TOOL_CALL:" in response_text:
                self.memory.append_message("model", response_text)

                lines = response_text.split("\n")
                tool_output_parts = []
                for line in lines:
                    stripped = line.strip()
                    if stripped.startswith("TOOL_CALL:"):
                        call_body = stripped[len("TOOL_CALL:"):].strip()
                        parts = call_body.split(" ", 1)
                        tool_name = parts[0]
                        tool_args = [a.strip() for a in parts[1].split("|")] if len(parts) > 1 else []

                        if tool_name in self.tools.dynamic_tools:
                            func = self.tools.dynamic_tools[tool_name]
                            try:
                                # Permission Check
                                self.permissions.check_permission(tool_name)
                                
                                import time
                                tool_start = time.time()
                                result = func(*tool_args)
                                tool_dur = (time.time() - tool_start) * 1000
                                
                                # Trace logging
                                self.trace.log_tool_call(tool_name, tool_args, 0, len(str(result)), tool_dur)
                                
                                result_redacted = self.redactor.redact(str(result))
                                tool_output_parts.append(f"[{tool_name}] OK: {result_redacted}")
                            except Exception as e:
                                tool_output_parts.append(f"[{tool_name}] ERROR: {str(e)}")
                        else:
                            tool_output_parts.append(f"[{tool_name}] NOT FOUND in dynamic_tools")

                tool_output = "\n".join(tool_output_parts)
                self.memory.append_message("system", tool_output)
                # Loop continues — LLM will see tool results on next iteration
            else:
                self.memory.append_message("model", response_text)
                return response_text

        return "Max iterations reached in tool calling loop."
