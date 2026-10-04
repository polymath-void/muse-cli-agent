import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MUSE_DIR = path.join(os.homedir(), '.muse', 'cognition');
const PERSONA_FILE = path.join(MUSE_DIR, 'persona.json');

const PERSONAS: Record<string, string> = {
    "architect": "You are an expert system architect. Prioritize scalable, maintainable design.",
    "debugger": "You are a ruthless debugger. Find the root cause of the error.",
    "coder": "You are a senior software engineer. Write clean, efficient code.",
    "writer": "You are an expert technical writer. Write clear, concise documentation."
};

function ensureDir() {
    if (!fs.existsSync(MUSE_DIR)) {
        fs.mkdirSync(MUSE_DIR, { recursive: true });
    }
}

export function setPersona(name: string): void {
    ensureDir();
    fs.writeFileSync(PERSONA_FILE, JSON.stringify({ name }), 'utf-8');
}

export function getPersonaSystemPrompt(): string | null {
    if (!fs.existsSync(PERSONA_FILE)) {
        return null;
    }
    try {
        const data = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf-8'));
        const name = data.name;
        if (name && PERSONAS[name]) {
            return PERSONAS[name];
        }
        return `You are assuming the persona of: ${name}`;
    } catch (e) {
        return null;
    }
}

export function clearPersona(): void {
    if (fs.existsSync(PERSONA_FILE)) {
        fs.unlinkSync(PERSONA_FILE);
    }
}
