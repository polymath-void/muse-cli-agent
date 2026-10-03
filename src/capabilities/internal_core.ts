import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export class InternalCoreTools {
  private workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  public internalWorkspaceSnapshot(maxDepth = 2): string {
    try {
      const walk = (dir: string, currentDepth: number): string[] => {
        if (currentDepth > maxDepth) return [];
        let results: string[] = [];
        const list = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of list) {
          if (item.name.startsWith(".") || item.name === "node_modules") continue;
          const rel = path.relative(this.workspace, path.join(dir, item.name));
          results.push(item.isDirectory() ? `📂 ${rel}/` : `📄 ${rel}`);
          if (item.isDirectory()) {
            results.push(...walk(path.join(dir, item.name), currentDepth + 1));
          }
        }
        return results;
      };
      const tree = walk(this.workspace, 1);
      return JSON.stringify({ workspace: this.workspace, filesCount: tree.length, tree: tree.slice(0, 100) }, null, 2);
    } catch (err: any) {
      return `error generating snapshot: ${err.message}`;
    }
  }

  public internalPythonEval(code: string): string {
    try {
      // Execute a safe python snippet via python3 -c
      const escaped = code.replace(/"/g, '\\"');
      const out = execSync(`python3 -c "${escaped}"`, { encoding: "utf-8", timeout: 5000 });
      return out.trim();
    } catch (err: any) {
      return `error evaluating python code: ${err.message}`;
    }
  }

  public internalMemorySearch(): string {
    const learningsPath = path.resolve(this.workspace, "LEARNINGS.md");
    if (!fs.existsSync(learningsPath)) {
      return "No LEARNINGS.md found.";
    }
    try {
      const content = fs.readFileSync(learningsPath, "utf-8");
      return content.slice(0, 5000);
    } catch (err: any) {
      return `error reading learnings: ${err.message}`;
    }
  }
}
