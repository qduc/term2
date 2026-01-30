import { spawnSync, spawn } from 'node:child_process';

/**
 * Check if the GitHub Copilot CLI is available.
 * Supports both standalone `copilot` command and `gh copilot` extension.
 */
let copilotAvailableCache: boolean | null = null;

/**
 * Check if the GitHub Copilot CLI is available.
 * Supports both standalone `copilot` command and `gh copilot` extension.
 * This is the synchronous version, which may block the Event Loop.
 */
export function isCopilotCliAvailable(): boolean {
    if (copilotAvailableCache !== null) {
        return copilotAvailableCache;
    }

    try {
        // Check for standalone copilot command first
        const copilotResult = spawnSync('copilot', ['--version'], {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (copilotResult.status === 0) {
            copilotAvailableCache = true;
            return true;
        }

        // Fallback: Check if gh CLI is installed
        const ghResult = spawnSync('gh', ['--version'], {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (ghResult.status !== 0) {
            copilotAvailableCache = false;
            return false;
        }

        // Check if copilot extension is installed
        const ghCopilotResult = spawnSync('gh', ['copilot', '--help'], {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const result = ghCopilotResult.status === 0;
        copilotAvailableCache = result;
        return result;
    } catch {
        copilotAvailableCache = false;
        return false;
    }
}

/**
 * Async version of isCopilotCliAvailable.
 */
export async function isCopilotCliAvailableAsync(): Promise<boolean> {
    if (copilotAvailableCache !== null) {
        return copilotAvailableCache;
    }

    const checkCommand = (command: string, args: string[]): Promise<boolean> => {
        return new Promise((resolve) => {
            const child = spawn(command, args, { stdio: 'ignore' });
            child.on('error', () => resolve(false));
            child.on('close', (code) => resolve(code === 0));
        });
    };

    // Check for standalone copilot command first
    if (await checkCommand('copilot', ['--version'])) {
        copilotAvailableCache = true;
        return true;
    }

    // Fallback: Check if gh CLI is installed
    if (!(await checkCommand('gh', ['--version']))) {
        copilotAvailableCache = false;
        return false;
    }

    // Check if copilot extension is installed
    const result = await checkCommand('gh', ['copilot', '--help']);
    copilotAvailableCache = result;
    return result;
}

/**
 * Verify that the CLI is authenticated.
 */
let ghAuthenticatedCache: boolean | null = null;

/**
 * Verify that the CLI is authenticated.
 * This is the synchronous version, which may block the Event Loop.
 */
export function isGhAuthenticated(): boolean {
    if (ghAuthenticatedCache !== null) {
        return ghAuthenticatedCache;
    }

    try {
        // If we have standalone copilot, we consider it authenticated if it exists
        // as there's no standardized 'auth status' for the standalone version yet.
        const copilotResult = spawnSync('copilot', ['--version'], {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (copilotResult.status === 0) {
            ghAuthenticatedCache = true;
            return true;
        }

        const result = spawnSync('gh', ['auth', 'status'], {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const status = result.status === 0;
        ghAuthenticatedCache = status;
        return status;
    } catch {
        ghAuthenticatedCache = false;
        return false;
    }
}

/**
 * Async version of isGhAuthenticated.
 */
export async function isGhAuthenticatedAsync(): Promise<boolean> {
    if (ghAuthenticatedCache !== null) {
        return ghAuthenticatedCache;
    }

    const checkCommand = (command: string, args: string[]): Promise<boolean> => {
        return new Promise((resolve) => {
            const child = spawn(command, args, { stdio: 'ignore' });
            child.on('error', () => resolve(false));
            child.on('close', (code) => resolve(code === 0));
        });
    };

    // If we have standalone copilot, we consider it authenticated if it exists
    if (await checkCommand('copilot', ['--version'])) {
        ghAuthenticatedCache = true;
        return true;
    }

    const result = await checkCommand('gh', ['auth', 'status']);
    ghAuthenticatedCache = result;
    return result;
}
