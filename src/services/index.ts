/**
 * src/services/index.ts — barrel for micro/nano services.
 */
export { NanoRegistry, registry } from "./registry.js";
export type { Sleepable } from "./registry.js";
export { FsNano } from "./fs.js";
export { MentionNano, parseMentions } from "./mentions.js";
export type { Mention, MentionKind, ExpandResult } from "./mentions.js";
export { PluginNano } from "./plugins.js";
export type { PluginModule, PluginTool, PluginSlash } from "./plugins.js";
export { PermissionNano } from "./permissions.js";
export type { PermissionDecision } from "./permissions.js";
export { SessionNano } from "./session.js";
