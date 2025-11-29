import {z} from 'zod';
import {exec} from 'child_process';
import util from 'util';
import process from 'process';
import {validateCommandSafety} from '../utils/command-safety.js';
import {logValidationError} from '../utils/command-logger.js';
import type {ToolDefinition} from './types.js';

const execPromise = util.promisify(exec);

const shellParametersSchema = z.object({
	commands: z.array(z.string().min(1)).min(1, 'At least one command required'),
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
	/** Maximum size in bytes before trimming (default: 100KB) */
	maxBytes: number;
}

/** Default trim configuration */
export const DEFAULT_TRIM_CONFIG: OutputTrimConfig = {
	maxLines: 100,
	maxBytes: 1 * 1024, // 1KB
};

/** Current trim configuration (can be modified at runtime) */
let trimConfig: OutputTrimConfig = {...DEFAULT_TRIM_CONFIG};

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

/**
 * Trim output by keeping the beginning and end, removing the middle.
 * Returns the original output if it doesn't exceed limits.
 */
function trimOutput(output: string): string {
	const lines = output.split('\n');
	const byteSize = Buffer.byteLength(output, 'utf8');

	const exceedsLines = lines.length > trimConfig.maxLines;
	const exceedsBytes = byteSize > trimConfig.maxBytes;

	if (!exceedsLines && !exceedsBytes) {
		return output;
	}

	// Calculate how many lines to keep at beginning and end
	// Keep 40% at the beginning, 40% at the end, trim 20% from the middle
	const keepLines = Math.floor(trimConfig.maxLines * 0.4);

	// If exceeds bytes but not lines, calculate lines to keep based on byte limit
	let effectiveKeepLines = keepLines;
	if (exceedsBytes && !exceedsLines) {
		// Estimate average bytes per line and calculate how many lines fit
		const avgBytesPerLine = byteSize / lines.length;
		const maxLinesForBytes = Math.floor(trimConfig.maxBytes / avgBytesPerLine);
		effectiveKeepLines = Math.floor(maxLinesForBytes * 0.4);
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
	execute: async ({commands}) => {
		const cwd = process.cwd();
		const output: ShellCommandResult[] = [];

		for (const command of commands) {
			let stdout = '';
			let stderr = '';
			let exitCode: number | null = 0;
			let outcome: ShellCommandResult['outcome'] = {
				type: 'exit',
				exitCode: 0,
			};

			try {
				const result = await execPromise(command, {
					cwd,
					timeout: 120000, // 2 minute timeout
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
				stdout: trimOutput(stdout),
				stderr: trimOutput(stderr),
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
