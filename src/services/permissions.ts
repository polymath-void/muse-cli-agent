/**
 * src/services/permissions.ts — PermissionNano: Enter-to-run approval gate.
 *
 * - `on-request` (default): confirm with default=true → bare Enter runs.
 * - `never`: allow. `untrusted`: deny. TTY-less / --yolo: allow.
 * - Every decision is returned with { allowed, via } for session logging.
 * - Ephemeral: no timers, no handles → sleeps instantly.
 */

import inquirer from "inquirer";
import type { Sleepable } from "./registry.js";
import type { ApprovalMode } from "../core/types.js";

export interface PermissionDecision {
  allowed: boolean;
  via: "never" | "untrusted" | "yolo" | "no-tty" | "enter" | "deny" | "auto";
}

export class PermissionNano implements Sleepable {
  readonly name = "permissions";
  readonly idleTtlMs = 0;
  approvalMode: ApprovalMode;
  yolo: boolean;

  constructor(approvalMode: ApprovalMode = "on-request", yolo = false) {
    this.approvalMode = approvalMode;
    this.yolo = yolo;
  }

  wake(): void { /* ephemeral */ }
  sleep(): void { /* nothing held */ }

  /** Enter-to-run gate. Default YES — user just hits Enter. */
  async approve(action: string, detail: string): Promise<PermissionDecision> {
    if (this.approvalMode === "never" || this.yolo) {
      return { allowed: true, via: this.yolo ? "yolo" : "never" };
    }
    if (this.approvalMode === "untrusted") {
      return { allowed: false, via: "untrusted" };
    }
    if (!process.stdin.isTTY) {
      return { allowed: true, via: "no-tty" };
    }
    
    let humanAction = action;
    if (action === "bash") humanAction = "run a shell command";
    else if (action === "read_file") humanAction = "read file";
    else if (action === "write_file") humanAction = "modify file";
    else if (action === "list_dir") humanAction = "list directory";
    else if (action === "search") humanAction = "search in";
    else if (action === "plugin") humanAction = "execute plugin";
    else if (action === "bridge") humanAction = "execute bridge tool";

    try {
      const { ok } = await inquirer.prompt<{ ok: boolean }>([
        {
          type: "confirm",
          name: "ok",
          message: `The agent wants to ${humanAction}: ${detail}\n  Allow this action?`,
          default: true,
        },
      ]);
      return ok ? { allowed: true, via: "enter" } : { allowed: false, via: "deny" };
    } catch {
      return { allowed: false, via: "deny" };
    }
  }
}
