import { createGrepToolDefinition } from './tools/system/grep.js';
import { createReadFileToolDefinition } from './tools/file/read-file.js';
import { createFindFilesToolDefinition } from './tools/file/find-files.js';
import { createSearchReplaceToolDefinition } from './tools/file/search-replace.js';
import { createApplyPatchToolDefinition } from './tools/file/apply-patch.js';
import { createShellToolDefinition } from './tools/system/shell.js';
import { createAskMentorToolDefinition } from './tools/agent/ask-mentor.js';
import { createAskUserToolDefinition } from './tools/agent/ask-user.js';
import { createRunSubagentToolDefinition } from './tools/agent/run-subagent.js';
import { createWebSearchToolDefinition } from './tools/web/web-search.js';
import { createWebFetchToolDefinition } from './tools/web/web-fetch.js';
import { createCreateFileToolDefinition } from './tools/file/create-file.js';
import {
  createCodeContextSearchToolDefinition,
  createReadCodeOutlineToolDefinition,
} from './tools/system/code-context.js';
import { registerToolFormatters } from './tools/command-message-formatters.js';
import { TOOL_NAME_ASK_USER } from './tools/tool-names.js';
import type { ToolDefinition } from './tools/types.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { default as createIgnore, type Ignore } from 'ignore';
import type { ISettingsService, ILoggingService } from './services/service-interfaces.js';
import { ExecutionContext } from './services/execution-context.js';
import { buildPromptSpec } from './prompts/prompt-constructor.js';
import { shouldPreferPatchEditingModel } from './lib/tool-selection-policy.js';
import { SkillsService } from './services/skills/skills-service.js';
import { createActivateSkillToolDefinition } from './tools/agent/activate-skill.js';

const BASE_PROMPT_PATH = path.join(import.meta.dirname, './prompts');

type ProjectTreeOptions = {
  maxDepth?: number;
  maxEntriesPerDir?: number;
  maxTotalEntries?: number;
  includeFiles?: boolean;
  ignoredNames?: Set<string>;
};

const ALWAYS_IGNORE = ['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', '.cache', '.DS_Store'];

const ALWAYS_INCLUDE = new Set([
  'package.json',
  'tsconfig.json',
  'README.md',
  'readme.md',
  '.gitignore',
  '.env.example',
]);

const SENSITIVE_PATTERNS = [/^\.env$/, /^\.env\./, /secret/i, /private/i, /credential/i, /token/i];

function isSensitiveFile(name: string) {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name));
}

function createProjectIgnore(cwd: string) {
  const ig = (createIgnore as unknown as () => Ignore)();

  ig.add(ALWAYS_IGNORE);

  const gitignorePath = path.join(cwd, '.gitignore');

  try {
    if (fs.existsSync(gitignorePath)) {
      ig.add(fs.readFileSync(gitignorePath, 'utf8'));
    }
  } catch {
    // If .gitignore cannot be read, continue with default ignores.
  }

  return {
    ignores(relativePath: string, basename: string) {
      const normalized = relativePath.split(path.sep).join('/');

      if (ALWAYS_INCLUDE.has(basename)) {
        return false;
      }

      return ig.ignores(normalized);
    },
  };
}

export function getProjectTreeForPrompt(cwd: string, options: ProjectTreeOptions = {}): string {
  const { maxDepth = 3, maxEntriesPerDir = 50, maxTotalEntries = 250, includeFiles = true } = options;

  let totalEntries = 0;
  let omittedByLimit = 0;

  const projectIgnore = createProjectIgnore(cwd);

  function walk(dir: string, depth: number, prefix: string): string[] {
    if (depth > maxDepth || totalEntries >= maxTotalEntries) return [];

    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e: any) {
      return [`${prefix}└─ [failed to read: ${e.message}]`];
    }

    const filtered = entries
      .filter((entry) => {
        const absolutePath = path.join(dir, entry.name);
        const relativePath = path.relative(cwd, absolutePath).split(path.sep).join('/');

        if (isSensitiveFile(entry.name)) {
          return false;
        }

        if (projectIgnore.ignores(relativePath, entry.name)) {
          return false;
        }

        if (!includeFiles && !entry.isDirectory()) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    const shown = filtered.slice(0, maxEntriesPerDir);
    omittedByLimit += Math.max(0, filtered.length - shown.length);

    const lines: string[] = [];
    const subdirs: Array<{ path: string; depth: number; prefix: string }> = [];

    // BFS: render all children at this level first, then recurse into subdirs.
    // This guarantees breadth-first budget allocation — shallower entries
    // always take priority over deeper ones.
    for (let index = 0; index < shown.length; index++) {
      if (totalEntries >= maxTotalEntries) {
        omittedByLimit += shown.length - index;
        break;
      }

      const entry = shown[index];
      totalEntries++;

      const isLast = index === shown.length - 1;
      const connector = isLast ? '└─ ' : '├─ ';
      const childPrefix = prefix + (isLast ? '   ' : '│  ');
      const displayName = entry.isDirectory() ? `${entry.name}/` : entry.name;

      lines.push(`${prefix}${connector}${displayName}`);

      if (entry.isDirectory()) {
        if (depth >= maxDepth) {
          lines.push(`${childPrefix}└─ …`);
        } else {
          subdirs.push({
            path: path.join(dir, entry.name),
            depth: depth + 1,
            prefix: childPrefix,
          });
        }
      }
    }

    // Now recurse into collected subdirs (BFS step 2: children of children).
    // Each subdir call starts a new breadth-first pass, but since they are
    // processed after all current-level siblings are rendered, the budget
    // naturally fills shallower levels first.
    for (const subdir of subdirs) {
      if (totalEntries >= maxTotalEntries) break;
      lines.push(...walk(subdir.path, subdir.depth, subdir.prefix));
    }

    return lines;
  }

  try {
    const lines = ['Project structure:', '.', ...walk(cwd, 1, ''), ''];

    if (omittedByLimit > 0) {
      lines.push(`- Omitted due to limits: ${omittedByLimit}`);
    }

    return lines.join('\n');
  } catch (e: any) {
    return `Project structure:\n[failed to read ${cwd}: ${e.message}]`;
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
    // Minimal env info for lite mode
    return `OS: ${osType} ${osRelease} (${osPlatform}); shell: ${shellPath}; cwd: ${cwd}; date: ${now}`;
  }

  // For remote sessions, we might not be able to list top-level entries efficiently or at all easily here synchronously
  // We'll skip top-level entries for now if remote, or maybe we can't get them sync.
  // getProjectTreeForPrompt is sync and uses fs.readdirSync. This won't work for remote.
  // So if remote, we skip that part.
  let topLevel = '';
  if (!executionContext?.isRemote()) {
    topLevel = `${getProjectTreeForPrompt(cwd)}`;
  }

  return `OS: ${osType} ${osRelease} (${osPlatform}); shell: ${shellPath}; cwd: ${cwd}; date: ${now}\n${topLevel}\n\n`;
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
    const relativePromptPath = path.relative(BASE_PROMPT_PATH, promptPath);
    const sourcePromptPath = path.join(
      import.meta.dirname,
      '../source/prompts',
      relativePromptPath.startsWith('..') ? path.basename(promptPath) : relativePromptPath,
    );
    if (sourcePromptPath !== promptPath && fs.existsSync(sourcePromptPath)) {
      return fs.readFileSync(sourcePromptPath, 'utf-8').trim();
    }
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
    runSubagent?: (params: { role: string; task: string }, context?: unknown, details?: unknown) => Promise<any>;
    getAskUserAnswer?: (callId?: string) => string | undefined;
    skillsService?: SkillsService;
  },
  model?: string,
): AgentDefinition => {
  const { settingsService, loggingService, executionContext, askMentor, runSubagent, getAskUserAnswer, skillsService } =
    deps;
  const defaultModel = settingsService.get<string>('agent.model');
  const resolvedModel = model?.trim() || defaultModel;

  if (!resolvedModel) throw new Error('Model cannot be undefined or empty');

  const planMode = settingsService.get<boolean>('app.planMode');
  const mentorMode = settingsService.get<boolean>('app.mentorMode');
  const liteMode = settingsService.get<boolean>('app.liteMode');
  const orchestratorMode = settingsService.get<boolean>('app.orchestratorMode');
  const searchViaShellSetting = settingsService.get<'auto' | 'on' | 'off'>('app.searchViaShell') ?? 'auto';
  const searchViaShell =
    searchViaShellSetting === 'auto' ? shouldPreferPatchEditingModel(resolvedModel) : searchViaShellSetting === 'on';
  // Code-context tools operate on the local filesystem only; disable them for
  // remote (SSH) execution where the workspace lives on another host.
  const codeContextEnabled = !(executionContext?.isRemote() ?? false);
  const isGpt5 = !liteMode && shouldPreferPatchEditingModel(resolvedModel);
  const promptSpec = buildPromptSpec({
    model: resolvedModel,
    liteMode,
    orchestratorMode,
    mentorMode,
    planMode,
    searchViaShell,
    codeContextEnabled,
    runSubagentEnabled: Boolean(runSubagent),
    executionContext,
  });
  let prompt = resolvePrompt(path.join(BASE_PROMPT_PATH, promptSpec.basePromptFile));

  for (const fragmentFile of promptSpec.fragmentFiles) {
    try {
      prompt = `${prompt}\n\n${resolvePrompt(path.join(BASE_PROMPT_PATH, fragmentFile))}`;
    } catch (e) {
      loggingService.error(`Failed to load prompt fragment ${fragmentFile}: ${e}`);
    }
  }

  for (const inlineSection of promptSpec.inlineSections) {
    prompt = `${prompt}\n\n${inlineSection}`;
  }

  const cwd = executionContext?.getCwd() || process.cwd();
  const isLiteEnv = liteMode && !orchestratorMode && !planMode;
  const envInfo = getEnvInfo(settingsService, executionContext, isLiteEnv);
  const skipAgentsMd = isLiteEnv || (executionContext?.isRemote() ?? false);
  const agentsInstructions = skipAgentsMd ? '' : getAgentsInstructions(cwd);

  let skillsInstructions = '';
  if (skillsService) {
    const catalog = skillsService.getSkillCatalog();
    if (catalog) {
      skillsInstructions = `\n\n${catalog}`;
    }
  }

  if (orchestratorMode) {
    if (!runSubagent) {
      throw new Error(
        'orchestratorMode requires runSubagent: cannot build orchestrator agent without a runSubagent implementation.',
      );
    }
    const tools: ToolDefinition[] = [
      createRunSubagentToolDefinition(runSubagent),
      createShellToolDefinition({ settingsService, loggingService, executionContext, orchestratorMode: true }),
      createReadFileToolDefinition({ executionContext, allowOutsideWorkspace: true, orchestratorMode: true }),
      createGrepToolDefinition({ executionContext, orchestratorMode: true }),
    ];
    if (getAskUserAnswer) {
      const askUserTool = createAskUserToolDefinition(getAskUserAnswer);
      if (askUserTool.name !== TOOL_NAME_ASK_USER) {
        throw new Error(`Unexpected ask_user tool name: ${askUserTool.name}`);
      }
      tools.push(askUserTool);
    }
    registerToolFormatters(tools);

    return {
      name: 'Agent',
      instructions: `${prompt}\n\nEnvironment: ${envInfo}${agentsInstructions}${skillsInstructions}`,
      tools,
      model: resolvedModel,
    };
  }

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

  if (skillsService && skillsService.getAvailableSkillsForModel().length > 0) {
    tools.push(createActivateSkillToolDefinition(skillsService));
  }

  if (getAskUserAnswer) {
    const askUserTool = createAskUserToolDefinition(getAskUserAnswer);
    if (askUserTool.name !== TOOL_NAME_ASK_USER) {
      throw new Error(`Unexpected ask_user tool name: ${askUserTool.name}`);
    }
    tools.push(askUserTool);
  }

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

  return {
    name: 'Terminal Assistant',
    instructions: `${prompt}\n\nEnvironment: ${envInfo}${agentsInstructions}${skillsInstructions}`,
    tools,
    model: resolvedModel,
  };
};
