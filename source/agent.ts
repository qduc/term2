import {searchToolDefinition} from './tools/search.js';
import {applyPatchToolDefinition} from './tools/apply-patch.js';
import {shellToolDefinition} from './tools/shell.js';
import type {ToolDefinition} from './tools/types.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {settingsService} from './services/settings-service.js';

export const DEFAULT_MODEL = settingsService.get<string>('agent.model');

const BASE_PROMPT_PATH = path.join(import.meta.dirname, './prompts')

const DEFAULT_PROMPT = 'default.md';
const ANTHROPIC_PROMPT = 'anthropic.md';
const GPT_PROMPT = 'gpt-5.md';
const CODEX_PROMPT = 'codex.md';

function getTopLevelEntries(cwd: string, limit = 50): string {
    try {
        const entries = fs.readdirSync(cwd, { withFileTypes: true });
        const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        const shown = names.slice(0, limit);
        const more = names.length > limit ? `, ...(+${names.length - limit} more)` : '';
        return shown.join(', ') + more;
    } catch (e: any) {
        return `failed to read: ${e.message}`;
    }
}

const envInfo = `OS: ${os.type()} ${os.release()} (${os.platform()}); shell: ${
    settingsService.get<string>('app.shellPath') || 'unknown'
}; cwd: ${process.cwd()}; top-level: ${getTopLevelEntries(process.cwd())}`;

const contextReminder = 'If there is a file named AGENTS.md in project root. You must read it to understand what you are working with'

export interface AgentDefinition {
    name: string;
    instructions: string;
    tools: ToolDefinition[];
    model: string;
}

function getPromptPath(model: string): string {
	const normalizedModel = model.trim().toLowerCase();

	if (normalizedModel.includes('sonnet') || normalizedModel.includes('haiku'))
		return path.join(BASE_PROMPT_PATH, ANTHROPIC_PROMPT);
	if (normalizedModel.includes('gpt-5') && normalizedModel.includes('codex'))
		return path.join(BASE_PROMPT_PATH, CODEX_PROMPT);
	if (normalizedModel.includes('gpt-5'))
		return path.join(BASE_PROMPT_PATH, GPT_PROMPT);

	return path.join(BASE_PROMPT_PATH, DEFAULT_PROMPT);
}

function resolvePrompt(promptPath: string): string {
	try {
		return fs.readFileSync(promptPath, 'utf-8').trim();
	} catch (e: any) {
		throw new Error(`Failed to read prompt file at ${promptPath}: ${e.message}`);
	}
}

/**
 * Returns the agent definition with appropriate tools based on the model.
 */
export const getAgentDefinition = (model?: string): AgentDefinition => {
    const resolvedModel = model?.trim() || DEFAULT_MODEL;

	if (!resolvedModel)
		throw new Error('Model cannot be undefined or empty');

	const promptPath = getPromptPath(resolvedModel);
	const prompt = resolvePrompt(promptPath);

    return {
        name: 'Terminal Assistant',
        instructions: `${prompt}\n\nEnvironment: ${envInfo}\n\n${contextReminder}`,
        tools: [
            shellToolDefinition,
            applyPatchToolDefinition,
            searchToolDefinition,
        ],
        model: resolvedModel,
    };
};
