import path from 'path';

/**
 * Resolves a relative path and ensures it's within the workspace
 */
export function resolveWorkspacePath(relativePath: string): string {
    const workspaceRoot = process.cwd();
    const resolved = path.resolve(workspaceRoot, relativePath);

    if (!resolved.startsWith(workspaceRoot)) {
        throw new Error(`Operation outside workspace: ${relativePath}`);
    }

    return resolved;
}
