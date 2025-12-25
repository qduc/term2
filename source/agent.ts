import {grepToolDefinition} from './tools/grep.js';
import {createSearchReplaceToolDefinition} from './tools/search-replace.js';
import {createApplyPatchToolDefinition} from './tools/apply-patch.js';
import {createShellToolDefinition} from './tools/shell.js';
import {createAskMentorToolDefinition} from './tools/ask-mentor.js';
import type {ToolDefinition} from './tools/types.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import type {
    ISettingsService,
    ILoggingService,
} from './services/service-interfaces.js';

const BASE_PROMPT_PATH = path.join(import.meta.dirname, './prompts');

const DEFAULT_PROMPT = 'simple.md';
const ANTHROPIC_PROMPT = 'anthropic.md';
const GPT_PROMPT = 'gpt-5.md';
const CODEX_PROMPT = 'codex.md';
const DEFAULT_MENTOR_PROMPT = 'simple-mentor.md';

function getTopLevelEntries(cwd: string, limit = 50): string {
    try {
        const entries = fs.readdirSync(cwd, {withFileTypes: true});
        const names = entries.map(e =>
            e.isDirectory() ? `${e.name}/` : e.name,
        );
        const shown = names.slice(0, limit);
        const more =
            names.length > limit ? `, ...(+${names.length - limit} more)` : '';
        return shown.join(', ') + more;
    } catch (e: any) {
        return `failed to read: ${e.message}`;
    }
}

function getEnvInfo(settingsService: ISettingsService): string {
    return `OS: ${os.type()} ${os.release()} (${os.platform()}); shell: ${
        settingsService.get<string>('app.shellPath') || 'unknown'
    }; cwd: ${process.cwd()}; top-level: ${getTopLevelEntries(process.cwd())}`;
}

function getAgentsInstructions(): string {
    const agentsPath = path.join(process.cwd(), 'AGENTS.md');
    if (!fs.existsSync(agentsPath)) return '';

    try {
        const contents = fs.readFileSync(agentsPath, 'utf-8').trim();
        return `\n\nAGENTS.md contents:\n${contents}`;
    } catch (e: any) {
        return `\n\nFailed to read AGENTS.md: ${e.message}`;
    }
}

export interface AgentDefinition {
    name: string;
    instructions: string;
    tools: ToolDefinition[];
    model: string;
}

function getPromptPath(model: string, mode?: 'default' | 'edit' | 'mentor'): string {
    const normalizedModel = model.trim().toLowerCase();

    // In mentor mode, use simplified mentor prompt for all models
    if (mode === 'mentor') {
        return path.join(BASE_PROMPT_PATH, DEFAULT_MENTOR_PROMPT);
    }

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
        throw new Error(
            `Failed to read prompt file at ${promptPath}: ${e.message}`,
        );
    }
}

/**
 * Returns the agent definition with appropriate tools based on the model.
 */
export const getAgentDefinition = (
    deps: {
        settingsService: ISettingsService;
        loggingService: ILoggingService;
        askMentor?: (question: string) => Promise<string>;
    },
    model?: string,
): AgentDefinition => {
    const {settingsService, loggingService, askMentor} = deps;
    const defaultModel = settingsService.get<string>('agent.model');
    const resolvedModel = model?.trim() || defaultModel;

    if (!resolvedModel) throw new Error('Model cannot be undefined or empty');

    const mode = settingsService.get<'default' | 'edit' | 'mentor'>('app.mode');
    const promptPath = getPromptPath(resolvedModel, mode);
    const prompt = resolvePrompt(promptPath);

    const envInfo = getEnvInfo(settingsService);

    const tools: ToolDefinition[] = [
        createShellToolDefinition({settingsService, loggingService}),
        grepToolDefinition,
    ];

    if (
        resolvedModel.includes('gpt-5.1') ||
        resolvedModel.includes('gpt-5.2')
    ) {
        tools.push(
            createApplyPatchToolDefinition({settingsService, loggingService}),
        );
    } else {
        tools.push(
            createSearchReplaceToolDefinition({
                settingsService,
                loggingService,
            }),
        );
    }

    // Add mentor tool if configured
    const mentorModel = settingsService.get<string>('agent.mentorModel');
    if (mentorModel && askMentor) {
        tools.push(createAskMentorToolDefinition(askMentor));
    }

    return {
        name: 'Terminal Assistant',
        instructions: `${prompt}\n\nEnvironment: ${envInfo}${getAgentsInstructions()}`,
        tools,
        model: resolvedModel,
    };
};
