const fs = require('fs');
let code = fs.readFileSync('src/tui.ts', 'utf8');

// 1. Add marked imports
code = `import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import cliHighlight from "cli-highlight";
marked.use(markedTerminal({
  code: (c: any, l: any) => cliHighlight.highlight(String(c), { language: String(l||'text'), ignoreIllegals: true }),
  heading: (t: any) => '\\n' + chalk.bold.underline.hex('#7EE787')(String(t)) + '\\n'
}) as any);
` + code;

// 2. Replace renderAssistant with marked render
code = code.replace(
  /export function renderAssistant\(text: string\): string \{\n(.*?)\n\}/s,
  `export function renderAssistant(text: string): string { return marked.parse(text) as string; }`
);

// 3. Add token footer in turn loop
// Find the history.push block
code = code.replace(
  /history\.push\(full\);\n\s*appendSessionLine/s,
  `history.push(full);
      console.log(chalk.dim(\`  ─┈ tokens ↓\${turnRes.usage?.inputTokens || 0} ↑\${turnRes.usage?.outputTokens || 0} · \`) + chalk.yellow(\`ctx usage \${turnRes.usage?.totalTokens || 0} \`));
      appendSessionLine`
);

// 4. Update the /tasks command list to use checkboxes
code = code.replace(
  /const items = sub === "next" \? nextTasks\(workspace, 5\) : loadTasks\(workspace\);(.*?)\}\n\s*\}/s,
  `const items = sub === "next" ? nextTasks(workspace, 5) : loadTasks(workspace);
            if (items.length === 0) {
              console.log(chalk.dim("(no tasks)"));
            } else {
              for (const t of items.slice(0, 20)) {
                const mark = t.status === "done" ? chalk.green("●") : t.status === "in-progress" ? chalk.yellow("◐") : chalk.dim("○");
                console.log(\`  [\${mark}] \${chalk.cyan(t.id)} \${chalk.dim(t.priority)} \${t.title.slice(0, 120)}\`);
              }
            }
          }`
);

fs.writeFileSync('src/tui.ts', code);
console.log('TUI Patched with TS fixes');
