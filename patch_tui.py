import re

with open('src/tui.ts', 'r') as f:
    content = f.read()

imports = """import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import cliHighlight from "cli-highlight";

marked.use(markedTerminal({
  code: (c, l) => cliHighlight.highlight(c, { language: l || 'text', ignoreIllegals: true }),
  heading: (t) => '\\n' + chalk.bold.underline.hex('#7EE787')(t) + '\\n'
}));
"""

content = content.replace("import chalk from \"chalk\";\n", "import chalk from \"chalk\";\n" + imports)

# Replace renderAssistant
render_assistant_old = """export function renderAssistant(text: string): string {
  const { thought, clean } = renderAssistantMessage(text);
  const lines = clean.split("\\n");
  let inFence = false;
  const body = lines
    .map((ln) => {
      if (ln.startsWith("```")) {
        inFence = !inFence;
        return chalk.dim(ln);
      }
      if (inFence) return chalk.green(ln);
      if (ln.startsWith("# ")) return chalk.bold.cyan(ln);
      if (ln.startsWith("## ")) return chalk.bold.blue(ln);
      return ln;
    })
    .join("\\n");
  
  if (thought) {
    return formatThoughtLine(thought) + "\\n" + body;
  }
  return body;
}"""

render_assistant_new = """export function renderAssistant(text: string): string {
  const { thought, clean } = renderAssistantMessage(text);
  const body = marked.parse(clean);
  if (thought) {
    return chalk.italic.dim('  ◌ thinking ┈┈┈┈\\n') + chalk.dim.italic(thought.slice(0,1200).split('\\n').map((l: string) => '    '+l).join('\\n')) + '\\n' + body;
  }
  return body;
}"""

if render_assistant_old in content:
    content = content.replace(render_assistant_old, render_assistant_new)
else:
    print("Could not find renderAssistant")

# Inject token footer
history_push_old = """      history.push(full);
      appendSessionLine("""

history_push_new = """      history.push(full);
      const m = fullRes.usage;
      if (m) {
        const pct = m.totalTokens / 200000;
        const ctxColor = pct > 0.9 ? chalk.red.bold : pct > 0.7 ? chalk.yellow : chalk.dim;
        console.log(chalk.dim(`  ─┈ tokens ↓${m.inputTokens} ↑${m.outputTokens} · `) + ctxColor(`ctx ${Math.round(pct*100)}% `) + chalk.green.dim(`· $${(m.totalTokens * 0.000005).toFixed(4)}`));
      }
      appendSessionLine("""

if history_push_old in content:
    content = content.replace(history_push_old, history_push_new)
else:
    print("Could not find history.push")


with open('src/tui.ts', 'w') as f:
    f.write(content)

print("Patch applied")
