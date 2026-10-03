import os

path = "src/tui.ts"
with open(path, "r") as f:
    content = f.read()

# 1. Add globFiles and promptMentionMenu at the end of the file
mention_menu_code = """
import * as fs from "node:fs";

function globWorkspaceFiles(dir: string, root: string, depth = 0): string[] {
  if (depth > 4) return [];
  let res: string[] = [];
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.name === 'node_modules' || f.name === '.git' || f.name === 'dist') continue;
      const p = path.join(dir, f.name);
      if (f.isDirectory()) res.push(...globWorkspaceFiles(p, root, depth + 1));
      else res.push(path.relative(root, p));
    }
  } catch {}
  return res;
}

export async function promptMentionMenu(root: string): Promise<{kind: string, value: string} | null> {
  try {
    const kind = await select({
      message: "Mention type",
      choices: [
        { name: "file", value: "file", description: "Inject a file from the workspace" },
        { name: "skill", value: "skill", description: "Inject a markdown skill" },
        { name: "project", value: "project", description: "Inject a project context" }
      ]
    });
    
    if (kind === "file") {
        const files = globWorkspaceFiles(root, root);
        const picked = await search({
           message: "Search file",
           source: async (term) => {
              const q = (term || "").toLowerCase();
              return files.filter(f => f.toLowerCase().includes(q)).slice(0, 25).map(f => ({ name: f, value: f }));
           }
        });
        return { kind: "file", value: picked };
    } else {
        const val = await input({ message: `${kind} name:` });
        return { kind, value: val };
    }
  } catch {
    return null;
  }
}
"""

if "function globWorkspaceFiles" not in content:
    content += mention_menu_code

# 2. Add bare '@' intercept in the input loop
intercept_code = """      }
      
      // Bare "@" -> Interactive Mention Menu
      if (userText.trim() === "@") {
        const picked = await promptMentionMenu(workspace);
        if (picked) {
            queuedInitial = `@${picked.kind} ${picked.value} `;
        }
        continue;
      }
"""

if 'if (userText.trim() === "@")' not in content:
    content = content.replace('if (!parsed || isSlashMenuTrigger(userText)) {', intercept_code + '\n      if (!parsed || isSlashMenuTrigger(userText)) {', 1)

# 3. Add default: queuedInitial ?? undefined to input()
input_replacement = """        userText = await input({
          message: promptColor("›"),
          default: queuedInitial || undefined,
          theme: { prefix: "" }
        });"""

content = content.replace("""        userText = await input({
          message: promptColor("›"),
          theme: { prefix: "" }
        });""", input_replacement)

with open(path, "w") as f:
    f.write(content)

print("TUI Mention & Input Patches applied.")
