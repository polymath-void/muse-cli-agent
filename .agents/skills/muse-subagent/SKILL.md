---
name: muse-subagent
description: Standard Operating Procedure for securely delegating coding tasks to Muse AI as a native conversational sub-agent using the OS-Free TypeScript Binary.
---

# Muse Sub-Agent Integration Skill

This skill allows Antigravity agents to securely spawn Muse AI as a native sub-agent to perform complex coding modifications, brainstorming, and reasoning natively inside a workspace.

## Architecture: OS-Free TypeScript CLI (`muse-cli-agent`)
We have completely migrated away from the legacy Rust binary (which caused `realpath` and timezone crashes under Android `proot`). Muse is now operated via the **OS-Free TypeScript Binary** located at:
`/data/data/com.termux/files/home/Projects/muse-cli-agent`

This TS agent handles:
1. **Meta API Device Flow**: Native `auth.ts` pipeline for authentication.
2. **Interactive Agent TUI**: Native `tui.ts` using `inquirer` and `chalk` for live streaming CLI chat.
3. **LMK-Safe Sequential Execution**: All workspace tools (`bash`, `read_file`) run strictly sequentially (no `Promise.all`) to avoid triggering the Android Low Memory Killer.
4. **JSON-RPC Bridge**: The TS binary can seamlessly spawn `muse_agent.py` as a Python child process if heavy JSONL/MSP features are needed.

## Manual Testing & Script Usage

If you (or the user) want to test the new TypeScript CLI Agent natively, follow these exact steps:

1. **Navigate to the Project**:
   ```bash
   cd ~/Projects/muse-cli-agent
   ```
2. **Compile the TypeScript Binary**:
   ```bash
   npm run build
   ```
3. **Login to Meta API (Device Auth Flow)**:
   ```bash
   npm run login
   ```
   *(This will output a Device Code. Open the URL provided to authorize the CLI on your Meta account).*
4. **Launch the Interactive TUI Agent**:
   ```bash
   npm run start
   ```
   *(This boots the beautiful `chalk` REPL where you can chat, use slash commands like `/tools` or `/model`, and instruct the agent).*

## How to Invoke Muse Programmatically (For Agents)

To seamlessly use Muse as a headless sub-agent, you MUST use the `exec` subcommand. 
You can use the `--json` flag to emit machine-readable JSONL events (thoughts, tool calls, results) on stdout for your orchestration scripts.

**New Feature (Hybrid Advance Optimized Architecture):** The `exec` command now has full feature parity with the TUI, meaning it executes tools natively. You can also attach a Python JSON-RPC bridge script to dynamically merge Python tools into the agent's toolset.

### 1. Bash / Direct Execution
```bash
node /data/data/com.termux/files/home/Projects/muse-cli-agent/dist/index.js exec --json --bridge-script /path/to/script.py "Refactor the auth middleware to use the new spec."
```
*Note: If the prompt is too large for the shell, write it to a file and use `--prompt-file <path>`.*

### 2. Python Orchestration (Leviathan / Brain Bridge)
When orchestrating Muse within Python, spawn it using `subprocess` and parse the JSONL stdout in real-time:
```python
import subprocess
import json

cmd = [
    "node", "/data/data/com.termux/files/home/Projects/muse-cli-agent/dist/index.js", 
    "exec", "--json", "Refactor the auth middleware"
]
process = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)

for line in process.stdout:
    event = json.loads(line)
    if event.get("type") == "tool_calls":
        print("Muse is calling tools:", event["toolCalls"])
    elif event.get("type") == "text":
        print("Muse reasoning:", event["delta"], end="")
```

## Critical Rules for Agents using this Skill:
- **Never Use the Rust Binary (`muse exec`)**: Always route API and tool execution through the TS binary in `muse-cli-agent`.
- **Compile First**: If you edit `src/auth.ts`, `src/tui.ts`, or `src/index.ts`, you MUST run `npm run build` before executing `node ./dist/index.js`.
- **LMK Constraints**: Rely on the TS Agent's built-in `tmp.json` persistence. If the agent crashes mid-turn, it can be resumed effortlessly.
- **Headless Tool Execution**: `exec` natively supports `WORKSPACE_TOOL_DEFS` and `--bridge-script` tool execution loops, allowing seamless orchestration.
