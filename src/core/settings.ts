import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface McpServerConfig {
  transport: string;
  enabled: boolean;
  mode?: string;
  command: string;
  args?: string[];
}

export interface MuseSettings {
  schema_version: number;
  provider: string;
  model: string;
  reasoning_effort: string;
  run: {
    system_prompt: string;
  };
  tui: {
    theme: string;
    verbose_output: string;
  };
  permissions: {
    default_profile: string;
    schema_version: number;
  };
  mcpServers: Record<string, McpServerConfig>;
}

const DEFAULT_SETTINGS: MuseSettings = {
  schema_version: 1,
  provider: "meta",
  model: "muse-spark-1.3",
  reasoning_effort: "high",
  run: {
    system_prompt: ""
  },
  tui: {
    theme: "default",
    verbose_output: "none"
  },
  permissions: {
    default_profile: "on-request",
    schema_version: 1
  },
  mcpServers: {}
};

export function loadMuseSettings(): MuseSettings {
  try {
    const p = path.join(os.homedir(), ".config", "muse", "settings.json");
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        run: { ...DEFAULT_SETTINGS.run, ...(parsed.run || {}) },
        tui: { ...DEFAULT_SETTINGS.tui, ...(parsed.tui || {}) },
        permissions: { ...DEFAULT_SETTINGS.permissions, ...(parsed.permissions || {}) },
        mcpServers: parsed.mcpServers || {}
      };
    }
  } catch {
    // Ignore errors, return defaults
  }
  return DEFAULT_SETTINGS;
}
