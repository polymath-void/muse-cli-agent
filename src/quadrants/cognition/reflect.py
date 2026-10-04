"""
Reflect Module - Long-term architectural learning.
"""
import os
import json
from datetime import datetime
from env import project_root

def append_reflection(task: str, worked: bool, cost: str, lesson: str) -> str:
    """Appends a structural reflection to .muse/cognition/REFLECT.md"""
    root = project_root()
    reflect_dir = os.path.join(root, ".muse", "cognition")
    os.makedirs(reflect_dir, exist_ok=True)
    reflect_path = os.path.join(reflect_dir, "REFLECT.md")
    
    status = "SUCCESS" if str(worked).lower() in ("true", "1", "yes") else "FAILED"
    timestamp = datetime.now().isoformat()
    
    entry = f"\n### {timestamp} - {status}\n"
    entry += f"**Task**: {task}\n"
    entry += f"**Cost**: {cost}\n"
    entry += f"**Lesson**: {lesson}\n"
    
    with open(reflect_path, "a") as f:
        f.write(entry)
        
    return f"Reflection appended to {reflect_path}"
