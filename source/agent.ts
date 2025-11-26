import {bashToolDefinition} from './tools/bash.js';
import type {ToolDefinition} from './tools/types.js';
import os from 'os';

export const DEFAULT_MODEL = 'gpt-4.1';

const baseInstructions =
	'You are a helpful terminal assistant. You can execute bash commands to help the user. Be proactive and proceed when the user intention is clear. Keep going until the task is fully complete.';

const envInfo = `OS: ${os.type()} ${os.release()} (${os.platform()}); shell: ${
	process.env.SHELL || process.env.COMSPEC || 'unknown'
}; cwd: ${process.cwd()}`;

export interface AgentDefinition {
	name: string;
	instructions: string;
	tools: ToolDefinition[];
}

const agentDefinition: AgentDefinition = {
	name: 'Terminal Assistant',
	instructions: `${baseInstructions}\n\nEnvironment: ${envInfo}`,
	tools: [bashToolDefinition],
};

export const getAgentDefinition = (): AgentDefinition => agentDefinition;
