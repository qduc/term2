import { SubagentManager } from '../services/subagents/subagent-manager.js';
import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../services/service-interfaces.js';
import type { ExecutionContext } from '../services/execution-context.js';
import type { SubagentResult } from '../services/subagents/types.js';

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
}

export class SubagentBridge {
  #subagentManager: SubagentManager | null;
  #subagentEventSink: ((event: ConversationEvent) => void) | null = null;
  #activeSubagentsCount = 0;
  #pendingClearSink = false;
  #logger: ILoggingService;

  constructor(deps: SubagentBridgeDeps) {
    this.#logger = deps.logger;

    if (deps.subagentManager !== undefined) {
      this.#subagentManager = deps.subagentManager;
    } else {
      this.#subagentManager = new SubagentManager({
        logger: deps.logger,
        settings: deps.settings,
        executionContext: deps.executionContext,
        sessionContextService: deps.sessionContextService,
        onEvent: (event) => this.#subagentEventSink?.(event),
        agentClient: { chat: (message, options) => deps.chat(message, options) },
        createClient: deps.createClient,
      });
    }
  }

  setEventSink(sink: ((event: ConversationEvent) => void) | null): void {
    if (sink === null && this.#activeSubagentsCount > 0) {
      this.#pendingClearSink = true;
    } else {
      this.#subagentEventSink = sink;
      this.#pendingClearSink = false;
    }
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

  /** Increment active count and return a disposer that decrements + handles pending sink clear */
  #beginSubagentRun(): () => void {
    this.#activeSubagentsCount++;
    return () => {
      this.#activeSubagentsCount--;
      if (this.#pendingClearSink && this.#activeSubagentsCount === 0) {
        this.#subagentEventSink = null;
        this.#pendingClearSink = false;
      }
    };
  }

  createMentor = async (question: string): Promise<string> => {
    if (!this.#subagentManager) {
      throw new Error('Transient agent clients cannot spawn subagents.');
    }
    const endRun = this.#beginSubagentRun();
    try {
      const result = await this.#subagentManager.run({
        role: 'mentor',
        task: question,
        parentTool: 'ask_mentor',
      });
      if (result.status === 'failed') {
        throw new Error(result.error || 'Mentor consultation failed');
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
  ): Promise<SubagentResult> => {
    if (!this.#subagentManager) {
      throw new Error('Transient agent clients cannot spawn subagents.');
    }
    const detailsRecord = details as { resumeState?: string; signal?: AbortSignal; toolCall?: unknown } | undefined;
    const request = {
      ...params,
      parentTool: 'run_subagent',
      ...(detailsRecord?.resumeState ? { resumeState: detailsRecord.resumeState } : {}),
      ...(detailsRecord?.signal ? { signal: detailsRecord.signal } : {}),
    };

    const endRun = this.#beginSubagentRun();
    try {
      return await this.#subagentManager.runAsTool(request, _context, details);
    } finally {
      endRun();
    }
  };
}
