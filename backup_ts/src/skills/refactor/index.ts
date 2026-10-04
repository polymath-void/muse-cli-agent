import { Skill } from "../types.js";

export const refactorSkill: Skill = {
  name: "refactor",
  description: "Guided code refactoring protocol for clean architecture and type safety.",
  promptTemplate: "Review the target source code for modularity, readability, and TypeScript best practices, then propose a clean refactored version.",
  async execute(context: Record<string, unknown>): Promise<string> {
    const target = String(context.target || "unspecified file");
    return `Refactor Skill Initialized for: ${target}. Ready to execute architectural cleanup.`;
  }
};

export default refactorSkill;
