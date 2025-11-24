import { Agent, tool } from '@openai/agents';
import { z } from 'zod';
import { exec } from 'child_process';
import util from 'util';
import {OpenAI} from 'openai';
import { isDangerousCommand, validateCommandSafety } from './utils/command-safety.js';
import { logCommandExecution, logValidationError } from './utils/command-logger.js';

const execPromise = util.promisify(exec);

export const client = new OpenAI();

const bashTool = tool({
	name: 'bash',
	description:
		'Execute a bash command. Use this to run terminal commands to help the user. Dangerous commands (rm, sudo, chmod, etc.) always require approval.',
	parameters: z.object({
		command: z.string().min(1, 'Command cannot be empty'),
		needsApproval: z.boolean(),
	}),
	needsApproval: async ({command, needsApproval}) => {
		// Layer 2: Business logic validation
		try {
			const isDangerous = validateCommandSafety(command);
			const requiresApproval = needsApproval || isDangerous;

			// Layer 4: Debug logging
			logCommandExecution(command, isDangerous, requiresApproval);

			return requiresApproval;
		} catch (error) {
			// Layer 3: Environment guard - fail safe on validation error
			logValidationError(`Validation failed: ${error.message}`);
			return true; // Always require approval if validation fails
		}
	},
	execute: async ({command}) => {
		try {
			// Layer 1: Entry point validation - validate before execution
			if (!command || typeof command !== 'string' || command.trim().length === 0) {
				return JSON.stringify({
					command,
					output: 'Error: Command cannot be empty',
					success: false
				});
			}

			// Layer 3: Environment guard - prevent dangerous commands from running
			// even if approval somehow bypassed this check
			if (isDangerousCommand(command)) {
				return JSON.stringify({
					command,
					output: 'Error: Dangerous command blocked. This command requires explicit approval.',
					success: false
				});
			}

			const {stdout, stderr} = await execPromise(command);
			const output = stderr ? `Error: ${stderr}` : stdout;
			return JSON.stringify({
				command,
				output,
				success: !stderr
			});
		} catch (error) {
			return JSON.stringify({
				command,
				output: `Error executing command: ${error.message}`,
				success: false
			});
		}
	},
});

export const agent = new Agent({
  name: 'Terminal Assistant',
  instructions: 'You are a helpful terminal assistant. You can execute bash commands to help the user. Be proactive and proceed when the user intention is clear.',
  tools: [bashTool],
});
