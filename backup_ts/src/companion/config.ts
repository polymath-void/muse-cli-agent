/**
 * src/companion/config.ts — load .muse/config.json, CWD-bound.
 * No hardcoded paths: resolves via explicit workspace or process.cwd().
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface CompanionConfig {
  project: string;
  scope: string;
  version: string;
  defaults: {
    model: string;
    effort: string;
    approvalMode: string;
    parallelToolCalls: boolean;
    readWindowLines: number;
    readMaxLines: number;
  };
  toolPolicy: {
    gated: string[];
    ungated: string[];
    caps: Record<string, number>;
  };
  [key: string]: unknown;
}

export function companionConfigPath(workspace?: string): string {
  return path.join(path.resolve(workspace ?? process.cwd()), ".muse", "config.json");
}

export function loadCompanionConfig(workspace?: string): CompanionConfig | null {
  try {
    const p = companionConfigPath(workspace);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as CompanionConfig;
  } catch {
    return null;
  }
}
