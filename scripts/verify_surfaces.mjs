import assert from "node:assert/strict";

const dist = new URL("../dist/", import.meta.url);
const { UnifiedRouter, zenSurfaceFor } = await import(new URL("microservices/connector/router.js", dist).href);
const tui = await import(new URL("tui.js", dist).href);

// --- surface map (docs table) ---
assert.equal(zenSurfaceFor("muse-spark-1.3"), "responses");
assert.equal(zenSurfaceFor("muse-spark-1.3-contributor-free"), "responses");
assert.equal(zenSurfaceFor("gpt-5.5"), "responses");
assert.equal(zenSurfaceFor("grok-4.7"), "responses");
assert.equal(zenSurfaceFor("claude-sonnet-4-6"), "anthropic");
assert.equal(zenSurfaceFor("qwen3.8-flash"), "anthropic");
assert.equal(zenSurfaceFor("gemini-3-flash"), "google");
assert.equal(zenSurfaceFor("gemini-3.1-pro"), "google");
assert.equal(zenSurfaceFor("big-pickle"), "chat");
assert.equal(zenSurfaceFor("deepseek-v4-flash-free"), "chat");
assert.equal(zenSurfaceFor("qwen3.8-max"), "chat");
assert.equal(zenSurfaceFor("jev-1.13"), "systemone");
assert.equal(zenSurfaceFor("opencode/muse-spark-1.3"), "responses");
console.log("ok surface map");

const realFetch = globalThis.fetch;
const seen = [];
const sse = (chunks) => new Response(
  new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); } }),
  { status: 200, headers: { "Content-Type": "text/event-stream" } },
);
const router = new UnifiedRouter();
const cfg = { opencode: { api_key: "sk-test" } };
const msgs = [
  { role: "system", content: "sys prompt" },
  { role: "user", content: "hi" },
];

// --- anthropic non-stream: headers, endpoint, body, normalization ---
globalThis.fetch = async (url, init) => {
  seen.push({ url, body: JSON.parse(init.body), h: init.headers });
  return new Response(JSON.stringify({
    id: "msg_1", stop_reason: "tool_use",
    content: [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "tu1", name: "read_file", input: { path: "a.ts" } },
    ],
  }), { status: 200 });
};
const out = await router.route("opencode", "claude-sonnet-4-6",
  { model: "x", messages: msgs, tools: [{ type: "function", function: { name: "read_file", description: "r", parameters: { type: "object" } } }] },
  false, cfg);
assert.equal(seen[0].url, "https://opencode.ai/zen/v1/messages");
assert.equal(seen[0].h["x-api-key"], "sk-test");
assert.equal(seen[0].h.Authorization, "Bearer sk-test");
assert.ok(String(seen[0].h["User-Agent"]).startsWith("opencode/"));
assert.equal(seen[0].body.model, "claude-sonnet-4-6");
assert.equal(seen[0].body.max_tokens, 8192);
assert.equal(seen[0].body.system, "sys prompt");
assert.equal(seen[0].body.messages.length, 1);
assert.equal(seen[0].body.tools[0].input_schema.type, "object");
assert.equal(out.choices[0].message.content, "hello");
assert.equal(out.choices[0].message.tool_calls[0].function.name, "read_file");
assert.equal(JSON.parse(out.choices[0].message.tool_calls[0].function.arguments).path, "a.ts");
console.log("ok anthropic round-trip");

// --- google non-stream: endpoint + body + normalization ---
seen.length = 0;
globalThis.fetch = async (url, init) => {
  seen.push({ url, body: JSON.parse(init.body), h: init.headers });
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "yo" }] }, finishReason: "STOP" }],
  }), { status: 200 });
};
const gout = await router.route("opencode", "gemini-3-flash", { model: "x", messages: msgs }, false, cfg);
assert.equal(seen[0].url, "https://opencode.ai/zen/v1/models/gemini-3-flash:generateContent");
assert.equal(seen[0].h["x-goog-api-key"], "sk-test");
assert.equal(seen[0].body.systemInstruction.parts[0].text, "sys prompt");
assert.equal(seen[0].body.contents[0].role, "user");
assert.equal(gout.choices[0].message.content, "yo");
console.log("ok google round-trip");

// --- google stream endpoint suffix ---
seen.length = 0;
globalThis.fetch = async (url, init) => { seen.push({ url }); return sse(['data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n']); };
const gres = await router.route("opencode", "gemini-3-flash", { model: "x", messages: msgs }, true, cfg);
assert.ok(gres instanceof Response);
assert.match(seen[0].url, /:streamGenerateContent\?alt=sse$/);
const gtext = await gres.text();
assert.match(gtext, /"content":"hi"/);
assert.match(gtext, /\[DONE\]/);
console.log("ok google stream normalize");

// --- responses stream: output_text.delta -> openai delta ---
globalThis.fetch = async () => sse([
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n',
]);
const rres = await router.route("opencode", "muse-spark-1.3", { model: "x", messages: msgs }, true, cfg);
assert.ok(rres instanceof Response);
const rtext = await rres.text();
assert.match(rtext, /"content":"Hello"/);
console.log("ok responses stream normalize");

// --- anthropic stream: content_block_delta -> openai delta + tool_use ---
globalThis.fetch = async () => sse([
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hey"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu9","name":"bash"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":\\"ls\\"}"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]);
const ares = await router.route("opencode", "claude-sonnet-4-6", { model: "x", messages: msgs }, true, cfg);
const atext = await ares.text();
assert.match(atext, /"content":"Hey"/);
assert.match(atext, /"tool_calls":\[{"id":"tu9"[^\]]*"name":"bash"/);
assert.match(atext, /ls/);
console.log("ok anthropic stream normalize");

// --- chatOnce via client on anthropic surface (end-to-end shape) ---
globalThis.fetch = async () => new Response(JSON.stringify({
  content: [{ type: "text", text: "done" }], stop_reason: "end_turn",
}), { status: 200 });
const client = new tui.UnifiedChatClient({ token: "sk-test", model: "claude-sonnet-4-6", gatewayId: "opencode" });
const one = await client.chatOnce([{ role: "user", content: "hi" }], []);
assert.equal(one.content, "done");
console.log("ok client chatOnce anthropic");

// --- systemone rejected with clear error ---
let threw = "";
try {
  await router.route("opencode", "jev-1.13", { model: "x", messages: msgs }, false, cfg);
} catch (e) { threw = e.message; }
assert.match(threw, /not a chat model/);
console.log("ok systemone guard");

// --- 401/403 hints ---
globalThis.fetch = async () => new Response('{"type":"error"}', { status: 401 });
threw = "";
try { await router.route("opencode", "big-pickle", { model: "x", messages: [] }, false, cfg); }
catch (e) { threw = e.message; }
assert.match(threw, /auth set --provider opencode/);
globalThis.fetch = async () => new Response('{"type":"error"}', { status: 403 });
threw = "";
try { await router.route("opencode", "big-pickle", { model: "x", messages: [] }, false, cfg); }
catch (e) { threw = e.message; }
assert.match(threw, /free tier is gated/);
console.log("ok error hints");

globalThis.fetch = realFetch;
console.log("ALL SURFACE VERIFY PASS");
