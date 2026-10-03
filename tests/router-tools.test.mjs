/**
 * tests/router-tools.test.mjs — regression coverage for Gemini↔OpenAI tool
 * translation in `src/microservices/connector/router.ts`.
 *
 * Why this matters: the router is the only layer that knows Antigravity's
 * Gemini wire format, and three silent failures used to make the agent look
 * "unaware" of execution while everything returned HTTP 200:
 *   1. `tools` were never forwarded  → the model never saw the catalog.
 *   2. `functionCall` parts were dropped → empty message, no action taken.
 *   3. replayed tool turns lost `thoughtSignature` → backend 400.
 *
 * The methods under test are TypeScript-`private`, which erases at runtime —
 * the compiled JS in dist/ calls them directly. `buildRequestBody` is the same
 * internal that `route()` uses, so these assertions cover the real payload.
 *
 * Runs on the Node built-in test runner: `npm test` → `node --test tests/`.
 * Imports the compiled output in dist/ (run `npm run build` first).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { UnifiedRouter } from "../dist/microservices/connector/router.js";

const router = new UnifiedRouter();
const bodies = (messages, tools) =>
  router.buildRequestBody("agy", "gemini-3.1-pro-high", { messages, tools }, false);

const openAiTool = {
  type: "function",
  function: {
    name: "bash",
    description: "run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

describe("google body: tool catalog forwarding", () => {
  it("omits tools entirely when none were attached", () => {
    const req = bodies([{ role: "user", content: "hi" }]);
    assert.equal(req.request.tools, undefined);
    assert.deepEqual(req.request.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("converts OpenAI tools into Gemini functionDeclarations", () => {
    const req = bodies([{ role: "user", content: "hi" }], [openAiTool]);
    const decls = req.request.tools?.[0]?.functionDeclarations;
    assert.equal(decls?.length, 1);
    assert.equal(decls[0].name, "bash");
    assert.equal(decls[0].description, "run a shell command");
    assert.deepEqual(decls[0].parameters.properties.command.type, "string");
  });

  it("strips JSON-Schema keywords Gemini rejects", () => {
    const req = bodies([{ role: "user", content: "hi" }], [openAiTool]);
    const params = req.request.tools[0].functionDeclarations[0].parameters;
    assert.equal(params.additionalProperties, undefined);
    assert.equal(params.$schema, undefined);
  });

  it("collapses nullable type unions to a single type", () => {
    const req = bodies([{ role: "user", content: "hi" }], [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: {
            type: "object",
            properties: { limit: { type: ["number", "null"] } },
          },
        },
      },
    ]);
    const params = req.request.tools[0].functionDeclarations[0].parameters;
    assert.equal(params.properties.limit.type, "number");
  });

  it("skips malformed tool entries instead of emitting a broken declaration", () => {
    const req = bodies([{ role: "user", content: "hi" }], [
      { type: "function" },
      { type: "function", function: { name: "" } },
      openAiTool,
    ]);
    const decls = req.request.tools[0].functionDeclarations;
    assert.equal(decls.length, 1);
    assert.equal(decls[0].name, "bash");
  });
});

describe("google body: tool-turn replay", () => {
  it("emits functionCall parts for assistant tool_calls", () => {
    const req = bodies([
      { role: "user", content: "make it" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_x", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
    ]);
    const modelTurn = req.request.contents[1];
    assert.equal(modelTurn.role, "model");
    assert.deepEqual(modelTurn.parts, [{ functionCall: { name: "bash", args: { command: "ls" } } }]);
  });

  it("emits functionResponse parts and recovers the name from the call id", () => {
    const req = bodies([
      { role: "user", content: "make it" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_x", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_x", content: "a.txt" },
    ]);
    const respTurn = req.request.contents[2];
    assert.equal(respTurn.role, "user");
    assert.equal(respTurn.parts[0].functionResponse.name, "bash");
    assert.equal(respTurn.parts[0].functionResponse.response.result, "a.txt");
  });

  it("preserves unparsable tool arguments instead of dropping the call", () => {
    const req = bodies([
      { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: "{not json" } }] },
    ]);
    assert.equal(req.request.contents[0].parts[0].functionCall.args._unparsed, "{not json");
  });
});

describe("google normalizer: functionCall → tool_calls", () => {
  it("maps a functionCall part onto an OpenAI tool_call", () => {
    const out = router.normalizeNonStream("agy", {
      candidates: [
        { content: { parts: [{ functionCall: { name: "bash", args: { command: "pwd" } }, thoughtSignature: "SIG-abc" }] } },
      ],
    });
    const choice = out.choices[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.content, "");
    assert.equal(choice.message.tool_calls.length, 1);
    assert.equal(choice.message.tool_calls[0].function.name, "bash");
    assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { command: "pwd" });
  });

  it("round-trips the thoughtSignature through the call id", () => {
    const out = router.normalizeNonStream("agy", {
      candidates: [{ content: { parts: [{ functionCall: { name: "bash", args: {} }, thoughtSignature: "SIG-round-trip" }] } }],
    });
    const call = out.choices[0].message.tool_calls[0];
    const req = bodies([
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "ok" },
    ]);
    // Without the signature echoed back, Antigravity answers 400
    // "Function call is missing a thought_signature".
    assert.equal(req.request.contents[0].parts[0].thoughtSignature, "SIG-round-trip");
    assert.equal(req.request.contents[1].parts[0].thoughtSignature, "SIG-round-trip");
  });

  it("omits thoughtSignature when the model sent none", () => {
    const out = router.normalizeNonStream("agy", {
      candidates: [{ content: { parts: [{ functionCall: { name: "bash", args: {} } }] } }],
    });
    const call = out.choices[0].message.tool_calls[0];
    const req = bodies([{ role: "assistant", content: "", tool_calls: [call] }]);
    assert.equal(req.request.contents[0].parts[0].thoughtSignature, undefined);
  });

  it("keeps text and thought separation while carrying calls", () => {
    const out = router.normalizeNonStream("agy", {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "internal" },
              { text: "running it" },
              { functionCall: { name: "bash", args: { command: "ls" } }, thoughtSignature: "s" },
            ],
          },
        },
      ],
    });
    const choice = out.choices[0];
    assert.equal(choice.message.content, "running it");
    assert.equal(choice.message.tool_calls.length, 1);
    assert.equal(choice.finish_reason, "tool_calls");
  });

  it("stays a plain stop when there are no calls", () => {
    const out = router.normalizeNonStream("agy", {
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
    });
    assert.equal(out.choices[0].finish_reason, "stop");
    assert.equal(out.choices[0].message.tool_calls, undefined);
  });
});

describe("stream normalizer: functionCall chunks", () => {
  const ssePayloads = [
    { response: { candidates: [{ content: { parts: [{ text: "working" }] } }] } },
    { response: { candidates: [{ content: { parts: [{ functionCall: { name: "bash", args: { command: "ls" } }, thoughtSignature: "SIG-s" }] } }] } },
  ];
  const sseBody = ssePayloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("");

  it("emits delta.content and delta.tool_calls plus a tool_calls finish", async () => {
    const upstream = new Response(sseBody, {
      headers: { "Content-Type": "text/event-stream" },
    });
    const res = router.normalizeStream("agy", upstream);
    const raw = await res.text();
    const chunks = raw
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)));
    const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    assert.equal(content, "working");
    const callChunk = chunks.find((c) => c.choices[0].delta.tool_calls);
    assert.equal(callChunk.choices[0].delta.tool_calls[0].function.name, "bash");
    assert.equal(callChunk.choices[0].delta.tool_calls[0].index, 0);
    assert.match(callChunk.choices[0].delta.tool_calls[0].id, /__sig_/);
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
    assert.ok(raw.includes("data: [DONE]"));
  });

  it("passes non-gemini gateways through untouched", async () => {
    const upstream = new Response('data: {"choices":[{"delta":{"content":"x"}}]}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
    const res = router.normalizeStream("opencode", upstream);
    assert.equal(res.headers.get("Content-Type"), "text/event-stream");
    assert.ok((await res.text()).includes('"content":"x"'));
  });
});