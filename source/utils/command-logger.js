/**
 * Log command execution for security forensics
 * Only writes to stderr if DEBUG_BASH_TOOL is enabled to avoid polluting Ink UI
 * @param {string} command - The command being executed
 * @param {boolean} isDangerous - Whether the command is flagged as dangerous
 * @param {boolean} approved - Whether the command was approved
 */
export function logCommandExecution(command, isDangerous, approved) {
	if (!process.env.DEBUG_BASH_TOOL) {
		return;
	}

	const timestamp = new Date().toISOString();
	const context = {
		timestamp,
		command: command.substring(0, 100), // Truncate for safety
		isDangerous,
		approved,
		env: process.env.NODE_ENV || 'production',
	};
	console.error(`[BASH_TOOL_LOG] ${JSON.stringify(context)}`);
}

/**
 * Log validation errors for debugging
 * @param {string} message - The error message
 */
export function logValidationError(message) {
	if (!process.env.DEBUG_BASH_TOOL) {
		return;
	}

	console.error(`[BASH_TOOL_ERROR] ${message}`);
}
