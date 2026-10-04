/**
 * src/capabilities/nodeos.ts — Optional NodeOS integration (dynamic capability).
 *
 * NodeOS is an advanced AST-indexing daemon used in Antigravity workspaces.
 * This module auto-detects its presence and gracefully degrades when absent.
 * External users who install muse-cli via npm will never see NodeOS errors.
 *
 * Detection strategy:
 * 1. Check if `nodeos` binary exists on PATH.
 * 2. Check if CWD contains NodeOS artifacts (agy_nodeos.db, .agents/).
 * 3. Only activate NodeOS features when both conditions are met.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// Dynamic binary resolution (platform-independent)
// ---------------------------------------------------------------------------

export function findBinary(name: string): string | null {
  // Use platform-appropriate lookup — no hardcoded paths.
  try {
    const cmd = process.platform === "win32" ? "where" : "command";
    const args = process.platform === "win32" ? [name] : ["-v", name];
    const r = spawnSync(cmd, args, {
      encoding: "utf-8",
      shell: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status === 0 && r.stdout.trim().length > 0) {
      return r.stdout.trim().split("\n")[0];
    }
  } catch { /* not found */ }

  // Fallback: try running it directly (works if it's on PATH).
  try {
    const r = spawnSync(name, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return name;
  } catch { /* not found */ }

  return null;
}

// ---------------------------------------------------------------------------
// NodeOS presence detection
// ---------------------------------------------------------------------------

export interface NodeOSStatus {
  available: boolean;
  binaryPath: string | null;
  hasWorkspaceArtifacts: boolean;
  daemonOnline: boolean;
}

export function detectNodeOS(workspace?: string): NodeOSStatus {
  const cwd = path.resolve(workspace ?? process.cwd());
  const binaryPath = findBinary("nodeos");
  const hasDb = fs.existsSync(path.join(cwd, "agy_nodeos.db"));
  const hasAgents = fs.existsSync(path.join(cwd, ".agents"));
  const hasWorkspaceArtifacts = hasDb || hasAgents;

  let daemonOnline = false;
  if (binaryPath) {
    try {
      const r = spawnSync(binaryPath, ["-c", "ping"], {
        encoding: "utf-8",
        cwd,
        timeout: 3000,
      });
      const out = (r.stdout + r.stderr).trim();
      daemonOnline = /pong|alive/i.test(out);
    } catch { /* offline */ }
  }

  return { available: !!binaryPath, binaryPath, hasWorkspaceArtifacts, daemonOnline };
}

// ---------------------------------------------------------------------------
// Init command — adapts output based on what's actually installed
// ---------------------------------------------------------------------------

export async function runInit(opts: { boot?: boolean; target?: string }): Promise<void> {
  const workspace = path.resolve(opts.target ?? process.cwd());
  console.log(chalk.bold.cyan("muse-cli init — workspace readiness"));
  console.log(`${chalk.dim("workspace:")} ${workspace}`);
  console.log(`${chalk.dim("platform:")} ${process.platform}/${process.arch}  ${chalk.dim("node:")} ${process.version}`);

  // Detect Termux (informational only, not required).
  const isTermux = !!process.env.TERMUX_VERSION;
  if (isTermux) {
    console.log(`${chalk.dim("termux:")} v${process.env.TERMUX_VERSION}  ${chalk.dim("prefix:")} ${process.env.PREFIX ?? "(unset)"}`);
  }

  // Core tools check (only tools that muse-cli itself uses).
  const coreTools = ["node"];
  // Optional ecosystem tools — only check if they're relevant.
  const optionalTools: { name: string; label: string }[] = [
    { name: "python3", label: "python3 (bridge/QA)" },
    { name: "sqlite3", label: "sqlite3 (graph queries)" },
    { name: "fd", label: "fd (fast search)" },
    { name: "rg", label: "rg (ripgrep)" },
  ];

  for (const tool of coreTools) {
    const found = findBinary(tool);
    console.log(`  ${found ? chalk.green("✓") : chalk.red("✗")} ${tool}${found ? chalk.dim(` → ${found}`) : chalk.red(" (required)")}`);
  }
  for (const { name, label } of optionalTools) {
    const found = findBinary(name);
    console.log(`  ${found ? chalk.green("✓") : chalk.dim("○")} ${label}${found ? chalk.dim(` → ${found}`) : chalk.dim(" (optional)")}`);
  }

  // NodeOS — dynamic capability, not a hard dependency.
  const nodeos = detectNodeOS(workspace);
  if (nodeos.available) {
    console.log(`  ${chalk.green("✓")} nodeos${chalk.dim(` → ${nodeos.binaryPath}`)}`);

    if (nodeos.daemonOnline) {
      console.log(`${chalk.dim("daemon:")} ${chalk.green("online")}`);
    } else if (opts.boot) {
      console.log(chalk.dim("booting daemon..."));
      try {
        const logPath = path.join(workspace, "daemon.log");
        const logFd = fs.openSync(logPath, "a");
        const child = spawn(nodeos.binaryPath!, ["-d"], {
          cwd: workspace,
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
        child.unref();
        console.log(chalk.green(`daemon boot requested → ${logPath}`));
      } catch (err) {
        console.log(chalk.yellow(`daemon boot failed: ${(err as Error).message}`));
      }
    } else {
      console.log(`${chalk.dim("daemon:")} ${chalk.yellow("offline")} ${chalk.dim("(use --boot to start)")}`);
    }
  } else {
    console.log(`  ${chalk.dim("○")} nodeos ${chalk.dim("(not installed — advanced features disabled)")}`);
  }

  // Workspace artifact checks (only if NodeOS artifacts exist).
  if (nodeos.hasWorkspaceArtifacts) {
    for (const rel of [".agents/hooks.json", "workflow.json"]) {
      const abs = path.join(workspace, rel);
      if (!fs.existsSync(abs)) {
        console.log(`  ${chalk.dim("○")} ${rel} ${chalk.dim("(absent)")}`);
        continue;
      }
      try {
        JSON.parse(fs.readFileSync(abs, "utf-8"));
        console.log(`  ${chalk.green("✓")} ${rel}`);
      } catch {
        console.log(`  ${chalk.red("✗")} ${rel} ${chalk.red("(invalid JSON)")}`);
      }
    }

    // Graph DB probe.
    const dbPath = path.join(workspace, "agy_nodeos.db");
    if (fs.existsSync(dbPath)) {
      const python = findBinary("python3");
      if (python) {
        try {
          const r = spawnSync(
            python,
            ["-c", `import sqlite3; c=sqlite3.connect(${JSON.stringify(dbPath)}).cursor(); c.execute('SELECT count(*) FROM nodes'); print(c.fetchone()[0])`],
            { encoding: "utf-8", timeout: 5000 },
          );
          console.log(`${chalk.dim("graph:")} ${r.status === 0 ? `${r.stdout.trim()} nodes` : chalk.yellow("unreadable")}`);
        } catch {
          console.log(`${chalk.dim("graph:")} ${chalk.yellow("probe failed")}`);
        }
      }
    }
  }

  // QA analyzer (best-effort, only if installed).
  const qaScript = path.join(os.homedir(), ".gemini", "config", "skills", "qa-analyzer", "scripts", "analyzer.py");
  if (fs.existsSync(qaScript)) {
    const python = findBinary("python3");
    if (python) {
      const r = spawnSync(python, [qaScript, workspace], { encoding: "utf-8", timeout: 10000 });
      console.log(`${chalk.dim("qa:")} ${r.status === 0 ? chalk.green("pass") : chalk.yellow("see output")}`);
      if (r.stdout.trim()) console.log(chalk.dim(r.stdout.trim().split("\n").slice(0, 10).join("\n")));
    }
  }

  console.log(chalk.green("ready."));
}
