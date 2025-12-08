import {settingsService} from '../services/settings-service.js';
/**
 * Log command execution for security forensics
 * Only writes to stderr if DEBUG_BASH_TOOL is enabled to avoid polluting Ink UI
 */
export function logCommandExecution(
    command: string,
    isDangerous: boolean,
    approved: boolean,
): void {
    if (!settingsService.get<boolean>('debug.debugBashTool')) {
        return;
    }

    const timestamp = new Date().toISOString();
    const context = {
        timestamp,
        command: command.substring(0, 100), // Truncate for safety
        isDangerous,
        approved,
        env: settingsService.get<string>('environment.nodeEnv') || 'production',
    };
    console.error(`[BASH_TOOL_LOG] ${JSON.stringify(context)}`);
}

/**
 * Log validation errors for debugging
 */
export function logValidationError(message: string): void {
    if (!settingsService.get<boolean>('debug.debugBashTool')) {
        return;
    }

    console.error(`[BASH_TOOL_ERROR] ${message}`);
}
