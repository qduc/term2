import {Agent, tool} from '@openai/agents';
import {z} from 'zod';
import {exec} from 'child_process';
import util from 'util';
import {OpenAI} from 'openai';
import {
	isDangerousCommand,
	validateCommandSafety,
} from './utils/command-safety.js';
import {logValidationError} from './utils/command-logger.js';

const execPromise = util.promisify(exec);

export const client = new OpenAI();

const bashTool = tool({
	name: 'bash',
	description:
		'Execute a bash command. Use this to run terminal commands. Assert the safety of the command; if the command does not change system state or read sensitive data, set needsApproval to false. Otherwise set needsApproval to true and wait for user approval before executing.',
	parameters: z.object({
		command: z.string().min(1, 'Command cannot be empty'),
		needsApproval: z.boolean(),
	}),
	needsApproval: async (_context, params) => {
		try {
			return params.needsApproval || validateCommandSafety(params.command);
		} catch (error) {
			logValidationError(`Validation failed: ${error.message}`);
			return true; // fail-safe: require approval on validation errors
		}
	},
	execute: async ({command}) => {
		try {
			if (
				!command ||
				typeof command !== 'string' ||
				command.trim().length === 0
			) {
				return JSON.stringify({
					command,
					output: 'Error: Command cannot be empty',
					success: false,
				});
			}

			if (isDangerousCommand(command)) {
				return JSON.stringify({
					command,
					output:
						'Error: Dangerous command blocked. This command requires explicit approval.',
					success: false,
				});
			}

			const {stdout, stderr} = await execPromise(command);
			const output = stderr ? `Error: ${stderr}` : stdout;
			return JSON.stringify({command, output, success: !stderr});
		} catch (error) {
			return JSON.stringify({
				command,
				output: `Error executing command: ${error.message}`,
				success: false,
			});
		}
	},
});

export const agent = new Agent({
	name: 'Terminal Assistant',
	instructions:
		'You are a helpful terminal assistant. You can execute bash commands to help the user. Be proactive and proceed when the user intention is clear.',
	tools: [bashTool],
});
