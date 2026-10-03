import { spawnSync, SpawnSyncReturns } from 'child_process';

export interface GitStatus {
  branch: string;
  isClean: boolean;
  modified: string[];
  untracked: string[];
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

function runGit(args: string[]): string {
  const result: SpawnSyncReturns<string> = spawnSync('git', args, { encoding: 'utf-8' as any });
  if (result.error) {
    throw new Error(`Git command failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Git command exited with ${result.status}: ${result.stderr?.toString() || result.stdout?.toString()}`);
  }
  return result.stdout?.toString().trim() || '';
}

export function gitStatus(): GitStatus {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const statusOutput = runGit(['status', '--porcelain']);
  
  const modified: string[] = [];
  const untracked: string[] = [];
  
  if (statusOutput) {
    const lines = statusOutput.split('\n');
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const prefix = line.substring(0, 2);
      const file = line.substring(3);
      if (prefix === '??') {
        untracked.push(file);
      } else {
        modified.push(file);
      }
    }
  }
  
  return {
    branch,
    isClean: modified.length === 0 && untracked.length === 0,
    modified,
    untracked
  };
}

export function gitDiff(): string {
  return runGit(['diff']);
}

export function gitCommit(message: string): string {
  return runGit(['commit', '-m', message]);
}

export function gitBranch(): string[] {
  const output = runGit(['branch', '--format=%(refname:short)']);
  return output.split('\n').filter(b => b.length > 0);
}

export function gitLog(limit = 10): GitLogEntry[] {
  const output = runGit(['log', `-n`, limit.toString(), '--pretty=format:%H|%an|%ad|%s', '--date=iso']);
  if (!output) return [];
  
  return output.split('\n').map(line => {
    const [hash, author, date, ...msgParts] = line.split('|');
    return {
      hash,
      author,
      date,
      message: msgParts.join('|')
    };
  });
}

export function gitPush(remote = 'origin', branch?: string): string {
  const currentBranch = branch || runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  return runGit(['push', remote, currentBranch]);
}
