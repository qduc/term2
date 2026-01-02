import {grepToolDefinition} from './tools/grep.js';
import {readFileToolDefinition} from './tools/read-file.js';
import {findFilesToolDefinition} from './tools/find-files.js';
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
const LITE_PROMPT = 'lite.md';

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

function getEnvInfo(settingsService: ISettingsService, lite = false): string {
    const shellPath = settingsService.get<string>('app.shellPath') || 'unknown';
    if (lite) {
        // Minimal env info for lite mode - no cwd listing
        return `OS: ${os.type()} ${os.release()} (${os.platform()}); shell: ${shellPath}`;
    }
    return `OS: ${os.type()} ${os.release()} (${os.platform()}); shell: ${shellPath}; cwd: ${process.cwd()}; top-level: ${getTopLevelEntries(process.cwd())}`;
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

function getPromptPath(model: string, mentorMode: boolean, liteMode: boolean): string {
    const normalizedModel = model.trim().toLowerCase();

    // Lite mode takes precedence - minimal context for terminal assistance
    if (liteMode) {
        return path.join(BASE_PROMPT_PATH, LITE_PROMPT);
    }

    // In mentor mode, use simplified mentor prompt for all models
    if (mentorMode) {
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

    const mentorMode = settingsService.get<boolean>('app.mentorMode');
    const liteMode = settingsService.get<boolean>('app.liteMode');
    const promptPath = getPromptPath(resolvedModel, mentorMode, liteMode);
    const prompt = resolvePrompt(promptPath);

    const envInfo = getEnvInfo(settingsService, liteMode);

    const tools: ToolDefinition[] = [
        createShellToolDefinition({settingsService, loggingService}),
    ];

    if (liteMode) {
        // Lite mode: shell + read-only tools only (no editing tools)
        tools.push(grepToolDefinition, readFileToolDefinition, findFilesToolDefinition);
    } else {
        // Full mode: all tools based on model
        const isGpt5 = resolvedModel.toLowerCase().includes('gpt-5');

        if (isGpt5) {
            tools.push(
                createApplyPatchToolDefinition({settingsService, loggingService}),
            );
        } else {
            tools.push(
                grepToolDefinition,
                readFileToolDefinition,
                findFilesToolDefinition,
                createSearchReplaceToolDefinition({
                    settingsService,
                    loggingService,
                }),
            );
        }

        // Add mentor tool if configured (not in lite mode)
        const mentorModel = settingsService.get<string>('agent.mentorModel');
        if (mentorModel && askMentor) {
            tools.push(createAskMentorToolDefinition(askMentor));
        }
    }

    // In lite mode, skip AGENTS.md loading
    const agentsInstructions = liteMode ? '' : getAgentsInstructions();

    return {
        name: 'Terminal Assistant',
        instructions: `${prompt}\n\nEnvironment: ${envInfo}${agentsInstructions}`,
        tools,
        model: resolvedModel,
    };
};
