import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Agent, RunContext, Runner, type Tool } from '@openai/agents';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { SubagentRequest, SubagentResult, SupportedSubagentRole } from './types.js';
import { SUBAGENT_ROLES } from './types.js';
import { SubagentToolFactory, getSubagentRunContext, type SubagentRunContext } from './tool-policy.js';
import {
  loadRoleDefinition,
  resolvePrompt,
  resolveSubagentSearchViaShell,
  buildAvailableToolGuidance,
  selectSubagentBasePromptFile,
  PROMPTS_DIR,
} from './role-loader.js';
import { getEnvInfo, getAgentsInstructions } from '../../agent.js';
import { getProvider } from '../../providers/index.js';
import { extractFinalText, aggregateContextToolUsage, safeEmit } from './utils.js';
import { normalizeAgentRunUsage, extractUsage } from '../../utils/ai/token-usage.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

export type CachedRoleTool = {
  agent: Agent<SubagentRunContext>;
  tool: Tool<SubagentRunContext>;
};

const AGENT_TOOL_ERROR_PREFIX = 'An error occurred while running the tool. Please try again. Error:';

/**
 * Increments the subagent's turn counter on every model call.
 *
 * The OpenAI Agents SDK invokes `callModelInputFilter` with `args.context` set
 * to the **unwrapped** user context (see `applyCallModelInputFilter` in
 * `@openai/agents-core/dist/runner/conversation.js`, which passes
 * `context: context.context`). Earlier versions of this code read
 * `args.context.context.turnCount`, which is always `undefined` and caused the
 * counter to never advance, preventing the turn-limit warning from ever
 * being injected into nested subagent tool output.
 */
export function incrementSubagentTurnCount(args: { context?: unknown; modelData: any }): any {
  const context = args.context as { turnCount?: number } | undefined;
  if (context && typeof context === 'object') {
    context.turnCount = (context.turnCount ?? 0) + 1;
  }
  return args.modelData;
}

function parseNestedSubagentResult(raw: unknown): SubagentResult & { interrupted?: boolean } {
  const output = String(raw);
  if (output.startsWith(AGENT_TOOL_ERROR_PREFIX)) {
    const message = output.slice(AGENT_TOOL_ERROR_PREFIX.length).trim();
    throw new Error(message || 'Nested subagent tool failed');
  }
  return JSON.parse(output) as SubagentResult & { interrupted?: boolean };
}

export class NestedSubagentRunner {
  #logger: ILoggingService;
  #settings: ISettingsService;
  #sessionContextService: ISessionContextService;
  #executionContext?: ExecutionContext;
  #toolFactory: SubagentToolFactory;
  #onEvent?: (event: ConversationEvent) => void;
  #roleToolCache: Map<SupportedSubagentRole, CachedRoleTool>;

  constructor(deps: {
    logger: ILoggingService;
    settings: ISettingsService;
    sessionContextService: ISessionContextService;
    executionContext?: ExecutionContext;
    toolFactory: SubagentToolFactory;
    onEvent?: (event: ConversationEvent) => void;
    roleToolCache: Map<SupportedSubagentRole, CachedRoleTool>;
  }) {
    this.#logger = deps.logger;
    this.#settings = deps.settings;
    this.#sessionContextService = deps.sessionContextService;
    this.#executionContext = deps.executionContext;
    this.#toolFactory = deps.toolFactory;
    this.#onEvent = deps.onEvent;
    this.#roleToolCache = deps.roleToolCache;
  }

  clearCache(): void {
    this.#roleToolCache.clear();
  }

  getRoleAgentTool(role: SupportedSubagentRole): Tool<SubagentRunContext> {
    return this.#getOrCreateRoleTool(role).tool;
  }

  getRoleAgent(role: SupportedSubagentRole): Agent<SubagentRunContext> {
    return this.#getOrCreateRoleTool(role).agent;
  }

  #restoreRunContext(resumeState?: string): SubagentRunContext | undefined {
    if (!resumeState) return undefined;
    try {
      const parsed = JSON.parse(resumeState);
      const context = parsed?.context?.context;
      if (
        context &&
        typeof context.agentId === 'string' &&
        Array.isArray(context.filesChanged) &&
        context.toolCounts &&
        typeof context.toolCounts === 'object' &&
        context.activeCommandMessages &&
        typeof context.activeCommandMessages === 'object'
      ) {
        return context as SubagentRunContext;
      }
    } catch (error: any) {
      this.#logger.warn('Failed to restore nested subagent bookkeeping context', {
        error: error?.message || String(error),
      });
    }
    return undefined;
  }

  #getOrCreateRoleTool(role: SupportedSubagentRole): CachedRoleTool {
    const cached = this.#roleToolCache.get(role);
    if (cached) return cached;

    const definition = loadRoleDefinition(role, this.#settings);
    const searchViaShell = resolveSubagentSearchViaShell(this.#settings, definition.model, definition.canRunShell);
    const toolDefinitions = this.#toolFactory.buildToolDefinitions(definition, [], '', searchViaShell, true);
    const providerId = definition.provider;
    const tools = this.#toolFactory.buildAgentTools(toolDefinitions, {
      providerId,
      onToolStart: (name, params, commandMessages, context, details) => {
        const runContext = getSubagentRunContext(context);
        if (!runContext) return;
        const callId = (details as any)?.toolCall?.callId ?? `subagent-tool-${randomUUID()}`;
        runContext.toolCounts[name] = (runContext.toolCounts[name] ?? 0) + 1;
        runContext.activeCommandMessages[callId] = commandMessages;
        safeEmit(this.#logger, this.#onEvent, {
          type: 'subagent_tool_started',
          agentId: runContext.agentId,
          role: runContext.role,
          toolCallId: callId,
          toolName: name,
          arguments: params,
        });
        for (const message of commandMessages) {
          safeEmit(this.#logger, this.#onEvent, {
            type: 'subagent_command_message',
            agentId: runContext.agentId,
            role: runContext.role,
            message,
          });
        }
      },
      onToolComplete: (_name, result, context, details) => {
        const runContext = getSubagentRunContext(context);
        if (!runContext) return;
        const callId = (details as any)?.toolCall?.callId;
        const messages = (callId && runContext.activeCommandMessages[callId]) ?? [];
        for (const message of messages) {
          safeEmit(this.#logger, this.#onEvent, {
            type: 'subagent_command_message',
            agentId: runContext.agentId,
            role: runContext.role,
            message: {
              ...message,
              status: 'completed',
              output: typeof result === 'string' ? result : JSON.stringify(result),
              success: true,
            },
          });
        }
        if (callId) {
          delete runContext.activeCommandMessages[callId];
        }
      },
    });

    const modelSettings: any = { retry: { maxRetries: this.#settings.get<number>('agent.retryAttempts') ?? 2 } };
    if (definition.reasoningEffort && definition.reasoningEffort !== 'default') {
      modelSettings.reasoning = { effort: definition.reasoningEffort, summary: 'auto' };
    }

    const envInfo = getEnvInfo(this.#settings, this.#executionContext);
    const cwd = this.#executionContext?.getCwd() ?? process.cwd();
    const agentsInstructions = this.#executionContext?.isRemote() ? '' : getAgentsInstructions(cwd);
    const instructions = [
      resolvePrompt(path.join(PROMPTS_DIR, selectSubagentBasePromptFile(definition.model))),
      resolvePrompt(path.join(PROMPTS_DIR, 'worktree-hygiene.md')),
      definition.instructions,
      buildAvailableToolGuidance(toolDefinitions, searchViaShell),
      `Environment: ${envInfo}${agentsInstructions}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const agent = new Agent<SubagentRunContext>({
      name: definition.name,
      model: definition.model,
      modelSettings,
      instructions,
      tools,
    });

    const providerDef = getProvider(providerId);
    const configuredRunner =
      providerId === 'openai'
        ? new Runner()
        : providerDef?.createRunner?.({
            settingsService: this.#settings,
            loggingService: this.#logger,
            sessionContextService: this.#sessionContextService,
          });
    const runConfig = (configuredRunner as Runner | undefined)?.config;
    const parameters = z.object({
      role: z.literal(role),
      task: z.string(),
    });
    const tool = agent.asTool({
      toolName: `run_subagent_${role}`,
      toolDescription: `Run the ${role} subagent.`,
      parameters,
      inputBuilder: ({ params }) => params.task,
      ...(runConfig ? { runConfig } : {}),
      runOptions: {
        maxTurns: definition.maxTurns,
        callModelInputFilter: incrementSubagentTurnCount,
      },
      resumeState: { contextStrategy: 'merge' },
      customOutputExtractor: (completedResult: any) => {
        const runContext =
          getSubagentRunContext(completedResult?.state?._context) ??
          ({
            agentId: randomUUID(),
            role,
            task: '',
            filesChanged: [],
            toolCounts: {},
            activeCommandMessages: {},
            turnCount: 0,
            maxTurns: definition.maxTurns,
          } satisfies SubagentRunContext);
        const result: SubagentResult & { interrupted?: boolean } = {
          agentId: runContext.agentId,
          role,
          status: 'completed',
          finalText: extractFinalText(completedResult),
          filesChanged: [...new Set(runContext.filesChanged)],
          toolsUsed: aggregateContextToolUsage(runContext.toolCounts),
          usage: normalizeAgentRunUsage(completedResult?.state?.usage) ?? extractUsage(completedResult),
          ...(completedResult?.interruptions?.length ? { interrupted: true } : {}),
        };
        return JSON.stringify(result);
      },
    }) as Tool<SubagentRunContext>;

    const created = { agent, tool };
    this.#roleToolCache.set(role, created);
    return created;
  }

  async runAsTool(request: SubagentRequest, context?: unknown, details?: unknown): Promise<SubagentResult> {
    if (!SUBAGENT_ROLES.includes(request.role as SupportedSubagentRole)) {
      throw new Error(`Unsupported subagent role: "${request.role}"`);
    }
    const role = request.role as SupportedSubagentRole;
    const detailsRecord = details as
      | { resumeState?: string; signal?: AbortSignal; toolCall?: { callId?: string } }
      | undefined;
    const signal = detailsRecord?.signal ?? request.signal;
    if (signal?.aborted) {
      const error = new Error('The nested subagent run was aborted.');
      error.name = 'AbortError';
      throw error;
    }
    const restoredContext = this.#restoreRunContext(detailsRecord?.resumeState);
    const agentId = restoredContext?.agentId ?? detailsRecord?.toolCall?.callId ?? randomUUID();
    const runContext: SubagentRunContext = restoredContext ?? {
      agentId,
      role,
      task: request.task,
      filesChanged: [],
      toolCounts: {},
      activeCommandMessages: {},
      turnCount: 0,
      maxTurns: loadRoleDefinition(role, this.#settings).maxTurns,
    };
    runContext.task = request.task;

    if (!detailsRecord?.resumeState) {
      safeEmit(this.#logger, this.#onEvent, {
        type: 'subagent_started',
        agentId,
        role,
        task: request.task,
        parentTool: request.parentTool,
      });
    }

    const nestedContext = new RunContext(runContext);
    const parentContext = context as RunContext<unknown> | undefined;
    if (parentContext && typeof (nestedContext as any)._mergeApprovals === 'function') {
      (nestedContext as any)._mergeApprovals(parentContext.toJSON().approvals);
    }

    try {
      const tool = this.#getOrCreateRoleTool(role).tool as any;
      const raw = await tool.invoke(nestedContext, JSON.stringify({ role, task: request.task }), details);
      const parsed = parseNestedSubagentResult(raw);
      if (!parsed.interrupted) {
        safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result: parsed });
      }
      return parsed;
    } catch (error: any) {
      this.#logger.error('Nested subagent tool failed', {
        agentId,
        role,
        error: error?.message || String(error),
      });
      throw error;
    }
  }
}
