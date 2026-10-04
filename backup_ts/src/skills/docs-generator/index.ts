import { Skill } from "../types.js";

export const docsGeneratorSkill: Skill = {
  name: "docs-generator",
  description: "Generates clear README documentation, API specs, and inline comments.",
  promptTemplate: "Generate comprehensive markdown documentation for the codebase.",
  async execute(): Promise<string> {
    return "Documentation generator protocol ready.";
  }
};

export default docsGeneratorSkill;
