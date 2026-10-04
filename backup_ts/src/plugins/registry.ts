import { Plugin, ToolDefinition } from "./types.js";
import { gitPlugin } from "./git/index.js";
import { systemPlugin } from "./system/index.js";
import { webPlugin } from "./web/index.js";
import { powerhousePlugin } from "./powerhouse/index.js";

export class PluginRegistry {
  private plugins: Map<string, Plugin> = new Map();

  constructor() {
    this.register(gitPlugin);
    this.register(systemPlugin);
    this.register(webPlugin);
    this.register(powerhousePlugin);
  }

  public register(plugin: Plugin) {
    this.plugins.set(plugin.name, plugin);
  }

  public getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const plugin of this.plugins.values()) {
      tools.push(...plugin.tools);
    }
    return tools;
  }

  public async executeTool(name: string, args: Record<string, unknown>): Promise<string | null> {
    for (const plugin of this.plugins.values()) {
      const matched = plugin.tools.some(t => t.function.name === name);
      if (matched) {
        return await plugin.execute(name, args);
      }
    }
    return null;
  }
}

export const globalPluginRegistry = new PluginRegistry();
