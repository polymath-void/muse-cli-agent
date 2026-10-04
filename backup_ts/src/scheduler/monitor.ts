import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const MUSE_DIR = path.join(os.homedir(), '.muse');
const RUNS_DIR = path.join(MUSE_DIR, 'schedule', 'runs');

export async function logRun(jobId: string, status: 'STARTED' | 'SUCCESS' | 'ERROR', message: string): Promise<void> {
  try {
    await fs.mkdir(RUNS_DIR, { recursive: true });
    const logFile = path.join(RUNS_DIR, `${jobId}.log`);
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${status}] ${message}\n`;
    await fs.appendFile(logFile, logEntry, 'utf-8');
  } catch (e) {
    console.error(`Failed to log run for job ${jobId}:`, e);
  }
}
