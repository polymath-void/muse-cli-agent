/**
 * src/core/context-manager.ts — Central compaction API with token estimation.
 *
 * Adapted to the muse-ts kernel: history is ChatMessage[] (src/core/types.ts).
 * Token estimate ≈ chars / 4. Compaction preserves recency (last 10 turns)
 * and replaces stale history with a `## Prior Summary` system turn.
 */

import type { ChatMessage } from "./types.js";

export interface ContextStatus {
  messages: number;
  estimatedTokens: number;
  limit: number;
  needsCompaction: boolean;
  usageRatio: number;
}

export type Summarizer = (stale: ChatMessage[]) => Promise<string> | string;

export class ContextManager {
  private history: ChatMessage[];
  private limit: number;

  constructor(history: ChatMessage[], limit = 120_000) {
    this.history = history;
    this.limit = limit;
  }

  /** Direct access to the live history array (mutated in place by compact/clear). */
  getHistory(): ChatMessage[] {
    return this.history;
  }

  estimateTokens(): number {
    let chars = 0;
    for (const m of this.history) {
      chars += (m.content ?? "").length;
      if (m.tool_calls) {
        for (const tc of m.tool_calls) chars += (tc.function.arguments ?? "").length;
      }
    }
    return Math.ceil(chars / 4);
  }

  needsCompaction(): boolean {
    return this.estimateTokens() > this.limit * 0.85;
  }

  getStatus(): ContextStatus {
    const estimatedTokens = this.estimateTokens();
    return {
      messages: this.history.length,
      estimatedTokens,
      limit: this.limit,
      needsCompaction: estimatedTokens > this.limit * 0.85,
      usageRatio: this.limit > 0 ? estimatedTokens / this.limit : 0,
    };
  }

  /**
   * Compact stale history into a summary turn. Keeps the leading system
   * prompt (index 0 when role === "system") plus the last 10 turns.
   */
  async compact(summarize: Summarizer): Promise<ChatMessage[]> {
    if (this.history.length <= 11) return this.history;
    const systemTurns = this.history.length > 0 && this.history[0].role === "system"
      ? [this.history[0]]
      : [];
    const rest = systemTurns.length > 0 ? this.history.slice(1) : this.history;
    if (rest.length <= 10) return this.history;
    const keep = rest.slice(-10);
    const stale = rest.slice(0, -10);
    const summary = await summarize(stale);
    const summaryTurn: ChatMessage = {
      role: "system",
      content: `## Prior Summary\n${summary}`,
    };
    const next: ChatMessage[] = [...systemTurns, summaryTurn, ...keep];
    this.history.splice(0, this.history.length, ...next);
    return this.history;
  }

  /** Default extractive fallback when no LLM summarizer is wired. */
  static fallbackSummary(stale: ChatMessage[]): string {
    const lines: string[] = [];
    for (const m of stale.slice(0, 40)) {
      const head = (m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      if (head) lines.push(`- [${m.role}] ${head}`);
    }
    return `Compacted ${stale.length} turn(s).\n${lines.join("\n")}`;
  }

  /** Clear all but the leading system prompt. Returns removed count. */
  clear(keepSystem = true): number {
    const removed = this.history.length;
    if (keepSystem && this.history.length > 0 && this.history[0].role === "system") {
      const sys = this.history[0];
      this.history.splice(0, this.history.length, sys);
      return removed - 1;
    }
    this.history.splice(0, this.history.length);
    return removed;
  }
}
