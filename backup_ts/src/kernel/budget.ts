/**
 * src/kernel/budget.ts — Cost & token governance: circuit breaker for autonomy.
 * Global caps live in muse.config.json: {maxTokensPerGoal, maxCostUsd}.
 * Exceeding a cap halts /goal loops with a BUDGET_EXCEEDED report.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface BudgetCaps {
  maxTokensPerGoal: number;
  maxCostUsd: number;
  /** USD per 1k tokens (blended in/out) for cost estimation. Default 0.002. */
  costPerK?: number;
}

export const DEFAULT_CAPS: BudgetCaps = {
  maxTokensPerGoal: 100_000,
  maxCostUsd: 2.0,
  costPerK: 0.002,
};

export function readCaps(workspace: string): BudgetCaps {
  try {
    const raw = fs.readFileSync(path.join(path.resolve(workspace), "muse.config.json"), "utf-8");
    const data = JSON.parse(raw) as Partial<BudgetCaps>;
    return {
      maxTokensPerGoal: Number(data.maxTokensPerGoal ?? DEFAULT_CAPS.maxTokensPerGoal),
      maxCostUsd: Number(data.maxCostUsd ?? DEFAULT_CAPS.maxCostUsd),
      costPerK: Number(data.costPerK ?? DEFAULT_CAPS.costPerK),
    };
  } catch {
    return { ...DEFAULT_CAPS };
  }
}

export class BudgetExceededError extends Error {
  constructor(public detail: string) {
    super(`BUDGET_EXCEEDED: ${detail}`);
    this.name = "BudgetExceededError";
  }
}

export interface BudgetUsage {
  tokensUsed: number;
  costUsd: number;
}

/** Throw BudgetExceededError when usage breaches caps. Returns usage otherwise. */
export function checkBudget(tokensUsed: number, caps: BudgetCaps): BudgetUsage {
  const costUsd = (tokensUsed / 1000) * (caps.costPerK ?? DEFAULT_CAPS.costPerK!);
  if (tokensUsed >= caps.maxTokensPerGoal) {
    throw new BudgetExceededError(
      `token budget exceeded: ${tokensUsed} >= ${caps.maxTokensPerGoal} tokens (cost ~$${costUsd.toFixed(2)})`,
    );
  }
  if (costUsd >= caps.maxCostUsd) {
    throw new BudgetExceededError(
      `cost budget exceeded: ~$${costUsd.toFixed(2)} >= $${caps.maxCostUsd.toFixed(2)}`,
    );
  }
  return { tokensUsed, costUsd };
}

/** Rough token estimate for a string (chars/4), zero-dep. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
