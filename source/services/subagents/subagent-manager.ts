import { Agent, run, tool as createTool, type Tool, RunState } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import { ExecutionContext } from '../execution-context.js';
import { getProvider } from '../../providers/index.js';
import { SubagentSession } from './subagent-session.js';
import type { SubagentRequest, SubagentResult, SubagentDefinition, SubagentRole } from './types.js';
import type { ConversationEvent } from '../conversation-events.js';
import type { CommandMessage, ToolDefinition } from '../../tools/types.js';
import { wrapToolInvoke } from '../../lib/tool-invoke.js';
import { wrapNeedsApproval } from '../../lib/openai-agent-client.js';
import { toOpenAIStrictToolSchema } from '../../lib/openai-strict-tool-schema.js';
import { shouldUseStrictToolSchema } from '../../lib/tool-selection-policy.js';
import { createReadFileToolDefinition } from '../../tools/read-file.js';
import { createGrepToolDefinition } from '../../tools/grep.js';
import { createFindFilesToolDefinition } from '../../tools/find-files.js';
import {
  createReadCodeOutlineToolDefinition,
  createCodeContextSearchToolDefinition,
} from '../../tools/code-context.js';
import { createWebSearchToolDefinition } from '../../tools/web-search.js';
import { createWebFetchToolDefinition } from '../../tools/web-fetch.js';
import { createApplyPatchToolDefinition } from '../../tools/apply-patch.js';
import { createSearchReplaceToolDefinition } from '../../tools/search-replace.js';
import { createCreateFileToolDefinition } from '../../tools/create-file.js';
import { createShellToolDefinition } from '../../tools/shell.js';
import { registerToolFormatters } from '../../tools/command-message-formatters.js';
import { trimToolOutput } from '../../utils/trim-tool-output.js';
import { extractUsage, normalizeAgentRunUsage } from '../../utils/token-usage.js';
import { getEnvInfo, getAgentsInstructions } from '../../agent.js';
import { tryAcquireFileLock } from '../../tools/file-locks.js';
import { classifyCommand, SafetyStatus } from '../../utils/command-safety/index.js';

const PROMPTS_DIR = path.join(import.meta.dirname, '../../prompts/subagents');
const ROLE_MAX_TURNS_DEFAULT = 20;

function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterText = match[1];
  const body = match[2];
  const frontmatter: Record<string, any> = {};

  for (const line of frontmatterText.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let raw = line.slice(colonIdx + 1).trim();

    const quoted =
      raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
    if (quoted) {
      frontmatter[key] = raw.slice(1, -1);
      continue;
    }

    if (raw === 'true') {
      frontmatter[key] = true;
    } else if (raw === 'false') {
      frontmatter[key] = false;
    } else if (!isNaN(Number(raw)) && raw !== '') {
      frontmatter[key] = Number(raw);
    } else {
      frontmatter[key] = raw;
    }
  }

  return { frontmatter, body: body.trim() };
}

function loadRoleDefinition(role: SubagentRole, settings: ISettingsService): SubagentDefinition {
  const filePath = path.join(PROMPTS_DIR, `${role}.md`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Unknown subagent role: "${role}". No definition found at ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  const subagentPrefix =
    role === 'mentor' ? 'agent.mentor' : `agent.subagent${role.charAt(0).toUpperCase() + role.slice(1)}`;

  const resolve = (value: any, subagentKey: string, fallbackKey: string, defaultValue: any): any => {
    if (value === 'inherit' || value === undefined || value === null || value === '') {
      return settings.get(subagentKey) ?? settings.get(fallbackKey) ?? defaultValue;
    }
    return value;
  };

  return {
    role,
    name: frontmatter.name ?? role,
    instructions: body,
    canRead: frontmatter.canRead ?? false,
    canWrite: frontmatter.canWrite ?? false,
    canSearchWeb: frontmatter.canSearchWeb ?? false,
    canRunShell: frontmatter.canRunShell ?? false,
    maxTurns: frontmatter.maxTurns ?? ROLE_MAX_TURNS_DEFAULT,
    model: resolve(frontmatter.model, `${subagentPrefix}Model`, 'agent.model', 'gpt-4o'),
    provider: resolve(frontmatter.provider, `${subagentPrefix}Provider`, 'agent.provider', 'openai'),
    reasoningEffort: resolve(
      frontmatter.reasoningEffort,
      `${subagentPrefix}ReasoningEffort`,
      'agent.reasoningEffort',
      'default',
    ),
    description: frontmatter.description ?? '',
  };
}

function buildAgentTools(
  toolDefinitions: ToolDefinition[],
  options: {
    providerId: string;
    logger: ILoggingService;
    settings: ISettingsService;
    onToolStart?: (toolName: string, params: unknown, commandMessages: CommandMessage[]) => void;
    onToolComplete?: (toolName: string) => void;
  },
): Tool[] {
  const providerDef = getProvider(options.providerId);
  const capabilities = {
    supportsConversationChaining: providerDef?.capabilities?.supportsConversationChaining ?? false,
    supportsTracingControl: providerDef?.capabilities?.supportsTracingControl ?? false,
    usesStrictToolSchema: providerDef?.capabilities?.usesStrictToolSchema,
  };
  const useStrictSchema = shouldUseStrictToolSchema({
    providerId: options.providerId,
    capabilities,
  });

  return toolDefinitions.map((definition) =>
    wrapToolInvoke(
      createTool({
        name: definition.name,
        description: definition.description,
        parameters: useStrictSchema ? toOpenAIStrictToolSchema(definition.parameters) : definition.parameters,
        needsApproval: wrapNeedsApproval(definition),
        execute: async (params, _context) => {
          options.onToolStart?.(definition.name, params, formatRunningCommandMessages(definition, params));
          const maxOutputLength = options.settings.get<number | undefined>('shell.maxOutputChars');
          const result = await definition.execute(params, _context);
          options.onToolComplete?.(definition.name);
          return trimToolOutput(result, undefined, maxOutputLength ?? undefined);
        },
      }),
    ),
  );
}

function formatRunningCommandMessages(definition: ToolDefinition, params: unknown): CommandMessage[] {
  const callId = `subagent-tool-${randomUUID()}`;
  const item = {
    id: callId,
    rawItem: {
      id: callId,
      callId,
      arguments: params,
      output: '',
    },
  };

  try {
    const messages = definition.formatCommandMessage(item, 0, new Map());
    if (messages.length > 0) {
      return messages.map((message, index) => ({
        ...message,
        id: `${callId}-${index}`,
        status: 'running',
        output: '',
        success: undefined,
        failureReason: undefined,
        toolName: message.toolName ?? definition.name,
        toolArgs: message.toolArgs ?? params,
      }));
    }
  } catch {
    // Fall back to the tool name if a formatter cannot handle an in-flight item.
  }

  return [
    {
      id: `${callId}-0`,
      sender: 'command',
      status: 'running',
      command: definition.name,
      output: '',
      toolName: definition.name,
      toolArgs: params,
    },
  ];
}

function runWithProvider(providerId: string, runner: any, agent: Agent, input: any, options: any): Promise<any> {
  const providerDef = getProvider(providerId);
  const supportsTracingControl = providerDef?.capabilities?.supportsTracingControl ?? false;
  const effectiveOptions = { ...options };
  if (!supportsTracingControl) {
    effectiveOptions.tracingDisabled = true;
  }

  if (!runner && providerId !== 'openai') {
    const label = providerDef?.label || providerId;
    throw new Error(
      `${label} is configured but could not be initialized. ` +
        `Please check that all required credentials and provider settings are set.`,
    );
  }

  return runner ? runner.run(agent, input, effectiveOptions) : run(agent, input, effectiveOptions);
}

function isToolHistoryItem(raw: any): boolean {
  const type = typeof raw?.type === 'string' ? raw.type : '';
  if (raw?.role === 'tool') return true;
  return /tool|function_call/i.test(type);
}

function assistantText(raw: any): string | null {
  if (raw?.role !== 'assistant') return null;
  const content = raw?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => typeof c?.text === 'string')
      .map((c: any) => c.text)
      .join('');
  }
  return null;
}

/**
 * Returns only the subagent's final answer. When the run used tools, the
 * answer is the last assistant message that appears strictly after the last
 * tool item, so intermediate narration emitted between tool calls does not
 * leak into the parent agent context.
 *
 * When the run ends with a tool call and no trailing narration, falls back to
 * the last assistant message found anywhere in the history (which may precede
 * the last tool call) to avoid returning an empty string for runs that
 * completed successfully via write operations.
 */
function extractFinalText(result: any): string {
  if (typeof result.finalOutput === 'string' && result.finalOutput) {
    return result.finalOutput;
  }

  if (Array.isArray(result.history)) {
    const history = result.history;
    let lastToolIndex = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (isToolHistoryItem(history[i]?.rawItem ?? history[i])) {
        lastToolIndex = i;
        break;
      }
    }

    // Look for an assistant message after the last tool item.
    for (let i = history.length - 1; i > lastToolIndex; i--) {
      const text = assistantText(history[i]?.rawItem ?? history[i]);
      if (text !== null) return text;
    }

    // Fallback: the run ended with a tool call and no narration. Return the
    // last assistant message found anywhere so the caller gets a non-empty
    // summary rather than an empty string.
    for (let i = history.length - 1; i >= 0; i--) {
      const text = assistantText(history[i]?.rawItem ?? history[i]);
      if (text !== null) return text;
    }
  }

  return '';
}

function aggregateToolUsage(toolCounts: Map<string, number>): Array<{ toolName: string; count: number }> {
  return Array.from(toolCounts.entries()).map(([toolName, count]) => ({ toolName, count }));
}

export class SubagentManager {
  #logger: ILoggingService;
  #settings: ISettingsService;
  #executionContext?: ExecutionContext;
  #onEvent?: (event: ConversationEvent) => void;
  #mentorSession: SubagentSession;

  constructor(deps: {
    logger: ILoggingService;
    settings: ISettingsService;
    executionContext?: ExecutionContext;
    onEvent?: (event: ConversationEvent) => void;
  }) {
    this.#logger = deps.logger;
    this.#settings = deps.settings;
    this.#executionContext = deps.executionContext;
    this.#onEvent = deps.onEvent;
    this.#mentorSession = new SubagentSession(randomUUID(), 'mentor');
  }

  #emit(event: ConversationEvent): void {
    try {
      this.#onEvent?.(event);
    } catch (error: any) {
      this.#logger.debug('Subagent event emit failed', { error: error?.message });
    }
  }

  resetMentorSession(): void {
    this.#mentorSession.reset();
  }

  async run(request: SubagentRequest): Promise<SubagentResult> {
    const agentId = randomUUID();

    this.#logger.debug('SubagentManager.run', { agentId, role: request.role, taskLength: request.task.length });
    this.#emit({ type: 'subagent_started', agentId, role: request.role, task: request.task });

    try {
      const result =
        request.role === 'mentor'
          ? await this.#runMentor(agentId, request.task)
          : await this.#runSubagent(agentId, request, loadRoleDefinition(request.role, this.#settings));
      this.#emit({ type: 'subagent_completed', result });
      return result;
    } catch (error: any) {
      this.#logger.error('Subagent run failed', { agentId, role: request.role, error: error?.message });

      // Detect abort-like errors (user cancellation, stream abort) and
      // normalize to 'cancelled' status so the parent can distinguish
      // intentional user-initiated cancellation from unexpected failures.
      const isAbort =
        error?.name === 'AbortError' ||
        error?.message?.includes('abort') ||
        error?.message?.includes('cancel') ||
        error?.code === 'ERR_ABORTED';

      const result: SubagentResult = {
        agentId,
        role: request.role,
        status: isAbort ? 'cancelled' : 'failed',
        finalText: '',
        filesChanged: [],
        toolsUsed: [],
        error: error?.message || String(error),
      };
      this.#emit({ type: 'subagent_completed', result });
      return result;
    }
  }

  async #runMentor(agentId: string, task: string): Promise<SubagentResult> {
    const mentorModel = this.#settings.get<string>('agent.mentorModel');
    if (!mentorModel) {
      throw new Error('Mentor model is not configured');
    }

    const mentorProvider =
      this.#settings.get<string>('agent.mentorProvider') ?? this.#settings.get<string>('agent.provider') ?? 'openai';
    const mentorMode = this.#settings.get<boolean>('app.mentorMode');

    // model/provider/reasoning stay on the mentor-specific settings (compat
    // bridge); the prompt body and maxTurns come from the mentor role markdown.
    const definition = loadRoleDefinition('mentor', this.#settings);

    const baseInstructions = mentorMode
      ? 'You are a senior architect acting as a peer reviewer. You have no codebase access—you rely on what the user reports.\n\n' +
        'Your role is adversarial review, not rubber-stamping:\n' +
        '- Challenge assumptions, even when reasoning sounds solid\n' +
        '- Probe for gaps: what did they not check? What could go wrong?\n' +
        '- Suggest alternatives they may have dismissed too quickly\n' +
        '- Ask for evidence when confidence seems misplaced\n\n' +
        'When satisfied, give clear approval with specific next steps. When not, say exactly what needs more investigation.\n\n' +
        "Be concise. Push back hard, but don't block unnecessarily."
      : definition.instructions;

    const envInfo = getEnvInfo(this.#settings, this.#executionContext);
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    const agentsInstructions = this.#executionContext?.isRemote() ? '' : getAgentsInstructions(cwd);
    const instructions = `${baseInstructions}\n\nEnvironment: ${envInfo}${agentsInstructions}`;

    this.#mentorSession.switchProvider(mentorProvider);

    const mentorRunner = this.#mentorSession.ensureRunner(mentorProvider, (providerId) => {
      const providerDef = getProvider(providerId);
      return providerDef?.createRunner?.({ settingsService: this.#settings, loggingService: this.#logger }) ?? null;
    });

    const mentorAgent = this.#mentorSession.ensureAgent(() => {
      const reasoningEffort = this.#settings.get<string>('agent.mentorReasoningEffort');
      const modelSettings: any = {};
      if (reasoningEffort && reasoningEffort !== 'default') {
        modelSettings.reasoning = { effort: reasoningEffort, summary: 'auto' };
      }

      return new Agent({
        name: definition.name,
        model: mentorModel,
        ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
        instructions,
      });
    });

    this.#mentorSession.addUserMessage(task);

    const providerDef = getProvider(mentorProvider);
    const supportsChaining = providerDef?.capabilities?.supportsConversationChaining ?? false;
    const input = this.#mentorSession.getInput(task, supportsChaining);
    const runOptions = this.#mentorSession.getRunOptions(supportsChaining, definition.maxTurns);

    const result = await runWithProvider(mentorProvider, mentorRunner, mentorAgent, input, runOptions);
    this.#mentorSession.updateFromResult(result);

    return {
      agentId,
      role: 'mentor',
      status: 'completed',
      finalText: extractFinalText(result),
      filesChanged: [],
      toolsUsed: [],
      usage: normalizeAgentRunUsage(result?.state?.usage) ?? extractUsage(result),
    };
  }

  async #runSubagent(
    agentId: string,
    request: SubagentRequest,
    definition: SubagentDefinition,
  ): Promise<SubagentResult> {
    const toolCounts = new Map<string, number>();
    const filesChanged: string[] = [];

    const toolDefinitions = this.#buildToolDefinitions(definition, request.writeBoundary, filesChanged);

    const providerId = definition.provider;
    const tools = buildAgentTools(toolDefinitions, {
      providerId,
      logger: this.#logger,
      settings: this.#settings,
      onToolStart: (name, _params, commandMessages) => {
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        this.#emit({
          type: 'subagent_tool_started',
          agentId,
          role: request.role,
          toolName: name,
          commandMessages,
        });
      },
    });

    const providerDef = getProvider(providerId);
    const runner =
      providerId !== 'openai'
        ? providerDef?.createRunner?.({ settingsService: this.#settings, loggingService: this.#logger }) ?? null
        : null;

    const modelSettings: any = {};
    if (definition.reasoningEffort && definition.reasoningEffort !== 'default') {
      modelSettings.reasoning = { effort: definition.reasoningEffort, summary: 'auto' };
    }

    const envInfo = getEnvInfo(this.#settings, this.#executionContext);
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    const agentsInstructions = this.#executionContext?.isRemote() ? '' : getAgentsInstructions(cwd);

    const fullInstructions = [
      definition.instructions,
      `Environment: ${envInfo}${agentsInstructions}`,
      request.writeBoundary?.length
        ? `Write boundary: you may only write to paths within: ${request.writeBoundary.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const agent = new Agent({
      name: definition.name,
      model: definition.model,
      ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
      instructions: fullInstructions,
      tools,
    });

    // When resuming from a nested agent-tool run (e.g. worker approvals),
    // restore the SDK RunState from the serialized resumeState string.
    // This is populated by the SDK in the Agent.asTool path. When
    // run_subagent is registered as a plain function tool,
    // details.resumeState is not populated by the SDK, so this branch is
    // dead code until run_subagent switches to Agent.asTool registration.
    const runInput = request.resumeState ? await RunState.fromString(agent, request.resumeState) : request.task;

    const result = await runWithProvider(providerId, runner, agent, runInput, {
      stream: false,
      maxTurns: definition.maxTurns,
    });

    return {
      agentId,
      role: request.role,
      status: 'completed',
      finalText: extractFinalText(result),
      filesChanged: [...new Set(filesChanged)],
      toolsUsed: aggregateToolUsage(toolCounts),
      usage: normalizeAgentRunUsage(result?.state?.usage) ?? extractUsage(result),
      nestedRunResult: result,
    };
  }

  #buildToolDefinitions(
    definition: SubagentDefinition,
    writeBoundary: string[] | undefined,
    filesChanged: string[],
  ): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    const isRemote = this.#executionContext?.isRemote() ?? false;

    if (definition.canRead) {
      tools.push(
        createReadFileToolDefinition({ executionContext: this.#executionContext, allowOutsideWorkspace: false }),
        createGrepToolDefinition({ executionContext: this.#executionContext }),
        createFindFilesToolDefinition({ executionContext: this.#executionContext }),
      );

      if (!isRemote) {
        tools.push(
          createReadCodeOutlineToolDefinition({ executionContext: this.#executionContext }),
          createCodeContextSearchToolDefinition({ executionContext: this.#executionContext }),
        );
      }
    }

    if (definition.canSearchWeb) {
      tools.push(
        createWebSearchToolDefinition({ settingsService: this.#settings, loggingService: this.#logger }),
        createWebFetchToolDefinition({ settingsService: this.#settings, loggingService: this.#logger }),
      );
    }

    if (definition.canRunShell) {
      tools.push(
        this.#wrapShellTool(
          createShellToolDefinition({
            settingsService: this.#settings,
            loggingService: this.#logger,
            executionContext: this.#executionContext,
          }),
          writeBoundary,
          cwd,
          filesChanged,
        ),
      );
    }

    if (definition.canWrite) {
      tools.push(
        this.#wrapWriteTool(
          createApplyPatchToolDefinition({
            settingsService: this.#settings,
            loggingService: this.#logger,
            executionContext: this.#executionContext,
          }),
          writeBoundary,
          cwd,
          filesChanged,
          (params: any) => this.#extractPathsFromApplyPatch(params),
        ),
        this.#wrapWriteTool(
          createSearchReplaceToolDefinition({
            settingsService: this.#settings,
            loggingService: this.#logger,
            executionContext: this.#executionContext,
          }),
          writeBoundary,
          cwd,
          filesChanged,
          (params: any) => this.#extractPathsFromSearchReplace(params),
        ),
        this.#wrapWriteTool(
          createCreateFileToolDefinition({
            settingsService: this.#settings,
            loggingService: this.#logger,
            executionContext: this.#executionContext,
          }),
          writeBoundary,
          cwd,
          filesChanged,
          (params: any) => (params?.path ? [params.path] : []),
        ),
      );
    }

    registerToolFormatters(tools);

    return tools;
  }

  #extractPathsFromApplyPatch(params: any): string[] {
    if (Array.isArray(params?.operations)) {
      return params.operations.map((op: any) => op?.path).filter(Boolean);
    }
    return params?.path ? [params.path] : [];
  }

  #extractPathsFromSearchReplace(params: any): string[] {
    if (Array.isArray(params?.replacements)) {
      return params.replacements.map((replacement: any) => replacement?.path).filter(Boolean);
    }
    return params?.path ? [params.path] : [];
  }

  #extractSuccessfulWritePaths(result: unknown): string[] {
    if (typeof result !== 'string') return [];

    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed?.output)) {
        return parsed.output
          .filter((item: any) => item?.success === true && typeof item?.path === 'string')
          .map((item: any) => item.path);
      }

      if (parsed?.success === true && typeof parsed?.path === 'string') {
        return [parsed.path];
      }
    } catch {
      return [];
    }

    return [];
  }

  #tryAcquireWorkerWriteLocks(paths: string[], cwd: string): (() => void) | null {
    const uniqueResolvedPaths = [...new Set(paths.map((filePath) => path.resolve(cwd, filePath)))];
    const releases: Array<() => void> = [];

    for (const resolvedPath of uniqueResolvedPaths) {
      const release = tryAcquireFileLock(resolvedPath);
      if (!release) {
        for (const unlock of releases.reverse()) {
          unlock();
        }
        return null;
      }
      releases.push(release);
    }

    return () => {
      for (const unlock of releases.reverse()) {
        unlock();
      }
    };
  }

  /**
   * Wraps the shell tool for worker subagents:
   * - Sets needsApproval to always return false. Workers run synchronously
   *   inside a blocked parent tool call and have no foreground approval channel,
   *   so SDK interruptions (triggered by needsApproval returning true) would
   *   silently hang or fail.
   * - Gates execution via command safety classification instead. Safe (GREEN)
   *   commands execute normally; dangerous (YELLOW/RED) commands are blocked
   *   and return an error string to the model without executing.
   * - For GREEN commands that perform write operations (redirects to paths
   *   within the workspace), enforces the worker write boundary and acquires
   *   file locks so that shell-based writes and structured writes (apply_patch,
   *   create_file) share the same safety guarantees.
   */
  /**
   * Parse a shell command string and extract file paths used as redirect
   * targets or explicit path arguments that look like write operations.
   * Returns resolved absolute paths.
   */
  #extractPathsFromCommand(command: string, cwd: string): string[] {
    const paths: string[] = [];
    try {
      classifyCommand(command, this.#logger);
      // classifyCommand only returns a status, not parsed paths. For now
      // we tokenize the command to find redirect targets and path-like
      // arguments. This is a simple heuristic — comprehensive path
      // extraction from AST is tracked as future work.
      const tokens = command.match(/>\s*(\S+)|>>\s*(\S+)|tee\s+(\S+)/gi);
      if (tokens) {
        for (const token of tokens) {
          const match = token.match(/>+\s*(\S+)|tee\s+(\S+)/);
          if (match) {
            const p = match[1] ?? match[2];
            if (p) {
              const resolved = path.resolve(cwd, p);
              paths.push(resolved);
            }
          }
        }
      }
    } catch {
      // Parsing failure is non-fatal — proceed without path extraction
    }
    return [...new Set(paths)];
  }

  #wrapShellTool(
    definition: ToolDefinition,
    writeBoundary: string[] | undefined,
    cwd: string,
    filesChanged: string[],
  ): ToolDefinition {
    const originalExecute = definition.execute.bind(definition);

    return {
      ...definition,
      needsApproval: () => false,
      execute: async (params: any, context?: unknown, details?: unknown) => {
        const command: string = typeof params?.command === 'string' ? params.command : '';
        if (!command) {
          return originalExecute(params, context, details);
        }

        const status = classifyCommand(command, this.#logger);
        if (status === SafetyStatus.YELLOW || status === SafetyStatus.RED) {
          return `Error: command blocked for safety (${status}). Workers cannot run commands that require interactive approval. Command: ${command}`;
        }

        // For GREEN commands, extract any file paths referenced in the
        // command (redirect targets, arguments that look like paths) and
        // enforce the write boundary and file locks.
        const extractedPaths = this.#extractPathsFromCommand(command, cwd);
        if (extractedPaths.length > 0) {
          for (const filePath of extractedPaths) {
            if (!this.#isWithinWriteBoundary(filePath, writeBoundary, cwd)) {
              return `Error: command blocked — target path "${filePath}" is outside the allowed write boundary. Command: ${command}`;
            }
          }

          const releaseWorkerLocks = this.#tryAcquireWorkerWriteLocks(extractedPaths, cwd);
          if (!releaseWorkerLocks) {
            return 'Error: command blocked — one or more target files are already being modified by another worker.';
          }

          try {
            const result = await originalExecute(params, context, details);
            filesChanged.push(...extractedPaths);
            return result;
          } finally {
            releaseWorkerLocks();
          }
        }

        return originalExecute(params, context, details);
      },
    };
  }

  // An explicit writeBoundary narrows where a worker may write. When omitted it
  // defaults to the workspace root, so writes outside the workspace are always
  // rejected even without an explicit boundary.
  #isWithinWriteBoundary(filePath: string, writeBoundary: string[] | undefined, cwd: string): boolean {
    const boundaries = writeBoundary?.length ? writeBoundary : [cwd];

    const resolved = path.resolve(cwd, filePath);
    return boundaries.some((boundary) => {
      const resolvedBoundary = path.resolve(cwd, boundary);
      return resolved === resolvedBoundary || resolved.startsWith(resolvedBoundary + path.sep);
    });
  }

  #wrapWriteTool(
    definition: ToolDefinition,
    writeBoundary: string[] | undefined,
    cwd: string,
    filesChanged: string[],
    extractPaths: (params: any) => string[],
  ): ToolDefinition {
    const originalExecute = definition.execute.bind(definition);

    return {
      ...definition,
      // The writeBoundary is the worker's permission grant: in-boundary writes
      // are auto-approved (there is no foreground approval channel for a
      // subagent running inside a blocked parent tool call), and out-of-boundary
      // writes are rejected deterministically by execute() below. Either way no
      // interactive approval is required, so this never returns true.
      needsApproval: () => false,
      execute: async (params: any, context?: unknown) => {
        const paths = extractPaths(params);

        for (const filePath of paths) {
          if (!this.#isWithinWriteBoundary(filePath, writeBoundary, cwd)) {
            return JSON.stringify({
              output: [
                {
                  success: false,
                  error: `Write rejected: path "${filePath}" is outside the allowed write boundary.`,
                },
              ],
            });
          }
        }

        const releaseWorkerLocks = this.#tryAcquireWorkerWriteLocks(paths, cwd);
        if (!releaseWorkerLocks) {
          return JSON.stringify({
            output: [
              {
                success: false,
                error: 'Write rejected: one or more target files are already being modified by another worker.',
              },
            ],
          });
        }

        try {
          const result = await originalExecute(params, context);
          for (const successfulPath of this.#extractSuccessfulWritePaths(result)) {
            filesChanged.push(successfulPath);
          }
          return result;
        } finally {
          releaseWorkerLocks();
        }
      },
    };
  }
}
