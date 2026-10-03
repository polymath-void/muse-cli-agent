import { Plugin, ToolDefinition } from "../types.js";
import { execSync } from "node:child_process";
import * as path from "node:path";

export const powerhousePlugin: Plugin = {
  name: "powerhouse",
  version: "2.0.0",
  description: "Advanced Python-backed hybrid agent powerhouse providing 20+ specialized system, code, and database tools.",
  tools: [
    {
      type: "function",
      function: {
        name: "plugin_git_diff_summary",
        description: "Get summary stats of git diff.",
        parameters: { type: "object", properties: {} }
      }
    },
    {
      type: "function",
      function: {
        name: "plugin_git_branches",
        description: "List all local and remote git branches.",
        parameters: { type: "object", properties: {} }
      }
    },
    {
      type: "function",
      function: {
        name: "plugin_system_processes",
        description: "List active system processes.",
        parameters: { type: "object", properties: {} }
      }
    },
    {
      type: "function",
      function: {
        name: "plugin_system_env",
        description: "Inspect environment variables securely.",
        parameters: { type: "object", properties: {} }
      }
    },
    {
      type: "function",
      function: {
        name: "plugin_db_query",
        description: "Run a SQL query against a SQLite database file.",
        parameters: {
          type: "object",
          properties: {
            db_path: { type: "string", description: "Path to sqlite database" },
            query: { type: "string", description: "SQL query statement" }
          },
          required: ["db_path", "query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "plugin_db_tables",
        description: "List all tables in a SQLite database.",
        parameters: {
          type: "object",
          properties: {
            db_path: { type: "string", description: "Path to sqlite database" }
          },
          required: ["db_path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "plugin_ast_symbols",
        description: "Extract functions and classes from a Python source file using AST.",
        parameters: {
          type: "object",
          properties: {
            filepath: { type: "string", description: "Path to python source file" }
          },
          required: ["filepath"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "plugin_security_secrets",
        description: "Scan repository files for hardcoded secrets, API keys, and passwords.",
        parameters: {
          type: "object",
          properties: {
            directory: { type: "string", description: "Directory to scan (default current)" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "plugin_file_hasher",
        description: "Generate SHA256 checksum of a file.",
        parameters: {
          type: "object",
          properties: {
            filepath: { type: "string", description: "Path to file" }
          },
          required: ["filepath"]
        }
      }
    }
  ],
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const scriptPath = path.resolve(process.cwd(), "muse-cli-agent/python_plugins/hybrid_powerhouse.py");
    try {
      if (name === "plugin_git_diff_summary") {
        return execSync(`python3 "${scriptPath}" git_diff_summary`, { encoding: "utf-8" });
      } else if (name === "plugin_git_branches") {
        return execSync(`python3 "${scriptPath}" git_branches`, { encoding: "utf-8" });
      } else if (name === "plugin_system_processes") {
        return execSync(`python3 "${scriptPath}" system_processes`, { encoding: "utf-8" });
      } else if (name === "plugin_system_env") {
        return execSync(`python3 "${scriptPath}" system_env`, { encoding: "utf-8" });
      } else if (name === "plugin_db_query") {
        const db = String(args.db_path || "");
        const q = String(args.query || "");
        return execSync(`python3 "${scriptPath}" db_query "${db}" "${q}"`, { encoding: "utf-8" });
      } else if (name === "plugin_db_tables") {
        const db = String(args.db_path || "");
        return execSync(`python3 "${scriptPath}" db_tables "${db}"`, { encoding: "utf-8" });
      } else if (name === "plugin_ast_symbols") {
        const fp = String(args.filepath || "");
        return execSync(`python3 "${scriptPath}" ast_symbols "${fp}"`, { encoding: "utf-8" });
      } else if (name === "plugin_security_secrets") {
        const dir = String(args.directory || ".");
        return execSync(`python3 "${scriptPath}" scan_secrets "${dir}"`, { encoding: "utf-8" });
      } else if (name === "plugin_file_hasher") {
        const fp = String(args.filepath || "");
        return execSync(`python3 "${scriptPath}" hash_file "${fp}"`, { encoding: "utf-8" });
      }
      return `Unknown powerhouse plugin tool: ${name}`;
    } catch (err: any) {
      return `error executing python powerhouse tool: ${err.message}`;
    }
  }
};

export default powerhousePlugin;
