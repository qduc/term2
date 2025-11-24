import { Agent, tool } from '@openai/agents';
import { z } from 'zod';
import { exec } from 'child_process';
import util from 'util';
import { OpenAI } from 'openai';
import { isSafeCommand } from './safety-checker.js';

const execPromise = util.promisify(exec);

export const client = new OpenAI();

const bashTool = tool({
	name: 'bash',
	description:
		'Execute a bash command. Use this to run terminal commands to help the user. If the command could have side effects, ask for approval first.',
	parameters: z.object({
		command: z.string(),
		needsApproval: z.boolean(),
	}),
	needsApproval: async ({command, needsApproval}) => {
		return needsApproval;
	},
	execute: async ({command}) => {
		try {
			const {stdout, stderr} = await execPromise(command);
			const output = stderr ? `Error: ${stderr}` : stdout;
			// Return structured output that includes the command for transparency
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
