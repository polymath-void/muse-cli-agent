/**
 * src/core/learnings.ts — Self-learning core: layered LEARNINGS.md files.
 *
 * Layers (priority order: global < project < session):
 * - `<repo>/LEARNINGS.md`            (root, committed)
 * - `~/.muse/LEARNINGS.md`        (global, XDG config)
 * - `<workspace>/.muse/LEARNINGS.md` (project, CWD-bound)
 *
 * Lessons persist as `- [category] lesson (YYYY-MM-DD)` lines. The loader
 * concatenates present layers for system-prompt injection.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type LessonScope = "project" | "global";
export type LessonCategory = "mistake" | "preference" | "pattern";

export const LEARN_CATEGORIES: LessonCategory[] = ["mistake", "preference", "pattern"];

export function workspaceRootFor(workspace?: string): string {
  return path.resolve(workspace ?? process.cwd());
}

export function rootLearningsPath(workspace?: string): string {
  return path.join(workspaceRootFor(workspace), "LEARNINGS.md");
}

export function globalLearningsPath(): string {
  return path.join(os.homedir(), ".muse", "LEARNINGS.md");
}

export function projectLearningsPath(workspace?: string): string {
  return path.join(workspaceRootFor(workspace), ".muse", "LEARNINGS.md");
}

export function learningsPathForScope(scope: LessonScope, workspace?: string): string {
  return scope === "global" ? globalLearningsPath() : projectLearningsPath(workspace);
}

export interface PersistLessonInput {
  lesson: string;
  scope?: LessonScope;
  category?: LessonCategory;
  workspace?: string;
}

/** Validate then append a lesson line. Returns the user-facing confirmation. */
export function persistLesson(input: PersistLessonInput): string {
  const lesson = (input.lesson ?? "").trim();
  if (lesson.length < 10) throw new Error("learn requires `lesson` (min 10 chars)");
  const category: LessonCategory = input.category ?? "pattern";
  if (!LEARN_CATEGORIES.includes(category)) {
    throw new Error(`unknown category: ${input.category} (want mistake|preference|pattern)`);
  }
  const scope: LessonScope = input.scope ?? "project";
  const file = learningsPathForScope(scope, input.workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(file, `\n- [${category}] ${lesson} (${date})\n`, "utf-8");
  return `Learned: ${lesson}`;
}

export interface LearningsSnapshot {
  root: string;
  global: string;
  project: string;
  combined: string;
}

function readIfExists(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

/** Load all layers. `combined` is "" when nothing is stored yet. */
export function loadLearnings(workspace?: string): LearningsSnapshot {
  const root = readIfExists(rootLearningsPath(workspace));
  const global = readIfExists(globalLearningsPath());
  const project = readIfExists(projectLearningsPath(workspace));
  const parts: string[] = [];
  if (global.trim()) parts.push(`### Global learnings\n${global.trim()}`);
  if (project.trim()) parts.push(`### Project learnings\n${project.trim()}`);
  if (root.trim()) parts.push(`### Repo learnings\n${root.trim()}`);
  const combined = parts.length > 0
    ? `## Durable Learnings\n${parts.join("\n\n")}`
    : "";
  return { root, global, project, combined };
}

/** System-prompt injection block for the loaded layers. */
export function learningsContextBlock(workspace?: string): string {
  const { combined } = loadLearnings(workspace);
  if (!combined) return "";
  return `<durable-learnings>\n${combined.slice(0, 8000)}\n</durable-learnings>`;
}

/** Normalize a lesson for repeat-counting (case/space/punct-insensitive). */
export function normalizeLesson(lesson: string): string {
  return lesson.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Count normalized occurrences across all stored layers. */
export function countLessonOccurrences(lesson: string, workspace?: string): number {
  const norm = normalizeLesson(lesson);
  if (!norm) return 0;
  const { root, global, project } = loadLearnings(workspace);
  const hay = `${root}\n${global}\n${project}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ");
  if (!hay.includes(norm)) return hay.split(norm).length - 1 > 0 && norm.length > 0 ? occurrences(hay, norm) : 0;
  return occurrences(hay, norm);
}

function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/** Slugify a lesson into a safe plugin directory name. */
export function slugifyLesson(lesson: string, max = 48): string {
  const slug = lesson
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug || "learned-skill";
}

/**
 * Promotion engine: when a normalized lesson has been recorded >= threshold
 * times across layers, materialize it as a SKILL.md plugin so future sessions
 * pick it up via the plugin system. Returns the skill file path or null.
 *
 * REVIEW NOTE (human review required): this creates new plugin files
 * dynamically. Threshold gate (default 3) + workspace scoping keep it
 * conservative; callers should surface the generated path in the TUI.
 */
export function maybePromoteLessonToSkill(
  rule: string,
  workspace?: string,
  threshold = 3,
): string | null {
  const trimmed = (rule ?? "").trim();
  if (trimmed.length < 10) return null;
  if (countLessonOccurrences(trimmed, workspace) < threshold) return null;
  const root = workspaceRootFor(workspace);
  const slug = slugifyLesson(trimmed);
  const dir = path.join(root, ".muse", "plugins", slug);
  const file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  const body = `---\nname: ${slug}\ndescription: ${trimmed.slice(0, 160)}\n---\n\n# ${slug}\n\n${trimmed}\n`;
  fs.writeFileSync(file, body, "utf-8");
  return file;
}
