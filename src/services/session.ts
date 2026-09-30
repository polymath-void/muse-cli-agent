/**
 * src/services/session.ts — SessionNano: write-and-sleep session persistence.
 *
 * Wraps core/session-store appends. No timers, no handles — awake only
 * during a turn, sleeps immediately after (idleTtl 0). LMK-safe: sync
 * appends, never throws into the TUI loop.
 */

import type { Sleepable } from "./registry.js";
import {
  createSession as coreCreateSession,
  appendSessionLine as coreAppend,
} from "../core/session-store.js";
import type { SessionInfo } from "../core/types.js";

export class SessionNano implements Sleepable {
  readonly name = "session";
  readonly idleTtlMs = 0;
  session: SessionInfo;
  noLog: boolean;

  constructor(workspace: string, sessionId?: string, noLog = false) {
    this.session = coreCreateSession(workspace, sessionId);
    this.noLog = noLog;
  }

  wake(): void { /* write-and-sleep */ }
  sleep(): void { /* nothing held */ }

  append(record: Record<string, unknown>): void {
    try {
      coreAppend(this.session, record, this.noLog);
    } catch { /* session logging must never crash the TUI */ }
  }
}
