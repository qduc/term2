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
import type { BackgroundShellOutputBundle } from './services/shell/background-shell-watches.js';
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
import {
  createConfigureTaskCheckInToolDefinition,
  type ConfigureTaskCheckInParams,
  type ConfigureTaskCheckInResult,
} from './tools/agent/configure-task-check-in.js';
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
import { buildPromptSpec, isLiteProfile } from './prompts/prompt-constructor.js';
import { ProfileResolutionError, resolveActiveProfile } from './services/profiles/index.js';
import { shouldPreferPatchEditingModel } from './lib/tool-selection-policy.js';
import { SkillsService } from './services/skills/skills-service.js';
import { createActivateSkillToolDefinition } from './tools/agent/activate-skill.js';
import { createRunAgentWorkflowToolDefinition } from './tools/run-agent-workflow.js';
import { createWorktreeToolDefinitions } from './tools/system/worktree.js';
import type { AgentRuntime } from './services/agent-runtime/agent-runtime.js';
import type { WorkflowLimits } from './services/agent-runtime/workflow/workflow-types.js';
import { getProjectTreeForPrompt } from './utils/project-tree.js';
import { MemoryCapabilityBuilder } from './services/memory/memory-capabilities.js';
import { resolveDisabledCapabilities } from './services/tool-toggles.js';
import type { ShellChildRegistry } from './utils/shell/shell-child-registry.js';
import { createSessionBrowserToolDefinitions } from './tools/session-browser/session-browser-tools.js';
import type { SessionBrowser } from './services/conversation/session-browser.js';
import type { SessionRolloverRequest, SessionRolloverRequestOutcome } from './contracts/session-rollover.js';
import { createSessionRolloverToolDefinition } from './tools/session-rollover/session-rollover-tool.js';

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
    /** Root-session-only output store + watch layer for background jobs. */
    backgroundShellOutput?: BackgroundShellOutputBundle;
    shellChildRegistry?: ShellChildRegistry;
    /** False for one-shot/non-interactive callers until their lifecycle is supported. */
    allowBackgroundShell?: boolean;
    /** False for non-interactive / headless sessions where user prompts cannot be answered. */
    allowAskUser?: boolean;
    /** Explicit interactive-root-only capability; never inferred from memory access. */
    sessionBrowser?: SessionBrowser;
    requestSessionRollover?: (request: SessionRolloverRequest) => SessionRolloverRequestOutcome;
    configureTaskCheckIn?: (params: ConfigureTaskCheckInParams) => ConfigureTaskCheckInResult;
    setTaskCheckInPolicy?: (
      target: { kind: 'shell' | 'subagent'; id: string },
      options: { enabled?: boolean; intervalMs?: number },
    ) => void;
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
    backgroundShellOutput,
    shellChildRegistry,
    allowBackgroundShell = true,
    allowAskUser = true,
    sessionBrowser,
    requestSessionRollover,
    configureTaskCheckIn,
    setTaskCheckInPolicy,
  } = deps;
  const defaultModel = settingsService.get('agent.model');
  const resolvedModel = model?.trim() || defaultModel;

  if (!resolvedModel) throw new Error('Model cannot be undefined or empty');

  const searchViaShellSetting = settingsService.get('app.searchViaShell') ?? 'auto';
  const searchViaShell =
    searchViaShellSetting === 'auto' ? shouldPreferPatchEditingModel(resolvedModel) : searchViaShellSetting === 'on';
  // Code-context tools operate on the local filesystem only; disable them for
  // remote (SSH) execution where the workspace lives on another host.
  const codeContextEnabled = !(executionContext?.isRemote() ?? false);
  const isGpt5 = shouldPreferPatchEditingModel(resolvedModel);
  const sandboxEnabled = settingsService.get('sandbox.enabled');
  // Async delegation is an all-or-nothing parent capability: launch, status
  // preflight, result retrieval, and the two non-blocking control tools share
  // one registry path.
  const asyncSubagentEnabled =
    Boolean(runSubagentAsync) &&
    Boolean(getSubagentResult) &&
    Boolean(getSubagentStatus) &&
    Boolean(sendSubagentMessage) &&
    Boolean(cancelSubagentRun);
  // A complete async capability owns the model-facing delegation contract. The
  // nested runner remains wired for foreground-only compatibility sessions and
  // for legacy lifecycle controls, but is not selectable alongside async work.
  const runSubagentForegroundEnabled = Boolean(runSubagent) && !asyncSubagentEnabled;
  let profile: ReturnType<typeof resolveActiveProfile>;
  try {
    profile = resolveActiveProfile(settingsService, {
      availableIntegrations: new Map([['builtin:integration/async-subagents', asyncSubagentEnabled]]),
    });
  } catch (error) {
    // The resolver reports unavailable required integrations as a resolution
    // error rather than returning them, so this remap is the enforcement point:
    // preserve the agent's established prerequisite message while allowing
    // other profile diagnostics to propagate.
    const unavailableAsyncSubagents =
      error instanceof ProfileResolutionError &&
      error.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'unavailable-integration' &&
          diagnostic.message.includes('builtin:integration/async-subagents'),
      );
    if (!unavailableAsyncSubagents) throw error;
    throw new Error(
      'orchestratorMode requires runSubagentAsync, getSubagentResult, getSubagentStatus, sendSubagentMessage, and cancelSubagentRun: cannot build orchestrator agent without asynchronous delegation.',
    );
  }
  const liteMode = isLiteProfile(profile);
  const capabilities = profile.tools.capabilities;
  // Per-group kill switches (tools.<group>.enabled): mask the resolved set so
  // every registration below consults the effective capabilities, and a
  // disabled group's capability-gated prompt fragments drop with it. Toggles
  // never restrict subagents, which resolve their own capabilities.
  const disabledCapabilities = resolveDisabledCapabilities(settingsService);
  const effectiveCapabilities =
    disabledCapabilities.size === 0
      ? capabilities
      : new Set([...capabilities].filter((capability) => !disabledCapabilities.has(capability)));
  if (disabledCapabilities.size > 0) {
    loggingService.debug('Tool capability toggles applied', { disabled: [...disabledCapabilities].sort() });
  }
  const hasCapability = (capability: string): boolean => effectiveCapabilities.has(capability);
  const filesystemReadEnabled = hasCapability('filesystem-read-workspace') || hasCapability('filesystem-read-external');
  const filesystemWriteEnabled = hasCapability('filesystem-write');
  const backgroundTasksEnabled = hasCapability('background-tasks');
  const isContextSourceEnabled = (source: string): boolean =>
    profile.context.sources.some((item) => item.source === source && item.enabled);
  const environmentEnabled = isContextSourceEnabled('environment');
  const projectInstructionsEnabled = isContextSourceEnabled('project-instructions');
  const skillsCatalogEnabled = isContextSourceEnabled('skills-catalog');
  const memoryContextEnabled = isContextSourceEnabled('memory');
  const sessionBrowserContextEnabled = isContextSourceEnabled('session-browser');
  const memoryCapability = new MemoryCapabilityBuilder(settingsService, {
    onWarning: (message) => loggingService.warn(message),
  }).build({ kind: 'main' }, { projectPath: executionContext?.getCwd() ?? process.cwd() });
  const promptSpec = buildPromptSpec({
    model: resolvedModel,
    profile,
    searchViaShell,
    codeContextEnabled: codeContextEnabled && hasCapability('code-context'),
    runSubagentEnabled: hasCapability('subagents') && (Boolean(runSubagent) || asyncSubagentEnabled),
    runSubagentForegroundEnabled: hasCapability('subagents') && runSubagentForegroundEnabled,
    runSubagentAsyncEnabled: hasCapability('subagents') && asyncSubagentEnabled,
    asyncSubagentControlsEnabled: hasCapability('subagents') && asyncSubagentEnabled,
    backgroundShellEnabled: backgroundTasksEnabled && allowBackgroundShell && Boolean(backgroundShellRegistry),
    sandboxEnabled,
    memoryEnabled: hasCapability('memory') && memoryContextEnabled && memoryCapability.access !== 'none',
    memoryGuidance: memoryCapability.guidance,
    sessionBrowserEnabled: hasCapability('sessions') && sessionBrowserContextEnabled && Boolean(sessionBrowser),
    executionContext,
  });
  let prompt = promptSpec.basePromptContent ?? resolvePrompt(path.join(BASE_PROMPT_PATH, promptSpec.basePromptFile!));

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

  if (memoryContextEnabled && memoryCapability.context) {
    prompt = `${prompt}\n\n${memoryCapability.context}`;
  }

  const cwd = executionContext?.getCwd() || process.cwd();
  const isLiteEnv = liteMode;
  // The glob/find-files tool is only registered in certain configurations; keep
  // the search-tool descriptions consistent so the model does not call a tool
  // that is not on its allowlist.
  const globAvailable = !searchViaShell && (liteMode || !isGpt5);
  const envInfo = environmentEnabled ? getEnvInfo(settingsService, executionContext, isLiteEnv) : '';
  const skipAgentsMd = !projectInstructionsEnabled || (executionContext?.isRemote() ?? false);
  const agentsInstructions = skipAgentsMd ? '' : getAgentsInstructions(cwd);

  let skillsInstructions = '';
  if (hasCapability('skills') && skillsCatalogEnabled && skillsService) {
    const catalog = skillsService.getSkillCatalog();
    if (catalog) {
      skillsInstructions = `\n\n${catalog}`;
    }
  }

  const rootBackgroundShellRegistry =
    backgroundTasksEnabled && allowBackgroundShell ? backgroundShellRegistry : undefined;
  const rootBackgroundShellOutput = backgroundTasksEnabled && allowBackgroundShell ? backgroundShellOutput : undefined;
  const shellTool = createShellToolDefinition({
    settingsService,
    loggingService,
    executionContext,
    searchViaShell,
    postExecuteDeniedRead,
    sessionAccess,
    backgroundShellRegistry: rootBackgroundShellRegistry,
    backgroundShellWatches: rootBackgroundShellOutput?.watches,
    configureCheckIn: setTaskCheckInPolicy,
    shellChildRegistry,
  });
  const tools: AnyToolDefinition[] = [];
  if (hasCapability('shell')) tools.push(shellTool);
  if (hasCapability('web')) {
    tools.push(
      createWebSearchToolDefinition({
        settingsService,
        loggingService,
      }),
      createWebFetchToolDefinition({
        settingsService,
        loggingService,
      }),
    );
  }

  if (
    backgroundTasksEnabled &&
    configureTaskCheckIn &&
    (rootBackgroundShellRegistry || (hasCapability('subagents') && asyncSubagentEnabled))
  ) {
    tools.push(createConfigureTaskCheckInToolDefinition(configureTaskCheckIn));
  }

  if (rootBackgroundShellRegistry) {
    const backgroundTools = createBackgroundShellJobToolDefinitions(
      rootBackgroundShellRegistry,
      rootBackgroundShellOutput,
    );
    tools.push(backgroundTools.get, backgroundTools.cancel);
    if (backgroundTools.monitor) tools.push(backgroundTools.monitor);
    if (backgroundTools.cancelMonitor) tools.push(backgroundTools.cancelMonitor);
  }

  // Worktree switching re-roots the local filesystem; in remote mode the remote
  // directory owns the execution root, so the tools have nothing to lease.
  if ((filesystemReadEnabled || filesystemWriteEnabled) && executionContext && !executionContext.isRemote()) {
    const worktreeTools = createWorktreeToolDefinitions({
      executionContext,
      getRunningJobs: () =>
        (rootBackgroundShellRegistry?.list() ?? [])
          .filter((job) => job.status === 'running' || job.status === 'cancelling')
          .map((job) => ({ id: job.id, command: job.command })),
    });
    tools.push(worktreeTools.enter, worktreeTools.exit);
  }

  if (hasCapability('memory')) tools.push(...memoryCapability.tools);
  if (hasCapability('sessions') && sessionBrowser) tools.push(...createSessionBrowserToolDefinitions(sessionBrowser));
  if (hasCapability('sessions') && requestSessionRollover)
    tools.push(createSessionRolloverToolDefinition(requestSessionRollover));

  if (hasCapability('skills') && skillsService && skillsService.getAvailableSkillsForModel().length > 0) {
    tools.push(createActivateSkillToolDefinition(skillsService));
  }

  if (hasCapability('user-interaction') && getAskUserAnswer && allowAskUser) {
    const askUserTool = createAskUserToolDefinition(getAskUserAnswer);
    if (askUserTool.name !== TOOL_NAME_ASK_USER) {
      throw new Error(`Unexpected ask_user tool name: ${askUserTool.name}`);
    }
    tools.push(askUserTool);
  }

  if (codeContextEnabled && hasCapability('code-context')) {
    tools.push(
      createReadCodeOutlineToolDefinition({ executionContext, settingsService }),
      createCodeContextSearchToolDefinition({ executionContext, globAvailable, settingsService }),
    );
  }

  if (liteMode) {
    // Lite mode keeps lightweight context and delegation policy, but still allows file edits.
    // Keep workspace scope keyed to lite identity, not filesystem-read eligibility,
    // so capability resolution cannot widen standard mode's read scope.
    if (filesystemReadEnabled && !searchViaShell) {
      tools.push(
        createGrepToolDefinition({ executionContext, globAvailable, allowOutsideWorkspace: true, settingsService }),
        createFindFilesToolDefinition({
          executionContext,
          allowOutsideWorkspace: true,
          settingsService,
        }),
      );
    }
    if (filesystemReadEnabled) {
      tools.push(
        createReadFileToolDefinition({
          executionContext,
          allowOutsideWorkspace: true,
          settingsService,
        }),
      );
    }
    if (filesystemWriteEnabled) {
      if (isGpt5) {
        tools.push(
          createApplyPatchToolDefinition({ settingsService, loggingService, executionContext, sessionAccess }),
        );
      } else {
        tools.push(
          createCreateFileToolDefinition({ settingsService, loggingService, executionContext, sessionAccess }),
          createSearchReplaceToolDefinition({ settingsService, loggingService, executionContext, sessionAccess }),
        );
      }
    }
  } else {
    // Full mode: all tools based on model
    if (filesystemReadEnabled) {
      tools.push(createReadFileToolDefinition({ executionContext, sessionAccess, settingsService }));
    }
    if (filesystemWriteEnabled) {
      if (isGpt5) {
        tools.push(
          createApplyPatchToolDefinition({ settingsService, loggingService, executionContext, sessionAccess }),
        );
      } else {
        if (filesystemReadEnabled && !searchViaShell) {
          tools.push(
            createGrepToolDefinition({ executionContext, globAvailable, sessionAccess, settingsService }),
            createFindFilesToolDefinition({ executionContext, sessionAccess, settingsService }),
          );
        }
        tools.push(
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
    }
  }

  // Add mentor tool if the smart tier or its legacy mentor override is configured.
  const mentorModel = settingsService.get('agent.smartModel') ?? settingsService.get('agent.mentorModel');
  if (hasCapability('mentor') && mentorModel && askMentor) {
    tools.push(createAskMentorToolDefinition(askMentor));
  }

  // One model-facing delegation tool selects the existing foreground nested
  // runner or background registry callback; lifecycle ownership stays split.
  if (hasCapability('subagents') && (runSubagent || asyncSubagentEnabled)) {
    tools.push(
      createRunSubagentToolDefinition({
        runSubagent: runSubagent
          ? async (params, context, details) =>
              toSubagentResult(await runSubagent(params, context, details), params.role)
          : undefined,
        runSubagentAsync: asyncSubagentEnabled ? runSubagentAsync : undefined,
        configureCheckIn: setTaskCheckInPolicy,
      }),
    );
  }

  // Add async subagent tools. The conjunction is `asyncSubagentEnabled` spelled
  // out so the callbacks narrow: registering any of these without the rest would
  // advertise delegation the prompt never explains.
  if (
    hasCapability('subagents') &&
    runSubagentAsync &&
    getSubagentResult &&
    getSubagentStatus &&
    sendSubagentMessage &&
    cancelSubagentRun
  ) {
    tools.push(createGetSubagentResultToolDefinition(getSubagentResult, getSubagentStatus));
    tools.push(createGetSubagentStatusToolDefinition(getSubagentStatus));
    tools.push(createSendMessageToolDefinition(sendSubagentMessage), createCancelRunToolDefinition(cancelSubagentRun));
  }

  if (hasCapability('subagents') && settingsService.get('enable_agent_workflow') && agentRuntime) {
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
    instructions: `${prompt}\n\n${
      environmentEnabled ? `Environment: ${envInfo}` : ''
    }${agentsInstructions}${skillsInstructions}`,
    tools,
    model: resolvedModel,
  };
};
