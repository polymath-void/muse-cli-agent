import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { CronExpressionParser } from 'cron-parser';

export interface Job {
  id: string;
  cron: string;
  prompt: string;
  createdAt: number;
  lastRun?: number;
  enabled: boolean;
}

const MUSE_DIR = path.join(os.homedir(), '.muse');
const SCHEDULE_DIR = path.join(MUSE_DIR, 'schedule');
const JOBS_FILE = path.join(SCHEDULE_DIR, 'jobs.json');

async function ensureDir(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // ignore
  }
}

export async function loadJobs(): Promise<Job[]> {
  try {
    const data = await fs.readFile(JOBS_FILE, 'utf-8');
    return JSON.parse(data) as Job[];
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return [];
    }
    throw e;
  }
}

export async function saveJobs(jobs: Job[]): Promise<void> {
  await ensureDir(SCHEDULE_DIR);
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf-8');
}

export function validateCron(cronExpression: string): boolean {
  try {
    CronExpressionParser.parse(cronExpression);
    return true;
  } catch (e) {
    return false;
  }
}

export function getNextRun(cronExpression: string, lastRun?: number): number {
  const options = lastRun ? { currentDate: new Date(lastRun) } : {};
  const interval = new CronExpressionParser(cronExpression, options);
  return interval.next().getTime();
}
