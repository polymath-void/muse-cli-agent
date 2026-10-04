/**
 * src/companion/tasks.ts — trackable tasks backed by .muse/tasks.json (CWD-bound).
 * Statuses: pending | in-progress | done. Priorities: P0 > P1 > P2.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type TaskStatus = "pending" | "in-progress" | "done";
export interface CompanionTask {
  id: string;
  title: string;
  priority: string;
  status: TaskStatus;
  created: string;
}

export function tasksPath(workspace?: string): string {
  return path.join(path.resolve(workspace ?? process.cwd()), ".muse", "tasks.json");
}

export function loadTasks(workspace?: string): CompanionTask[] {
  try {
    const raw = JSON.parse(fs.readFileSync(tasksPath(workspace), "utf-8")) as {
      tasks: CompanionTask[];
    };
    return raw.tasks ?? [];
  } catch {
    return [];
  }
}

function saveTasks(workspace: string | undefined, tasks: CompanionTask[]): void {
  fs.writeFileSync(
    tasksPath(workspace),
    JSON.stringify({ tasks, updated: new Date().toISOString() }, null, 2),
    "utf-8",
  );
}

export function addTask(title: string, priority = "P1", workspace?: string): CompanionTask {
  const tasks = loadTasks(workspace);
  const id = `t-${Date.now().toString(36)}`;
  const task: CompanionTask = {
    id,
    title,
    priority,
    status: "pending",
    created: new Date().toISOString().slice(0, 10),
  };
  tasks.push(task);
  saveTasks(workspace, tasks);
  return task;
}

export function setTaskStatus(id: string, status: TaskStatus, workspace?: string): boolean {
  const tasks = loadTasks(workspace);
  const t = tasks.find((x) => x.id === id);
  if (!t) return false;
  t.status = status;
  saveTasks(workspace, tasks);
  return true;
}

export function nextTasks(workspace?: string, limit = 5): CompanionTask[] {
  const rank = (p: string) => (p === "P0" ? 0 : p === "P1" ? 1 : 2);
  return loadTasks(workspace)
    .filter((t) => t.status !== "done")
    .sort((a, b) => rank(a.priority) - rank(b.priority))
    .slice(0, limit);
}
