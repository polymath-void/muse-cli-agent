import os

path = "src/tui.ts"
with open(path, "r") as f:
    content = f.read()

# Remove from current location
content = content.replace('''      // Bare "@" -> Interactive Mention Menu
      if (userText.trim() === "@") {
        const picked = await promptMentionMenu(workspace);
        if (picked) {
            queuedInitial = `@${picked.kind} ${picked.value} `;
        }
        continue;
      }''', '')

# Insert before if (userText.startsWith("/"))
new_code = '''    // Bare "@" -> Interactive Mention Menu
    if (userText.trim() === "@") {
      const picked = await promptMentionMenu(workspace);
      if (picked) {
          queuedInitial = `@${picked.kind} ${picked.value} `;
      }
      continue;
    }

    // ---- slash commands (explicit only — boot/init never auto-run) ----'''

content = content.replace('    // ---- slash commands (explicit only — boot/init never auto-run) ----', new_code)

with open(path, "w") as f:
    f.write(content)
print("Moved")
