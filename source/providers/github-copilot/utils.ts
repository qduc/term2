import { spawnSync } from 'node:child_process';

/**
 * Check if the GitHub Copilot CLI is available and authenticated.
 * The Copilot SDK requires the `gh copilot` CLI extension to be installed.
 */
export function isCopilotCliAvailable(): boolean {
    try {
        // Check if gh CLI is installed
        const ghResult = spawnSync('gh', ['--version'], {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (ghResult.status !== 0) {
            return false;
        }

        // Check if copilot extension is installed
        const copilotResult = spawnSync('gh', ['copilot', '--help'], {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        return copilotResult.status === 0;
    } catch {
        return false;
    }
}

/**
 * Verify that the gh CLI is authenticated.
 */
export function isGhAuthenticated(): boolean {
    try {
        const result = spawnSync('gh', ['auth', 'status'], {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        return result.status === 0;
    } catch {
        return false;
    }
}
