/**
 * src/nodeos.ts — NodeOS readiness + daemon boot (CWD-bound, shared).
 *
 * Single owner for the `runInit({ boot })` sequence so both the
 * `muse-ts init` CLI command (src/index.ts) and the interactive TUI
 * `/init` + `/boot` slash commands (src/tui.ts) run the exact same code.
 *
 * NodeOS architecture (mandatory):
 * - Workspace resolves dynamically via process.cwd() or explicit target.
 * - agy_nodeos.db, workflow.json, daemon.log, .agents/hooks.json always
 *   attach relative to the runtime CWD. Nothing is hardcoded.
 */
export declare function checkBin(name: string): string | null;
export declare function runInit(opts: {
    boot?: boolean;
    target?: string;
}): Promise<void>;
