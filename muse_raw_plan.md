## Implement Cognitive Enhancements Protocol — Thought Processing, Context Management, and Self-Learning Core
## Proposed Changes
### 1. Internal Thought Processing (`<thought>` system)
- **[MODIFY] `src/tui.ts`** — Render `<thought>` blocks as collapsed/dimmed sections in TUI, separate from user-visible output:
```ts
// src/tui.ts - renderAssistantMessage()
function renderAssistantMessage(raw: string) {
  const thoughtMatch = raw.match(/<thought>([\s\S]*?)<\/thought>/);
  const thought = thoughtMatch?.[1]?.trim();
  const clean = raw.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
  if (thought) printDim(`💭 ${truncate(thought, 300)}`, { collapsible: true });
  printMarkdown(clean);
}
```
- **[MODIFY] `src/session/store.ts`** — Strip `<thought>` content before persisting to `.muse/sessions/*.jsonl` to save tokens/context:
```ts
// src/session/store.ts - sanitizeBeforeSave()
export function sanitizeBeforeSave(content: string): string {
  return content
    .replace(/<thought>[\s\S]*?<\/thought>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// in appendTurn(): history.push({ role, content: sanitizeBeforeSave(content) })
```
- **[MODIFY] `src/agent/prompt.ts`** — Inject system instruction to always reason inside `<thought></thought>` before tool calls / final answers.

### 2. Context / Session Management
- **[NEW] `src/context/ContextManager.ts`** — Central `compact` API with token estimation + summarization:
```ts
export class ContextManager {
  constructor(private history: Turn[], private limit = 120_000) {}
  needsCompaction() { return this.estimateTokens() > this.limit * 0.85; }
  async compact(llm: LLM): Promise<Turn[]> {
    const keep = this.history.slice(-10); // preserve recency
    const stale = this.history.slice(0, -10);
    const summary = await llm.summarize(stale);
    return [{ role: 'system', content: `## Prior Summary\n${summary}` }, ...keep];
  }
}
```
- **[NEW] `src/tools/manage_context.ts`** — Agentic tool wrapper:
```ts
export const manage_context = {
  name: 'manage_context',
  description: 'Check token usage, compact, or clear session history',
  inputSchema: z.object({ action: z.enum(['status','compact','clear']) }),
  async run({ action }, ctx) {
    if (action === 'status') return ctx.contextManager.getStatus();
    if (action === 'compact') return ctx.contextManager.compact(ctx.llm);
    if (action === 'clear') return ctx.contextManager.clear(true);
  }
};
```
- **[MODIFY] `src/tools/registry.ts`** — Register `manage_context`.
- **[NEW] `.muse/commands/session.md`** — Expose via `/session` slash command:
```md
---
description: Manage session context (status/compact/clear)
---
Invoke `manage_context` with $ARGUMENTS (default: status). Show token counts in TUI.
```

### 3. Self-Learning Core
- **[NEW] `LEARNINGS.md` (root) + `~/.muse/LEARNINGS.md` (global) + `<project>/.muse/LEARNINGS.md` (project)** — Layered system loaded in priority order global < project < session at startup in `src/agent/context-loader.ts`.
- **[NEW] `src/tools/learn.ts`** — Explicit `learn()` tool to remember mistakes/preferences:
```ts
export const learn = {
  name: 'learn',
  description: 'Persist a durable lesson to LEARNINGS.md',
  inputSchema: z.object({
    lesson: z.string().min(10),
    scope: z.enum(['project','global']).default('project'),
    category: z.enum(['mistake','preference','pattern'])
  }),
  async run({ lesson, scope, category }) {
    const path = scope === 'global' ? GLOBAL_LEARNINGS : PROJECT_LEARNINGS;
    await appendFile(path, `\n- [${category}] ${lesson} (${new Date().toISOString().slice(0,10)})`);
    return `Learned: ${lesson}`;
  }
};
```
- **[MODIFY] `src/tools/registry.ts`** — Register `learn`.
- **[NEW] `src/learning/promotion.ts`** — Promotion engine: counts repeated lessons, auto-generates skills:
```ts
// if same normalized lesson seen >= 3x, promote to skill
if (countFor(rule) >= 3) {
  await writeFile(`.muse/plugins/${slug}/SKILL.md`,
`---\nname: ${slug}\ndescription: ${rule}\n---\n\n# ${slug}\n${rule}\n`);
}
```
- **[MODIFY] `src/agent/prompt.ts`** — Add learning directive: `On user correction, call learn() proactively.`
## Verification Plan
- **Thought stripping:** Unit test `sanitizeBeforeSave('<thought>secret</thought>hi') === 'hi'`; manual: run TUI, confirm 💭 block renders collapsed, then inspect `.muse/sessions/latest.jsonl` contains no `<thought>` tags.
- **Context management:** Unit test `ContextManager.needsCompaction()` threshold and `compact()` preserves last 10 turns + summary header; manual: `/session status` shows tokens, `/session compact` reduces history, `manage_context` tool-call works via agent.
- **Self-learning:** Unit test `learn({lesson, scope: 'project'})` appends to `.muse/LEARNINGS.md`; test `promotion.ts` creates `.muse/plugins/<skill>/SKILL.md` after 3 repeats; manual: correct agent, verify lesson persisted and reloaded on restart, verify skill file generated.
- **Regression:** `npm test` + `npm run typecheck` + `npm run lint` all green; no existing tool/skill broken.

