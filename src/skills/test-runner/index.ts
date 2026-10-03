import { Skill } from "../types.js";
import { execSync } from "node:child_process";

export const testRunnerSkill: Skill = {
  name: "test-runner",
  description: "Executes the project test suite and formats the results.",
  promptTemplate: "Analyze the following test suite results and diagnose any failures:\n\n{results}",
  async execute(): Promise<string> {
    try {
      const output = execSync("npm test", { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return `Test Suite Passed Successfully:\n\n${output.slice(0, 3000)}`;
    } catch (err: any) {
      return `Test Suite Failed:\n\n${err.stdout || ""}\n${err.stderr || err.message}`;
    }
  }
};

export default testRunnerSkill;
