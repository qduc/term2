import { randomUUID } from 'node:crypto';
import { SubagentManager } from '../services/subagents/subagent-manager.js';
import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../services/service-interfaces.js';
import type { ExecutionContext } from '../services/execution-context.js';
import type {
  NestedSubagentResult,
  SubagentCancelAcknowledgement,
  SubagentResult,
  SubagentRunStatus,
  SubagentSteerAcknowledgement,
} from '../services/subagents/types.js';
import type { AgentRuntime } from '../services/agent-runtime/agent-runtime.js';
import { createAbortError } from '../services/subagents/utils.js';
import type { SkillsService } from '../services/skills/skills-service.js';
import type { SubagentRunHandle } from '../services/subagents/types.js';
import type { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';

export interface SubagentBridgeDeps {
  logger: ILoggingService;
  settings: ISettingsService;
  executionContext?: ExecutionContext;
  sessionContextService: ISessionContextService;
  /** Chat method from the parent AgentClient — injected, not captured via `this` */
  chat: (message: string, options?: any) => Promise<string>;
  /** Factory for creating transient AgentClient instances for subagent runs */
  createClient: (opts: { agent: any; provider: string; maxTurns: number; retryAttempts?: number }) => any;
  /**
   * Optional pre-built SubagentManager for test injection.
   * When provided, the bridge uses it instead of creating one internally.
   */
  subagentManager?: SubagentManager;
  skillsService?: SkillsService;
  toolOwnership: ToolOwnershipRegistry;
}

type SubagentEventScope = 'foreground' | 'background';

export class SubagentBridge {
  #subagentManager: SubagentManager | null;
  #isDisposed = false;
  #sessionContextService: ISessionContextService;
  #subagentEventSink: ((event: ConversationEvent) => void) | null = null;
  #backgroundEventSink: ((event: ConversationEvent) => void) | null = null;
  #backgroundRunIds = new Set<string>();
  #activeSubagentsCount = 0;
  #bufferedEvents: Array<{ event: ConversationEvent; scope: SubagentEventScope }> = [];
  #logger: ILoggingService;
  /** Per-turn scope: foreground subagent work belonging to the running turn. */
  #abortController = new AbortController();
  /**
   * Conversation scope: background (async) runs outlive the turn that launched
   * them, so they must not share the per-turn controller.
   */
  #backgroundAbortController = new AbortController();

  constructor(deps: SubagentBridgeDeps) {
    this.#logger = deps.logger;
    this.#sessionContextService = deps.sessionContextService;

    if (deps.subagentManager !== undefined) {
      this.#subagentManager = deps.subagentManager;
    } else {
      this.#subagentManager = new SubagentManager({
        logger: deps.logger,
        settings: deps.settings,
        executionContext: deps.executionContext,
        sessionContextService: deps.sessionContextService,
        onEvent: (event) => this.#emitEvent(event),
        agentClient: { chat: (message, options) => deps.chat(message, options) },
        createClient: deps.createClient,
        skillsService: deps.skillsService,
        toolOwnership: deps.toolOwnership,
      });
    }
  }

  setEventSink(sink: ((event: ConversationEvent) => void) | null): void {
    this.#subagentEventSink = sink;
    if (sink) this.#flushBufferedEvents('foreground', sink);
  }

  /**
   * Conversation-scoped sink that outlives individual turns. Unlike
   * {@link setEventSink}, it is never torn down at turn end, so subagent
   * activity that settles while the conversation is idle is still observed
   * instead of being buffered until the next turn attaches a sink.
   */
  setBackgroundEventSink(sink: ((event: ConversationEvent) => void) | null): void {
    this.#backgroundEventSink = sink;
    if (sink) this.#flushBufferedEvents('background', sink);
  }

  /** End session-scoped subagent work and release its event sinks and caches. */
  dispose(): void {
    if (this.#isDisposed) return;
    this.#isDisposed = true;

    this.#abortController.abort();
    this.#backgroundAbortController.abort();
    this.#subagentManager?.cancelAllAsyncRuns();
    this.#subagentManager?.clearCache();
    this.#subagentManager?.resetMentorSession();
    this.#subagentManager?.dispose();
    this.#subagentManager = null;
    this.#subagentEventSink = null;
    this.#backgroundEventSink = null;
    this.#backgroundRunIds.clear();
    this.#bufferedEvents = [];
  }

  #flushBufferedEvents(scope: SubagentEventScope, sink: (event: ConversationEvent) => void): void {
    const pending: Array<{ event: ConversationEvent; scope: SubagentEventScope }> = [];
    for (const buffered of this.#bufferedEvents) {
      if (buffered.scope === scope) {
        sink(buffered.event);
      } else {
        pending.push(buffered);
      }
    }
    this.#bufferedEvents = pending;
  }

  #emitEvent(event: ConversationEvent): void {
    if (this.#isDisposed) return;

    const agentId =
      event.type === 'subagent_completed'
        ? event.result.agentId
        : 'agentId' in event && typeof event.agentId === 'string'
        ? event.agentId
        : undefined;

    const explicitlyAsync = 'async' in event && event.async === true;
    if (event.type === 'subagent_started' && explicitlyAsync && agentId) {
      this.#backgroundRunIds.add(agentId);
    }

    const scope: SubagentEventScope =
      explicitlyAsync || (agentId !== undefined && this.#backgroundRunIds.has(agentId)) ? 'background' : 'foreground';
    const sink = scope === 'background' ? this.#backgroundEventSink : this.#subagentEventSink;
    if (sink) {
      sink(event);
    } else {
      this.#bufferedEvents.push({ event, scope });
    }

    if (scope === 'background' && event.type === 'subagent_completed' && agentId) {
      this.#backgroundRunIds.delete(agentId);
    }
  }

  /**
   * Obtain an AgentRuntime backed by this bridge's SubagentManager.
   * This is the stable production boundary for creating and running
   * one-shot agents through the same infrastructure that powers
   * subagent tool calls. Budget creation, scope enforcement, and
   * permission attenuation are all enforced.
   */
  getAgentRuntime(): AgentRuntime | null {
    return this.#subagentManager?.getAgentRuntime() ?? null;
  }

  clearSubagentCache(): void {
    if (this.#subagentManager) {
      this.#subagentManager.resetMentorSession();
    }
  }

  clearCache(): void {
    this.#subagentManager?.clearCache();
  }

  get activeSubagentsCount(): number {
    return this.#activeSubagentsCount;
  }

  /** Abort signal shared by the foreground subagent runs of the current turn. */
  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  /**
   * Conversation-scoped abort signal for background (async) runs. It is never
   * reset or aborted by turn boundaries, only by {@link cancelBackgroundRuns}.
   */
  get backgroundSignal(): AbortSignal {
    return this.#backgroundAbortController.signal;
  }

  /** Replace the per-turn abort controller so a new parent run starts fresh. */
  resetAbortController(): void {
    this.#abortController = new AbortController();
  }

  /**
   * Abort the foreground subagent runs of the current turn and prepare a fresh
   * controller. Background runs are conversation-bound and are deliberately
   * left alone; use {@link cancelBackgroundRuns} for those.
   */
  abort(): void {
    this.#abortController.abort();
    this.#abortController = new AbortController();
  }

  /**
   * Cancel every conversation-bound background run. Reserved for an explicit
   * user interrupt, conversation disposal, or shutdown.
   */
  cancelBackgroundRuns(): void {
    this.#backgroundAbortController.abort();
    this.#subagentManager?.cancelAllAsyncRuns();
    this.#backgroundAbortController = new AbortController();
  }

  /** Increment active count and return a disposer that decrements it */
  #beginSubagentRun(): () => void {
    this.#activeSubagentsCount++;
    return () => {
      this.#activeSubagentsCount--;
    };
  }

  /**
   * Runs `fn` under a traffic context whose provider history key identifies the
   * subagent run rather than the conversation that launched it. Providers key
   * server-side state off this — an OpenCode session, a Codex response chain —
   * so a run that reuses the parent's key writes its turns into the parent's
   * history.
   *
   * `runScope` identifies the run: a tool call ID, or `mentor` for the mentor
   * session that persists across consultations. It is appended to the current
   * key so a nested subagent scopes under its parent rather than flattening
   * back onto the conversation. Without one, a random scope is used: a fresh,
   * unshared history is a safer default than silently sharing the parent's.
   */
  #withSubagentTrafficContext<T>(runScope: string | undefined, fn: () => T): T {
    const currentContext = this.#sessionContextService.getContext();
    if (!currentContext) {
      return fn();
    }

    const parentKey = currentContext.providerHistoryKey ?? currentContext.sessionId;
    const scope = runScope ?? randomUUID();

    return this.#sessionContextService.runWithContext(
      { ...currentContext, providerHistoryKey: `${parentKey}:subagent:${scope}` },
      fn,
    );
  }

  createMentor = async (question: string): Promise<string> => {
    if (!this.#subagentManager) {
      throw new Error('Transient agent clients cannot spawn subagents.');
    }
    const endRun = this.#beginSubagentRun();
    try {
      // The mentor session outlives a single consultation (see
      // `resetMentorSession`), so its scope is the role, not the call.
      const result = await this.#withSubagentTrafficContext('mentor', () =>
        this.#subagentManager!.run({
          role: 'mentor',
          task: question,
          parentTool: 'ask_mentor',
          signal: this.signal,
        }),
      );
      if (result.status === 'failed') {
        throw new Error(result.error || 'Mentor consultation failed');
      }
      if (result.status === 'cancelled') {
        throw createAbortError('The mentor consultation was aborted.');
      }
      return result.finalText;
    } catch (error) {
      this.#logger.error('Mentor consultation failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    } finally {
      endRun();
    }
  };

  runSubagent = async (
    params: { role: string; task: string },
    _context?: unknown,
    details?: unknown,
  ): Promise<NestedSubagentResult> => {
    if (!this.#subagentManager) {
      throw new Error('Transient agent clients cannot spawn subagents.');
    }
    const detailsRecord = details as
      | { resumeState?: string; signal?: AbortSignal; toolCall?: { callId?: string } }
      | undefined;
    const request = {
      ...params,
      parentTool: 'run_subagent',
      ...(detailsRecord?.resumeState ? { resumeState: detailsRecord.resumeState } : {}),
      signal: this.signal,
    };

    const endRun = this.#beginSubagentRun();
    try {
      return await this.#withSubagentTrafficContext(detailsRecord?.toolCall?.callId, () =>
        this.#subagentManager!.runAsTool(request, _context, details),
      );
    } finally {
      endRun();
    }
  };

  runSubagentAsync = async (
    params: { role: string; task: string; name?: string; continue_run_id?: string },
    _context?: unknown,
    _details?: unknown,
  ): Promise<SubagentRunHandle> => {
    if (!this.#subagentManager) {
      throw new Error('Transient agent clients cannot spawn subagents.');
    }
    const request = {
      role: params.role,
      task: params.task,
      ...(params.name ? { name: params.name } : {}),
      ...(params.continue_run_id ? { continueRunId: params.continue_run_id } : {}),
      parentTool: 'run_subagent',
      // Conversation-scoped, not per-turn: this run must survive the turn that
      // launched it and every ordinary abort.
      signal: this.backgroundSignal,
    };

    // Deliberately not scoped here: a background run outlives the tool call that
    // launched it and can be continued from a later one, so only the registry —
    // which owns the run ID — can give every segment one stable scope. See
    // `SubagentAsyncRegistry`'s `trafficContext`.
    return this.#subagentManager.startRunAsync(request);
  };

  getSubagentResult = async (
    params: { runId: string },
    _context?: unknown,
    details?: unknown,
  ): Promise<SubagentResult> => {
    if (!this.#subagentManager) {
      throw new Error('Transient agent clients cannot spawn subagents.');
    }
    const detailsRecord = details as { signal?: AbortSignal } | undefined;
    return this.#subagentManager.getRunResult(params.runId, detailsRecord?.signal);
  };

  /**
   * Non-blocking peek: progress snapshot for one run (runId provided) or all
   * non-evicted runs (runId omitted). Never awaits; never carries completion
   * detail. Throws only when the bridge has no manager (transient clients).
   */
  getSubagentStatus = (
    params: { runId?: string },
    _context?: unknown,
    _details?: unknown,
  ): SubagentRunStatus | SubagentRunStatus[] => {
    if (!this.#subagentManager) {
      throw new Error('Transient agent clients cannot get subagent status.');
    }
    return this.#subagentManager.getRunStatus(params.runId);
  };

  /** Parent-only non-blocking control for active async execution runs. */
  sendSubagentMessage = (params: {
    target: string;
    message: string;
    reply_to?: string | null;
  }): SubagentSteerAcknowledgement => {
    if (!this.#subagentManager) {
      throw new Error('Transient agent clients cannot control asynchronous subagents.');
    }
    return this.#subagentManager.sendMessageToAsyncRun(params);
  };

  /** Parent-only non-blocking two-phase cancellation by runId or active name. */
  cancelSubagentRun = (params: { target: string }): SubagentCancelAcknowledgement => {
    if (!this.#subagentManager) {
      throw new Error('Transient agent clients cannot control asynchronous subagents.');
    }
    return this.#subagentManager.cancelAsyncRun(params.target);
  };

  abortAsyncRun = (runId: string): void => {
    this.#subagentManager?.abortAsyncRun(runId);
  };

  resetAsyncRuns = (): void => {
    this.#subagentManager?.resetAsyncRuns();
  };

  /** @deprecated Ordinary turns do not cancel async runs. */
  cancelAsyncRuns = (): void => {
    // Kept for callers compiled against the Phase 1 bridge.
  };
}
