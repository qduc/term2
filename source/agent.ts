import {Agent} from '@openai/agents';
import {OpenAI} from 'openai';
import {bashTool} from './tools/bash.js';
import os from 'os';

export const client = new OpenAI();

export const DEFAULT_MODEL = 'gpt-4.1';

const baseInstructions =
	'You are a helpful terminal assistant. You can execute bash commands to help the user. Be proactive and proceed when the user intention is clear. Keep going until the task is fully complete.';

const envInfo = `OS: ${os.type()} ${os.release()} (${os.platform()}); shell: ${
	process.env.SHELL || process.env.COMSPEC || 'unknown'
}; cwd: ${process.cwd()}`;

export const createAgent = ({
	model,
}: {
	model?: string | null;
} = {}): Agent => {
	const resolvedModel = model?.trim() || DEFAULT_MODEL;

	return new Agent({
		name: 'Terminal Assistant',
		model: resolvedModel,
		instructions: `${baseInstructions}\n\nEnvironment: ${envInfo}`,
		tools: [bashTool],
	});
};

export const defaultAgent = createAgent();
