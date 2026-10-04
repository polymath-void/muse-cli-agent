/**
 * src/autonomy/loop.ts — /goal ReAct loop: plan → act → observe → checkpoint → reflect.
 * Every iteration appends to events.jsonl + atomically rewrites state.json.
 * Circuit breaker: 3 consecutive tool failures, token/iter budget exceeded,
 * deadline passed, or user interrupt (SIGINT → paused, resumable).
 *
 * The loop is executor-injected so CLI/TUI/tests can drive it without a model:
 * `executor(step, state)` performs one ReAct iteration and returns tool stats.
 */
import {
  GoalState,
  appendEvent,
  saveState,
  renderScratchpad,
  heartbeat,
} from "./goal-store.js";
import { BudgetExceededError } from "../kernel/budget.js";

export interface StepResult {
  /** Human-readable observation appended to events + scratchpad. */
  observation: string;
  /** Approx tokens consumed by this step. */
  tokensUsed?: number;
  /** True when the step's tool work failed. */
  failed?: boolean;
  /** True when the objective is complete. */
  done?: boolean;
  /** Optional plan titles to install/refresh. */
  plan?: string[];
  /** Mark current plan step complete. */
  advanceStep?: boolean;
}

export interface LoopOutcome {
  status: "done" | "paused" | "failed";
  reason: string;
  iters: number;
}

export type StepExecutor = (stepIndex: number, state: GoalState) => Promise<StepResult>;

export async function runGoalLoop(
  workspace: string,
  state: GoalState,
  executor: StepExecutor,
  opts: { onIter?: (s: GoalState) => void } = {},
): Promise<LoopOutcome> {
  state.status = "active";
  saveState(workspace, state);
  const deadlineAt = state.budget.deadlineMs ? Date.now() + state.budget.deadlineMs : Infinity;
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
  };
  process.once("SIGINT", onSigint);

  try {
    while (true) {
      if (interrupted) {
        return finish(workspace, state, "paused", "interrupted by user (SIGINT) — resume with goal --resume");
      }
      if (Date.now() > deadlineAt) {
        return finish(workspace, state, "failed", "deadline exceeded");
      }
      if (state.iters >= state.budget.maxIters) {
        return finish(
          workspace,
          state,
          "failed",
          new BudgetExceededError(`maxIters ${state.budget.maxIters} reached`).message,
        );
      }
      if (state.tokensUsed >= state.budget.maxTokens) {
        return finish(
          workspace,
          state,
          "failed",
          new BudgetExceededError(`token budget ${state.budget.maxTokens} reached`).message,
        );
      }
      if (state.consecutiveFailures >= 3) {
        return finish(workspace, state, "failed", "circuit breaker: 3 consecutive tool failures");
      }

      const stepIndex = state.iters;
      appendEvent(workspace, state.id, { ts: new Date().toISOString(), type: "iter_start", data: { stepIndex } });
      let result: StepResult;
      try {
        result = await executor(stepIndex, state);
      } catch (err) {
        result = { observation: `executor error: ${(err as Error).message}`, failed: true };
      }

      // Observe + checkpoint (atomic) — crash-resume safe.
      state.iters += 1;
      state.tokensUsed += result.tokensUsed ?? 0;
      if (result.plan && result.plan.length > 0 && state.plan.length === 0) {
        state.plan = result.plan.map((title) => ({ title, done: false }));
      }
      if (result.failed) state.consecutiveFailures += 1;
      else state.consecutiveFailures = 0;
      if (result.advanceStep && state.plan[state.currentStep]) {
        state.plan[state.currentStep].done = true;
        state.currentStep += 1;
      }
      appendEvent(workspace, state.id, {
        ts: new Date().toISOString(),
        type: result.failed ? "iter_failed" : "iter_ok",
        data: { stepIndex, observation: result.observation.slice(0, 2000), done: !!result.done },
      });
      saveState(workspace, state);
      renderScratchpad(workspace, state);
      heartbeat(workspace, state.id, { iters: state.iters, status: state.status });
      opts.onIter?.(state);

      if (result.done) {
        return finish(workspace, state, "done", result.observation.slice(0, 500));
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function finish(workspace: string, state: GoalState, status: GoalState["status"], reason: string): LoopOutcome {
  state.status = status;
  appendEvent(workspace, state.id, { ts: new Date().toISOString(), type: `goal_${status}`, data: { reason } });
  saveState(workspace, state);
  renderScratchpad(workspace, state);
  heartbeat(workspace, state.id, { status, reason: reason.slice(0, 200) });
  return { status: status as LoopOutcome["status"], reason, iters: state.iters };
}
