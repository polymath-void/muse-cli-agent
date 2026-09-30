/**
 * src/nodeos.ts — NodeOS readiness + daemon boot (CWD-bound, shared).
 *
 * Single owner for the `runInit({ boot })` sequence so both the
 * `muse-ts init` CLI command (src/index.ts) and the interactive TUI
 * `/init` + `/boot` slash commands (src/tui.ts) run the exact same code.
 *
 * NodeOS architecture (mandatory):
 * - Workspace resolves dynamically via process.cwd() or explicit target.
 * - agy_nodeos.db, workflow.json, daemon.log, .agents/hooks.json always
 *   attach relative to the runtime CWD. Nothing is hardcoded.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import chalk from "chalk";

export function checkBin(name: string): string | null {
  const prefix = process.env.PREFIX ?? "/data/data/com.termux/files/usr";
  const candidates = [
    path.join(prefix, "bin", name),
    `/usr/bin/${name}`,
    name,
  ];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["--version"], { stdio: "ignore" });
      if (r.status === 0 || r.error === undefined) return c;
    } catch {
      continue;
    }
    // Fallback: `command -v`.
    try {
      const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf-8" });
      if (r.status === 0 && r.stdout.trim().length > 0) return r.stdout.trim();
    } catch {
      continue;
    }
  }
  return null;
}

export async function runInit(opts: { boot?: boolean; target?: string }): Promise<void> {
  const workspace = path.resolve(opts.target ?? process.cwd());
  console.log(chalk.bold.cyan("muse-ts init — NodeOS readiness"));
  console.log(`${chalk.dim("workspace:")} ${workspace}`);
  console.log(`${chalk.dim("termux:")} ${process.env.TERMUX_VERSION ?? "(not detected)"}  ${chalk.dim("prefix:")} ${process.env.PREFIX ?? "(unset)"}`);

  for (const tool of ["python3", "node", "sqlite3", "fd", "rg", "nodeos"]) {
    const found = checkBin(tool);
    console.log(`  ${found ? chalk.green("ok ") : chalk.red("miss")} ${tool}${found ? chalk.dim(` → ${found}`) : ""}`);
  }

  // NodeOS daemon ping (CWD-bound semantics live in the daemon itself).
  try {
    const r = spawnSync("nodeos", ["-c", "ping"], { encoding: "utf-8", cwd: workspace });
    const out = (r.stdout + r.stderr).trim().split("\n")[0] ?? "";
    console.log(`${chalk.dim("nodeos:")} ${out || "(no output)"}`);
    if (/Offline/i.test(out) && opts.boot) {
      console.log(chalk.dim("booting daemon: nohup nodeos -d > daemon.log 2>&1 &"));
      const logPath = path.join(workspace, "daemon.log");
      const logFd = fs.openSync(logPath, "a");
      const child = spawn("nodeos", ["-d"], {
        cwd: workspace,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      child.unref();
      console.log(chalk.green(`daemon boot requested → ${logPath}`));
    }
  } catch (err) {
    console.log(`${chalk.dim("nodeos:")} ${chalk.red((err as Error).message)}`);
  }

  // hooks.json + workflow.json (CWD-relative).
  for (const rel of [".agents/hooks.json", "workflow.json"]) {
    const abs = path.join(workspace, rel);
    if (!fs.existsSync(abs)) {
      console.log(`  ${chalk.yellow("absent")} ${rel}`);
      continue;
    }
    try {
      JSON.parse(fs.readFileSync(abs, "utf-8"));
      console.log(`  ${chalk.green("ok ")} ${rel}`);
    } catch {
      console.log(`  ${chalk.red("bad json")} ${rel}`);
    }
  }

  // agy_nodeos.db quick probe.
  const dbPath = path.join(workspace, "agy_nodeos.db");
  if (fs.existsSync(dbPath)) {
    try {
      const r = spawnSync(
        "python3",
        [
          "-c",
          `import sqlite3; c=sqlite3.connect(${JSON.stringify(dbPath)}).cursor(); c.execute('SELECT count(*) FROM nodes'); print(c.fetchone()[0])`,
        ],
        { encoding: "utf-8" },
      );
      console.log(`${chalk.dim("graph:")} ${r.status === 0 ? `${r.stdout.trim()} nodes` : chalk.yellow("unreadable")}`);
    } catch {
      console.log(`${chalk.dim("graph:")} ${chalk.yellow("probe failed")}`);
    }
  } else {
    console.log(`${chalk.dim("graph:")} ${chalk.yellow("no agy_nodeos.db in this CWD (dynamic binding — expected outside indexed roots)")}`);
  }

  // QA analyzer smoke (best-effort, offline).
  const qaScript = path.join(os.homedir(), ".gemini", "config", "skills", "qa-analyzer", "scripts", "analyzer.py");
  if (fs.existsSync(qaScript)) {
    const r = spawnSync("python3", [qaScript, workspace], { encoding: "utf-8" });
    console.log(`${chalk.dim("qa:")} ${r.status === 0 ? chalk.green("pass") : chalk.yellow("see output")}`);
    if (r.stdout.trim()) console.log(chalk.dim(r.stdout.trim().split("\n").slice(0, 10).join("\n")));
  } else {
    console.log(`${chalk.dim("qa:")} ${chalk.yellow("analyzer not installed — skipping")}`);
  }
  console.log(chalk.green("ready."));
}
