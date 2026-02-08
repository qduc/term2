import { createGrepToolDefinition } from './tools/grep.js';
import { createReadFileToolDefinition } from './tools/read-file.js';
import { createFindFilesToolDefinition } from './tools/find-files.js';
import { createSearchReplaceToolDefinition } from './tools/search-replace.js';
import { createApplyPatchToolDefinition } from './tools/apply-patch.js';
import { createShellToolDefinition } from './tools/shell.js';
import { createAskMentorToolDefinition } from './tools/ask-mentor.js';
import { createWebSearchToolDefinition } from './tools/web-search.js';
import { createWebFetchToolDefinition } from './tools/web-fetch.js';
import { createCreateFileToolDefinition } from './tools/create-file.js';
import type { ToolDefinition } from './tools/types.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import type { ISettingsService, ILoggingService } from './services/service-interfaces.js';
import { ExecutionContext } from './services/execution-context.js';

const BASE_PROMPT_PATH = path.join(import.meta.dirname, './prompts');

const DEFAULT_PROMPT = 'simple.md';
const ANTHROPIC_PROMPT = 'anthropic.md';
const GPT_PROMPT = 'gpt-5.md';
const CODEX_PROMPT = 'codex.md';
const LITE_PROMPT = 'lite.md';

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

export function getEnvInfo(
  settingsService: ISettingsService,
  executionContext?: ExecutionContext,
  lite = false,
): string {
  const shellPath = settingsService.get<string>('app.shellPath') || 'unknown';
  const cwd = executionContext?.getCwd() || process.cwd();
  const osType = os.type();
  const osRelease = os.release();
  const osPlatform = os.platform();

  if (lite) {
    // Minimal env info for lite mode - no cwd listing
    return `OS: ${osType} ${osRelease} (${osPlatform}); shell: ${shellPath}`;
  }

  // For remote sessions, we might not be able to list top-level entries efficiently or at all easily here synchronously
  // We'll skip top-level entries for now if remote, or maybe we can't get them sync.
  // getTopLevelEntries is sync and uses fs.readdirSync. This won't work for remote.
  // So if remote, we skip that part.
  let topLevel = '';
  if (!executionContext?.isRemote()) {
    topLevel = `; top-level: ${getTopLevelEntries(cwd)}`;
  }

  return `OS: ${osType} ${osRelease} (${osPlatform}); shell: ${shellPath}; cwd: ${cwd}${topLevel}`;
}

export function getAgentsInstructions(cwd: string): string {
  const agentsPath = path.join(cwd, 'AGENTS.md');
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

function getPromptPath(model: string, liteMode: boolean): string {
  const normalizedModel = model.trim().toLowerCase();

  // Lite mode takes precedence - minimal context for terminal assistance
  if (liteMode) {
    return path.join(BASE_PROMPT_PATH, LITE_PROMPT);
  }

  if (normalizedModel.includes('sonnet') || normalizedModel.includes('haiku'))
    return path.join(BASE_PROMPT_PATH, ANTHROPIC_PROMPT);
  if (normalizedModel.includes('gpt-5') && normalizedModel.includes('codex'))
    return path.join(BASE_PROMPT_PATH, CODEX_PROMPT);
  if (normalizedModel.includes('gpt-5')) return path.join(BASE_PROMPT_PATH, GPT_PROMPT);

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
export const getAgentDefinition = (
  deps: {
    settingsService: ISettingsService;
    loggingService: ILoggingService;
    executionContext?: ExecutionContext;
    askMentor?: (question: string) => Promise<string>;
  },
  model?: string,
): AgentDefinition => {
  const { settingsService, loggingService, executionContext, askMentor } = deps;
  const defaultModel = settingsService.get<string>('agent.model');
  const resolvedModel = model?.trim() || defaultModel;

  if (!resolvedModel) throw new Error('Model cannot be undefined or empty');

  const mentorMode = settingsService.get<boolean>('app.mentorMode');
  const liteMode = settingsService.get<boolean>('app.liteMode');
  const promptPath = getPromptPath(resolvedModel, liteMode);
  let prompt = resolvePrompt(promptPath);

  if (mentorMode && !liteMode) {
    const addonPath = path.join(BASE_PROMPT_PATH, 'mentor-addon.md');
    try {
      const addon = resolvePrompt(addonPath);
      prompt = `${prompt}\n\n${addon}`;
    } catch (e) {
      loggingService.error(`Failed to load mentor addon: ${e}`);
    }
  }

  const envInfo = getEnvInfo(settingsService, executionContext, liteMode);
  const cwd = executionContext?.getCwd() || process.cwd();

  const tools: ToolDefinition[] = [
    createShellToolDefinition({ settingsService, loggingService, executionContext }),
    createWebSearchToolDefinition({
      settingsService,
      loggingService,
    }),
    createWebFetchToolDefinition({
      settingsService,
      loggingService,
    }),
  ];

  if (liteMode) {
    // Lite mode: shell + read-only tools only (no editing tools)
    tools.push(
      createGrepToolDefinition({ executionContext }),
      createReadFileToolDefinition({
        executionContext,
        allowOutsideWorkspace: true,
      }),
      createFindFilesToolDefinition({
        executionContext,
        allowOutsideWorkspace: true,
      }),
    );
  } else {
    // Full mode: all tools based on model
    const isGpt5 = resolvedModel.toLowerCase().includes('gpt-5');

    if (isGpt5) {
      tools.push(createApplyPatchToolDefinition({ settingsService, loggingService, executionContext }));
    } else {
      tools.push(
        createGrepToolDefinition({ executionContext }),
        createReadFileToolDefinition({ executionContext }),
        createFindFilesToolDefinition({ executionContext }),
        createCreateFileToolDefinition({
          settingsService,
          loggingService,
          executionContext,
        }),
        createSearchReplaceToolDefinition({
          settingsService,
          loggingService,
          executionContext,
        }),
      );
    }

    // Add mentor tool if configured (not in lite mode)
    const mentorModel = settingsService.get<string>('agent.mentorModel');
    if (mentorModel && askMentor) {
      tools.push(createAskMentorToolDefinition(askMentor));
    }
  }

  // In lite mode, skip AGENTS.md loading.
  // In remote mode, we also skip because we can't synchronously read from remote disk.
  const agentsInstructions = liteMode || executionContext?.isRemote() ? '' : getAgentsInstructions(cwd);

  return {
    name: 'Terminal Assistant',
    instructions: `${prompt}\n\nEnvironment: ${envInfo}${agentsInstructions}`,
    tools,
    model: resolvedModel,
  };
};
