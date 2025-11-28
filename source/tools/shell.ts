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
				stdout,
				stderr,
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
