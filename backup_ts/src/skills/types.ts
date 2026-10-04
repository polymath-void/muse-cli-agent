export interface Skill {
  name: string;
  description: string;
  promptTemplate: string;
  execute(context: Record<string, unknown>): Promise<string>;
}
