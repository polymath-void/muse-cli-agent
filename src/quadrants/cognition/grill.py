"""
Grill Module - Metacognitive Critique.
Adversarial alignment for design decisions.
"""

async def generate_grill_critique(cognition_node, code_or_task: str) -> str:
    """Uses the Cognition engine to harshly critique a design or code block."""
    system = (
        "You are the Muse Adversary. Your job is to rigorously critique the provided "
        "code or task plan. Find security flaws, performance bottlenecks, and "
        "architectural weaknesses. Be concise, direct, and brutally honest."
    )
    return await cognition_node.handle(code_or_task, system_prompt=system)
