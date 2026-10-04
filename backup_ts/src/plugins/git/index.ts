import { Plugin, ToolDefinition } from "../types.js";
import { execSync } from "node:child_process";

export const gitPlugin: Plugin = {
  name: "git",
  version: "1.0.0",
  description: "Provides Git repository inspection and status tools.",
  tools: [
    {
      type: "function",
      function: {
        name: "plugin_git_status",
        description: "Get the current git status of the repository.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "plugin_git_log",
        description: "Get recent git commit history.",
        parameters: {
          type: "object",
          properties: {
            count: { type: "number", description: "Number of commits to show (default 5)" }
          },
        },
      },
    }
  ],
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      if (name === "plugin_git_status") {
        return execSync("git status", { encoding: "utf-8" });
      } else if (name === "plugin_git_log") {
        const count = typeof args.count === "number" ? args.count : 5;
        return execSync(`git log -n ${count} --oneline`, { encoding: "utf-8" });
      }
      return `Unknown git plugin tool: ${name}`;
    } catch (err: any) {
      return `Error executing git tool: ${err.message}`;
    }
  }
};

export default gitPlugin;
