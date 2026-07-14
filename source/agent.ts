import { createGrepToolDefinition } from './tools/file/grep.js';
import { createReadFileToolDefinition } from './tools/file/read-file.js';
import { createFindFilesToolDefinition } from './tools/file/glob.js';
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
} from './tools/file/code-context.js';
import { registerToolFormatters } from './tools/command-message-formatters.js';
import { TOOL_NAME_ASK_USER } from './tools/tool-names.js';
import type { ToolDefinition } from './tools/types.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import type { ISettingsService, ILoggingService } from './services/service-interfaces.js';
import { ExecutionContext } from './services/execution-context.js';
import { buildPromptSpec } from './prompts/prompt-constructor.js';
import { shouldPreferPatchEditingModel } from './lib/tool-selection-policy.js';
import { SkillsService } from './services/skills/skills-service.js';
import { createActivateSkillToolDefinition } from './tools/agent/activate-skill.js';
import { createRunAgentWorkflowToolDefinition } from './tools/run-agent-workflow.js';
import type { AgentRuntime } from './services/agent-runtime/agent-runtime.js';
import type { WorkflowLimits } from './services/agent-runtime/workflow/workflow-types.js';
import { getProjectTreeForPrompt } from './utils/project-tree.js';
import { MemoryCapabilityBuilder } from './services/memory/memory-capabilities.js';

export { getProjectTreeForPrompt } from './utils/project-tree.js';

const BASE_PROMPT_PATH = path.join(import.meta.dirname, './prompts');

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
    return `OS: ${osType} ${osRelease} (${osPlatform}); shell: ${shellPath}; cwd (you're already here, don't \`cd\` to it): ${cwd}; date: ${now}`;
  }

  // For remote sessions, we might not be able to list top-level entries efficiently or at all easily here synchronously
  // We'll skip top-level entries for now if remote, or maybe we can't get them sync.
  // getProjectTreeForPrompt is sync and uses fs.readdirSync. This won't work for remote.
  // So if remote, we skip that part.
  let topLevel = '';
  if (!executionContext?.isRemote()) {
    topLevel = `${getProjectTreeForPrompt(cwd)}`;
  }

  return `OS: ${osType} ${osRelease} (${osPlatform}); shell: ${shellPath}; cwd (you're already here, don't \`cd\` to it): ${cwd}; date: ${now}\n${topLevel}\n\n`;
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
    agentRuntime?: Pick<AgentRuntime, 'agent'> | null;
  },
  model?: string,
): AgentDefinition => {
  const {
    settingsService,
    loggingService,
    executionContext,
    askMentor,
    runSubagent,
    getAskUserAnswer,
    skillsService,
    agentRuntime,
  } = deps;
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
  const isGpt5 = shouldPreferPatchEditingModel(resolvedModel);
  const sandboxEnabled = settingsService.get<boolean>('sandbox.enabled');
  const memoryCapability = new MemoryCapabilityBuilder(settingsService, {
    onWarning: (message) => loggingService.warn(message),
  }).build({ kind: 'main' }, { projectPath: executionContext?.getCwd() ?? process.cwd() });
  const promptSpec = buildPromptSpec({
    model: resolvedModel,
    liteMode,
    orchestratorMode,
    mentorMode,
    planMode,
    searchViaShell,
    codeContextEnabled,
    runSubagentEnabled: Boolean(runSubagent),
    sandboxEnabled,
    memoryEnabled: memoryCapability.access !== 'none',
    memoryGuidance: memoryCapability.guidance,
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

  if (memoryCapability.context) {
    prompt = `${prompt}\n\n${memoryCapability.context}`;
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
      createShellToolDefinition({
        settingsService,
        loggingService,
        executionContext,
        orchestratorMode: true,
        searchViaShell,
      }),
      createReadFileToolDefinition({ executionContext, allowOutsideWorkspace: true, orchestratorMode: true }),
      createGrepToolDefinition({ executionContext, orchestratorMode: true }),
    ];
    if (codeContextEnabled) {
      tools.push(
        createReadCodeOutlineToolDefinition({ executionContext }),
        createCodeContextSearchToolDefinition({ executionContext }),
      );
    }
    if (isGpt5) {
      tools.push(createApplyPatchToolDefinition({ settingsService, loggingService, executionContext }));
    } else {
      tools.push(
        createCreateFileToolDefinition({ settingsService, loggingService, executionContext }),
        createSearchReplaceToolDefinition({ settingsService, loggingService, executionContext }),
      );
    }
    tools.push(...memoryCapability.tools);
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
    createShellToolDefinition({ settingsService, loggingService, executionContext, searchViaShell }),
    createWebSearchToolDefinition({
      settingsService,
      loggingService,
    }),
    createWebFetchToolDefinition({
      settingsService,
      loggingService,
    }),
  ];

  tools.push(...memoryCapability.tools);

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
    // Lite mode keeps lightweight context and delegation policy, but still allows file edits.
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
    if (isGpt5) {
      tools.push(createApplyPatchToolDefinition({ settingsService, loggingService, executionContext }));
    } else {
      tools.push(
        createCreateFileToolDefinition({ settingsService, loggingService, executionContext }),
        createSearchReplaceToolDefinition({ settingsService, loggingService, executionContext }),
      );
    }
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

    // Add mentor tool if the smart tier or its legacy mentor override is configured.
    const mentorModel =
      settingsService.get<string>('agent.smartModel') ?? settingsService.get<string>('agent.mentorModel');
    if (mentorModel && askMentor) {
      tools.push(createAskMentorToolDefinition(askMentor));
    }

    // Add run_subagent tool (not in lite mode)
    if (runSubagent) {
      tools.push(createRunSubagentToolDefinition(runSubagent));
    }
  }

  if (settingsService.get<boolean>('enable_agent_workflow') && agentRuntime) {
    tools.push(
      createRunAgentWorkflowToolDefinition({
        runtime: agentRuntime,
        parentTools: tools.map((tool) => tool.name),
        limits: settingsService.get<WorkflowLimits>('agentWorkflow'),
      }),
    );
  }

  registerToolFormatters(tools);

  return {
    name: 'Terminal Assistant',
    instructions: `${prompt}\n\nEnvironment: ${envInfo}${agentsInstructions}${skillsInstructions}`,
    tools,
    model: resolvedModel,
  };
};
