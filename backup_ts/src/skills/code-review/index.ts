import { Skill } from "../types.js";
import { execSync } from "node:child_process";

export const codeReviewSkill: Skill = {
  name: "code-review",
  description: "Performs an automated review of unstaged or recent git changes.",
  promptTemplate: "Review the following git diff for code quality, bugs, and best practices:\n\n{diff}",
  async execute(): Promise<string> {
    try {
      const diff = execSync("git diff", { encoding: "utf-8" });
      if (!diff.trim()) {
        return "No unstaged changes found to review.";
      }
      return `Code Review Analysis:\n\nDiff size: ${diff.split('\n').length} lines.\n\nReady to analyze changes.`;
    } catch (err: any) {
      return `Failed to execute code review skill: ${err.message}`;
    }
  }
};

export default codeReviewSkill;
