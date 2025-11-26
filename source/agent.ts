import {Agent} from '@openai/agents';
import {OpenAI} from 'openai';
import {bashTool} from './tools/bash.js';

export const client = new OpenAI();

export const agent = new Agent({
	name: 'Terminal Assistant',
	instructions:
		'You are a helpful terminal assistant. You can execute bash commands to help the user. Be proactive and proceed when the user intention is clear.',
	tools: [bashTool],
});
