import path from 'path';
import {z} from 'zod';

/**
 * Resolves a relative path and ensures it's within the workspace
 */
export function resolveWorkspacePath(relativePath: string, baseDir: string = process.cwd()): string {
    const resolved = path.resolve(baseDir, relativePath);

    if (!resolved.startsWith(baseDir)) {
        throw new Error(`Operation outside workspace: ${relativePath}`);
    }

    return resolved;
}

/**
 * A Zod schema that allows either a number or a string that can be parsed as a number.
 * Useful for tool parameters that might be passed as strings from the LLM.
 * Use with .int(), .positive(), etc. to add further constraints.
 */
export const relaxedNumber = z.coerce.number();
