/**
 * Log command execution for security forensics
 * Only writes to stderr if DEBUG_BASH_TOOL is enabled to avoid polluting Ink UI
 */
export function logCommandExecution(settingsService, command, isDangerous, approved) {
    if (!settingsService.get('debug.debugBashTool')) {
        return;
    }
    if (settingsService.get('logging.suppressConsoleOutput')) {
        return;
    }
    const timestamp = new Date().toISOString();
    const context = {
        timestamp,
        command: command.substring(0, 100), // Truncate for safety
        isDangerous,
        approved,
        env: settingsService.get('environment.nodeEnv') || 'production',
    };
    console.error(`[BASH_TOOL_LOG] ${JSON.stringify(context)}`);
}
/**
 * Log validation errors for debugging
 */
export function logValidationError(settingsService, message) {
    if (!settingsService.get('debug.debugBashTool')) {
        return;
    }
    if (settingsService.get('logging.suppressConsoleOutput')) {
        return;
    }
    console.error(`[BASH_TOOL_ERROR] ${message}`);
}
//# sourceMappingURL=command-logger.js.map