import {bashToolDefinition} from './tools/bash.js';
import {applyPatchToolDefinition} from './tools/apply-patch.js';
import type {ToolDefinition} from './tools/types.js';
import os from 'os';
import fs from 'fs';
import path from 'path';

export const DEFAULT_MODEL = 'gpt-5.1';

const baseInstructions = fs
	.readFileSync(
		path.join(import.meta.dirname, '../docs/agent-instructions.md'),
		'utf-8',
	)
	.replace(/^# Agent Instructions\n+/, '')
	.trim();

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
	tools: [bashToolDefinition, applyPatchToolDefinition],
};

export const getAgentDefinition = (): AgentDefinition => agentDefinition;
