/**
 * src/kernel/trace.ts — Observability: every tool call → .muse/audit/trace.jsonl
 * Record: {ts, tool, argsHash, tokensIn/Out, durationMs}. Secrets redacted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { hashArgs } from "./redactor.js";

export interface TraceRecord {
  ts: string;
  tool: string;
  argsHash: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  ok?: boolean;
}

export function tracePath(workspace: string): string {
  return path.join(path.resolve(workspace), ".muse", "audit", "trace.jsonl");
}

export function appendTrace(workspace: string, rec: TraceRecord): void {
  try {
    const p = tracePath(workspace);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(rec) + "\n", "utf-8");
  } catch {
    /* observability must never break the agent */
  }
}

export async function traced<T>(
  workspace: string,
  tool: string,
  args: unknown,
  fn: () => Promise<{ result: T; tokensIn?: number; tokensOut?: number }>,
): Promise<T> {
  const start = Date.now();
  let ok = true;
  try {
    const r = await fn();
    appendTrace(workspace, {
      ts: new Date().toISOString(),
      tool,
      argsHash: hashArgs(args),
      tokensIn: r.tokensIn ?? 0,
      tokensOut: r.tokensOut ?? 0,
      durationMs: Date.now() - start,
      ok: true,
    });
    return r.result;
  } catch (err) {
    ok = false;
    appendTrace(workspace, {
      ts: new Date().toISOString(),
      tool,
      argsHash: hashArgs(args),
      tokensIn: 0,
      tokensOut: 0,
      durationMs: Date.now() - start,
      ok,
    });
    throw err;
  }
}

export interface TraceSummary {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  perTool: Record<string, number>;
}

/** Sum trace.jsonl, optionally filtered to records since `sinceIso`. */
export function summarizeTrace(workspace: string, sinceIso?: string): TraceSummary {
  const out: TraceSummary = { calls: 0, tokensIn: 0, tokensOut: 0, perTool: {} };
  try {
    const raw = fs.readFileSync(tracePath(workspace), "utf-8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = JSON.parse(t) as TraceRecord;
        if (sinceIso && r.ts < sinceIso) continue;
        out.calls++;
        out.tokensIn += Number(r.tokensIn ?? 0);
        out.tokensOut += Number(r.tokensOut ?? 0);
        out.perTool[r.tool] = (out.perTool[r.tool] ?? 0) + 1;
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* no trace file yet */
  }
  return out;
}
