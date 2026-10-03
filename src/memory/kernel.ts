import * as fs from 'fs';
import * as path from 'path';

// Memory base directory
const MUSE_DIR = '.muse';

function ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

export function appendToMemory(workspaceRoot: string, text: string): void {
    const memPath = path.join(workspaceRoot, MUSE_DIR, 'MEMORY.md');
    ensureDir(path.dirname(memPath));
    fs.appendFileSync(memPath, text + '\n');
}

export function readMemory(workspaceRoot: string): string {
    const memPath = path.join(workspaceRoot, MUSE_DIR, 'MEMORY.md');
    if (!fs.existsSync(memPath)) return '';
    return fs.readFileSync(memPath, 'utf8');
}

export function appendToScratchpad(workspaceRoot: string, goalId: string, text: string): void {
    const spPath = path.join(workspaceRoot, MUSE_DIR, 'goals', goalId, 'scratchpad.md');
    ensureDir(path.dirname(spPath));
    fs.appendFileSync(spPath, text + '\n');
}

export function readScratchpad(workspaceRoot: string, goalId: string): string {
    const spPath = path.join(workspaceRoot, MUSE_DIR, 'goals', goalId, 'scratchpad.md');
    if (!fs.existsSync(spPath)) return '';
    return fs.readFileSync(spPath, 'utf8');
}

export function appendToLearnings(workspaceRoot: string, text: string): void {
    const lrnPath = path.join(workspaceRoot, MUSE_DIR, 'LEARNINGS.md');
    ensureDir(path.dirname(lrnPath));
    fs.appendFileSync(lrnPath, text + '\n');
}

export function readLearnings(workspaceRoot: string): string {
    const lrnPath = path.join(workspaceRoot, MUSE_DIR, 'LEARNINGS.md');
    if (!fs.existsSync(lrnPath)) return '';
    return fs.readFileSync(lrnPath, 'utf8');
}

export function recall(workspaceRoot: string, query: string): string[] {
    const content = readMemory(workspaceRoot);
    if (!content) return [];
    
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);
    
    const scoredLines = lines.map(line => {
        const lineLower = line.toLowerCase();
        let score = 0;
        for (const kw of keywords) {
            if (lineLower.includes(kw)) score++;
        }
        return { line, score };
    }).filter(ls => ls.score > 0);
    
    scoredLines.sort((a, b) => b.score - a.score);
    
    return scoredLines.map(ls => ls.line);
}
