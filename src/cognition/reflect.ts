import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MUSE_DIR = path.join(os.homedir(), '.muse', 'cognition');
const REFLECT_FILE = path.join(MUSE_DIR, 'REFLECT.md');

function ensureDir() {
    if (!fs.existsSync(MUSE_DIR)) {
        fs.mkdirSync(MUSE_DIR, { recursive: true });
    }
}

export function appendReflection(task: string, worked: boolean, cost: number, lesson: string): void {
    ensureDir();
    const timestamp = new Date().toISOString();
    const status = worked ? "Success" : "Failure";
    
    // Initialize file with header if it doesn't exist
    if (!fs.existsSync(REFLECT_FILE)) {
        fs.writeFileSync(REFLECT_FILE, '# Muse Reflection Log\n\n', 'utf-8');
    }

    const entry = `## [${timestamp}] Task: ${task}\n- **Status:** ${status}\n- **Cost:** $${cost.toFixed(4)}\n- **Lesson:** ${lesson}\n\n`;
    
    fs.appendFileSync(REFLECT_FILE, entry, 'utf-8');
}
