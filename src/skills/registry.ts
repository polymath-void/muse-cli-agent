import { Skill } from "./types.js";
import { codeReviewSkill } from "./code-review/index.js";
import { testRunnerSkill } from "./test-runner/index.js";
import { refactorSkill } from "./refactor/index.js";
import { securityAuditSkill } from "./security-audit/index.js";
import { architectureExplainSkill } from "./architecture-explain/index.js";
import { performanceProfilerSkill } from "./performance-profiler/index.js";
import { docsGeneratorSkill } from "./docs-generator/index.js";

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();

  constructor() {
    this.register(codeReviewSkill);
    this.register(testRunnerSkill);
    this.register(refactorSkill);
    this.register(securityAuditSkill);
    this.register(architectureExplainSkill);
    this.register(performanceProfilerSkill);
    this.register(docsGeneratorSkill);
  }

  public register(skill: Skill) {
    this.skills.set(skill.name, skill);
  }

  public getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  public listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }
}

export const globalSkillRegistry = new SkillRegistry();
