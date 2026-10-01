## Massive TUI/UX Overhaul — Ultimate Advanced Redesign Implementation Plan
## Proposed Changes
### 1. Core Renderer & Message Pipeline [MODIFY] `src/tui.ts: TuiRenderer, printTurn()`
**Issues:** Flat print stream, no type discrimination, no word-wrap awareness, no width-responsive layout, flicker on streaming.
- Introduce `BlockType = 'thought' | 'tool-call' | 'tool-result' | 'assistant' | 'user' | 'system' | 'footer'` with central `renderBlock(type, body)` dispatcher.
- Add terminal-width-aware wrapping via `wrapAnsi` + `process.stdout.columns` listener; indent all nested content by 2-4 spaces with vertical guide `│`.
- Implement streaming buffer: accumulate tokens, re-render Markdown only on flush (every 120ms) to avoid flicker.
```diff
- console.log(responseText);
+ renderBlock('assistant', responseText);
+ renderFooter({ inputTokens, outputTokens, cost });
```
```ts
// [MODIFY] central dispatcher with Chalk identity per block
import chalk from 'chalk';
import wrapAnsi from 'wrap-ansi';
const WIDTH = process.stdout.columns ?? 100;
export function renderBlock(type: BlockType, body: string) {
  const w = Math.min(WIDTH - 4, 110);
  switch(type){
    case 'assistant': return console.log(chalk.bold.whiteBright(body));
    case 'user': return console.log(chalk.bgBlueBright.black.bold(' YOU ') + ' ' + chalk.blueBright(body));
  }
}
```

### 2. Tool Call vs Result Distinction [MODIFY] `renderToolCall(), renderToolResult()`
**Issues:** Tool JSON blends into prose; no status, duration, collapsibility.
- Box tool calls in indented panel with header, syntax-highlighted JSON args, spinner → ✅/❌ transition, elapsed ms.
```ts
// [MODIFY] chalk formatting for tool calls
import { highlightJson } from './highlight.js';
console.log(chalk.dim('  ┌─') + chalk.bold.hex('#FFA657')(' ⚙ TOOL ') + chalk.hex('#FFA657')(name) + chalk.dim(` · ${elapsed}ms`));
console.log(chalk.dim('  │ ') + highlightJson(JSON.stringify(args,null,2)).split('\n').join('\n'+chalk.dim('  │ ')));
console.log(chalk.dim('  └─') + (ok ? chalk.green(' ✓ success') : chalk.red(' ✗ failed')));
```

### 3. <thought> Blocks [MODIFY] `renderThought()`
**Issues:** Internal reasoning visually identical to final answer; confusing trust boundary.
- Render collapsed by default behind `--verbose-thoughts` flag; dim italic gray with left border and `THINKING` label, max 12 lines with `… [expand]`.
```ts
// [MODIFY] thought block styling
console.log(chalk.italic.dim('  ◌ thinking ┈┈┈┈'));
console.log(chalk.dim.italic(wrapAnsi(thought.slice(0,1200), WIDTH-8).split('\n').map(l=>'    '+l).join('\n')));
```

### 4. User Prompts & Assistant Responses Separator [MODIFY] `renderTurnBoundary()`
**Issues:** No turn rhythm; prompts/responses run together on scrollback.
- Add full-width rule + turn header: `── You · 14:02 ──` vs `── Muse · opus-4.5 ──` with distinct bg colors; 1 blank line before/after every block.
```ts
// [MODIFY] turn separators
const rule = chalk.dim('─'.repeat(WIDTH-2));
console.log(`\n${rule}\n${chalk.bgMagenta.black.bold(' CLAUDE ')} ${chalk.dim(new Date().toLocaleTimeString())}\n`);
```

### 5. Context Menus (Inquirer) [MODIFY] `promptMenu(), promptModel(), promptMcp()`
**Issues:** Dense list, no gaps, no descriptions, no hints, keyboard undiscoverable.
- Migrate all `select/checkbox` to `@inquirer/prompts` `select` with `theme: { style: { description } }`, empty `pageSize: 9`, separators every group, footer hint bar.
- Each choice gets `name`, `value`, `description` (detailed info: model cost/speed/context, MCP tool count/status).
```ts
// [MODIFY] structured Inquirer menu with gaps
import { select, Separator } from '@inquirer/prompts';
const model = await select({
  message: chalk.bold.cyan('Select model (↑↓ navigate · enter confirm · / filter)'),
  pageSize: 9,
  theme: { prefix: chalk.magenta('◆'), style: { highlight: chalk.bold.cyan } },
  choices: [
    new Separator(chalk.dim(' ── Flagship ──')),
    { name: 'Opus 4.5  ', value: 'opus', description: chalk.dim('smartest · $5/$25/M · 200k ctx') },
    new Separator(chalk.dim(' ── Fast ──')),
    { name: 'Haiku 4.5 ', value: 'haiku', description: chalk.dim('3x faster · $0.8/$4/M · 80k ctx') },
  ],
});
```

### 6. Task Management (/tasks) [MODIFY] `renderTasks(), /tasks command`
**Issues:** Static dump, no interactive ops, poor status scanability.
- Replace dump with interactive `checkbox` + `expand` operations: `toggle done / rename / priority / delete / quit`; kanban coloring: `○ pending gray, ◐ in-progress yellow, ● done green, ✕ blocked red`; progress bar header `Tasks 3/7 ▓▓▓░░░░`.
```ts
// [MODIFY] clean task formatting
function fmtTask(t: Task){
  const icon = t.status==='done'?chalk.green('●'):t.status==='in_progress'?chalk.yellow('◐'):chalk.dim('○');
  const pri = t.priority==='high'?chalk.red.bold('[HIGH] '):t.priority==='med'?chalk.yellow('[MED] '):'';
  return `${icon} ${chalk.bold(`#${t.id}`)} ${pri}${t.title} ${chalk.dim(`(${t.age})`)}`;
}
// [NEW] interactive ops via expand prompt
import { expand } from '@inquirer/prompts';
await expand({ message: `Task #${id} — (t)oggle, (e)dit, (p)riority, (d)elete, (q)uit`, choices: [...] });
```

### 7. Token Counts & Cost Footer [NEW] `renderFooter()`
**Issues:** Invisible spend; no per-turn accountability.
- After every assistant turn print dim right-aligned footer: `↓ 1,204 · ↑ 342 · ctx 12% (24k/200k) · $0.0183 · 4.2s`; warn yellow >70%, red >90% with `context compaction suggested`; session totals on `/cost`.
```ts
// [NEW] token footer — called synchronously after each response flush
import chalk from 'chalk';
export function renderFooter(m: {in:number; out:number; ctxUsed:number; ctxMax:number; cost:number; secs:number}){
  const pct = m.ctxUsed/m.ctxMax;
  const ctxColor = pct>0.9?chalk.red.bold:pct>0.7?chalk.yellow:chalk.dim;
  console.log(chalk.dim(`  ─┈ tokens ↓${m.in.toLocaleString()} ↑${m.out.toLocaleString()} · `) + ctxColor(`ctx ${Math.round(pct*100)}% `) + chalk.green.dim(`· $${m.cost.toFixed(4)} · ${m.secs.toFixed(1)}s`));
}
```

### 8. External Editor Integration [NEW] `promptLongText(), EDITOR_HOOK`
**Issues:** Long paste breaks, no multiline editing, Esc mishandling.
- Hook `editor` from `@inquirer/prompts` on `Ctrl+O` / `/edit` / auto-trigger when input >500 chars or multi-line paste detected; respect `$EDITOR/$VISUAL`, fallback to temp file; re-inject result into readline buffer.
```ts
// [NEW] external editor hook for long multi-line input
import { editor, input } from '@inquirer/prompts';
import chalk from 'chalk';
export async function promptLongText(initial=''): Promise<string> {
  console.log(chalk.dim('  [Ctrl+O opens $EDITOR · /edit forces editor]'));
  // auto-escalate: if paste >500 chars or >5 newlines, jump to editor
  if (initial.length > 500 || initial.split('\n').length > 5) {
    return await editor({
      message: chalk.cyan('Edit long input (save & close to submit)'),
      default: initial,
      waitForUseInput: false,
      // respects $EDITOR, falls back to vi/nano/notepad
    });
  }
  return await input({ message: chalk.blueBright('›'), default: initial });
}
// keybinding in readline loop:
// rl.on('keypress', (s,key)=>{ if(key.ctrl&&key.name==='o') openEditorForCurrentBuffer(); });
```

### 9. Paragraph Formatting & Markdown Rendering [MODIFY] `renderMarkdown()`
**Issues:** Weak headings, broken code fences, no tables, raw URLs.
- Swap naive `console.log(md)` for `marked` + `marked-terminal` with custom Chalk theme + `cli-highlight` for fenced blocks + `wrapAnsi` reflow; headings bold underline with spacing, bullets `•` indented, blockquotes dim `│`, links `text (url)` cyan underline.
```ts
// [MODIFY] Markdown rendering enhancements
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import chalk from 'chalk';
marked.use(markedTerminal({
  code: (code, lang) => require('cli-highlight').highlight(code, { language: lang||'text', ignoreIllegals: true }),
  heading: (t) => '\n' + chalk.bold.underline.hex('#7EE787')(t) + '\n',
  blockquote: (q) => chalk.dim('│ ') + chalk.italic.dim(q),
  link: (href, title, text) => chalk.cyan.underline(text||href) + chalk.dim(` (${href})`),
  listitem: (b) => '  ' + chalk.yellow('• ') + b,
}));
export function renderMarkdown(md: string){ console.log(marked.parse(wrapAnsi(md, Math.min(process.stdout.columns-4,100)))); }
```

### 10. Additional Visual/UX Issues Found [NEW/MODIFY]
- **[MODIFY] Spinner/streaming:** no activity indicator → add `ora` spinner `⠋ Muse thinking…` replaced by footer on flush.
- **[MODIFY] Error vs info:** all red/white noise → `ERROR bgRed white bold`, `WARN yellow`, `INFO dim blue` helpers.
- **[NEW] Responsive & a11y:** honor `NO_COLOR`, `--no-color`, non-TTY pipe (strip ANSI); truncate tool results >80 lines with `[+240 lines — /expand]`.
- **[NEW] Copy & scrollback:** prefix code fences with ` ```ts [copy: /copy 3] ` language tag for easy extraction.
## Verification Plan
1. **Visual snapshot:** run `npm run tui:demo` fixture (thought+2 tool calls+markdown+tasks) in 80-col and 120-col terminals; screenshot diff vs baseline, assert: distinct colors per block, `│` guides present, blank lines around blocks.
2. **Unit:** `vitest src/tui.test.ts` — `renderFooter()` formats `↓/↑/ctx/$/s` exactly; `fmtTask()` color codes; `renderMarkdown()` snapshot for headings/code/table/quote/link; `promptLongText()` auto-escalates when >500 chars (mock `editor`).
3. **Interactive:** manual Inquirer walkthrough — arrow navigation, `/` filter, description visible, `pageSize` gap check; `/tasks` toggle/rename/priority/delete round-trip persists to store.
4. **Editor hook:** set `EDITOR=true` and `EDITOR=code --wait`; press `Ctrl+O`, paste 50-line text → editor opens, save returns content intact; unset `$EDITOR` falls back without crash.
5. **Tokens/cost:** mock usage `{in:1204,out:342}` → footer shows `$0.0183`, ctx bar turns yellow at 75%, red + hint at 92%; `/cost` session totals match sum.
6. **Regression:** `NO_COLOR=1` and piped output contain zero ANSI; `npm run lint && npm run typecheck` clean; ask 2 beta users to complete 5-turn task and confirm tool/thought/answer distinguishability ≥4/5 Likert.

