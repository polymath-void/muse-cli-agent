"""
Planner Module - Core Architectural Intelligence.
Deconstructs tasks into DAG strings.
"""
from typing import Optional

async def generate_plan(cognition_node, task: str) -> str:
    """Uses the Cognition engine to generate a step-by-step DAG plan for a task."""
    system = (
        "You are the Muse Architect. Your job is to break down the given task "
        "into a logical, sequential DAG (Directed Acyclic Graph) format.\n"
        "Format as Markdown checklist:\n"
        "- [ ] Step 1\n"
        "- [ ] Step 2"
    )
    return await cognition_node.handle(task, system_prompt=system)
