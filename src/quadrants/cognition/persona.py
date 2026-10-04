"""
Persona Module - Context overlays.
"""
import os
import json
from env import project_root

def set_persona(name: str, system_prompt: str) -> str:
    """Creates or updates a persona."""
    root = project_root()
    persona_dir = os.path.join(root, ".muse", "cognition")
    os.makedirs(persona_dir, exist_ok=True)
    
    path = os.path.join(persona_dir, f"{name}.json")
    with open(path, "w") as f:
        json.dump({"name": name, "prompt": system_prompt}, f, indent=2)
    return f"Persona '{name}' saved."

def get_persona(name: str) -> str:
    """Loads a persona system prompt."""
    root = project_root()
    path = os.path.join(root, ".muse", "cognition", f"{name}.json")
    if not os.path.exists(path):
        return ""
    try:
        with open(path, "r") as f:
            return json.load(f).get("prompt", "")
    except:
        return ""
