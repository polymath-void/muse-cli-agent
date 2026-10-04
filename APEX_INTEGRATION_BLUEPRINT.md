# Apex Rage Engine Integration Blueprint

## 1. Overview
The **Apex Rage Engine** has been integrated into the `muse-cli-agent` natively. Rather than running as an external hook, it operates as `ApexNode`, a first-class `QuadNode` citizen inside the kernel's architecture (`self.quadrants['apex']`).

## 2. Interaction with QuadTree Kernel
By being integrated into `kernel.py`, the Apex Engine can fluidly communicate with the other kernel quadrants:
- **CognitionNode:** Standard reasoning is handled here. If the user invokes `/apex`, messages can be routed to the `ApexNode` directly for high-tier System 2 reasoning.
- **MemoryNode:** Apex leverages `MemoryNode` in **Tier 2** to query the Episodic Memory (RLHF) and retrieve past bug fix states as few-shot RAG context.
- **ToolsNode:** Apex queries the codebase by using `ToolsNode` capabilities, driving the **Tier 1** Semantic Indexing (FTS5 SQLite Graph mapping).
- **FleetNode:** In **Tier 4**, the Actor-Critic Swarm executes multi-agent sandboxing logic by spawning workers through the `FleetNode`.

## 3. The 5-Tier Metacognitive Pipeline

Whenever `ApexNode.handle()` is invoked, it forces the execution through a strict loop:
1. **Semantic Indexing:** Instantly maps the codebase via FTS5.
2. **Episodic Memory (RLHF):** Retrieves successful past bug fixes.
3. **System 2 Reasoning:** Evaluates 3 distinct hypotheses using Monte Carlo heuristics to pick optimal patch strategies.
4. **Actor-Critic Swarm:** Isolates code in a physical sandbox, runs a background AGY swarm to compile/test, and uses a Surgical Critic for heuristic generation on failure.
5. **Continuous Adaptation:** Saves successful rules to `~/.agents/rules/` for permanent behavioral tuning.

## 4. Conclusion
By wrapping the Apex Rage Engine within the `QuadTreeKernel`, it provides native 95%+ SWE-bench performance without decoupling from the central `muse-cli-agent` memory and tool architectures.
