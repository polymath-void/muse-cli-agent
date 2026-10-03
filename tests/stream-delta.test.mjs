/**
 * tests/stream-delta.test.mjs — regression coverage for `extractDeltaText`
 * in `src/tui/stream.ts`.
 *
 * The bug it pins: tool calls arrive OpenAI-nested
 * (`{id, type, function:{name, arguments}}`), but the extractor only read the
 * flat keys, so `name` stayed empty, the TUI's `.filter(name.length > 0)`
 * dropped every call, and the agent looked like it had done nothing while the
 * backend happily returned tool calls.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractDeltaText, SseBuffer, safeJsonParse } from "../dist/tui/stream.js";

const chunk = (delta) => ({ choices: [{ index: 0, delta }] });

describe("extractDeltaText tool calls", () => {
  it("reads the OpenAI-nested function shape", () => {
    const d = extractDeltaText(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1__sig_ABC",
            type: "function",
            function: { name: "write_file", arguments: '{"path":"a.txt"}' },
          },
        ],
      }),
    );
    assert.equal(d.toolCallParts.length, 1);
    assert.equal(d.toolCallParts[0].name, "write_file");
    assert.equal(d.toolCallParts[0].arguments, '{"path":"a.txt"}');
    assert.equal(d.toolCallParts[0].id, "call_1__sig_ABC");
    assert.equal(d.toolCallParts[0].index, 0);
  });

  it("still accepts the flat shape", () => {
    const d = extractDeltaText(
      chunk({ tool_calls: [{ index: 1, id: "x", name: "bash", arguments: "{}" }] }),
    );
    assert.equal(d.toolCallParts[0].name, "bash");
    assert.equal(d.toolCallParts[0].index, 1);
  });

  it("omits keys the provider did not send", () => {
    const d = extractDeltaText(chunk({ tool_calls: [{ function: { name: "bash" } }] }));
    assert.deepEqual(d.toolCallParts[0], { name: "bash" });
  });

  it("never throws on a malformed tool_calls payload", () => {
    assert.doesNotThrow(() => extractDeltaText(chunk({ tool_calls: "nope" })));
    assert.doesNotThrow(() => extractDeltaText(chunk({ tool_calls: [null, 3] })));
  });

  it("keeps text and thought alongside tool calls", () => {
    const d = extractDeltaText(
      chunk({
        content: "working",
        reasoning_content: "thinking",
        tool_calls: [{ function: { name: "bash", arguments: "{}" } }],
      }),
    );
    assert.equal(d.text, "working");
    assert.equal(d.thought, "thinking");
    assert.equal(d.toolCallParts[0].name, "bash");
  });
});

describe("SseBuffer", () => {
  it("emits complete payloads and keeps split JSON buffered", () => {
    const buf = new SseBuffer();
    const payload = JSON.stringify(chunk({ content: "hello" }));
    assert.deepEqual(buf.push(`data: ${payload.slice(0, 10)}`), []);
    const out = buf.push(`${payload.slice(10)}\n\n`);
    assert.equal(out.length, 1);
    assert.equal(safeJsonParse(out[0]).choices[0].delta.content, "hello");
  });

  it("drops [DONE] and comment keep-alives", () => {
    const buf = new SseBuffer();
    assert.deepEqual(buf.push("data: [DONE]\n\n"), []);
    assert.deepEqual(buf.push(": keep-alive\n\n"), []);
  });

  it("flushes a trailing unterminated payload", () => {
    const buf = new SseBuffer();
    assert.deepEqual(buf.push(`data: ${JSON.stringify(chunk({ content: "z" }))}`), []);
    assert.equal(buf.flush().length, 1);
  });
});