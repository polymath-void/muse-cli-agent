import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface SessionCheckpoint {
  id: string;
  timestamp: number;
  messageCount: number;
  summary: string;
}

export class SessionManager {
  private workspace: string;
  private sessionDir: string;

  constructor(workspace: string) {
    this.workspace = workspace;
    this.sessionDir = path.join(this.workspace, ".muse", "sessions");
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  public listSessions(): string[] {
    if (!fs.existsSync(this.sessionDir)) return [];
    return fs.readdirSync(this.sessionDir).filter(f => f.endsWith(".jsonl") || fs.statSync(path.join(this.sessionDir, f)).isDirectory());
  }

  public createCheckpoint(sessionId: string, messages: any[], summary: string): SessionCheckpoint {
    const cpDir = path.join(this.workspace, ".muse", "checkpoints");
    if (!fs.existsSync(cpDir)) fs.mkdirSync(cpDir, { recursive: true });

    const cpId = randomUUID().slice(0, 8);
    const cp: SessionCheckpoint = {
      id: cpId,
      timestamp: Date.now(),
      messageCount: messages.length,
      summary
    };

    const cpFile = path.join(cpDir, `${sessionId}_${cpId}.json`);
    fs.writeFileSync(cpFile, JSON.stringify({ checkpoint: cp, messages }, null, 2));
    
    return cp;
  }

  public forkSession(sessionId: string, checkpointId: string): string {
    const cpFile = path.join(this.workspace, ".muse", "checkpoints", `${sessionId}_${checkpointId}.json`);
    if (!fs.existsSync(cpFile)) throw new Error(`Checkpoint ${checkpointId} not found.`);
    
    const data = JSON.parse(fs.readFileSync(cpFile, "utf-8"));
    const newSessionId = `fork_${checkpointId}_${randomUUID().slice(0, 4)}`;
    
    // In a real scenario, this would write the messages to a new session log
    const newLogPath = path.join(this.sessionDir, `${newSessionId}.jsonl`);
    for (const msg of data.messages) {
      fs.appendFileSync(newLogPath, JSON.stringify(msg) + "\n");
    }
    
    return newSessionId;
  }
}
