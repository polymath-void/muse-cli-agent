import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { renderAssistant } from "../tui.js";

export async function watchCommand(target?: string) {
  let workspace = process.cwd();
  let sessionId: string | undefined;

  if (target) {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      workspace = path.resolve(target);
    } else {
      sessionId = target;
    }
  }

  const cleanups: Array<() => void> = [];
  const cleanupAll = () => {
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // ignore cleanup errors
      }
    }
  };

  // Ensure watchers don't keep the process alive after Ctrl+C / kill.
  // Use `once` so we don't leak process listeners on repeated calls.
  process.once("SIGINT", () => {
    cleanupAll();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanupAll();
    process.exit(0);
  });
  process.once("SIGQUIT", () => {
    cleanupAll();
    process.exit(0);
  });
  process.once("exit", () => {
    cleanupAll();
  });

  if (sessionId) {
    const sessionFile = findSessionFile(workspace, sessionId);
    if (!sessionFile) {
      console.error(chalk.red(`Session ${sessionId} not found in ${workspace}`));
      process.exitCode = 1;
      cleanupAll();
      return;
    }
    console.log(chalk.cyan(`Watching session: ${sessionId}`));
    cleanups.push(tailLogFile(sessionFile, parseSessionLine));
  } else {
    const daemonLog = path.join(workspace, "daemon.log");
    const workflowJson = path.join(workspace, "workflow.json");

    console.log(chalk.cyan(`Watching daemon in workspace: ${workspace}`));

    if (fs.existsSync(daemonLog)) {
      cleanups.push(tailLogFile(daemonLog, (line) => console.log(chalk.dim("[daemon] ") + line)));
    } else {
      console.log(chalk.yellow(`daemon.log not found in ${workspace}`));
    }

    if (fs.existsSync(workflowJson)) {
      let lastStatus = "";
      cleanups.push(
        watchJsonFile(workflowJson, (json) => {
          if (json && json.status && json.status !== lastStatus) {
            lastStatus = json.status;
            let statusColor = chalk.white;
            if (json.status === "pending") statusColor = chalk.yellow;
            if (json.status === "running") statusColor = chalk.blue;
            if (json.status === "completed") statusColor = chalk.green;
            console.log(chalk.magenta("[workflow] ") + statusColor(`Intent: ${json.intent || "Unknown"} - Status: ${json.status}`));
          }
        })
      );
    } else {
      console.log(chalk.yellow(`workflow.json not found in ${workspace}`));
    }
  }

  // No `return new Promise(() => {})` here: the returned FSWatcher
  // handles keep the event loop alive, and `unref()` + cleanup above
  // lets the process exit cleanly instead of leaving zombie handles.
}

function findSessionFile(workspace: string, sessionId: string): string | null {
  const sessionsDir = path.join(workspace, ".muse", "sessions");
  if (!fs.existsSync(sessionsDir)) return null;

  let found: string | null = null;
  function search(dir: string) {
    if (found) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === sessionId) {
          const sFile = path.join(fullPath, "session.jsonl");
          if (fs.existsSync(sFile)) {
            found = sFile;
          }
        } else {
          search(fullPath);
        }
      }
    }
  }
  search(sessionsDir);
  return found;
}

function tailLogFile(filePath: string, onLine: (line: string) => void): () => void {
  let lastSize = 0;
  if (fs.existsSync(filePath)) {
    lastSize = fs.statSync(filePath).size;
  }

  let buffer = "";
  let closed = false;
  function readDelta() {
    if (closed) return;
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size > lastSize) {
      const stream = fs.createReadStream(filePath, { start: lastSize, end: stat.size - 1, encoding: "utf-8" });
      stream.on("data", (chunk) => {
        buffer += chunk;
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (line.trim()) {
            onLine(line);
          }
        }
      });
      stream.on("error", () => {
        // ignore transient read errors (rotation, truncation)
      });
      lastSize = stat.size;
    } else if (stat.size < lastSize) {
      // file truncated
      lastSize = stat.size;
    }
  }

  // Single watcher only (previously both fs.watch + fs.watchFile leaked).
  // unref() so the watcher alone never becomes a zombie handle.
  const watcher = fs.watch(path.dirname(filePath), (eventType, filename) => {
    if (filename === path.basename(filePath)) {
      readDelta();
    }
  });
  if (typeof (watcher as any).unref === "function") {
    (watcher as any).unref();
  }

  return () => {
    closed = true;
    try {
      watcher.close();
    } catch {
      // already closed
    }
  };
}

function watchJsonFile(filePath: string, onParse: (json: any) => void): () => void {
  let closed = false;
  function readFull() {
    if (closed) return;
    if (!fs.existsSync(filePath)) return;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      if (content.trim()) {
        onParse(JSON.parse(content));
      }
    } catch (e) {
      // skip invalid/partial JSON
    }
  }

  readFull();

  // Single watcher only (previously both fs.watch + fs.watchFile leaked).
  const watcher = fs.watch(path.dirname(filePath), (eventType, filename) => {
    if (filename === path.basename(filePath)) {
      readFull();
    }
  });
  if (typeof (watcher as any).unref === "function") {
    (watcher as any).unref();
  }

  return () => {
    closed = true;
    try {
      watcher.close();
    } catch {
      // already closed
    }
  };
}

function parseSessionLine(line: string) {
  try {
    const json = JSON.parse(line);
    if (json.type === "tool_call" || json.tool) {
      console.log(chalk.yellow(`[Tool] ${json.tool || json.name || "unknown"} (${JSON.stringify(json.args || json.arguments || {})})`));
    } else if (json.type === "reasoning" || (json.role === "assistant" && json.content)) {
      console.log(chalk.cyan(`[Reasoning]\n${renderAssistant(json.content)}`));
    } else if (json.type === "result" || json.role === "tool") {
      console.log(chalk.green(`[Result]\n${json.content || json.result || ""}`));
    } else if (json.message || json.msg) {
      console.log(chalk.white(json.message || json.msg));
    } else {
      console.log(chalk.dim(line));
    }
  } catch (e) {
    console.log(chalk.dim(line));
  }
}
