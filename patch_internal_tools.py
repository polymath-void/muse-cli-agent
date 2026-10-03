import os

path = "muse-cli-agent/src/tui.ts"
with open(path, "r") as f:
    content = f.read()

# 1. Add import for InternalCoreTools if not present
import_str = 'import { InternalCoreTools } from "./capabilities/internal_core.js";\n'
if import_str not in content:
    content = import_str + content

# 2. Add definitions to WORKSPACE_TOOL_DEFS
new_defs = '''    {
        type: "function",
        function: {
            name: "internal_workspace_snapshot",
            description: "Generate a structural tree snapshot of the workspace.",
            parameters: {
                type: "object",
                properties: { max_depth: { type: "integer", default: 2 } }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "internal_python_eval",
            description: "Execute a Python snippet for math, data crunching, or utility computations.",
            parameters: {
                type: "object",
                properties: { code: { type: "string", description: "Python code to execute" } },
                required: ["code"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "internal_memory_search",
            description: "Search durable learnings and project memory from LEARNINGS.md.",
            parameters: { type: "object", properties: {} }
        }
    },'''

if "internal_workspace_snapshot" not in content:
    content = content.replace('export const WORKSPACE_TOOL_DEFS: ToolDefinition[] = [', 'export const WORKSPACE_TOOL_DEFS: ToolDefinition[] = [\n' + new_defs, 1)

# 3. Add dispatch handler in executeToolCall
new_dispatch = '''            case "internal_workspace_snapshot": {
                const internal = new InternalCoreTools(this.workspace);
                return internal.internalWorkspaceSnapshot(num(args.max_depth, 2));
            }
            case "internal_python_eval": {
                const internal = new InternalCoreTools(this.workspace);
                return internal.internalPythonEval(str(args.code));
            }
            case "internal_memory_search": {
                const internal = new InternalCoreTools(this.workspace);
                return internal.internalMemorySearch();
            }'''

if "case \"internal_workspace_snapshot\":" not in content:
    content = content.replace('switch (name) {', 'switch (name) {\n' + new_dispatch, 1)

with open(path, "w") as f:
    f.write(content)

print("Successfully patched internal core tools into tui.ts!")
