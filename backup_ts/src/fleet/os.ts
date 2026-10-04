import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

const ALLOWED_COMMANDS = ['pwd', 'ls', 'cat', 'node'];
const RESTRICTED_COMMANDS = ['rm', 'sudo', 'chmod', 'ssh', 'docker'];
const AUDIT_LOG_DIR = path.join(process.cwd(), '.muse', 'audit');
const AUDIT_LOG_FILE = path.join(AUDIT_LOG_DIR, 'exec.log');

export function logExecAudit(cmd: string, cwd: string, exitCode: number | null, durationMs: number) {
  if (!fs.existsSync(AUDIT_LOG_DIR)) {
    fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
  }
  const logEntry = JSON.stringify({
    timestamp: new Date().toISOString(),
    cmd,
    cwd,
    exitCode,
    durationMs
  }) + '\n';
  fs.appendFileSync(AUDIT_LOG_FILE, logEntry);
}

export function execOS(command: string, args: string[], override = false): ExecResult {
  if (RESTRICTED_COMMANDS.includes(command) && !override) {
    throw new Error(`Command '${command}' requires approval/override.`);
  }

  // Enforce allowlist if not restricted and no override
  if (!ALLOWED_COMMANDS.includes(command) && !RESTRICTED_COMMANDS.includes(command) && !override) {
    throw new Error(`Command '${command}' is not in the allowlist.`);
  }

  const startTime = Date.now();
  const cwd = process.cwd();
  
  const result = spawnSync(command, args, { encoding: 'utf-8' as any });
  const durationMs = Date.now() - startTime;
  
  const exitCode = result.status;
  
  logExecAudit(`${command} ${args.join(' ')}`, cwd, exitCode, durationMs);
  
  if (result.error && !result.stdout && !result.stderr) {
     throw new Error(`Execution failed: ${result.error.message}`);
  }
  
  return {
    stdout: result.stdout?.toString() || '',
    stderr: result.stderr?.toString() || '',
    exitCode,
    durationMs
  };
}
