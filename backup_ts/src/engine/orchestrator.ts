import { ToolDefinition, ChatMessage, MetaChatClient } from "../tui.js";
import { globalPluginRegistry } from "../plugins/registry.js";
import chalk from "chalk";

/**
 * The Hybrid Agent Orchestrator manages delegating complex tasks to specialized sub-agents.
 */
export class Orchestrator {
  private client: MetaChatClient | null = null;
  
  constructor() {}

  /**
   * Bind the orchestrator to the current active MetaChatClient to allow sub-agent spawning.
   */
  public bindClient(client: MetaChatClient) {
    this.client = client;
  }

  /**
   * The single entry point tool that the main model uses to delegate.
   */
  public get delegationTool(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: "delegate_task",
        description: "Delegate a complex sub-task to a specialized expert agent. Always use this instead of trying to do everything yourself if it falls under one of these categories: 'web_researcher', 'code_reviewer', 'system_admin', 'powerhouse'.",
        parameters: {
          type: "object",
          properties: {
            agent_id: {
              type: "string",
              description: "The ID of the specialized agent to use.",
              enum: ["web_researcher", "code_reviewer", "system_admin", "powerhouse"]
            },
            task: {
              type: "string",
              description: "The detailed prompt/task for the sub-agent."
            }
          },
          required: ["agent_id", "task"]
        }
      }
    };
  }

  /**
   * Executes the delegation by spinning up a single-shot sub-agent loop.
   */
  public async executeDelegation(agentId: string, task: string): Promise<string> {
    if (!this.client) {
      return "Error: Orchestrator client not bound.";
    }

    console.log(`\n  ${chalk.magenta("► Orchestrator:")} Delegating to ${chalk.bold.yellow(agentId)}...`);
    
    // Determine the specific toolset for the chosen agent
    let specializedTools: ToolDefinition[] = [];
    
    // Add plugins depending on the agent
    if (agentId === "web_researcher") {
      specializedTools = [
        ...globalPluginRegistry.getAllTools().filter((t: any) => t.function.name.startsWith("web_") || t.function.name.startsWith("fetch_")),
      ];
    } else if (agentId === "system_admin") {
      specializedTools = [
        ...globalPluginRegistry.getAllTools().filter((t: any) => t.function.name.startsWith("system_") || t.function.name.startsWith("os_")),
      ];
    } else if (agentId === "powerhouse") {
      specializedTools = [
        ...globalPluginRegistry.getAllTools().filter((t: any) => t.function.name.startsWith("powerhouse_")),
      ];
    } else if (agentId === "code_reviewer") {
      specializedTools = [
        ...globalPluginRegistry.getAllTools().filter((t: any) => t.function.name.startsWith("git_")),
      ];
    }

    // Default to at least the basic tools if none matched specifically
    if (specializedTools.length === 0) {
      specializedTools = globalPluginRegistry.getAllTools();
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `You are a highly specialized sub-agent: ${agentId}. Your sole purpose is to accomplish the following task using your specialized tools. Provide a complete, final summary of your findings or actions.`
      },
      {
        role: "user",
        content: task
      }
    ];

    try {
      // Execute a single turn for the sub-agent
      const response = await this.client.chatOnce(messages, specializedTools.slice(0, 16));
      return `[Sub-Agent ${agentId} Result]:\n${response.content}`;
    } catch (e: any) {
      return `[Sub-Agent ${agentId} Failed]: ${e.message}`;
    }
  }
}

export const globalOrchestrator = new Orchestrator();
