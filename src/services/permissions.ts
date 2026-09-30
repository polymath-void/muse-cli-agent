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
    try {
      const { ok } = await inquirer.prompt<{ ok: boolean }>([
        {
          type: "confirm",
          name: "ok",
          message: `${action} ${detail} ? [Enter to run / n to deny]`,
          default: true,
        },
      ]);
      return ok ? { allowed: true, via: "enter" } : { allowed: false, via: "deny" };
    } catch {
      return { allowed: false, via: "deny" };
    }
  }
}
