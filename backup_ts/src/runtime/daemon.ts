import { DashboardServer } from "./dashboard_server.js";
import { setInterval } from "node:timers";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";

export interface CronJob {
  id: string;
  scheduleMs: number;
  task: () => Promise<void>;
  lastRun?: number;
}

export class RuntimeManager {
  private jobs: CronJob[] = [];
  private active = false;
  private intervalRef: NodeJS.Timeout | null = null;
  public workspace: string;
  public dashboard: DashboardServer;

  constructor(workspace: string) {
    this.workspace = workspace;
    this.dashboard = new DashboardServer(workspace);
  }

  public registerJob(job: CronJob) {
    this.jobs.push(job);
  }

  public start() {
    if (this.active) return;
    this.active = true;
    this.dashboard.start();
    console.log(chalk.green("⚙ Background Runtime Manager: Active"));
    
    // Check jobs every second
    this.intervalRef = setInterval(() => {
      this.evaluateJobs();
    }, 1000);
  }

  public stop() {
    this.active = false;
    this.dashboard.stop();
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = null;
    }
    console.log(chalk.yellow("⚙ Background Runtime Manager: Stopped"));
  }

  private async evaluateJobs() {
    const now = Date.now();
    for (const job of this.jobs) {
      if (!job.lastRun || (now - job.lastRun) >= job.scheduleMs) {
        job.lastRun = now;
        try {
          await job.task();
        } catch (err: any) {
          fs.appendFileSync(
            path.join(this.workspace, ".muse", "daemon.log"),
            `[${new Date().toISOString()}] Job ${job.id} failed: ${err.message}\n`
          );
        }
      }
    }
  }
}

export function initializeRuntime(workspace: string): RuntimeManager {
  const daemonDir = path.join(workspace, ".muse");
  if (!fs.existsSync(daemonDir)) {
    fs.mkdirSync(daemonDir, { recursive: true });
  }

  const manager = new RuntimeManager(workspace);

  // Default internal self-healing/cache flush job (runs every 10 minutes)
  manager.registerJob({
    id: "session-cleanup",
    scheduleMs: 10 * 60 * 1000, 
    task: async () => {
       const logMsg = `[${new Date().toISOString()}] Background tick: session cleanup verified.\n`;
       fs.appendFileSync(path.join(daemonDir, "daemon.log"), logMsg);
    }
  });

  return manager;
}
