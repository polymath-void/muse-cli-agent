import { Plugin, ToolDefinition } from "../types.js";
import * as os from "node:os";

export const systemPlugin: Plugin = {
  name: "system",
  version: "1.0.0",
  description: "Provides host system diagnostics and resource information.",
  tools: [
    {
      type: "function",
      function: {
        name: "plugin_system_info",
        description: "Get host system memory, uptime, platform, and CPU details.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    }
  ],
  async execute(name: string): Promise<string> {
    if (name === "plugin_system_info") {
      const info = {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        uptimeMinutes: Math.round(os.uptime() / 60),
        totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
        freeMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
        cpus: os.cpus().length,
      };
      return JSON.stringify(info, null, 2);
    }
    return `Unknown system plugin tool: ${name}`;
  }
};

export default systemPlugin;
