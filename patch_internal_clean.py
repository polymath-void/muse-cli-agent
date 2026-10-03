import os

path = "muse-cli-agent/src/tui.ts"
with open(path, "r") as f:
    content = f.read()

# 1. Add import at the top
import_str = 'import { InternalCoreTools } from "./capabilities/internal_core.js";\n'
if import_str not in content:
    content = import_str + content

# 2. Add tools to WORKSPACE_TOOL_DEFS before the closing bracket of the array (line 212)
internal_tools_def = '''    {
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
    },
'''

if "internal_workspace_snapshot" not in content:
    content = content.replace('    {\n        type: "function",\n        function: {\n            name: "learn"', internal_tools_def + '    {\n        type: "function",\n        function: {\n            name: "learn"', 1)

# 3. Add cases in switch (name)
internal_cases = '''      case "internal_workspace_snapshot": {
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
      }
'''

if 'case "internal_workspace_snapshot":' not in content:
    content = content.replace('    switch (name) {', '    switch (name) {\n' + internal_cases, 1)

with open(path, "w") as f:
    f.write(content)

print("Successfully applied clean internal core tools patch to tui.ts!")
