import os

path = "muse-cli-agent/src/tui.ts"
with open(path, "r") as f:
    content = f.read()

# 1. Add import at the top if not present
import_str = 'import { globalPluginRegistry } from "./plugins/registry.js";\n'
if import_str not in content:
    content = import_str + content

# 2. Append plugin tools to WORKSPACE_TOOL_DEFS
old_defs_end = "];\n// ---------------------------------------------------------------------------"
new_defs_end = '    ...globalPluginRegistry.getAllTools(),\n];\n// ---------------------------------------------------------------------------'
if "...globalPluginRegistry.getAllTools()" not in content:
    content = content.replace(old_defs_end, new_defs_end, 1)

# 3. Add dispatch handler in executeToolCall
old_exec = '        switch (name) {'
new_exec = '''        const pluginResult = await globalPluginRegistry.executeTool(name, args);
        if (pluginResult !== null) {
            return pluginResult;
        }
        switch (name) {'''
if "globalPluginRegistry.executeTool" not in content:
    content = content.replace(old_exec, new_exec, 1)

with open(path, "w") as f:
    f.write(content)

print("Successfully patched tui.ts!")
