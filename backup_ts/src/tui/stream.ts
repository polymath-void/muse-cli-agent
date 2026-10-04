/**
 * src/tui/stream.ts — Chunked Markdown Stream Renderer + resilient SSE buffer.
 *
 * Architecture plan §2.5:
 * - "Builds a resilient JSON buffer in `src/tui/stream.ts` that safely parses
 *   partial `data: {...}` API chunks, ensuring it doesn't crash on split JSON
 *   tokens and renders cleanly with `chalk`."
 *
 * Design:
 * - `SseBuffer` accumulates raw HTTP chunks and only emits complete
 *   `data:` payloads delimited by `\n\n` (SSE event boundary). A `data:`
 *   prefix split across TCP chunks is harmless because we concatenate before
 *   scanning. Incomplete trailing bytes stay buffered — never parsed, never
 *   thrown.
 * - `safeJsonParse` never throws; truncated JSON yields `null` so the caller
 *   can keep buffering instead of crashing.
 * - `ChunkedMarkdownRenderer` accumulates text deltas and produces a
 *   chalk-styled final render (fence-aware, so a split ``` fence can't break
 *   styling). Internal `<think>` blocks are split out for the Ctrl+O UI.
 *
 * No I/O, no process globals — safe to import in TUI, headless, and tests.
 */

import chalk from "chalk";

// ---------------------------------------------------------------------------
// Safe JSON
// ---------------------------------------------------------------------------

/** Parse JSON without ever throwing. Returns null on truncated/invalid input. */
export function safeJsonParse<T = unknown>(text: string): T | null {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

/**
 * Heuristic: does this payload look like truncated JSON (unbalanced braces /
 * brackets, or an unterminated string)? Used to decide "keep buffering"
 * vs "drop this event". Never throws.
 */
export function isProbablyTruncatedJson(payload: string): boolean {
  const t = payload.trim();
  if (!t) return false;
  if (t === "[DONE]") return false;
  const first = t[0];
  if (first !== "{" && first !== "[") return false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (const ch of t) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return inStr || depth > 0;
}

// ---------------------------------------------------------------------------
// Resilient SSE buffer
// ---------------------------------------------------------------------------

/**
 * Accumulates raw stream bytes and emits complete `data:` payload strings.
 *
 * - Normalizes CRLF → LF.
 * - Splits on the SSE event terminator `\n\n` only; a JSON object split
 *   across chunks stays in `buf` until its terminator arrives.
 * - Skips `data: [DONE]`, empty lines, and `:comment` keep-alives.
 * - Never throws on malformed bytes.
 */
export class SseBuffer {
  private buf = "";

  /** Feed a decoded text chunk. Returns zero or more complete payloads. */
  push(chunk: string): string[] {
    if (!chunk) return [];
    this.buf += chunk.replace(/\r\n/g, "\n");
    const out: string[] = [];
    let sep: number;
    // Guard against a pathological giant buffer (LMK safety).
    if (this.buf.length > 2_000_000) {
      this.buf = this.buf.slice(-2_000_000);
    }
    while ((sep = this.buf.indexOf("\n\n")) !== -1) {
      const block = this.buf.slice(0, sep);
      this.buf = this.buf.slice(sep + 2);
      for (const payload of SseBuffer.extractDataPayloads(block)) {
        if (!payload || payload === "[DONE]") continue;
        out.push(payload);
      }
    }
    return out;
  }

  /** Drain any trailing bytes that never got a `\n\n` terminator. */
  flush(): string[] {
    const rem = this.buf;
    this.buf = "";
    if (!rem.trim()) return [];
    return SseBuffer.extractDataPayloads(rem).filter(
      (p) => p.length > 0 && p !== "[DONE]",
    );
  }

  reset(): void {
    this.buf = "";
  }

  get bufferedLength(): number {
    return this.buf.length;
  }

  get pending(): string {
    return this.buf;
  }

  /** Extract `data:` payloads from one SSE event block (no terminator). */
  static extractDataPayloads(block: string): string[] {
    const out: string[] = [];
    // A block may itself contain several `data:` lines (SSE spec: join with \n).
    // For OpenAI-style streams each event carries exactly one JSON object, so
    // we emit each line separately; multi-line data that is clearly one JSON
    // value split across lines is re-joined by the caller via safeJsonParse.
    const dataLines: string[] = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith(":")) continue; // SSE comment / keep-alive
      if (!line.startsWith("data:")) continue;
      dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return out;
    if (dataLines.length === 1) {
      out.push(dataLines[0]);
      return out;
    }
    // Heuristic: if joining the lines parses as one JSON value, it was a
    // single payload wrapped across lines; otherwise keep them separate.
    const joined = dataLines.join("\n");
    if (safeJsonParse(joined) !== null) {
      out.push(joined);
    } else {
      for (const d of dataLines) out.push(d);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Chat delta extraction (never crashes on split tokens)
// ---------------------------------------------------------------------------

export interface DeltaText {
  /** Normal assistant text delta. */
  text?: string;
  /** Reasoning / internal-thought delta (rendered dim, Ctrl+O gated). */
  thought?: string;
  toolCallParts?: {
    index?: number;
    id?: string;
    name?: string;
    arguments?: string;
  }[];
}

/**
 * Pull text + tool-call parts out of a parsed SSE event object.
 * Tolerates every known shape (`delta.content`, `message.content`,
 * `reasoning_content`, string-vs-array content) and never throws.
 */
export function extractDeltaText(evt: unknown): DeltaText {
  if (!evt || typeof evt !== "object") return {};
  const root = evt as Record<string, unknown>;
  const choices = (root.choices ?? root.data) as unknown;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const holder = (first ?? root) as Record<string, unknown>;
  const delta = (holder.delta ?? holder.message ?? holder) as Record<
    string,
    unknown
  >;
  const out: DeltaText = {};
  const pushContent = (v: unknown): void => {
    if (typeof v === "string" && v.length > 0) {
      out.text = (out.text ?? "") + v;
    } else if (Array.isArray(v)) {
      for (const part of v) {
        if (typeof part === "string") out.text = (out.text ?? "") + part;
        else if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          const t = p.text ?? p.content;
          if (typeof t === "string") out.text = (out.text ?? "") + t;
        }
      }
    }
  };
  try {
    pushContent(delta.content);
    const reasoning =
      delta.reasoning_content ?? delta.reasoning ?? delta.thought;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      out.thought = reasoning;
    }
    // Tool calls arrive in two shapes: the OpenAI-nested
    // ({id, type, function:{name, arguments}}) and some providers' flat
    // ({index, id, name, arguments}). The Gemini→OpenAI normalizer emits the
    // nested form, so reading only the flat keys silently drops every tool
    // call — the agent then looks like it did nothing.
    const tc = delta.tool_calls;
    if (Array.isArray(tc)) {
      out.toolCallParts = tc.map((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        const fn = (r.function ?? {}) as Record<string, unknown>;
        const name = typeof fn.name === "string" ? fn.name : r.name;
        const args = typeof fn.arguments === "string" ? fn.arguments : r.arguments;
        return {
          ...(typeof r.index === "number" ? { index: r.index } : {}),
          ...(typeof r.id === "string" ? { id: r.id } : {}),
          ...(typeof name === "string" ? { name } : {}),
          ...(typeof args === "string" ? { arguments: args } : {}),
        };
      });
    }
  } catch {
    /* never crash the stream on a weird token */
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal thoughts (<think>…</think>) splitting for the Ctrl+O UI
// ---------------------------------------------------------------------------

const THOUGHT_RE =
  /<(think|thinking|thought|reasoning)[^>]*>([\s\S]*?)(?:<\/\1>|$)/gi;

export interface SplitThoughts {
  /** User-visible text (thought blocks removed). */
  visible: string;
  /** Concatenated internal thoughts (without tags). */
  thoughts: string;
}

/** Split `<think>`-style blocks out of assistant text. Never throws. */
export function splitThoughts(text: string): SplitThoughts {
  if (!text) return { visible: "", thoughts: "" };
  try {
    const thoughts: string[] = [];
    const visible = text.replace(
      THOUGHT_RE,
      (_m, _tag: string, inner: string) => {
        if (inner && inner.trim().length > 0) thoughts.push(inner.trim());
        return "";
      },
    );
    // Unclosed trailing tag without a closer (streaming cut): treat the tail
    // from the last opening tag as thoughts so half a thought never leaks.
    return { visible, thoughts: thoughts.join("\n\n") };
  } catch {
    return { visible: text, thoughts: "" };
  }
}

// ---------------------------------------------------------------------------
// Markdown-ish terminal rendering (fence-aware, split-safe)
// ---------------------------------------------------------------------------

/** Minimal markdown-ish render: code fences dimmed, headers bold. */
export function renderAssistant(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  let inFence = false;
  return lines
    .map((ln) => {
      try {
        if (ln.trimStart().startsWith("```")) {
          inFence = !inFence;
          return chalk.dim(ln);
        }
        if (inFence) return chalk.dim(ln);
        if (/^#{1,4}\s/.test(ln)) return chalk.bold.white(ln);
        if (/^>\s?/.test(ln)) return chalk.dim(ln);
        if (/^\s*([-∗•]|\d+[.)])\s/.test(ln)) {
          return ln.replace(
            /^(\s*)([-∗•]|\d+[.)])(\s+)/,
            (_m, ind: string, bullet: string, sp: string) =>
              `${ind}${chalk.cyan(bullet)}${sp}`,
          );
        }
        // Inline `code` — highlight the spans without breaking on a stray "`".
        if (ln.includes("`")) {
          const parts = ln.split("`");
          if (parts.length >= 3 && parts.length % 2 === 1) {
            return parts
              .map((p, i) => (i % 2 === 1 ? chalk.yellow(`\`${p}\``) : p))
              .join("");
          }
        }
        let formatted = ln.replace(
          /\[([^\]]+)\]\(([^)]+)\)/g,
          chalk.bold.blue("[$1]") + chalk.dim("($2)"),
        );
        formatted = formatted.replace(/\*\*([^*]+)\*\*/g, chalk.bold("$1"));
        formatted = formatted.replace(
          /(^|[^*])\*([^*\n]+)\*/g,
          (_m, pre: string, it: string) => `${pre}${chalk.dim(it)}`,
        );
        return formatted;
      } catch {
        return ln;
      }
    })
    .join("\n");
}

/**
 * Incremental accumulator for one assistant turn.
 * Raw deltas are appended verbatim (ANSI is only applied at final render so
 * a chalk code can never be split across chunks). Thoughts are tracked
 * separately for the Ctrl+O overlay.
 */
export class ChunkedMarkdownRenderer {
  private text = "";
  private thoughtText = "";
  private showThoughts = false;

  push(delta: string, thought?: string): void {
    if (delta) this.text += delta;
    if (thought) this.thoughtText += thought;
    // LMK bound: keep the renderer small on giant streams.
    if (this.text.length > 500_000) this.text = this.text.slice(-500_000);
    if (this.thoughtText.length > 200_000) {
      this.thoughtText = this.thoughtText.slice(-200_000);
    }
  }

  setShowThoughts(v: boolean): void {
    this.showThoughts = v;
  }

  get showThoughtsEnabled(): boolean {
    return this.showThoughts;
  }

  getText(): string {
    return this.text;
  }

  getThoughts(): string {
    try {
      const embedded = splitThoughts(this.text);
      const extra = this.thoughtText.trim();
      const combined = [embedded.thoughts, extra]
        .filter((s) => s.trim().length > 0)
        .join("\n\n");
      return combined;
    } catch {
      return this.thoughtText;
    }
  }

  /** Visible text after thought-stripping (honors the Ctrl+O flag). */
  getVisibleText(): string {
    const embedded = splitThoughts(this.text);
    if (this.showThoughts) {
      const extra = this.thoughtText.trim();
      if (!extra) return this.text;
      return `${embedded.visible}\n\n${chalk.dim("[reasoning]")}\n${chalk.dim(extra)}`;
    }
    return embedded.visible;
  }

  /** Fully styled text ready for console.log. */
  render(): string {
    try {
      const thoughts = this.getThoughts();
      const visible = this.getVisibleText();
      const styled = renderAssistant(visible);
      if (this.showThoughts || !thoughts) return styled;
      return (
        styled +
        chalk.dim(
          `\n(+${thoughts.length} chars internal thoughts — Ctrl+O or /thoughts to show)`,
        )
      );
    } catch {
      return this.text;
    }
  }

  reset(): void {
    this.text = "";
    this.thoughtText = "";
  }
}

export default ChunkedMarkdownRenderer;
