import * as vm from 'node:vm';
import * as path from 'path';

/**
 * Runs JS code in a node:vm sandbox with a 5s timeout.
 */
export function runSandboxedJS(code: string, contextObj: Record<string, any> = {}): any {
    const sandbox = {
        console,
        ...contextObj
    };
    vm.createContext(sandbox);
    
    const script = new vm.Script(code);
    return script.runInContext(sandbox, { timeout: 5000 });
}

/**
 * Validates and resolves a path to ensure it strictly falls within the workspaceRoot.
 * Can be used as a wrapper for file system operations in a sandbox.
 * Throws an error if a path traversal violation occurs.
 */
export function resolveSafePath(workspaceRoot: string, requestedPath: string): string {
    const resolvedRoot = path.resolve(workspaceRoot);
    const resolvedPath = path.resolve(workspaceRoot, requestedPath);
    
    // Check if the resolved path starts with the workspace root followed by a path separator,
    // or if it exactly matches the workspace root.
    if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) {
        throw new Error(`Path traversal violation: ${requestedPath} is outside workspace root.`);
    }
    
    return resolvedPath;
}
