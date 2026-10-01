/**
 * src/kernel/index.ts — barrel for the Security & Cost Kernel.
 */
export { classifyTool, checkPermission, isTier2Command, ApprovalRequiredError } from "./permissions.js";
export type { Tier, ApprovalCheckOpts } from "./permissions.js";
export { redactSecrets, redactArgs, hashArgs } from "./redactor.js";
export { appendTrace, traced, summarizeTrace, tracePath } from "./trace.js";
export type { TraceRecord, TraceSummary } from "./trace.js";
export { readCaps, checkBudget, estimateTokens, BudgetExceededError, DEFAULT_CAPS } from "./budget.js";
export type { BudgetCaps, BudgetUsage } from "./budget.js";
