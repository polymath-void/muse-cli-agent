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
/** Parse JSON without ever throwing. Returns null on truncated/invalid input. */
export declare function safeJsonParse<T = unknown>(text: string): T | null;
/**
 * Heuristic: does this payload look like truncated JSON (unbalanced braces /
 * brackets, or an unterminated string)? Used to decide "keep buffering"
 * vs "drop this event". Never throws.
 */
export declare function isProbablyTruncatedJson(payload: string): boolean;
/**
 * Accumulates raw stream bytes and emits complete `data:` payload strings.
 *
 * - Normalizes CRLF → LF.
 * - Splits on the SSE event terminator `\n\n` only; a JSON object split
 *   across chunks stays in `buf` until its terminator arrives.
 * - Skips `data: [DONE]`, empty lines, and `:comment` keep-alives.
 * - Never throws on malformed bytes.
 */
export declare class SseBuffer {
    private buf;
    /** Feed a decoded text chunk. Returns zero or more complete payloads. */
    push(chunk: string): string[];
    /** Drain any trailing bytes that never got a `\n\n` terminator. */
    flush(): string[];
    reset(): void;
    get bufferedLength(): number;
    get pending(): string;
    /** Extract `data:` payloads from one SSE event block (no terminator). */
    static extractDataPayloads(block: string): string[];
}
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
export declare function extractDeltaText(evt: unknown): DeltaText;
export interface SplitThoughts {
    /** User-visible text (thought blocks removed). */
    visible: string;
    /** Concatenated internal thoughts (without tags). */
    thoughts: string;
}
/** Split `<think>`-style blocks out of assistant text. Never throws. */
export declare function splitThoughts(text: string): SplitThoughts;
/** Minimal markdown-ish render: code fences dimmed, headers bold. */
export declare function renderAssistant(text: string): string;
/**
 * Incremental accumulator for one assistant turn.
 * Raw deltas are appended verbatim (ANSI is only applied at final render so
 * a chalk code can never be split across chunks). Thoughts are tracked
 * separately for the Ctrl+O overlay.
 */
export declare class ChunkedMarkdownRenderer {
    private text;
    private thoughtText;
    private showThoughts;
    push(delta: string, thought?: string): void;
    setShowThoughts(v: boolean): void;
    get showThoughtsEnabled(): boolean;
    getText(): string;
    getThoughts(): string;
    /** Visible text after thought-stripping (honors the Ctrl+O flag). */
    getVisibleText(): string;
    /** Fully styled text ready for console.log. */
    render(): string;
    reset(): void;
}
export default ChunkedMarkdownRenderer;
