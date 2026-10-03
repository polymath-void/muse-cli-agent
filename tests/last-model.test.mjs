/**
 * tests/last-model.test.mjs — regression coverage for the "remember the last
 * model" memory (`src/core/last-model.ts`).
 *
 * Rules under test:
 *  1. Round-trip: a written selection reads back identical.
 *  2. Precedence: explicit flags beat the file (resolve in the TUI, but the
 *     file itself must never hand back empty/garbage fields that outrank it).
 *  3. Robustness: missing file, corrupt JSON, unknown gateway, and a partially
 *     valid file all degrade to null / partial instead of throwing.
 *  4. Isolation: memory is CWD-bound — a different workspace sees nothing.
 *
 * Runs on the Node built-in test runner: `npm test` → `node --test tests/`.
 * Imports the compiled output in dist/ (run `npm run build` first).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  readLastModel,
  writeLastModel,
  clearLastModel,
} from "../dist/core/last-model.js";
import { lastModelPath } from "../dist/core/config.js";

let ws;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "muse-lastmodel-"));
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("last-model memory", () => {
  it("returns null when nothing was ever written", () => {
    assert.equal(readLastModel(ws), null);
  });

  it("round-trips model, gateway and effort", () => {
    writeLastModel(ws, {
      model: "gemini-3.1-pro-high",
      gatewayId: "agy",
      reasoningEffort: "low",
    });
    const got = readLastModel(ws);
    assert.equal(got.model, "gemini-3.1-pro-high");
    assert.equal(got.gatewayId, "agy");
    assert.equal(got.reasoningEffort, "low");
    assert.ok(got.updatedAt, "writes must stamp updatedAt");
  });

  it("stays CWD-bound (another workspace sees nothing)", () => {
    writeLastModel(ws, { model: "gemini-3.1-pro", gatewayId: "agy", reasoningEffort: "high" });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "muse-lastmodel-other-"));
    try {
      assert.equal(readLastModel(other), null);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("degrades to null on corrupt JSON instead of throwing", () => {
    fs.mkdirSync(path.dirname(lastModelPath(ws)), { recursive: true });
    fs.writeFileSync(lastModelPath(ws), "{not json", "utf-8");
    assert.equal(readLastModel(ws), null);
  });

  it("drops an unknown gateway but keeps the model", () => {
    writeLastModel(ws, { model: "gemini-3.1-pro", gatewayId: "not-a-gateway", reasoningEffort: "high" });
    const got = readLastModel(ws);
    assert.equal(got.model, "gemini-3.1-pro");
    assert.equal(got.gatewayId, "", "unknown gateway must not be restored");
  });

  it("refuses to overwrite a good file with an empty selection", () => {
    writeLastModel(ws, { model: "gemini-3.1-pro", gatewayId: "agy", reasoningEffort: "high" });
    writeLastModel(ws, { model: "   ", gatewayId: "", reasoningEffort: "" });
    assert.equal(readLastModel(ws).model, "gemini-3.1-pro");
  });

  it("clearLastModel forgets the selection", () => {
    writeLastModel(ws, { model: "gemini-3.1-pro", gatewayId: "agy", reasoningEffort: "high" });
    clearLastModel(ws);
    assert.equal(readLastModel(ws), null);
    clearLastModel(ws); // idempotent
  });

  it("leaves no tmp files behind (atomic rename)", () => {
    writeLastModel(ws, { model: "gemini-3.1-pro", gatewayId: "agy", reasoningEffort: "high" });
    const dir = path.dirname(lastModelPath(ws));
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});