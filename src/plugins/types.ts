export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface Plugin {
  name: string;
  version: string;
  description: string;
  tools: ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}
