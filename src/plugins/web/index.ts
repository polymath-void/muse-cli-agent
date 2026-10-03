import { Plugin, ToolDefinition } from "../types.js";

export const webPlugin: Plugin = {
  name: "web",
  version: "1.0.0",
  description: "Provides HTTP fetching capabilities for external documentation or APIs.",
  tools: [
    {
      type: "function",
      function: {
        name: "plugin_web_fetch",
        description: "Fetch content from a URL via HTTP GET.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Target URL to fetch" }
          },
          required: ["url"]
        },
      },
    }
  ],
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === "plugin_web_fetch") {
      const url = String(args.url || "");
      if (!url) return "error: url parameter is required";
      try {
        const res = await fetch(url);
        const text = await res.text();
        return text.slice(0, 10_000); // bounded return
      } catch (err: any) {
        return `error fetching url: ${err.message}`;
      }
    }
    return `Unknown web plugin tool: ${name}`;
  }
};

export default webPlugin;
