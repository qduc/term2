import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ApplicationRunLoop,
  type AgentModelSettings,
  type ApplicationAgent,
} from '../agent-runtime/application-run-loop.js';
import { ApprovalLedger, type ToolInvocationContext } from '../agent-runtime/tool-invocation-context.js';
import { getProvider } from '../../providers/index.js';
import type { AnyToolDefinition } from '../../tools/types.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type {
  NestedSubagentResult,
  SubagentRequest,
  SubagentResult,
  SupportedSubagentRole,
  SubagentDefinition,
} from './types.js';
import type { SkillsService } from '../skills/skills-service.js';
import { SUBAGENT_ROLES } from './types.js';
import { SubagentToolFactory, getSubagentRunContext, type SubagentRunContext } from './tool-policy.js';
import { loadRoleDefinition, resolveSubagentSearchViaShell, buildInstructions } from './role-loader.js';
import {
  extractFinalText,
  aggregateContextToolUsage,
  safeEmit,
  createCompositeAbortSignal,
  createAbortError,
  isAbortLike,
} from './utils.js';
import { normalizeAgentRunUsage, extractUsage } from '../../utils/ai/token-usage.js';
import type { ModelRequestCost } from '../../services/cost/model-cost.js';
import { replayApprovals, type ApprovalRecord } from '../approval/approval-replay.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { AcquiredChildSlot } from '../agent-runtime/execution-budget.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { getCallIdFromObject } from '../interruption-info.js';
import { normalizeToolParameters } from '../../lib/tool-invoke.js';
import { ForegroundSubagentLease } from './foreground-subagent-lease.js';

export type CachedRoleTool = {
  agent: ApplicationAgent;
  tool: AnyToolDefinition;
};

const AGENT_TOOL_ERROR_PREFIX = 'An error occurred while running the tool. Please try again. Error:';

// Turn counting used to live here as a `callModelInputFilter` hook, which the
// SDK-shaped tool wrapper dropped on the floor. `ApplicationRunLoop` owns it
// now: the nested run is given `maxTurns` and reports its budget to tools as
// `ToolInvocationContext.turn`.

function collectApprovalCallIds(interruptions: unknown): string[] {
  if (!Array.isArray(interruptions)) {
    return [];
  }
  const callIds: string[] = [];
  for (const interruption of interruptions) {
    const callId = getCallIdFromObject(interruption);
    if (callId) {
      callIds.push(callId);
    }
  }
  return callIds;
}

/**
 * Reads the approvals of the run context the subagent tool was invoked from.
 *
 * The parent is the `ToolInvocationContext` the run loop hands to tools; its
 * ledger snapshot replaces the old structural `toJSON()` probe on whatever the
 * loop handed over (which was never a RunContext, so replay was always a no-op
 * — F5). A caller without a ledger simply contributes no approvals.
 */
function readParentApprovals(context: unknown): Readonly<Record<string, ApprovalRecord>> | undefined {
  const parent = context as { approvals?: { snapshot: () => Readonly<Record<string, ApprovalRecord>> } } | undefined;
  return parent?.approvals?.snapshot();
}

function parseNestedSubagentResult(raw: unknown): NestedSubagentResult {
  const output = String(raw);
  if (output.startsWith(AGENT_TOOL_ERROR_PREFIX)) {
    const message = output.slice(AGENT_TOOL_ERROR_PREFIX.length).trim();
    throw new Error(message || 'Nested subagent tool failed');
  }
  return JSON.parse(output) as NestedSubagentResult;
}

export class NestedSubagentRunner {
  #logger: ILoggingService;
  #settings: ISettingsService;
  #sessionContextService: ISessionContextService;
  #executionContext?: ExecutionContext;
  #toolFactory: SubagentToolFactory;
  #onEvent?: (event: ConversationEvent) => void;
  #roleToolCache: Map<SupportedSubagentRole, CachedRoleTool>;
  #skillsService?: SkillsService;
  #toolOwnership: ToolOwnershipRegistry;
  /** Live foreground runs, addressable by the stable root tool-call id. */
  #foregroundLeases = new Map<
    string,
    { lease: ForegroundSubagentLease; role: string; task: string; parentTool?: string }
  >();
  /**
   * Optional resolver that overrides the default `loadRoleDefinition`.
   * When set, all role loads in `#getOrCreateRoleTool` go through this
   * callback. This allows the agent-runtime / `SubagentManager` to
   * inject the shared `ResolvedAgentDefinition` adaptation so that every
   * role passes through the same resolution before reaching the SDK.
   */
  readonly #resolveRole?: (role: SupportedSubagentRole) => SubagentDefinition;

  constructor(deps: {
    logger: ILoggingService;
    settings: ISettingsService;
    sessionContextService: ISessionContextService;
    executionContext?: ExecutionContext;
    toolFactory: SubagentToolFactory;
    onEvent?: (event: ConversationEvent) => void;
    roleToolCache: Map<SupportedSubagentRole, CachedRoleTool>;
    /** Optional role resolver for shared resolution path. */
    resolveRole?: (role: SupportedSubagentRole) => SubagentDefinition;
    skillsService?: SkillsService;
    /** Session-owned registry where this runner records pending tool owners. */
    toolOwnership: ToolOwnershipRegistry;
  }) {
    this.#logger = deps.logger;
    this.#settings = deps.settings;
    this.#sessionContextService = deps.sessionContextService;
    this.#executionContext = deps.executionContext;
    this.#toolFactory = deps.toolFactory;
    this.#onEvent = deps.onEvent;
    this.#roleToolCache = deps.roleToolCache;
    this.#resolveRole = deps.resolveRole;
    this.#skillsService = deps.skillsService;
    this.#toolOwnership = deps.toolOwnership;
  }

  clearCache(): void {
    this.#roleToolCache.clear();
  }

  getRoleAgentTool(role: SupportedSubagentRole): AnyToolDefinition {
    return this.#getOrCreateRoleTool(role).tool;
  }

  getRoleAgent(role: SupportedSubagentRole): any {
    return this.#getOrCreateRoleTool(role).agent;
  }

  /** Candidate lookup only; ownership moves through the async registry. */
  getForegroundLease(runId: string): ForegroundSubagentLease | undefined {
    return this.#foregroundLeases.get(runId)?.lease;
  }

  getForegroundCandidate(
    runId: string,
  ): { lease: ForegroundSubagentLease; role: string; task: string; parentTool?: string } | undefined {
    return this.#foregroundLeases.get(runId);
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

    // Use the injected resolver when available (shared ResolvedAgentDefinition
    // adaptation path); otherwise fall back to direct loadRoleDefinition.
    const definition = this.#resolveRole ? this.#resolveRole(role) : loadRoleDefinition(role, this.#settings);
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

    const modelSettings: AgentModelSettings = {
      retry: { maxRetries: this.#settings.get('agent.retryAttempts') ?? 2 },
    };
    if (definition.reasoningEffort && definition.reasoningEffort !== 'default') {
      modelSettings.reasoning = { effort: definition.reasoningEffort, summary: 'auto' };
    }
    // Pass maxTokens from definition to provider model settings
    if (definition.maxTokens !== undefined) {
      modelSettings.maxTokens = definition.maxTokens;
    }

    const instructions = buildInstructions(
      definition,
      toolDefinitions,
      searchViaShell,
      this.#settings,
      this.#executionContext,
      this.#skillsService,
    );

    const agent: ApplicationAgent = {
      name: definition.name,
      model: definition.model,
      modelSettings,
      instructions,
      tools,
    };

    const tool = this.createSubagentTool(role, definition, agent);

    const created = { agent, tool };
    this.#roleToolCache.set(role, created);
    return created;
  }

  /**
   * Builds the `run_subagent_<role>` tool. Its `execute` actually runs the role
   * agent through `ApplicationRunLoop` — replacing the legacy `Agent.asTool`
   * stub whose execute returned the raw task string and dropped every run
   * option, which is why nested subagents could never return a result (F1).
   *
   * The run's `SubagentRunContext` and the replayed parent approvals arrive on
   * the `ToolInvocationContext` that `runAsTool` builds; the loop seeds its
   * ledger from `toolContext.approvals`, so parent decisions are honored (F5)
   * and the run's own decisions accumulate on the same ledger.
   */
  createSubagentTool(
    role: SupportedSubagentRole,
    definition: SubagentDefinition,
    agent: ApplicationAgent,
  ): AnyToolDefinition {
    const parameters = z.object({
      role: z.literal(role),
      task: z.string(),
    });
    return {
      name: `run_subagent_${role}`,
      description: `Run the ${role} subagent.`,
      parameters,
      needsApproval: () => false,
      formatCommandMessage: () => [],
      execute: async (params: unknown, context: unknown, details: unknown) => {
        const { task } = params as { task: string };
        const toolContext = context as ToolInvocationContext<SubagentRunContext> | undefined;
        const runContext =
          toolContext?.context ??
          ({
            agentId: randomUUID(),
            role,
            task,
            filesChanged: [],
            toolCounts: {},
            activeCommandMessages: {},
            turnCount: 0,
            maxTurns: definition.maxTurns,
          } satisfies SubagentRunContext);
        runContext.task = task;

        const detailsRecord = details as
          | { signal?: AbortSignal; foregroundSubagentLease?: ForegroundSubagentLease }
          | undefined;
        const foregroundLease = detailsRecord?.foregroundSubagentLease;
        const signal = detailsRecord?.signal;
        const providerId = definition.provider;
        const provider = getProvider(providerId);
        if (!provider?.createStreamedModel) {
          throw new Error(`Provider '${providerId}' has no application-owned model for nested subagents`);
        }
        const createStreamedModel = provider.createStreamedModel;
        // Continuations can be triggered later from the session's background
        // control lane. Preserve the provider-history context captured at
        // launch instead of inheriting that unrelated caller context.
        const trafficContext = this.#sessionContextService.getContext();
        const loop = new ApplicationRunLoop({
          resolveModel: (model) =>
            createStreamedModel(model, {
              settingsService: this.#settings,
              loggingService: this.#logger,
              sessionContextService: this.#sessionContextService,
            }),
        });

        let stream = loop.startStream(agent, task, {
          context: runContext,
          signal,
          // The nested run's ledger was seeded with the parent's decisions by
          // runAsTool; use it so F5 holds and nested decisions land on it.
          approvals: toolContext?.approvals,
          // Without this the role's configured budget is advisory only and the
          // nested run is bounded solely by the model choosing to stop.
          maxTurns: definition.maxTurns,
        });
        let settled: unknown;
        // A transferred run never manufactures a second execution. Each
        // continuation resolves exactly one tool interruption, then this loop
        // observes the next returned segment (including batched siblings).
        for (;;) {
          settled = await stream.completed;
          this.#toolOwnership.claim(collectApprovalCallIds(stream.interruptions), {
            kind: 'subagent',
            agentId: runContext.agentId,
            role,
          });
          if (!stream.interruptions?.length || !foregroundLease?.adopted || !stream.state) break;
          let resumed: typeof stream | undefined;
          const continued = await foregroundLease.waitForBackgroundContinuation(
            stream.state,
            stream.interruptions[0],
            () => {
              resumed = trafficContext
                ? this.#sessionContextService.runWithContext(trafficContext, () =>
                    loop.continueRunStream(stream.state!),
                  )
                : loop.continueRunStream(stream.state!);
            },
          );
          if (!continued || !resumed) break;
          stream = resumed;
        }

        const interrupted = Boolean(stream.interruptions?.length);
        const cancelled = signal?.aborted === true;
        const result: NestedSubagentResult = {
          agentId: runContext.agentId,
          role,
          // An interrupted run stopped at an approval pause with work still
          // pending; reporting it as completed told the parent model the
          // opposite of what the event stream said.
          status: cancelled ? 'cancelled' : interrupted ? 'interrupted' : 'completed',
          finalText: extractFinalText(stream),
          filesChanged: [...new Set(runContext.filesChanged)],
          toolsUsed: aggregateContextToolUsage(runContext.toolCounts),
          usage: normalizeAgentRunUsage((settled as { usage?: unknown } | undefined)?.usage) ?? extractUsage(stream),
          costRecords: stream.runCostRecords as ModelRequestCost[] | undefined,
          ...(interrupted && !cancelled ? { interrupted: true } : {}),
        };
        return JSON.stringify(result);
      },
    };
  }

  async runAsTool(request: SubagentRequest, context?: unknown, details?: unknown): Promise<NestedSubagentResult> {
    if (!SUBAGENT_ROLES.includes(request.role as SupportedSubagentRole)) {
      throw new Error(`Unsupported subagent role: "${request.role}"`);
    }
    const role = request.role as SupportedSubagentRole;
    const detailsRecord = details as
      | { resumeState?: string; signal?: AbortSignal; toolCall?: { callId?: string } }
      | undefined;

    // ── Budget enforcement ──
    // Only acquire a slot for fresh runs, not resumed ones (resumed runs
    // already hold their slot from the initial invocation).
    let childSlot: AcquiredChildSlot | undefined;
    if (request.executionBudget && !detailsRecord?.resumeState) {
      const slot = request.executionBudget.tryAcquireChild();
      if (!(slot instanceof AcquiredChildSlot)) {
        const rejection = slot;
        throw new Error(
          `Budget exhausted: ${rejection.reason}${
            rejection.max !== undefined ? ` (${rejection.current}/${rejection.max})` : ''
          }`,
        );
      }
      childSlot = slot;
    }

    // The lease is created before any provider work starts. Its independent
    // controller keeps the child alive after a truthful transfer, while its
    // detachable parent link preserves ordinary foreground abort beforehand.
    const candidateRunId = detailsRecord?.toolCall?.callId ?? randomUUID();
    const parentComposite = createCompositeAbortSignal(detailsRecord?.signal, request.signal);
    const lease = new ForegroundSubagentLease({ runId: candidateRunId, parentSignal: parentComposite?.signal });
    this.#foregroundLeases.set(candidateRunId, { lease, role, task: request.task, parentTool: request.parentTool });
    const composite = createCompositeAbortSignal(lease.signal);
    const signal = composite?.signal;
    if (signal?.aborted) {
      childSlot?.release();
      throw createAbortError('The nested subagent run was aborted.');
    }
    const restoredContext = this.#restoreRunContext(detailsRecord?.resumeState);
    const agentId = restoredContext?.agentId ?? candidateRunId;
    const runContext: SubagentRunContext = restoredContext ?? {
      agentId,
      role,
      task: request.task,
      filesChanged: [],
      toolCounts: {},
      activeCommandMessages: {},
      turnCount: 0,
      maxTurns: (this.#resolveRole ? this.#resolveRole(role) : loadRoleDefinition(role, this.#settings)).maxTurns,
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

    const nestedLedger = new ApprovalLedger();
    // The subagent runs in its own ledger, but decisions the user already made in the
    // parent have to be carried across or the same tool call prompts twice.
    let abortListener: (() => void) | undefined;
    let transferredToBackground = false;
    try {
      const { tool, agent: roleAgent } = this.#getOrCreateRoleTool(role);
      replayApprovals(nestedLedger, readParentApprovals(context), roleAgent);
      const nestedToolContext: ToolInvocationContext<SubagentRunContext> = {
        context: runContext,
        approvals: nestedLedger,
        signal,
      };
      const effectiveDetails = { ...detailsRecord, ...(signal ? { signal } : {}), foregroundSubagentLease: lease };

      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            abortListener = () => reject(createAbortError('The nested subagent run was aborted.'));
            signal.addEventListener('abort', abortListener, { once: true });
          })
        : null;

      const execution = Promise.resolve(
        tool.execute(
          normalizeToolParameters({ role, task: request.task }, tool.parameters),
          nestedToolContext,
          effectiveDetails,
        ),
      );
      const promises: Array<Promise<unknown>> = [execution];
      if (abortPromise) {
        promises.push(abortPromise);
      }
      // Successful adoption resolves the foreground tool exactly once while
      // retaining the original promise (and therefore its budget slot) until
      // the actual child loop settles.
      const transferred = Symbol('foreground-subagent-transferred');
      promises.push(lease.waitForAdoption().then((adopted) => (adopted ? transferred : new Promise<never>(() => {}))));
      const raw = await Promise.race(promises);
      if (raw === transferred) {
        transferredToBackground = true;
        const transferredSlot = childSlot;
        const emitTransferredFailure = (error: unknown): void => {
          // The foreground tool result has already been handed off. A late
          // loop rejection or parse failure must therefore enter the durable
          // async terminal lane; otherwise get_subagent_result hangs forever.
          safeEmit(this.#logger, this.#onEvent, {
            type: 'subagent_completed',
            async: true,
            result: {
              agentId,
              role,
              status: lease.signal.aborted || isAbortLike((error as any)?.message, error) ? 'cancelled' : 'failed',
              finalText: '',
              filesChanged: [],
              toolsUsed: [],
              error: (error as any)?.message || String(error),
            },
          });
        };
        void execution
          .then(
            (terminal) => {
              try {
                const parsed = parseNestedSubagentResult(terminal);
                if (transferredSlot && parsed.usage) request.executionBudget!.recordUsage(parsed.usage);
                if (parsed.status !== 'interrupted' && parsed.status !== 'running') {
                  const completed: SubagentResult = { ...parsed, status: parsed.status };
                  safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result: completed, async: true });
                }
              } catch (error) {
                emitTransferredFailure(error);
              }
              lease.settle();
            },
            (error) => {
              emitTransferredFailure(error);
              lease.settle();
            },
          )
          .finally(() => {
            this.#foregroundLeases.delete(candidateRunId);
            transferredSlot?.release();
          });
        childSlot = undefined;
        return {
          agentId,
          role,
          status: 'running' as NestedSubagentResult['status'],
          finalText: '',
          filesChanged: [],
          toolsUsed: [],
        };
      }
      const parsed = parseNestedSubagentResult(raw);
      // Record usage from nested run
      if (childSlot && parsed.usage) {
        request.executionBudget!.recordUsage(parsed.usage);
      }
      // An interrupted run has not finished, so it must not be announced as a
      // completion. `subagent_completed` carries a SubagentResult, which cannot
      // be `interrupted` — narrowing here keeps the event payload honest.
      if (parsed.status !== 'interrupted' && parsed.status !== 'running') {
        const completed: SubagentResult = { ...parsed, status: parsed.status };
        safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result: completed });
      }
      return parsed;
    } catch (error: any) {
      this.#logger.error('Nested subagent tool failed', {
        agentId,
        role,
        error: error?.message || String(error),
      });
      safeEmit(this.#logger, this.#onEvent, {
        type: 'subagent_completed',
        result: {
          agentId,
          role,
          status: isAbortLike(error?.message, error) ? 'cancelled' : 'failed',
          finalText: '',
          filesChanged: [],
          toolsUsed: [],
          error: error?.message || String(error),
        },
      });
      throw error;
    } finally {
      if (!transferredToBackground) {
        lease.settle();
        this.#foregroundLeases.delete(candidateRunId);
        childSlot?.release();
      }
      if (abortListener && signal) {
        signal.removeEventListener('abort', abortListener);
      }
      composite?.cleanup();
      parentComposite?.cleanup();
    }
  }
}
