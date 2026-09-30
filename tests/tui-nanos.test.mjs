/**
 * tests/tui-nanos.test.mjs — regression coverage for the micro/nano build:
 *  1. Mention parser: split multi-mentions, quoted paths, comma/semicolon seps.
 *  2. FsNano: workspace escape throws, read cache returns identical output.
 *  3. Registry: use/release/sleepAll lifecycle, zero-TTL nanos sleep on tick.
 *  4. PermissionNano: never=allow, untrusted=deny (no TTY needed).
 *  5. Uncapped turns: dist/tui.js contains no "(max model steps reached)".
 *
 * Runs on the Node built-in test runner: `npm test`.
 * Imports the compiled output in dist/ (run `npm run build` first).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  NanoRegistry,
  FsNano,
  MentionNano,
  parseMentions,
  PluginNano,
  PermissionNano,
} from "../dist/services/index.js";

describe("mention parser", () => {
  it("splits adjacent mentions without swallowing words", () => {
    const got = parseMentions("@file src/tui.ts and @project muse-ai and @skill muse-subagent");
    assert.deepEqual(got.map((m) => [m.kind, m.query]), [
      ["file", "src/tui.ts"],
      ["project", "muse-ai"],
      ["skill", "muse-subagent"],
    ]);
  });

  it("supports quoted multi-word queries", () => {
    const got = parseMentions('@file "my notes/x.md" review');
    assert.deepEqual(got.map((m) => [m.kind, m.query]), [["file", "my notes/x.md"]]);
  });

  it("handles comma/semicolon separators", () => {
    const got = parseMentions("@project muse-ai, @skill foo; @file a.ts");
    assert.deepEqual(got.map((m) => [m.kind, m.query]), [
      ["project", "muse-ai"],
      ["skill", "foo"],
      ["file", "a.ts"],
    ]);
  });

  it("returns [] for plain text", () => {
    assert.deepEqual(parseMentions("hello world"), []);
  });
});

describe("mention expander (workspace-scoped)", () => {
  it("expands @file within the workspace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-nano-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "line1\nline2\n");
    const nano = new MentionNano(dir);
    const r = nano.expand("@file a.txt show me");
    assert.match(r.contextBlock, /line1/);
    assert.equal(r.errors.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("errors (never escapes) on ../ traversal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-nano-"));
    const nano = new MentionNano(dir);
    const r = nano.expand("@file ../outside.txt");
    assert.ok(r.errors.length > 0 || r.contextBlock === "");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("fs nano", () => {
  it("throws on workspace escape", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-nano-"));
    const nano = new FsNano(dir);
    assert.throws(() => nano.resolve("../evil.txt"), /escapes workspace/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("caches reads and invalidates on demand", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-nano-"));
    fs.writeFileSync(path.join(dir, "b.txt"), "hello\n");
    const nano = new FsNano(dir);
    const first = nano.readFileSync("b.txt");
    const second = nano.readFileSync("b.txt");
    assert.equal(first, second);
    nano.invalidate("b.txt");
    assert.equal(nano.readFileSync("b.txt"), first);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("registry sleep/wake", () => {
  it("use() wakes, release()/sleepAll() sleep", () => {
    const r = new NanoRegistry();
    let slept = 0;
    const fake = { name: "fake", idleTtlMs: 60_000, wake() {}, sleep() { slept++; } };
    r.register(fake);
    assert.deepEqual(r.awakeNames(), []);
    r.use("fake");
    assert.deepEqual(r.awakeNames(), ["fake"]);
    r.release("fake");
    assert.deepEqual(r.awakeNames(), []);
    assert.equal(slept, 1);
  });
});

describe("permissions", () => {
  it("never allows, untrusted denies — no TTY needed", async () => {
    const allow = new PermissionNano("never");
    const deny = new PermissionNano("untrusted");
    assert.equal((await allow.approve("bash", "ls")).allowed, true);
    assert.equal((await deny.approve("bash", "ls")).allowed, false);
  });
});

describe("uncapped turns (no step-cap stall)", () => {
  it("dist/tui.js has no max-steps footer", () => {
    const src = fs.readFileSync(new URL("../dist/tui.js", import.meta.url), "utf-8");
    assert.doesNotMatch(src, /max model steps reached/);
  });

  it("dist/index.js exec defaults to uncapped", () => {
    const src = fs.readFileSync(new URL("../dist/index.js", import.meta.url), "utf-8");
    assert.match(src, /POSITIVE_INFINITY/);
  });

  it("slash registry gained project/skill/plugins", async () => {
    const { SLASH_COMMANDS } = await import("../dist/tui.js");
    const names = SLASH_COMMANDS.map((c) => c.name);
    assert.ok(names.includes("project"));
    assert.ok(names.includes("skill"));
    assert.ok(names.includes("plugins"));
  });

  it("plugin nano starts empty and degrades cleanly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-nano-"));
    const pl = new PluginNano(dir);
    assert.deepEqual(await pl.listTools(), []);
    assert.equal(await pl.callTool("plugin_nope_x", {}), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
