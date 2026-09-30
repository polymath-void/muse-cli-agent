/**
 * src/services/plugins.ts — PluginNano: lazy workspace + XDG plugins.
 *
 * - Dirs: <workspace>/.muse/plugins/*.mjs + ~/.config/muse/plugins/*.mjs
 * - Module export: { name, description?, tools?: [{name,description,parameters,handler}],
 *     slash?: [{name,description,usage?,handler}], activate?, deactivate? }
 * - Lazy: loaded on first list/call, deactivated + evicted after 5min idle.
 * - No watcher (poll-free); rescanned on demand. Sleeps → unload all.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Sleepable } from "./registry.js";

export interface PluginTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface PluginSlash {
  name: string;
  description: string;
  usage?: string;
  handler: (arg: string, ctx: { workspace: string }) => Promise<string | null> | string | null;
}

export interface PluginModule {
  name: string;
  description?: string;
  tools?: PluginTool[];
  slash?: PluginSlash[];
  activate?: () => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
}

export class PluginNano implements Sleepable {
  readonly name = "plugins";
  readonly idleTtlMs = 5 * 60_000;
  readonly root: string;

  private loaded = new Map<string, { mod: PluginModule; file: string }>();
  private activated = new Set<string>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  wake(): void { /* lazy */ }

  async sleep(): Promise<void> {
    for (const [name, e] of this.loaded) {
      if (this.activated.has(name)) {
        try { await e.mod.deactivate?.(); } catch { /* ignore */ }
        this.activated.delete(name);
      }
    }
    this.loaded.clear();
  }

  pluginDirs(): string[] {
    return [
      path.join(this.root, ".muse", "plugins"),
      path.join(os.homedir(), ".config", "muse", "plugins"),
    ];
  }

  pluginFiles(): string[] {
    const out: string[] = [];
    for (const d of this.pluginDirs()) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".mjs")) out.push(path.join(d, e.name));
      }
    }
    return out.slice(0, 50);
  }

  async ensureLoaded(): Promise<void> {
    for (const file of this.pluginFiles()) {
      if ([...this.loaded.values()].some((e) => e.file === file)) continue;
      try {
        const mod = (await import(pathToFileURL(file).href + `?t=${Date.now()}`)) as PluginModule & { default?: PluginModule };
        const p: PluginModule = (mod.default ?? mod) as PluginModule;
        if (!p || typeof p.name !== "string" || !p.name) continue;
        if (this.loaded.has(p.name)) continue;
        this.loaded.set(p.name, { mod: p, file });
        try { await p.activate?.(); } catch { /* plugin stays, activation failed */ }
        this.activated.add(p.name);
      } catch {
        /* broken plugin file — skip, never crash TUI */
      }
    }
  }

  async listTools(): Promise<{ name: string; description?: string; parameters?: Record<string, unknown> }[]> {
    await this.ensureLoaded();
    const out: { name: string; description?: string; parameters?: Record<string, unknown> }[] = [];
    for (const [, e] of this.loaded) {
      for (const t of e.mod.tools ?? []) {
        out.push({ name: `plugin_${e.mod.name}_${t.name}`, description: t.description, parameters: t.parameters });
      }
    }
    return out;
  }

  async listSlash(): Promise<{ name: string; description: string; usage: string }[]> {
    await this.ensureLoaded();
    const out: { name: string; description: string; usage: string }[] = [];
    for (const [, e] of this.loaded) {
      for (const s of e.mod.slash ?? []) {
        out.push({ name: s.name, description: s.description, usage: s.usage ?? `/${s.name}` });
      }
    }
    return out;
  }

  async callTool(fullName: string, args: Record<string, unknown>): Promise<string | null> {
    await this.ensureLoaded();
    for (const [, e] of this.loaded) {
      for (const t of e.mod.tools ?? []) {
        if (`plugin_${e.mod.name}_${t.name}` === fullName) {
          return String(await t.handler(args));
        }
      }
    }
    return null;
  }

  async runSlash(name: string, arg: string): Promise<string | null> {
    await this.ensureLoaded();
    for (const [, e] of this.loaded) {
      for (const s of e.mod.slash ?? []) {
        if (s.name === name) {
          const r = await s.handler(arg, { workspace: this.root });
          return r ?? null;
        }
      }
    }
    return null;
  }

  loadedNames(): string[] {
    return [...this.loaded.keys()];
  }
}
