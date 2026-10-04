import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { loadJobs, saveJobs, Job, getNextRun, validateCron } from './store.js';
import { logRun } from './monitor.js';
import { randomUUID } from 'crypto';

const MUSE_DIR = path.join(os.homedir(), '.muse');
const SCHEDULE_DIR = path.join(MUSE_DIR, 'schedule');
const LOCK_FILE = path.join(SCHEDULE_DIR, 'jobs.lock');

async function acquireLock(): Promise<boolean> {
  try {
    await fs.mkdir(SCHEDULE_DIR, { recursive: true });
    // Attempt to open the lockfile with wx flag (fail if exists)
    const file = await fs.open(LOCK_FILE, 'wx');
    await file.close();
    return true;
  } catch (e) {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(LOCK_FILE);
  } catch (e) {
    // ignore
  }
}

export async function addJob(cron: string, prompt: string): Promise<Job> {
  if (!validateCron(cron)) {
    throw new Error(`Invalid cron expression: ${cron}`);
  }
  
  const jobs = await loadJobs();
  const job: Job = {
    id: randomUUID(),
    cron,
    prompt,
    createdAt: Date.now(),
    enabled: true
  };
  jobs.push(job);
  await saveJobs(jobs);
  return job;
}

export async function removeJob(id: string): Promise<boolean> {
  const jobs = await loadJobs();
  const filtered = jobs.filter((j: Job) => j.id !== id);
  if (filtered.length === jobs.length) {
    return false;
  }
  await saveJobs(filtered);
  return true;
}

export async function listJobs(): Promise<Job[]> {
  return await loadJobs();
}

export async function runPendingJobs(executePrompt: (prompt: string) => Promise<string>): Promise<void> {
  if (!(await acquireLock())) {
    return; // Already running or locked
  }
  
  try {
    const jobs = await loadJobs();
    const now = Date.now();
    let jobsUpdated = false;

    for (const job of jobs) {
      if (!job.enabled) continue;
      
      let shouldRun = false;
      if (!job.lastRun) {
        shouldRun = true;
      } else {
        const nextRun = getNextRun(job.cron, job.lastRun);
        if (now >= nextRun) {
          shouldRun = true;
        }
      }

      if (shouldRun) {
        try {
          await logRun(job.id, 'STARTED', `Prompt: ${job.prompt}`);
          const output = await executePrompt(job.prompt);
          await logRun(job.id, 'SUCCESS', output);
        } catch (e: any) {
          await logRun(job.id, 'ERROR', e.message);
        } finally {
          job.lastRun = now;
          jobsUpdated = true;
        }
      }
    }

    if (jobsUpdated) {
      await saveJobs(jobs);
    }
  } finally {
    await releaseLock();
  }
}
