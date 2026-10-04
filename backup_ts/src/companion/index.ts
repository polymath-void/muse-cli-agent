/**
 * src/companion/index.ts — barrel for the companion advanced layer.
 * CWD-bound task + memory + config bridge (see .muse/config.json).
 */
export { loadCompanionConfig, companionConfigPath } from "./config.js";
export type { CompanionConfig } from "./config.js";
export { loadTasks, addTask, setTaskStatus, nextTasks, tasksPath } from "./tasks.js";
export type { CompanionTask, TaskStatus } from "./tasks.js";
export { readMemory, appendMemory, memoryPath } from "./memory.js";
