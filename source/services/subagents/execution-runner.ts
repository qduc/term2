import { Agent } from '@openai/agents';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { SubagentRequest, SubagentDefinition, SubagentResult } from './types.js';
import type { SubagentToolFactory } from './tool-policy.js';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../retry/conversation-retry-policy.js';
import { isAbortLike, aggregateToolUsage, safeEmit } from './utils.js';
import { normalizeAgentRunUsage, extractUsage } from '../../utils/ai/token-usage.js';
import { buildInstructions, resolveSubagentSearchViaShell } from './role-loader.js';
import type { ISubagentClientFactory } from './subagent-client-types.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { createSessionRuntime } from '../session/session-composition.js';

export class ExecutionSubagentRunner {
  #logger: ILoggingService;
  #settings: ISettingsService;
  #sessionContextService: ISessionContextService;
  #executionContext?: ExecutionContext;
  #createClient?: ISubagentClientFactory['createClient'];
  #toolFactory: SubagentToolFactory;
  #onEvent?: (event: ConversationEvent) => void;

  constructor(deps: {
    logger: ILoggingService;
    settings: ISettingsService;
    sessionContextService: ISessionContextService;
    executionContext?: ExecutionContext;
    createClient?: ISubagentClientFactory['createClient'];
    toolFactory: SubagentToolFactory;
    onEvent?: (event: ConversationEvent) => void;
  }) {
    this.#logger = deps.logger;
    this.#settings = deps.settings;
    this.#sessionContextService = deps.sessionContextService;
    this.#executionContext = deps.executionContext;
    this.#createClient = deps.createClient;
    this.#toolFactory = deps.toolFactory;
    this.#onEvent = deps.onEvent;
  }

  async run(agentId: string, request: SubagentRequest, definition: SubagentDefinition): Promise<SubagentResult> {
    if (!this.#createClient) {
      throw new Error('SubagentManager: createClient factory not provided');
    }

    const toolCounts = new Map<string, number>();
    const filesChanged: string[] = [];

    const searchViaShell = resolveSubagentSearchViaShell(this.#settings, definition.model, definition.canRunShell);
    const toolDefinitions = this.#toolFactory.buildToolDefinitions(
      definition,
      filesChanged,
      request.task,
      searchViaShell,
    );

    const providerId = definition.provider;
    const tools = this.#toolFactory.buildAgentTools(toolDefinitions, {
      providerId,
      onToolStart: (name) => {
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      },
    });

    const modelSettings: any = {
      retry: { maxRetries: this.#settings.get<number>('agent.retryAttempts') ?? 2 },
    };
    if (definition.reasoningEffort && definition.reasoningEffort !== 'default') {
      modelSettings.reasoning = { effort: definition.reasoningEffort, summary: 'auto' };
    }

    const fullInstructions = buildInstructions(
      definition,
      toolDefinitions,
      searchViaShell,
      this.#settings,
      this.#executionContext,
    );

    const agent = new Agent({
      name: definition.name,
      model: definition.model,
      ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
      instructions: fullInstructions,
      tools,
    });

    const subClient = this.#createClient({
      agent,
      provider: providerId,
      maxTurns: definition.maxTurns,
      retryAttempts: this.#settings.get<number>('agent.retryAttempts') ?? 2,
    });

    const runtime = createSessionRuntime({
      sessionId: `subagent-${agentId}`,
      agentClient: subClient,
      deps: {
        logger: this.#logger,
        settingsService: this.#settings,
        sessionContextService: this.#sessionContextService,
      },
      retryOptions: {
        allowFreshStartRetries: false,
      },
    });

    const userTurn = { text: request.task, images: [] as any[] };
    let finalText = '';
    let usage: any = undefined;
    let error: Error | undefined;
    let subagentStatus: SubagentResult['status'] = 'completed';
    let loopProcessedError = false;

    try {
      for await (const event of runtime.turns.start(userTurn, {
        signal: request.signal,
        maxModelRetries: MAX_SUBAGENT_MODEL_RETRIES,
      })) {
        switch (event.type) {
          case 'tool_started':
            if (event.toolName) {
              safeEmit(this.#logger, this.#onEvent, {
                type: 'subagent_tool_started',
                agentId,
                role: request.role,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                arguments: event.arguments,
              });
            }
            break;
          case 'command_message':
            safeEmit(this.#logger, this.#onEvent, {
              type: 'subagent_command_message',
              agentId,
              role: request.role,
              message: event.message,
            });
            break;
          case 'final':
            finalText = event.finalText;
            if (event.usage) usage = event.usage;
            break;
          case 'usage_update':
            if (event.usage) usage = event.usage;
            break;
          case 'error':
            error = new Error(event.message);
            loopProcessedError = true;
            subagentStatus = isAbortLike(event.message, event) ? 'cancelled' : 'failed';
            break;
          case 'retry':
            safeEmit(this.#logger, this.#onEvent, {
              type: 'retry',
              toolName: event.toolName,
              attempt: event.attempt,
              maxRetries: event.maxRetries,
              errorMessage: event.errorMessage,
              retryType: event.retryType,
              agentId,
              role: request.role,
            } as any);
            break;
        }
      }
    } catch (err: any) {
      if (!error) {
        error = err instanceof Error ? err : new Error(String(err));
      }
      if (!loopProcessedError) {
        subagentStatus = isAbortLike(error.message, error) || isAbortLike(err?.message, err) ? 'cancelled' : 'failed';
      }
      if (!usage) {
        usage = normalizeAgentRunUsage(err?.state?.usage) ?? extractUsage(err);
      }
    } finally {
      runtime.dispose();
    }

    if (error) {
      return {
        agentId,
        role: request.role,
        status: subagentStatus,
        finalText: '',
        filesChanged: [...new Set(filesChanged)],
        toolsUsed: aggregateToolUsage(toolCounts),
        error: error.message,
        ...(usage ? { usage } : {}),
      };
    }

    return {
      agentId,
      role: request.role,
      status: 'completed',
      finalText,
      filesChanged: [...new Set(filesChanged)],
      toolsUsed: aggregateToolUsage(toolCounts),
      ...(usage ? { usage } : {}),
    };
  }
}
