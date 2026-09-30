/**
 * tests/tui-slash.test.mjs — durable regression coverage for the TUI fixes:
 *  1. `/boot` exists alongside `/init` (explicit boot, never automatic).
 *  2. "/" menu helpers: parse / trigger / filter (no guessing).
 *  3. Startup header stays clean (no raw workspace path dumps).
 *
 * Runs on the Node built-in test runner: `npm test` → `node --test tests/`.
 * Imports the compiled output in dist/ (run `npm run build` first).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SLASH_COMMANDS,
  parseSlashInput,
  isSlashMenuTrigger,
  filterSlashCommands,
  banner,
} from "../dist/tui.js";
import { runInit } from "../dist/nodeos.js";

const names = () => SLASH_COMMANDS.map((c) => c.name);

describe("slash command registry", () => {
  it("includes /boot for the explicit daemon boot sequence", () => {
    assert.ok(names().includes("boot"), "SLASH_COMMANDS must include boot");
    const boot = SLASH_COMMANDS.find((c) => c.name === "boot");
    assert.match(boot.description, /boot/i);
  });

  it("keeps /init as a separate briefing command", () => {
    assert.ok(names().includes("init"));
    assert.ok(names().includes("help"));
    assert.ok(names().includes("exit"));
  });

  it("shares the exact runInit path used by `muse-ts init --boot`", () => {
    assert.equal(typeof runInit, "function");
  });
});

describe("slash menu triggers", () => {
  it("parses /cmd + args", () => {
    assert.deepEqual(parseSlashInput("/boot"), { command: "boot", arg: "" });
    assert.deepEqual(parseSlashInput("/model foo"), { command: "model", arg: "foo" });
    assert.deepEqual(parseSlashInput("/EFFORT high"), { command: "effort", arg: "high" });
  });

  it("returns null for non-slash input", () => {
    assert.equal(parseSlashInput("hello"), null);
    assert.equal(parseSlashInput(""), null);
  });

  it("treats a bare / as a menu trigger, not a model prompt", () => {
    assert.equal(isSlashMenuTrigger("/"), true);
    assert.equal(isSlashMenuTrigger("/help"), false);
    assert.equal(isSlashMenuTrigger("/boot"), false);
    assert.equal(isSlashMenuTrigger("hello"), false);
  });

  it("filters commands so partial input never forces guessing", () => {
    const all = filterSlashCommands("");
    assert.equal(all.length, SLASH_COMMANDS.length);
    const bootish = filterSlashCommands("boot").map((c) => c.name);
    assert.ok(bootish.includes("boot"));
    assert.deepEqual(filterSlashCommands("no-such-command-xyz"), []);
  });
});

describe("startup header", () => {
  it("shows the project name — never the raw workspace path", () => {
    const workspace = "/data/data/com.termux/files/usr/home/myproj";
    const out = banner({
      model: "muse-spark-1.3",
      effort: "high",
      workspace,
      sessionId: "12345678-aaaa-bbbb-cccc-1234567890ab",
      approval: "on-request",
      provider: "meta",
    });
    assert.match(out, /myproj/);
    assert.doesNotMatch(out, /\/data\/data\/com\.termux/);
    assert.doesNotMatch(out, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("shortens the session id instead of dumping the full UUID", () => {
    const full = "12345678-aaaa-bbbb-cccc-1234567890ab";
    const out = banner({
      model: "m",
      effort: "high",
      workspace: "/tmp/x",
      sessionId: full,
      approval: "on-request",
      provider: "meta",
    });
    assert.match(out, /12345678/);
    assert.doesNotMatch(out, new RegExp(full.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("points at / for discovery", () => {
    const out = banner({
      model: "m",
      effort: "high",
      workspace: "/tmp/x",
      sessionId: "abcdefgh-1234",
      approval: "never",
      provider: "echo",
    });
    assert.match(out, /Type \/ for commands/);
  });
});
