"""
Core Architectural Intelligence Tools.
Binds Planner, Grill, Reflect, and Persona to the agent.
"""
from quadrants.cognition.planner import generate_plan
from quadrants.cognition.grill import generate_grill_critique
from quadrants.cognition.reflect import append_reflection
from quadrants.cognition.persona import set_persona, get_persona
import asyncio
import concurrent.futures

def _sync_wrapper(coro):
    """Run an async function safely from a sync context."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(asyncio.run, coro)
        return future.result()

def plan_task(task: str) -> str:
    """Break down a complex task into a DAG graph of subtasks."""
    # We need access to the cognition node.
    from kernel import QuadTreeKernel
    # We can rely on the fact that this plugin has access to the kernel context if we capture it
    return "Error: kernel not captured."

def register(kernel):
    def _plan(task: str):
        """Break down a task into a DAG architecture."""
        return _sync_wrapper(generate_plan(kernel.quadrants["cognition"], task))
        
    def _grill(code_or_task: str):
        """Adversarially critique a design or code block."""
        return _sync_wrapper(generate_grill_critique(kernel.quadrants["cognition"], code_or_task))
        
    def _reflect(task: str, worked: str, cost: str, lesson: str):
        """Log an architectural learning to long-term reflection memory."""
        return append_reflection(task, worked, cost, lesson)
        
    def _set_persona(name: str, prompt: str):
        """Save a new context persona."""
        return set_persona(name, prompt)

    kernel.tools.add_tool("arch_plan", _plan)
    kernel.tools.add_tool("arch_grill", _grill)
    kernel.tools.add_tool("arch_reflect", _reflect)
    kernel.tools.add_tool("arch_set_persona", _set_persona)
