import os

path = "src/tui.ts"
with open(path, "r") as f:
    content = f.read()

# Replace the else block in promptMentionMenu with advanced search
advanced_searches = """    } else if (kind === "skill") {
        const localSkills = path.join(root, ".agents", "skills");
        const globalSkills = path.join(process.env.HOME || "", ".gemini", "config", "skills");
        const skills: string[] = [];
        try { if (fs.existsSync(localSkills)) skills.push(...fs.readdirSync(localSkills)); } catch {}
        try { if (fs.existsSync(globalSkills)) skills.push(...fs.readdirSync(globalSkills)); } catch {}
        const uniqueSkills = Array.from(new Set(skills));
        
        const picked = await search({
           message: "Search skill",
           source: async (term) => {
              const q = (term || "").toLowerCase();
              return uniqueSkills.filter(s => s.toLowerCase().includes(q)).map(s => ({ name: s, value: s }));
           }
        });
        return { kind: "skill", value: picked };
    } else if (kind === "plugin") {
        // Known plugins
        const plugins = ["git", "system", "powerhouse", "web"];
        const picked = await select({
           message: "Select plugin",
           choices: plugins.map(p => ({ name: p, value: p }))
        });
        return { kind: "plugin", value: picked };
    } else {
        const val = await input({ message: `${kind} name:` });
        return { kind, value: val };
    }"""

old_else = """    } else {
        const val = await input({ message: `${kind} name:` });
        return { kind, value: val };
    }"""

content = content.replace(old_else, advanced_searches)

# Add plugin to choices
content = content.replace('{ name: "project", value: "project"', '{ name: "plugin", value: "plugin", description: "Inject a plugin context" },\n        { name: "project", value: "project"')

with open(path, "w") as f:
    f.write(content)
print("Skills/Plugins patch applied")
