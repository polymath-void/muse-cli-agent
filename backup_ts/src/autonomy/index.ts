/**
 * src/autonomy/index.ts — barrel.
 */
export { createGoal, loadState, listGoals, saveState, appendEvent, readEvents, renderScratchpad, heartbeat, goalsDir, goalDir } from "./goal-store.js";
export type { GoalState, GoalStatus, GoalStep, GoalBudget, GoalEvent } from "./goal-store.js";
export { runGoalLoop } from "./loop.js";
export type { StepResult, LoopOutcome, StepExecutor } from "./loop.js";
export { findResumable, resumeGoal } from "./resume.js";
