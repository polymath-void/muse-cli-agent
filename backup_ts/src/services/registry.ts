/**
 * src/services/registry.ts — NanoRegistry: wake/sleep manager.
 *
 * Micro/nano rule: only needed functionalities run; everything else sleeps.
 * - No polling. Each nano declares idleTtlMs; registry sleeps it after TTL.
 * - `sleepAll()` is called on TUI exit / LMK snapshot.
 * - Pure bookkeeping — no I/O, safe to import anywhere.
 */

export interface Sleepable {
  readonly name: string;
  /** Hint: service is needed now — cancel pending sleep. */
  wake(): void;
  /** Release handles/timers/caches. Must never throw. */
  sleep(): void;
  /** Idle TTL before auto-sleep. 0 = sleep immediately when not in use. */
  readonly idleTtlMs: number;
}

interface Entry {
  svc: Sleepable;
  timer: NodeJS.Timeout | null;
  awake: boolean;
}

export class NanoRegistry {
  private entries = new Map<string, Entry>();

  register(svc: Sleepable): void {
    this.entries.set(svc.name, { svc, timer: null, awake: false });
  }

  /** Mark needed — wake + (re)arm idle sleep. */
  use(name: string): Sleepable | null {
    const e = this.entries.get(name);
    if (!e) return null;
    try { e.svc.wake(); } catch { /* never crash TUI */ }
    e.awake = true;
    this.arm(e);
    return e.svc;
  }

  /** Explicit sleep (e.g. after a turn completes). */
  release(name: string): void {
    const e = this.entries.get(name);
    if (!e) return;
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    if (e.awake) {
      try { e.svc.sleep(); } catch { /* ignore */ }
      e.awake = false;
    }
  }

  /** Sleep everything — TUI exit path. */
  sleepAll(): void {
    for (const [, e] of this.entries) {
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      if (e.awake) {
        try { e.svc.sleep(); } catch { /* ignore */ }
        e.awake = false;
      }
    }
  }

  awakeNames(): string[] {
    return [...this.entries.entries()].filter(([, e]) => e.awake).map(([n]) => n);
  }

  private arm(e: Entry): void {
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    const ttl = e.svc.idleTtlMs;
    if (ttl <= 0) {
      // Nano: sleep on next tick unless re-used synchronously.
      e.timer = setTimeout(() => this.release(e.svc.name), 0);
      // Don't hold the event loop for nano sleepers.
      (e.timer as unknown as { unref?: () => void }).unref?.();
      return;
    }
    e.timer = setTimeout(() => this.release(e.svc.name), ttl);
    (e.timer as unknown as { unref?: () => void }).unref?.();
  }
}

/** Shared singleton for the TUI process. */
export const registry = new NanoRegistry();
