/**
 * src/autonomy/resume.ts — startup crash-resume scan + resume helper.
 */
import { GoalState, listGoals, loadState, saveState, appendEvent } from "./goal-store.js";

export function findResumable(workspace: string): GoalState[] {
  return listGoals(workspace).filter((g) => g.status === "active" || g.status === "paused" || g.status === "queued");
}

/** Mark a goal resumable (queued) so runGoalLoop can pick it up again. */
export function resumeGoal(workspace: string, id: string): GoalState | null {
  const s = loadState(workspace, id);
  if (!s) return null;
  if (s.status === "done" || s.status === "failed") return s;
  s.status = "queued";
  s.consecutiveFailures = 0;
  appendEvent(workspace, id, { ts: new Date().toISOString(), type: "goal_resumed" });
  saveState(workspace, s);
  return s;
}
