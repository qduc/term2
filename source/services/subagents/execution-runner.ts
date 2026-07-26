import { Agent } from '@openai/agents';
import path from 'node:path';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type {
  SubagentRequest,
  SubagentDefinition,
  SubagentResult,
  DiffStatEntry,
  SubagentSegmentControl,
} from './types.js';
import { SubagentToolFactory, type ValidationCapture } from './tool-policy.js';
import { SubagentSession } from './subagent-session.js';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../retry/conversation-retry-policy.js';
import { isAbortLike, aggregateToolUsage, safeEmit } from './utils.js';
import { normalizeAgentRunUsage, extractUsage } from '../../utils/ai/token-usage.js';
import { buildInstructions, resolveSubagentSearchViaShell } from './role-loader.js';
import type { ISubagentClientFactory } from './subagent-client-types.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { createSessionRuntime } from '../session/session-composition.js';
import { AcquiredChildSlot } from '../agent-runtime/execution-budget.js';
import type { SkillsService } from '../skills/skills-service.js';

const MAX_PEEK_TEXT_LENGTH = 200;

export class ExecutionSubagentRunner {
  #logger: ILoggingService;
  #settings: ISettingsService;
  #sessionContextService: ISessionContextService;
  #executionContext?: ExecutionContext;
  #createClient?: ISubagentClientFactory['createClient'];
  #toolFactory: SubagentToolFactory;
  #onEvent?: (event: ConversationEvent) => void;
  #skillsService?: SkillsService;

  constructor(deps: {
    logger: ILoggingService;
    settings: ISettingsService;
    sessionContextService: ISessionContextService;
    executionContext?: ExecutionContext;
    createClient?: ISubagentClientFactory['createClient'];
    toolFactory: SubagentToolFactory;
    onEvent?: (event: ConversationEvent) => void;
    skillsService?: SkillsService;
  }) {
    this.#logger = deps.logger;
    this.#settings = deps.settings;
    this.#sessionContextService = deps.sessionContextService;
    this.#executionContext = deps.executionContext;
    this.#createClient = deps.createClient;
    this.#toolFactory = deps.toolFactory;
    this.#onEvent = deps.onEvent;
    this.#skillsService = deps.skillsService;
  }

  async run(agentId: string, request: SubagentRequest, definition: SubagentDefinition): Promise<SubagentResult> {
    return this.#execute(
      agentId,
      request,
      definition,
      new SubagentSession(agentId, request.role),
      undefined,
      request.signal,
      undefined,
      undefined,
      request.task,
    );
  }

  async runInSession(
    agentId: string,
    request: SubagentRequest,
    definition: SubagentDefinition,
    session: SubagentSession,
    providedChildSlot?: AcquiredChildSlot,
    signal?: AbortSignal,
    onEventOverride?: (event: ConversationEvent) => void,
    segmentControl?: SubagentSegmentControl,
    input = request.task,
  ): Promise<SubagentResult> {
    return this.#execute(
      agentId,
      request,
      definition,
      session,
      providedChildSlot,
      signal,
      onEventOverride,
      segmentControl,
      input,
    );
  }

  async #execute(
    agentId: string,
    request: SubagentRequest,
    definition: SubagentDefinition,
    session: SubagentSession,
    providedChildSlot: AcquiredChildSlot | undefined,
    signal: AbortSignal | undefined,
    onEventOverride: ((event: ConversationEvent) => void) | undefined,
    segmentControl: SubagentSegmentControl | undefined,
    input: string,
  ): Promise<SubagentResult> {
    if (!this.#createClient) {
      throw new Error('SubagentManager: createClient factory not provided');
    }

    // ── Budget enforcement ──
    // Root executions do NOT consume a child slot; only actual nested
    // agent runs do. The root budget tracks children, not itself.
    let childSlot = providedChildSlot;
    let executionBudget = definition.executionBudget;
    if (definition.executionBudget && !definition.isRootExecution && !childSlot) {
      executionBudget = definition.executionBudget.createChildBudget();
      const slot = definition.executionBudget.tryAcquireChild();
      if (!(slot instanceof AcquiredChildSlot)) {
        return {
          agentId,
          role: request.role,
          status: 'failed',
          finalText: '',
          filesChanged: [],
          toolsUsed: [],
          error: `Budget exhausted: ${slot.reason}${slot.max !== undefined ? ` (${slot.current}/${slot.max})` : ''}`,
        };
      }
      childSlot = slot;
    }

    const toolCounts = new Map<string, number>();
    const filesChanged: string[] = [];
    const diffDeltas = new Map<string, { added: number; deleted: number }>();
    const validationCapture: ValidationCapture = {};

    const searchViaShell = resolveSubagentSearchViaShell(this.#settings, definition.model, definition.canRunShell);
    const toolDefinitions = this.#toolFactory.buildToolDefinitions(
      definition,
      filesChanged,
      request.task,
      searchViaShell,
      false,
      diffDeltas,
      validationCapture,
      segmentControl ? (question) => segmentControl.askOrchestrator(question) : undefined,
    );

    const providerId = definition.provider;
    const tools = this.#toolFactory.buildAgentTools(toolDefinitions, {
      providerId,
      onToolStart: (name) => {
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        segmentControl?.onToolStart();
      },
      onToolComplete: () => {
        segmentControl?.onToolComplete();
      },
    });

    const modelSettings: any = {
      retry: { maxRetries: this.#settings.get<number>('agent.retryAttempts') ?? 2 },
    };
    if (definition.reasoningEffort && definition.reasoningEffort !== 'default') {
      modelSettings.reasoning = { effort: definition.reasoningEffort, summary: 'auto' };
    }
    // Pass maxTokens from definition to provider model settings
    if (definition.maxTokens !== undefined) {
      modelSettings.maxTokens = definition.maxTokens;
    }

    const fullInstructions = buildInstructions(
      definition,
      toolDefinitions,
      searchViaShell,
      this.#settings,
      this.#executionContext,
      this.#skillsService,
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

    const initialState = session.exportState();
    if (initialState.history.length > 0) {
      runtime.state.importState(initialState);
    }

    const onEvent = onEventOverride ?? this.#onEvent;
    const userTurn = { text: input, images: [] as any[] };
    let finalText = '';
    let usage: any = undefined;
    let error: Error | undefined;
    let subagentStatus: SubagentResult['status'] = 'completed';
    let loopProcessedError = false;
    let currentText = '';

    try {
      for await (const event of runtime.turns.start(userTurn, {
        signal,
        maxModelRetries: MAX_SUBAGENT_MODEL_RETRIES,
      })) {
        switch (event.type) {
          case 'text_delta':
            currentText = `${currentText}${event.delta}`.slice(0, MAX_PEEK_TEXT_LENGTH);
            safeEmit(this.#logger, onEvent, {
              type: 'subagent_streaming_text',
              agentId,
              text: currentText,
            });
            break;
          case 'tool_started':
            if (currentText.trim()) {
              safeEmit(this.#logger, onEvent, {
                type: 'subagent_text_turn',
                agentId,
                role: request.role,
                text: currentText,
              });
              currentText = '';
            }
            if (event.toolName) {
              safeEmit(this.#logger, onEvent, {
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
            safeEmit(this.#logger, onEvent, {
              type: 'subagent_command_message',
              agentId,
              role: request.role,
              message: event.message,
            });
            break;
          case 'final':
            if (currentText.trim()) {
              safeEmit(this.#logger, onEvent, {
                type: 'subagent_text_turn',
                agentId,
                role: request.role,
                text: currentText,
              });
              currentText = '';
            }
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
            currentText = '';
            safeEmit(this.#logger, onEvent, {
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
      try {
        const exported = runtime.state.exportState();
        session.importState(exported as any);
        const messageCap = this.#settings.get<number>('subagent.asyncMessageCap') ?? 50;
        session.trimHistory(messageCap);
      } catch (exportErr: any) {
        this.#logger.debug('Failed to export async subagent session state', {
          agentId,
          error: exportErr?.message || String(exportErr),
        });
      }
      // Record usage to the budget on every terminal path
      if (childSlot && usage) {
        executionBudget!.recordUsage(usage);
      }
      // Release the child slot
      childSlot?.release();
      runtime.dispose();
    }

    const diffStat = buildDiffStat(filesChanged, diffDeltas);
    const validation = validationCapture.value;

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
        ...(diffStat.length > 0 ? { diffStat } : {}),
        ...(validation ? { validation } : {}),
      };
    }

    return {
      agentId,
      role: request.role,
      status: 'completed',
      finalText: truncateResultText(finalText),
      filesChanged: [...new Set(filesChanged)],
      toolsUsed: aggregateToolUsage(toolCounts),
      ...(usage ? { usage } : {}),
      ...(diffStat.length > 0 ? { diffStat } : {}),
      ...(validation ? { validation } : {}),
    };
  }
}

function buildDiffStat(
  filesChanged: string[],
  diffDeltas: Map<string, { added: number; deleted: number }>,
): DiffStatEntry[] {
  const seen = new Set<string>();
  const entries: DiffStatEntry[] = [];
  for (const file of filesChanged) {
    if (seen.has(file)) continue;
    seen.add(file);
    const delta = diffDeltas.get(file) ?? diffDeltas.get(resolveSafe(file));
    entries.push({
      path: file,
      added: delta?.added ?? 0,
      deleted: delta?.deleted ?? 0,
    });
  }
  return entries;
}

function resolveSafe(p: string): string {
  try {
    return path.resolve(p);
  } catch {
    return p;
  }
}

const MAX_FINAL_TEXT_CHARS = 4000;

function truncateResultText(text: string): string {
  if (text.length <= MAX_FINAL_TEXT_CHARS) return text;
  return text.slice(0, MAX_FINAL_TEXT_CHARS) + '\n...(truncated)';
}
