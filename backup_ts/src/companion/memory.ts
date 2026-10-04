/**
 * src/companion/memory.ts — persistent companion memory backed by .muse/memory.md.
 * Append-only notes + full read. CWD-bound, never global.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function memoryPath(workspace?: string): string {
  return path.join(path.resolve(workspace ?? process.cwd()), ".muse", "memory.md");
}

export function readMemory(workspace?: string): string {
  try {
    return fs.readFileSync(memoryPath(workspace), "utf-8");
  } catch {
    return "";
  }
}

export function appendMemory(note: string, workspace?: string): void {
  const p = memoryPath(workspace);
  const line = `\n- ${new Date().toISOString().slice(0, 10)}: ${note}\n`;
  fs.appendFileSync(p, line, "utf-8");
}
