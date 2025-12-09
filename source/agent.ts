import {searchToolDefinition} from './tools/search.js';
import {applyPatchToolDefinition} from './tools/apply-patch.js';
import {shellToolDefinition} from './tools/shell.js';
import type {ToolDefinition} from './tools/types.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {settingsService} from './services/settings-service.js';

export const DEFAULT_MODEL = 'gpt-5.1';
const BASE_INSTRUCTION_PATH = path.join(import.meta.dirname, '../prompts/default.md')

const baseInstructions = fs
    .readFileSync(
        BASE_INSTRUCTION_PATH,
        'utf-8',
    )
    .replace(/^# Agent Instructions\n+/, '')
    .trim();

const envInfo = `OS: ${os.type()} ${os.release()} (${os.platform()}); shell: ${
    settingsService.get<string>('app.shellPath') || 'unknown'
}; cwd: ${process.cwd()}`;

export interface AgentDefinition {
    name: string;
    instructions: string;
    tools: ToolDefinition[];
    model: string;
}

/**
 * Returns the agent definition with appropriate tools based on the model.
 */
export const getAgentDefinition = (model?: string): AgentDefinition => {
    const resolvedModel = model?.trim() || DEFAULT_MODEL;

    return {
        name: 'Terminal Assistant',
        instructions: `${baseInstructions}\n\nEnvironment: ${envInfo}`,
        tools: [
            shellToolDefinition,
            applyPatchToolDefinition,
            searchToolDefinition,
        ],
        model: resolvedModel,
    };
};
