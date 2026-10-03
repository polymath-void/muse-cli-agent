import { Skill } from "../types.js";

export const architectureExplainSkill: Skill = {
  name: "architecture-explain",
  description: "Explains project structure, data flow, and organ design.",
  promptTemplate: "Analyze the workspace layout and generate a comprehensive architectural explanation.",
  async execute(): Promise<string> {
    return "Architecture analysis protocol ready. Ready to explain codebase modules and design patterns.";
  }
};

export default architectureExplainSkill;
