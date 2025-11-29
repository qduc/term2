import {z} from 'zod';
import {exec, type ExecException} from 'child_process';
import process from 'process';
import {validateCommandSafety} from '../utils/command-safety.js';
import {logValidationError} from '../utils/command-logger.js';
import type {ToolDefinition} from './types.js';

function bufferToString(output: string | Buffer | undefined): string {
	if (typeof output === 'string') {
		return output;
	}

	return output?.toString('utf8') ?? '';
}

/** Default trim configuration */
export const DEFAULT_TRIM_CONFIG: OutputTrimConfig = {
	maxLines: 1000,
	maxCharacters: 10000,
};

const shellParametersSchema = z.object({
	commands: z
		.array(z.string().min(1))
		.min(1, 'At least one command required')
		.max(3, 'The maximum number of parallel commands is 3')
		.describe('Array of shell commands to execute sequentially, one command per entry.'),
	timeout_ms: z
		.number()
		.int()
		.positive()
		.optional()
		.default(DEFAULT_TRIM_CONFIG.maxCharacters)
		.describe(
			'Optional timeout in milliseconds for each command. Defaults to 120000 ms (2 minutes) if not specified.',
		),
	max_output_length: z
		.number()
		.int()
		.positive()
		.optional()
		.default(DEFAULT_TRIM_CONFIG.maxCharacters)
		.describe(
			'Optional maximum output length in characters for each command. Outputs exceeding this length will be trimmed. Defaults to 10000 characters if not specified.',
		),
	needsApproval: z.boolean(),
});

export type ShellToolParams = z.infer<typeof shellParametersSchema>;

/**
 * Configuration for output trimming limits.
 * Output will be trimmed if it exceeds either limit.
 */
export interface OutputTrimConfig {
	/** Maximum number of lines before trimming (default: 1000) */
	maxLines: number;
	/** Maximum size in characters before trimming (default: 10000) */
	maxCharacters: number;
}

/** Current trim configuration (can be modified at runtime) */
let trimConfig: OutputTrimConfig = {...DEFAULT_TRIM_CONFIG};

/**
 * Run a shell command while immediately closing stdin so tools like ripgrep
 * don't wait for user input and incorrectly fall back to stdin scanning.
 */
async function execWithoutInput(
	command: string,
	options: Parameters<typeof exec>[1],
): Promise<{stdout: string; stderr: string}> {
	return new Promise((resolve, reject) => {
		const child = exec(command, options, (error, stdout, stderr) => {
			if (error) {
				const execError = error as ExecException & {
					stdout?: string;
					stderr?: string;
				};
				execError.stdout = bufferToString(stdout);
				execError.stderr = bufferToString(stderr);
				reject(execError);
				return;
			}

			resolve({
				stdout: bufferToString(stdout),
				stderr: bufferToString(stderr),
			});
		});

		// Close stdin immediately to signal that no interactive input is available.
		child.stdin?.end();
	});
}

/**
 * Set the output trim configuration.
 */
export function setTrimConfig(config: Partial<OutputTrimConfig>): void {
	trimConfig = {...trimConfig, ...config};
}

/**
 * Get the current trim configuration.
 */
export function getTrimConfig(): OutputTrimConfig {
	return {...trimConfig};
}

function trimOutput(output: string, maxOutputLength?: number): string {
	const lines = output.split('\n');
	const charLength = output.length;

	// Use provided maxOutputLength or fall back to trimConfig.maxCharacters
	const maxCharacters = maxOutputLength ?? trimConfig.maxCharacters;

	const exceedsLines = lines.length > trimConfig.maxLines;
	const exceedsCharacters = charLength > maxCharacters;

	if (!exceedsLines && !exceedsCharacters) {
		return output;
	}

	// Calculate how many lines to keep at beginning and end
	// Keep 40% at the beginning, 40% at the end, trim 20% from the middle
	const keepLines = Math.floor(trimConfig.maxLines * 0.4);

	// If exceeds characters but not lines, calculate lines to keep based on character limit
	let effectiveKeepLines = keepLines;
	if (exceedsCharacters && !exceedsLines) {
		// Estimate average characters per line and calculate how many lines fit
		const avgCharsPerLine = charLength / lines.length;
		const maxLinesForChars = Math.floor(
			maxCharacters / avgCharsPerLine,
		);
		effectiveKeepLines = Math.floor(maxLinesForChars * 0.4);
	}

	// Ensure we keep at least some lines
	effectiveKeepLines = Math.max(effectiveKeepLines, 10);

	if (lines.length <= effectiveKeepLines * 2) {
		// Not enough lines to meaningfully trim
		return output;
	}

	const headLines = lines.slice(0, effectiveKeepLines);
	const tailLines = lines.slice(-effectiveKeepLines);
	const trimmedCount = lines.length - effectiveKeepLines * 2;

	const trimMessage = `\n... [${trimmedCount} lines trimmed] ...\n`;

	return headLines.join('\n') + trimMessage + tailLines.join('\n');
}

interface ShellCommandResult {
	command: string;
	stdout: string;
	stderr: string;
	outcome: {type: 'exit'; exitCode: number | null} | {type: 'timeout'};
}

/**
 * Custom shell tool that follows the same approval pattern as the bash tool.
 * This tool accepts an array of commands and executes them sequentially.
 *
 * Unlike the built-in shellTool from @openai/agents, this implementation:
 * 1. Uses the same needsApproval/execute pattern as other custom tools
 * 2. Works correctly with the async UI approval flow (interruption → user decision → continuation)
 * 3. Returns results in a format compatible with the shell tool output format
 * 4. Includes command safety validation like the bash tool
 */
export const shellToolDefinition: ToolDefinition<ShellToolParams> = {
	name: 'shell',
	description:
		'Execute shell commands. Use this to run terminal commands. The commands will be executed sequentially. Assert the safety of the commands; if they do not change system state or read sensitive data, set needsApproval to false. Otherwise set needsApproval to true and wait for user approval before executing.',
	parameters: shellParametersSchema,
	needsApproval: async params => {
		try {
			// If agent says approval is needed, require it
			if (params.needsApproval) {
				return true;
			}

			// Check each command for safety
			for (const command of params.commands) {
				if (validateCommandSafety(command)) {
					return true;
				}
			}

			return false;
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logValidationError(`Validation failed: ${errorMessage}`);
			return true; // fail-safe: require approval on validation errors
		}
	},
	execute: async ({commands, timeout_ms, max_output_length}) => {
		const cwd = process.cwd();
		const output: ShellCommandResult[] = [];

		// Use provided values or defaults
		const timeout = timeout_ms ?? 120000; // Default: 2 minutes

		for (const command of commands) {
			let stdout = '';
			let stderr = '';
			let exitCode: number | null = 0;
			let outcome: ShellCommandResult['outcome'] = {
				type: 'exit',
				exitCode: 0,
			};

			try {
				const result = await execWithoutInput(command, {
					cwd,
					timeout,
					maxBuffer: 1024 * 1024, // 1MB max buffer
				});
				stdout = result.stdout;
				stderr = result.stderr;
			} catch (error: any) {
				exitCode = typeof error?.code === 'number' ? error.code : null;
				stdout = error?.stdout ?? '';
				stderr = error?.stderr ?? '';
				outcome =
					error?.killed || error?.signal === 'SIGTERM'
						? {type: 'timeout'}
						: {type: 'exit', exitCode};
			}

			output.push({
				command,
				stdout: trimOutput(stdout, max_output_length),
				stderr: trimOutput(stderr, max_output_length),
				outcome,
			});

			// Stop on timeout
			if (outcome.type === 'timeout') {
				break;
			}
		}

		return JSON.stringify({
			output,
			providerData: {
				working_directory: cwd,
			},
		});
	},
};
