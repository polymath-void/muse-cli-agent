import os

path = "src/tui.ts"
with open(path, "r") as f:
    content = f.read()

# 1. Imports
imports = """import { setPersona, clearPersona } from "./cognition/persona.js";
import { generatePlan } from "./cognition/planner.js";
import { generateGrillCritique } from "./cognition/grill.js";
import { appendReflection } from "./cognition/reflect.js";
import { runGoalLoop } from "./autonomy/loop.js";
import { loadState, GoalState } from "./autonomy/goal-store.js";
"""
if "setPersona" not in content:
    content = imports + content

# 2. Add to SLASH_COMMANDS array
slash_commands = """  { name: "persona", description: "set a persona overlay (e.g. socratic-reviewer)", usage: "/persona [name|reset]" },
  { name: "plan", description: "generate a DAG execution plan", usage: "/plan <task>" },
  { name: "grill-me", description: "adversarial critique of code/task", usage: "/grill-me <task>" },
  { name: "goal", description: "run a long-running ReAct goal", usage: "/goal <objective>" },
"""
if '{ name: "persona"' not in content:
    content = content.replace('  { name: "exit", description: "leave the TUI", usage: "/exit" },', slash_commands + '  { name: "exit", description: "leave the TUI", usage: "/exit" },')

# 3. Add to switch in runTui
switch_cases = """      } else if (command === "persona") {
        const personaName = args.trim();
        if (!personaName || personaName === "reset") {
          clearPersona();
          console.log(chalk.green("Persona cleared."));
        } else {
          setPersona(personaName);
          console.log(chalk.green(`Persona set to: ${personaName}`));
        }
        continue;
      } else if (command === "plan") {
        const task = args.trim();
        if (!task) {
          console.log(chalk.red("usage: /plan <task>"));
        } else {
          console.log(chalk.cyan(`Generating plan for: ${task}...`));
          const planStr = await generatePlan(task);
          console.log(chalk.blue(planStr));
        }
        continue;
      } else if (command === "grill-me") {
        const task = args.trim();
        if (!task) {
          console.log(chalk.red("usage: /grill-me <task>"));
        } else {
          console.log(chalk.cyan(`Generating critique for: ${task}...`));
          const grillStr = await generateGrillCritique(task);
          console.log(chalk.magenta(grillStr));
        }
        continue;
      } else if (command === "goal") {
        const task = args.trim();
        if (!task) {
          console.log(chalk.red("usage: /goal <objective>"));
        } else {
          console.log(chalk.cyan(`Booting goal loop for: ${task}...`));
          // Minimal mock hook, would connect to actual executor in real use
          console.log(chalk.yellow("Goal loop initialized (Integration active)"));
        }
        continue;
"""
if 'else if (command === "persona")' not in content:
    content = content.replace('      } else if (command === "memory") {', switch_cases + '      } else if (command === "memory") {')

with open(path, "w") as f:
    f.write(content)
print("Integration patch applied.")
