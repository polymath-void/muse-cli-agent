import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dist = new URL("../dist/", import.meta.url);
const { UnifiedRouter } = await import(new URL("microservices/connector/router.js", dist).href);
const tui = await import(new URL("tui.js", dist).href);
const auth = await import(new URL("auth.js", dist).href);

// 1. gateway inference
assert.equal(tui.gatewayForModel("opencode/muse-spark-1.3-contributor-free"), "opencode");
assert.equal(tui.gatewayForModel("muse-spark-1.3"), "opencode");
assert.equal(tui.gatewayForModel("gemini-2.5-flash"), "google");
assert.equal(tui.gatewayForModel("claude-sonnet-4-6"), "agy");
assert.ok(tui.modelsForGateway("opencode").length >= 7);
assert.ok(tui.modelsForGateway("google").length >= 4);
console.log("ok gateway inference");

// 2. per-provider credential resolution (isolated temp auth file)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "muse-auth-"));
const authPath = path.join(tmp, "auth.json");
auth.saveAuthFile({ schema_version: 1, providers: {
  opencode: { api_key: "oc-key", api_base_url: "https://opencode.ai/zen/v1" },
  google: { access_token: "g-tok" },
} }, authPath);
delete process.env.OPENCODE_API_KEY; delete process.env.GOOGLE_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.META_API_KEY;
assert.equal(auth.resolveCredential(authPath, "opencode")?.token, "oc-key");
assert.equal(auth.resolveCredential(authPath, "opencode")?.baseUrl, "https://opencode.ai/zen/v1");
assert.equal(auth.resolveCredential(authPath, "google")?.token, "g-tok");
assert.equal(auth.resolveCredential(authPath, "google")?.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
assert.equal(auth.resolveCredential(authPath, "meta"), null);
assert.deepEqual(auth.listLoggedInProviders(authPath).sort(), ["agy", "google", "opencode"]);
process.env.OPENCODE_API_KEY = "env-oc";
assert.equal(auth.resolveCredential(authPath, "opencode")?.token, "env-oc");
delete process.env.OPENCODE_API_KEY;
console.log("ok credential resolution");

// 3. router: opencode prefix strip + chat/completions endpoint + auth header
const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  seen.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
  // responses surface shape (muse-spark lives on /responses)
  return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] }), { status: 200 });
};
const router = new UnifiedRouter();
const out = await router.route("opencode", "opencode/muse-spark-1.3-contributor-free",
  { model: "x", messages: [{ role: "user", content: "hi" }] }, false,
  { opencode: { api_key: "oc-key" } });
assert.equal(out.choices[0].message.content, "hi");
assert.equal(seen[0].url, "https://opencode.ai/zen/v1/responses");
assert.equal(seen[0].body.model, "muse-spark-1.3-contributor-free");
assert.equal(seen[0].auth, "Bearer oc-key");
console.log("ok router opencode responses route");

// 4. router: Gemini contents -> messages conversion for chat models
seen.length = 0;
await router.route("opencode", "opencode/big-pickle",
  { model: "x", contents: [{ role: "model", parts: [{ text: "a" }] }, { role: "user", parts: [{ text: "b" }] }] },
  false, { opencode: { api_key: "k" } });
assert.equal(seen[0].url, "https://opencode.ai/zen/v1/chat/completions");
assert.deepEqual(seen[0].body.messages, [
  { role: "assistant", content: "a" },
  { role: "user", content: "b" },
]);
assert.ok(!("contents" in seen[0].body));
console.log("ok router gemini->openai conversion");

// 5. router: muse-spark contents -> input (responses API)
seen.length = 0;
await router.route("opencode", "muse-spark-1.3",
  { model: "x", contents: [{ role: "user", parts: [{ text: "hello" }] }] },
  false, { opencode: { access_token: "tok123" } });
assert.equal(seen[0].body.input, "hello");
assert.equal(seen[0].auth, "Bearer tok123");
console.log("ok router responses-api input");

// 6. router: caller's body is not mutated
const caller = { model: "orig", messages: [] };
await router.route("opencode", "opencode/big-pickle", caller, false, { opencode: { api_key: "k" } });
assert.equal(caller.model, "orig");
console.log("ok router no-mutation");

// 7. router: empty credential -> throws meaningful error (never undefined)
let threw = "";
try {
  await router.route("opencode", "opencode/big-pickle", { model: "x", messages: [] }, false, { opencode: {} });
} catch (e) { threw = e.message; }
assert.match(threw, /no credential for provider "opencode"/);
console.log("ok router empty-credential error");

// 8. router: all-fail (500s) throws instead of returning undefined
globalThis.fetch = async () => new Response("boom", { status: 500 });
threw = "";
try {
  await router.route("opencode", "opencode/big-pickle", { model: "x", messages: [] }, false, { opencode: { api_key: "k" } });
} catch (e) { threw = e.message; }
assert.match(threw, /HTTP 500/);
console.log("ok router all-fail throws");
globalThis.fetch = realFetch;

// 9. banner accepts gateway
const b = tui.banner({ model: "m", effort: "high", workspace: "/tmp/x", sessionId: "abcdefgh-1234", approval: "never", provider: "meta", gateway: "opencode" });
assert.match(b, /opencode/);
console.log("ok banner gateway");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL VERIFY PASS");
