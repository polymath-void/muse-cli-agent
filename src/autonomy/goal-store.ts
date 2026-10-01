/**
 * src/autonomy/goal-store.ts — Crash-resumable goal state machine.
 * Store: .muse/goals/<goal-id>/{state.json, events.jsonl, scratchpad.md}.
 * scratchpad.md is a human-readable view, NOT the source of truth.
 * Atomic writes: write tmp + rename so kill -9 can never corrupt state.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export type GoalStatus = "queued" | "active" | "paused" | "done" | "failed";

export interface GoalStep {
  title: string;
  done: boolean;
  note?: string;
}

export interface GoalBudget {
  maxIters: number;
  maxTokens: number;
  deadlineMs?: number;
}

export interface GoalState {
  id: string;
  objective: string;
  status: GoalStatus;
  plan: GoalStep[];
  currentStep: number;
  iters: number;
  tokensUsed: number;
  consecutiveFailures: number;
  budget: GoalBudget;
  createdAt: string;
  updatedAt: string;
}

export interface GoalEvent {
  ts: string;
  type: string;
  data?: unknown;
}

export function goalsDir(workspace: string): string {
  return path.join(path.resolve(workspace), ".muse", "goals");
}

export function goalDir(workspace: string, id: string): string {
  return path.join(goalsDir(workspace), id);
}

function parseDeadline(s?: string): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+)\s*(m|min|mins|h|hr|hrs|d|day|days)?$/i.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "h").toLowerCase();
  if (unit.startsWith("m")) return n * 60_000;
  if (unit.startsWith("d")) return n * 86_400_000;
  return n * 3_600_000;
}

export function createGoal(
  workspace: string,
  objective: string,
  opts: { budget?: number; maxTokens?: number; deadline?: string } = {},
): GoalState {
  const id = randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  const state: GoalState = {
    id,
    objective,
    status: "queued",
    plan: [],
    currentStep: 0,
    iters: 0,
    tokensUsed: 0,
    consecutiveFailures: 0,
    budget: {
      maxIters: opts.budget ?? 50,
      maxTokens: opts.maxTokens ?? 100_000,
      deadlineMs: parseDeadline(opts.deadline),
    },
    createdAt: now,
    updatedAt: now,
  };
  const dir = goalDir(workspace, id);
  fs.mkdirSync(dir, { recursive: true });
  saveState(workspace, state);
  appendEvent(workspace, id, { ts: now, type: "goal_created", data: { objective, budget: state.budget } });
  renderScratchpad(workspace, state);
  return state;
}

/** Atomic: write to tmp file then rename. */
export function saveState(workspace: string, state: GoalState): void {
  state.updatedAt = new Date().toISOString();
  const dir = goalDir(workspace, state.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `state.json.tmp.${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, path.join(dir, "state.json"));
}

export function loadState(workspace: string, id: string): GoalState | null {
  try {
    const raw = fs.readFileSync(path.join(goalDir(workspace, id), "state.json"), "utf-8");
    return JSON.parse(raw) as GoalState;
  } catch {
    return null;
  }
}

export function listGoals(workspace: string): GoalState[] {
  const out: GoalState[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(goalsDir(workspace));
  } catch {
    return out;
  }
  for (const id of entries) {
    const s = loadState(workspace, id);
    if (s) out.push(s);
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export function appendEvent(workspace: string, id: string, ev: GoalEvent): void {
  try {
    const dir = goalDir(workspace, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(ev) + "\n", "utf-8");
  } catch {
    /* events are best-effort */
  }
}

export function readEvents(workspace: string, id: string, limit = 200): GoalEvent[] {
  try {
    const raw = fs.readFileSync(path.join(goalDir(workspace, id), "events.jsonl"), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    return lines.slice(-limit).map((l) => JSON.parse(l) as GoalEvent);
  } catch {
    return [];
  }
}

/** Human-readable view derived from state (never parsed back). */
export function renderScratchpad(workspace: string, state: GoalState): void {
  try {
    const lines = [
      `# Goal ${state.id} — ${state.status}`,
      "",
      `Objective: ${state.objective}`,
      `Iters: ${state.iters}/${state.budget.maxIters} · Tokens: ~${state.tokensUsed}/${state.budget.maxTokens}`,
      `Updated: ${state.updatedAt}`,
      "",
      `## Plan`,
      ...(state.plan.length === 0
        ? ["(no plan yet)"]
        : state.plan.map((s, i) => `- [${s.done ? "x" : " "}] ${i + 1}. ${s.title}${s.note ? ` — ${s.note}` : ""}`)),
      "",
      `## Recent events`,
      ...readEvents(workspace, state.id, 10).map((e) => `- ${e.ts} ${e.type}`),
    ];
    fs.writeFileSync(path.join(goalDir(workspace, state.id), "scratchpad.md"), lines.join("\n"), "utf-8");
  } catch {
    /* view is best-effort */
  }
}

export function heartbeat(workspace: string, id: string, extra: Record<string, unknown> = {}): void {
  try {
    const dir = goalDir(workspace, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "heartbeat.json"),
      JSON.stringify({ ts: new Date().toISOString(), goalId: id, pid: process.pid, ...extra }),
      "utf-8",
    );
  } catch {
    /* liveness is best-effort */
  }
}
