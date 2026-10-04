from ..base import QuadNode
from typing import Any
from .auth import load_auth_file
from .provider import gateway_for_model
from .router import UnifiedRouter

class CognitionNode(QuadNode):
    def __init__(self, kernel):
        super().__init__(kernel, "Cognition")
        self.router = UnifiedRouter()

    def providers_config(self) -> dict:
        """Router credentials: kernel-loaded config, defaulting to {}."""
        cfg = getattr(self.kernel, "providers_config", None)
        return cfg if isinstance(cfg, dict) else {}
        
    async def handle(self, message: str, system_prompt: str = "", routing: Any = None) -> str:
        """
        Core Architect Intelligence. Routes a raw message to the active LLM.
        `routing` is an optional delegation context (strategy/slot/is_child).
        """
        provider = getattr(self.kernel, "provider", "google")
        model = getattr(self.kernel, "model", "gemini-2.5-flash")
        
        contents = []
        if system_prompt:
            contents.append({"role": "system", "content": system_prompt})
        contents.append({"role": "user", "content": message})
        
        body = {"contents": contents, "tools": []}
        
        try:
            response = await self.router.route(provider, model, body, False, self.providers_config(), routing)
            # Extract text safely
            if isinstance(response, dict):
                candidates = response.get("candidates", [])
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    return "".join(p.get("text", "") for p in parts)
                elif "text" in response:
                    return response["text"]
            elif isinstance(response, str):
                return response
            return str(response)
        except Exception as e:
            return f"Cognition Engine Error: {str(e)}"
