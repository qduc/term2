import { createGrepToolDefinition } from './tools/file/grep.js';
import { createReadFileToolDefinition } from './tools/file/read-file.js';
import type { SessionAccessState } from './services/session/session-access-state.js';
import { createFindFilesToolDefinition } from './tools/file/glob.js';
import { createSearchReplaceToolDefinition } from './tools/file/search-replace.js';
import { createApplyPatchToolDefinition } from './tools/file/apply-patch.js';
import {
  createBackgroundShellJobToolDefinitions,
  createShellToolDefinition,
  type BackgroundShellExecutionResult,
} from './tools/system/shell.js';
import type { BackgroundShellRegistry } from './services/shell/background-shell-registry.js';
import { createAskMentorToolDefinition } from './tools/agent/ask-mentor.js';
import { createAskUserToolDefinition } from './tools/agent/ask-user.js';
import { createRunSubagentToolDefinition, type ForegroundRunSubagentParams } from './tools/agent/run-subagent.js';
import {
  createGetSubagentResultToolDefinition,
  createGetSubagentStatusToolDefinition,
  createSendMessageToolDefinition,
  createCancelRunToolDefinition,
} from './tools/agent/run-subagent-async.js';
import { createWebSearchToolDefinition } from './tools/web/web-search.js';
import { createWebFetchToolDefinition } from './tools/web/web-fetch.js';
import { createCreateFileToolDefinition } from './tools/file/create-file.js';
import {
  createCodeContextSearchToolDefinition,
  createReadCodeOutlineToolDefinition,
} from './tools/file/code-context.js';
import { registerToolFormatters } from './tools/command-message-formatters.js';
import { TOOL_NAME_ASK_USER } from './tools/tool-names.js';
import type { AnyToolDefinition, ToolRegistry } from './tools/types.js';
import type {
  NestedSubagentResult,
  SubagentResult,
  SubagentRunHandle,
  SubagentRunStatus,
} from './services/subagents/types.js';
import type {
  CancelRunParams,
  GetSubagentResultParams,
  GetSubagentStatusParams,
  RunSubagentAsyncParams,
  SendMessageParams,
  SendMessageAcknowledgement,
  CancelRunAcknowledgement,
} from './tools/agent/run-subagent-async.js';
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
  const shellPath = settingsService.get('app.shellPath') || 'unknown';
  const cwd = executionContext?.getCwd() || process.cwd();
  const osType = os.type();
  const osRelease = os.release();
  const osPlatform = os.platform();

  const now = new Date().toISOString().slice(0, 10);

  // State the home directory explicitly. Without it a model asked about a path
  // outside cwd has to guess what `~` resolves to, and weaker models guess the
  // container default (/root), producing paths that cannot exist on this host.
  // Remote sessions run against another machine's home, which this process
  // cannot know, so only claim it for local ones.
  const home = executionContext?.isRemote() ? '' : `; home (\`~\`): ${os.homedir()}`;

  if (lite) {
    // Minimal env info for lite mode
    return `OS: ${osType} ${osRelease} (${osPlatform}); shell: ${shellPath}; cwd (you're already here, don't \`cd\` to it): ${cwd}${home}; date: ${now}`;
  }

  // For remote sessions, we might not be able to list top-level entries efficiently or at all easily here synchronously
  // We'll skip top-level entries for now if remote, or maybe we can't get them sync.
  // getProjectTreeForPrompt is sync and uses fs.readdirSync. This won't work for remote.
  // So if remote, we skip that part.
  let topLevel = '';
  if (!executionContext?.isRemote()) {
    topLevel = `${getProjectTreeForPrompt(cwd)}`;
  }

  return `OS: ${osType} ${osRelease} (${osPlatform}); shell: ${shellPath}; cwd (you're already here, don't \`cd\` to it): ${cwd}${home}; date: ${now}\n${topLevel}\n\n`;
}

export function getAgentsInstructions(cwd: string): string {
  // A global AGENTS.md may live at ~/.agents/AGENTS.md and applies to every
  // project; the project-root AGENTS.md (if present) takes precedence and is
  // appended after it so project-specific guidance stays closest to the model.
  const globalAgentsPath = path.join(os.homedir(), '.agents', 'AGENTS.md');
  const agentsPath = path.join(cwd, 'AGENTS.md');

  const parts: string[] = [];

  try {
    if (fs.existsSync(globalAgentsPath)) {
      const globalContents = fs.readFileSync(globalAgentsPath, 'utf-8').trim();
      if (globalContents) {
        parts.push(`\n\nGlobal AGENTS.md contents (~/.agents/AGENTS.md):\n${globalContents}`);
      }
    }
  } catch {
    // Ignore an unreadable global AGENTS.md; the project file still applies.
  }

  if (fs.existsSync(agentsPath)) {
    try {
      const contents = fs.readFileSync(agentsPath, 'utf-8').trim();
      parts.push(`\n\nAGENTS.md contents:\n${contents}`);
    } catch (e: any) {
      parts.push(`\n\nFailed to read AGENTS.md: ${e.message}`);
    }
  }

  return parts.join('');
}

export interface AgentDefinition {
  name: string;
  instructions: string;
  tools: ToolRegistry;
  model: string;
}

type SubagentResultLike = Pick<SubagentResult, 'finalText'> & Partial<NestedSubagentResult>;

function toSubagentResult(result: SubagentResultLike, role: ForegroundRunSubagentParams['role']): NestedSubagentResult {
  return {
    agentId: result.agentId ?? 'unknown',
    role: result.role ?? role,
    status: result.status ?? 'completed',
    finalText: result.finalText,
    filesChanged: result.filesChanged ?? [],
    toolsUsed: result.toolsUsed ?? [],
    finalTextTruncated: result.finalTextTruncated,
    finalTextArtifactPath: result.finalTextArtifactPath,
    usage: result.usage,
    error: result.error,
    nestedRunResult: result.nestedRunResult,
    diffStat: result.diffStat,
    validation: result.validation,
    interrupted: result.interrupted,
  };
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
    runSubagent?: (
      params: ForegroundRunSubagentParams,
      context?: unknown,
      details?: unknown,
    ) => Promise<SubagentResultLike>;
    runSubagentAsync?: (
      params: RunSubagentAsyncParams,
      context?: unknown,
      details?: unknown,
    ) => Promise<SubagentRunHandle>;
    getSubagentResult?: (
      params: GetSubagentResultParams,
      context?: unknown,
      details?: unknown,
    ) => Promise<SubagentResult>;
    getSubagentStatus?: (
      params: GetSubagentStatusParams,
      context?: unknown,
      details?: unknown,
    ) => SubagentRunStatus | SubagentRunStatus[];
    sendSubagentMessage?: (params: SendMessageParams) => SendMessageAcknowledgement;
    cancelSubagentRun?: (params: CancelRunParams) => CancelRunAcknowledgement;
    getAskUserAnswer?: (callId?: string) => string | undefined;
    skillsService?: SkillsService;
    agentRuntime?: Pick<AgentRuntime, 'agent'> | null;
    postExecuteDeniedRead?: boolean;
    sessionAccess?: SessionAccessState;
    /** Root-session-only capability. Nested/subagent factories do not receive it. */
    backgroundShellRegistry?: BackgroundShellRegistry<BackgroundShellExecutionResult>;
    /** False for one-shot/non-interactive callers until their lifecycle is supported. */
    allowBackgroundShell?: boolean;
  },
  model?: string,
): AgentDefinition => {
  const {
    settingsService,
    loggingService,
    executionContext,
    askMentor,
    runSubagent,
    runSubagentAsync,
    getSubagentResult,
    getSubagentStatus,
    sendSubagentMessage,
    cancelSubagentRun,
    getAskUserAnswer,
    skillsService,
    agentRuntime,
    postExecuteDeniedRead = false,
    sessionAccess,
    backgroundShellRegistry,
    allowBackgroundShell = true,
  } = deps;
  const defaultModel = settingsService.get('agent.model');
  const resolvedModel = model?.trim() || defaultModel;

  if (!resolvedModel) throw new Error('Model cannot be undefined or empty');

  const planMode = settingsService.get('app.planMode');
  const mentorMode = settingsService.get('app.mentorMode');
  const liteMode = settingsService.get('app.liteMode');
  const orchestratorMode = settingsService.get('app.orchestratorMode');
  const searchViaShellSetting = settingsService.get('app.searchViaShell') ?? 'auto';
  const searchViaShell =
    searchViaShellSetting === 'auto' ? shouldPreferPatchEditingModel(resolvedModel) : searchViaShellSetting === 'on';
  // Code-context tools operate on the local filesystem only; disable them for
  // remote (SSH) execution where the workspace lives on another host.
  const codeContextEnabled = !(executionContext?.isRemote() ?? false);
  const isGpt5 = shouldPreferPatchEditingModel(resolvedModel);
  const sandboxEnabled = settingsService.get('sandbox.enabled');
  // Async delegation is an all-or-nothing parent capability: launch, result
  // retrieval, and the two non-blocking control tools share one registry path.
  const asyncSubagentEnabled =
    Boolean(runSubagentAsync) &&
    Boolean(getSubagentResult) &&
    Boolean(sendSubagentMessage) &&
    Boolean(cancelSubagentRun);
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
    runSubagentEnabled: Boolean(runSubagent) || asyncSubagentEnabled,
    runSubagentForegroundEnabled: Boolean(runSubagent),
    runSubagentAsyncEnabled: asyncSubagentEnabled,
    asyncSubagentControlsEnabled: asyncSubagentEnabled,
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
  // The glob/find-files tool is only registered in certain configurations; keep
  // the search-tool descriptions consistent so the model does not call a tool
  // that is not on its allowlist.
  const globAvailable = orchestratorMode ? false : !searchViaShell && (liteMode || !isGpt5);
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

  const rootBackgroundShellRegistry = allowBackgroundShell ? backgroundShellRegistry : undefined;

  if (orchestratorMode) {
    if (!runSubagentAsync || !getSubagentResult || !sendSubagentMessage || !cancelSubagentRun) {
      throw new Error(
        'orchestratorMode requires runSubagentAsync, getSubagentResult, sendSubagentMessage, and cancelSubagentRun: cannot build orchestrator agent without asynchronous delegation.',
      );
    }
    const tools: AnyToolDefinition[] = [
      createRunSubagentToolDefinition({ runSubagentAsync }),
      createGetSubagentResultToolDefinition(getSubagentResult),
      ...(getSubagentStatus ? [createGetSubagentStatusToolDefinition(getSubagentStatus)] : []),
      createSendMessageToolDefinition(sendSubagentMessage),
      createCancelRunToolDefinition(cancelSubagentRun),
    ];
    tools.push(
      createShellToolDefinition({
        settingsService,
        loggingService,
        executionContext,
        orchestratorMode: true,
        searchViaShell,
        backgroundShellRegistry: rootBackgroundShellRegistry,
      }),
      createReadFileToolDefinition({ executionContext, allowOutsideWorkspace: true, orchestratorMode: true }),
      createGrepToolDefinition({ executionContext, orchestratorMode: true, globAvailable: false }),
    );
    if (rootBackgroundShellRegistry) {
      const backgroundTools = createBackgroundShellJobToolDefinitions(rootBackgroundShellRegistry);
      tools.push(backgroundTools.get, backgroundTools.cancel);
    }
    if (codeContextEnabled) {
      tools.push(
        createReadCodeOutlineToolDefinition({ executionContext }),
        createCodeContextSearchToolDefinition({ executionContext, globAvailable: false }),
      );
    }
    if (isGpt5) {
      tools.push(createApplyPatchToolDefinition({ settingsService, loggingService, executionContext, sessionAccess }));
    } else {
      tools.push(
        createCreateFileToolDefinition({ settingsService, loggingService, executionContext, sessionAccess }),
        createSearchReplaceToolDefinition({ settingsService, loggingService, executionContext, sessionAccess }),
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

  const shellTool = createShellToolDefinition({
    settingsService,
    loggingService,
    executionContext,
    searchViaShell,
    postExecuteDeniedRead,
    sessionAccess,
    backgroundShellRegistry: rootBackgroundShellRegistry,
  });
  const tools: AnyToolDefinition[] = [
    shellTool,
    createWebSearchToolDefinition({
      settingsService,
      loggingService,
    }),
    createWebFetchToolDefinition({
      settingsService,
      loggingService,
    }),
  ];

  if (rootBackgroundShellRegistry) {
    const backgroundTools = createBackgroundShellJobToolDefinitions(rootBackgroundShellRegistry);
    tools.push(backgroundTools.get, backgroundTools.cancel);
  }

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
      createCodeContextSearchToolDefinition({ executionContext, globAvailable }),
    );
  }

  if (liteMode) {
    // Lite mode keeps lightweight context and delegation policy, but still allows file edits.
    if (!searchViaShell) {
      tools.push(
        createGrepToolDefinition({ executionContext, globAvailable, allowOutsideWorkspace: true }),
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
      tools.push(createApplyPatchToolDefinition({ settingsService, loggingService, executionContext, sessionAccess }));
    } else {
      tools.push(
        createCreateFileToolDefinition({ settingsService, loggingService, executionContext, sessionAccess }),
        createSearchReplaceToolDefinition({ settingsService, loggingService, executionContext, sessionAccess }),
      );
    }
  } else {
    // Full mode: all tools based on model
    if (isGpt5) {
      tools.push(createApplyPatchToolDefinition({ settingsService, loggingService, executionContext, sessionAccess }));
    } else {
      if (!searchViaShell) {
        tools.push(
          createGrepToolDefinition({ executionContext, globAvailable, sessionAccess }),
          createFindFilesToolDefinition({ executionContext, sessionAccess }),
        );
      }
      tools.push(
        createReadFileToolDefinition({ executionContext, sessionAccess }),
        createCreateFileToolDefinition({
          settingsService,
          loggingService,
          executionContext,
          sessionAccess,
        }),
        createSearchReplaceToolDefinition({
          settingsService,
          loggingService,
          executionContext,
          sessionAccess,
        }),
      );
    }

    // Add mentor tool if the smart tier or its legacy mentor override is configured.
    const mentorModel = settingsService.get('agent.smartModel') ?? settingsService.get('agent.mentorModel');
    if (mentorModel && askMentor) {
      tools.push(createAskMentorToolDefinition(askMentor));
    }

    // One model-facing delegation tool selects the existing foreground nested
    // runner or background registry callback; lifecycle ownership stays split.
    if (runSubagent || asyncSubagentEnabled) {
      tools.push(
        createRunSubagentToolDefinition({
          runSubagent: runSubagent
            ? async (params, context, details) =>
                toSubagentResult(await runSubagent(params, context, details), params.role)
            : undefined,
          runSubagentAsync: asyncSubagentEnabled ? runSubagentAsync : undefined,
        }),
      );
    }

    // Add async subagent tools (not in lite mode). The conjunction is
    // `asyncSubagentEnabled` spelled out so the callbacks narrow: registering any
    // of these without the rest would advertise delegation the prompt never explains.
    if (runSubagentAsync && getSubagentResult && sendSubagentMessage && cancelSubagentRun) {
      tools.push(createGetSubagentResultToolDefinition(getSubagentResult));
      if (getSubagentStatus) {
        tools.push(createGetSubagentStatusToolDefinition(getSubagentStatus));
      }
      tools.push(
        createSendMessageToolDefinition(sendSubagentMessage),
        createCancelRunToolDefinition(cancelSubagentRun),
      );
    }
  }

  if (settingsService.get('enable_agent_workflow') && agentRuntime) {
    tools.push(
      createRunAgentWorkflowToolDefinition({
        runtime: agentRuntime,
        parentTools: tools.map((tool) => tool.name),
        limits: settingsService.getDynamic('agentWorkflow') as WorkflowLimits,
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
