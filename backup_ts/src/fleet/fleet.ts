import { spawnSync } from 'child_process';

export interface FleetRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export function fleetRun(host: string, cmd: string): FleetRunResult {
  const result = spawnSync('ssh', [host, cmd], { encoding: 'utf-8' as any });
  
  if (result.error && !result.stdout && !result.stderr) {
     throw new Error(`Fleet SSH execution failed: ${result.error.message}`);
  }
  
  return {
    stdout: result.stdout?.toString() || '',
    stderr: result.stderr?.toString() || '',
    exitCode: result.status
  };
}
