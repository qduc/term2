import { createGrepToolDefinition } from './tools/grep.js';
import { createReadFileToolDefinition } from './tools/read-file.js';
import { createFindFilesToolDefinition } from './tools/find-files.js';
import { createSearchReplaceToolDefinition } from './tools/search-replace.js';
import { createApplyPatchToolDefinition } from './tools/apply-patch.js';
import { createShellToolDefinition } from './tools/shell.js';
import { createAskMentorToolDefinition } from './tools/ask-mentor.js';
import { createRunSubagentToolDefinition } from './tools/run-subagent.js';
import { createWebSearchToolDefinition } from './tools/web-search.js';
import { createWebFetchToolDefinition } from './tools/web-fetch.js';
import { createCreateFileToolDefinition } from './tools/create-file.js';
import { createCodeContextSearchToolDefinition, createReadCodeOutlineToolDefinition } from './tools/code-context.js';
import { registerToolFormatters } from './tools/command-message-formatters.js';
import type { ToolDefinition } from './tools/types.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import type { ISettingsService, ILoggingService } from './services/service-interfaces.js';
import { ExecutionContext } from './services/execution-context.js';
import { getPromptPath } from './prompts/prompt-selector.js';
import { shouldPreferPatchEditingModel } from './lib/tool-selection-policy.js';
import { getSearchViaShellAddendum } from './prompts/search-via-shell.js';
import { getSubagentDelegationAddendum } from './prompts/subagent-delegation.js';

const BASE_PROMPT_PATH = path.join(import.meta.dirname, './prompts');

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

  const now = new Date().toISOString().slice(0, 10);

  if (lite) {
    // Minimal env info for lite mode - no cwd listing
    return `OS: ${osType} ${osRelease} (${osPlatform}); shell: ${shellPath}; date: ${now}`;
  }

  // For remote sessions, we might not be able to list top-level entries efficiently or at all easily here synchronously
  // We'll skip top-level entries for now if remote, or maybe we can't get them sync.
  // getTopLevelEntries is sync and uses fs.readdirSync. This won't work for remote.
  // So if remote, we skip that part.
  let topLevel = '';
  if (!executionContext?.isRemote()) {
    topLevel = `; top-level: ${getTopLevelEntries(cwd)}`;
  }

  return `OS: ${osType} ${osRelease} (${osPlatform}); shell: ${shellPath}; cwd: ${cwd}${topLevel}; date: ${now}`;
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
    runSubagent?: (params: { role: string; task: string; writeBoundary?: string[] }) => Promise<any>;
  },
  model?: string,
): AgentDefinition => {
  const { settingsService, loggingService, executionContext, askMentor, runSubagent } = deps;
  const defaultModel = settingsService.get<string>('agent.model');
  const resolvedModel = model?.trim() || defaultModel;

  if (!resolvedModel) throw new Error('Model cannot be undefined or empty');

  const mentorMode = settingsService.get<boolean>('app.mentorMode');
  const liteMode = settingsService.get<boolean>('app.liteMode');
  const searchViaShell = settingsService.get<boolean>('app.searchViaShell');
  // Code-context tools operate on the local filesystem only; disable them for
  // remote (SSH) execution where the workspace lives on another host.
  const codeContextEnabled = !(executionContext?.isRemote() ?? false);
  const isGpt5 = !liteMode && shouldPreferPatchEditingModel(resolvedModel);
  const promptPath = getPromptPath({ basePromptDir: BASE_PROMPT_PATH, model: resolvedModel, liteMode });
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

  const codeContextDoc = codeContextEnabled
    ? liteMode
      ? '### Code Context Tools\n\n- `read_code_outline`: inspect file structure.\n- `code_context_search`: find related files or symbol declarations. Use `read_file` before editing.'
      : '### Code Context Tools\n\n- Use `read_code_outline` for a compact file outline.\n- Use `code_context_search` for related files or symbol declarations.\n- Use `read_file` before editing.'
    : '';

  if (codeContextDoc) {
    prompt = `${prompt}\n\n${codeContextDoc}`;
  }

  if (searchViaShell) {
    try {
      const addendum = getSearchViaShellAddendum({ executionContext });
      prompt = `${prompt}\n\n${addendum}`;
    } catch (e) {
      loggingService.error(`Failed to load search-via-shell addendum: ${e}`);
    }
  } else {
    if (!isGpt5) {
      const searchToolsDoc = liteMode
        ? '### Search Tools\n\n- `find_files`: locate files by name or glob.\n- `grep`: search file contents.'
        : '### Search Tools\n\n- Prefer `find_files` for locating files by name or glob.\n- Prefer `grep` for searching code content or symbols.';
      prompt = `${prompt}\n\n${searchToolsDoc}`;
    }
  }

  // Delegation guidance is injected under the same condition that registers
  // the run_subagent tool (full mode + runSubagent dependency available).
  if (!liteMode && runSubagent) {
    prompt = `${prompt}\n\n${getSubagentDelegationAddendum()}`;
  }

  try {
    const planModeInfoPath = path.join(BASE_PROMPT_PATH, 'plan-mode-info.md');
    prompt = `${prompt}\n\n${resolvePrompt(planModeInfoPath)}`;
  } catch (e) {
    loggingService.error(`Failed to load plan-mode-info: ${e}`);
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

  if (codeContextEnabled) {
    tools.push(
      createReadCodeOutlineToolDefinition({ executionContext }),
      createCodeContextSearchToolDefinition({ executionContext }),
    );
  }

  if (liteMode) {
    // Lite mode: shell + read-only tools only (no editing tools)
    if (!searchViaShell) {
      tools.push(
        createGrepToolDefinition({ executionContext }),
        createFindFilesToolDefinition({
          executionContext,
          allowOutsideWorkspace: true,
        }),
      );
    }
    tools.push(
      createReadFileToolDefinition({
        executionContext,
        allowOutsideWorkspace: true,
      }),
    );
  } else {
    // Full mode: all tools based on model
    if (isGpt5) {
      tools.push(createApplyPatchToolDefinition({ settingsService, loggingService, executionContext }));
    } else {
      if (!searchViaShell) {
        tools.push(createGrepToolDefinition({ executionContext }), createFindFilesToolDefinition({ executionContext }));
      }
      tools.push(
        createReadFileToolDefinition({ executionContext }),
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

    // Add run_subagent tool (not in lite mode)
    if (runSubagent) {
      tools.push(createRunSubagentToolDefinition(runSubagent));
    }
  }

  registerToolFormatters(tools);

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
