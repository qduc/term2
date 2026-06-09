import type { AgentStream } from './agent-stream.js';
import type { ConversationEvent } from './conversation-events.js';
import { MAX_HALLUCINATION_RETRIES } from './conversation-retry-policy.js';
import type { ConversationAgentClient } from './conversation-agent-client.js';
import type { ILoggingService } from './service-interfaces.js';
import { RetryHandler, type RetryDecision } from './retry-handler.js';
import { extractHistoryLength } from './stream-snapshot.js';
import type { UserTurn } from '../types/user-turn.js';

export type RetryState = {
  transientRetryCount?: number;
  flexServiceTierFallbackCount?: number;
  hallucinationRetryCount?: number;
  transportFallbackRetryCount?: number;
};

export type RetryDispatchContext = {
  error: unknown;
  turn: UserTurn;
  gen: number;
  stream: AgentStream | null;
  retries: RetryState;
  maxTransientRetries: number;
  maxModelRetries?: number;
};

export type RetryOutcome =
  | { kind: 'stale_generation' }
  | { kind: 'unrecoverable' }
  | {
      kind: 'retry_flex_fallback';
      runOptions: { skipUserMessage: boolean; retries: RetryState; maxModelRetries?: number };
      useStandardServiceTier: true;
    }
  | {
      kind: 'retry_transient';
      runOptions: {
        skipUserMessage: boolean;
        retries: RetryState;
        maxModelRetries?: number;
        resumeState?: unknown;
      };
      delayMs: number;
      isResuming: boolean;
      restoreOptions?: { removeLastUserMessage?: boolean };
    }
  | {
      kind: 'retry_transport_downgrade';
      runOptions: { skipUserMessage: boolean; retries: RetryState; maxModelRetries?: number };
      restoreOptions: { removeLastUserMessage: true };
    }
  | {
      kind: 'retry_hallucination';
      runOptions: { skipUserMessage?: boolean; retries?: RetryState; maxModelRetries?: number };
      hadStream: boolean;
      addErrorContext?: string;
    };

/**
 * Owns retry state and retry decision logic for a conversation session.
 *
 * The session delegates to this orchestrator for retry classification,
 * retry event construction, and retry plan generation. The session keeps
 * the actual rerun/stream orchestration (recursive `yield* run(...)`) to
 * avoid the pitfall of the orchestrator becoming a session-in-disguise.
 */
export class SessionRetryOrchestrator {
  private retryHandler: RetryHandler;
  private generation = 0;
  private allowFreshStartRetries: boolean;
  private chainingBroken = false;
  private inputSurgeKind: 'delta' | 'full_history' = 'delta';

  constructor(
    private logger: ILoggingService,
    private sessionId: string,
    private agentClient: ConversationAgentClient,
    allowFreshStartRetries: boolean = true,
  ) {
    this.allowFreshStartRetries = allowFreshStartRetries;
    this.retryHandler = new RetryHandler(this.logger, this.sessionId, this.agentClient);
  }

  get currentGeneration(): number {
    return this.generation;
  }

  isCurrentGeneration(gen: number): boolean {
    return gen === this.generation;
  }

  incrementGeneration(): void {
    this.generation++;
  }

  get chainingBrokenState(): boolean {
    return this.chainingBroken;
  }

  breakChaining(): void {
    this.chainingBroken = true;
  }

  get inputSurgeKindState(): 'delta' | 'full_history' {
    return this.inputSurgeKind;
  }

  setInputSurgeKind(kind: 'delta' | 'full_history'): void {
    this.inputSurgeKind = kind;
  }

  get freshStartRetriesAllowed(): boolean {
    return this.allowFreshStartRetries;
  }

  classifyError(opts: {
    error: unknown;
    transientRetryCount: number;
    transportFallbackRetryCount: number;
    hallucinationRetryCount: number;
    flexServiceTierFallbackCount: number;
    maxTransientRetries: number;
    stream: AgentStream | null;
    maxModelRetries?: number;
  }): RetryDecision {
    const streamHistoryLength = extractHistoryLength(opts.stream);
    return this.retryHandler.classifyError({
      ...opts,
      streamHistoryLength,
    });
  }

  classifyForContinuation(opts: {
    error: unknown;
    transientRetryCount: number;
    stream: AgentStream | null;
    maxTransientRetries: number;
  }): RetryDecision {
    const decision = this.classifyError({
      error: opts.error,
      transientRetryCount: opts.transientRetryCount,
      transportFallbackRetryCount: 0,
      hallucinationRetryCount: 0,
      flexServiceTierFallbackCount: 0,
      maxTransientRetries: opts.maxTransientRetries,
      stream: opts.stream,
      maxModelRetries: undefined,
    });

    if (!this.allowFreshStartRetries && !opts.stream && decision.kind !== 'none' && decision.kind !== 'unrecoverable') {
      this.logger.warn('Retry requires fresh start but fresh-start retries are disabled for this session', {
        eventType: 'retry.fresh_start_blocked',
        category: 'retry',
        phase: 'retry',
        sessionId: this.sessionId,
        traceId: this.logger.getCorrelationId(),
        retryKind: decision.kind,
        errorMessage: opts.error instanceof Error ? opts.error.message : String(opts.error),
      });
      return { kind: 'unrecoverable' };
    }

    return decision;
  }

  async *handleRetryDecision(ctx: RetryDispatchContext): AsyncGenerator<ConversationEvent, RetryOutcome> {
    const { error, gen, stream, retries, maxTransientRetries, maxModelRetries } = ctx;
    void ctx.turn;
    const {
      transientRetryCount = 0,
      flexServiceTierFallbackCount = 0,
      hallucinationRetryCount = 0,
      transportFallbackRetryCount = 0,
    } = retries;

    const streamHistoryLength = extractHistoryLength(stream);
    let decision: RetryDecision = this.retryHandler.classifyError({
      error,
      transientRetryCount,
      transportFallbackRetryCount,
      hallucinationRetryCount,
      flexServiceTierFallbackCount,
      maxTransientRetries,
      stream,
      streamHistoryLength,
      maxModelRetries,
    });

    if (!this.allowFreshStartRetries && !stream && decision.kind !== 'none' && decision.kind !== 'unrecoverable') {
      this.logger.warn('Retry requires fresh start but fresh-start retries are disabled for this session', {
        eventType: 'retry.fresh_start_blocked',
        category: 'retry',
        phase: 'retry',
        sessionId: this.sessionId,
        traceId: this.logger.getCorrelationId(),
        retryKind: decision.kind,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      decision = { kind: 'unrecoverable' };
    }

    switch (decision.kind) {
      case 'flex_fallback': {
        this.#logRetry('Flex service tier timed out, retrying with standard service tier', 'retry.flex_service_tier', {
          retryType: 'flex_service_tier',
          retryAttempt: 1,
          attempt: 1,
          maxRetries: 1,
          errorMessage: error instanceof Error ? error.message : String(error),
        });

        yield {
          type: 'retry',
          toolName: 'service_tier',
          attempt: 1,
          maxRetries: 1,
          errorMessage: 'Flex service tier timed out. Falling back to standard service tier and retrying.',
          retryType: 'flex_service_tier',
        };

        if (!this.isCurrentGeneration(gen)) {
          return { kind: 'stale_generation' };
        }

        return {
          kind: 'retry_flex_fallback',
          runOptions: {
            skipUserMessage: true,
            retries: { ...retries, flexServiceTierFallbackCount: flexServiceTierFallbackCount + 1 },
            maxModelRetries,
          },
          useStandardServiceTier: true,
        };
      }
      case 'transient': {
        const isResuming = Boolean(stream?.state && typeof this.agentClient.continueRunStream === 'function');
        this.#logRetry('Transient upstream error detected, retrying turn', 'retry.transient', {
          retryType: 'upstream',
          retryAttempt: decision.attempt,
          attempt: decision.attempt,
          maxRetries: maxTransientRetries,
          errorMessage: error instanceof Error ? error.message : String(error),
          delayMs: decision.delay,
        });

        yield {
          type: 'retry',
          toolName: isResuming ? 'continuation' : 'turn',
          attempt: decision.attempt,
          maxRetries: maxTransientRetries,
          errorMessage: error instanceof Error ? error.message : String(error),
          retryType: 'upstream',
        };

        if (!this.isCurrentGeneration(gen)) {
          return { kind: 'stale_generation' };
        }

        await new Promise((resolve) => setTimeout(resolve, decision.delay));

        if (!this.isCurrentGeneration(gen)) {
          return { kind: 'stale_generation' };
        }

        return {
          kind: 'retry_transient',
          runOptions: {
            skipUserMessage: Boolean(stream),
            retries: { ...retries, transientRetryCount: decision.attempt },
            maxModelRetries,
            resumeState: isResuming ? stream?.state : undefined,
          },
          delayMs: decision.delay,
          isResuming,
          restoreOptions: isResuming ? undefined : { removeLastUserMessage: true },
        };
      }
      case 'transport_downgrade': {
        const attempt = transportFallbackRetryCount + 1;

        this.#logRetry(
          'Transient upstream error exhausted WS retries, forcing HTTP fallback',
          'retry.transport_fallback',
          {
            retryType: 'upstream',
            retryAttempt: attempt,
            attempt,
            maxRetries: 1,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        );

        yield {
          type: 'retry',
          toolName: 'transport',
          attempt,
          maxRetries: 1,
          errorMessage: 'WebSocket retries exhausted. Falling back to HTTP transport and retrying.',
          retryType: 'upstream',
        };

        if (!this.isCurrentGeneration(gen)) {
          return { kind: 'stale_generation' };
        }

        return {
          kind: 'retry_transport_downgrade',
          runOptions: {
            skipUserMessage: Boolean(stream),
            retries: { transientRetryCount: 0, transportFallbackRetryCount: attempt },
            maxModelRetries,
          },
          restoreOptions: { removeLastUserMessage: true },
        };
      }
      case 'hallucination': {
        const decisionResult = decision.decision;
        if (decisionResult.kind !== 'retry') {
          break;
        }

        this.#logRetry('Recoverable model error detected, retrying', 'retry.model_error', {
          toolName: decisionResult.logPayload.toolName,
          retryType: decisionResult.logPayload.retryType,
          retryAttempt: decisionResult.attempt,
          attempt: decisionResult.attempt,
          maxRetries: maxModelRetries ?? MAX_HALLUCINATION_RETRIES,
          errorMessage: decisionResult.message,
        });

        yield decisionResult.retryEvent;

        if (!this.isCurrentGeneration(gen)) {
          return { kind: 'stale_generation' };
        }

        return {
          kind: 'retry_hallucination',
          runOptions: {
            ...decisionResult.nextRunOptions,
            maxModelRetries,
          },
          hadStream: decisionResult.hadStream,
          addErrorContext: decisionResult.shouldInjectErrorContext ? decisionResult.errorContextMessage : undefined,
        };
      }
      case 'none':
      case 'unrecoverable':
        break;
    }

    return { kind: 'unrecoverable' };
  }

  restoreForRetry(opts: {
    ledgerSnapshot: import('./tool-execution-ledger.js').SavedToolExecution[];
    stream: AgentStream | null;
    toolLedger: import('./tool-execution-ledger.js').ToolExecutionLedger;
    conversationStore: import('./conversation-store.js').ConversationStore;
    clearPreviousResponseId: () => void;
    restoreCompletedToolLedgerEntries: (snapshot: import('./tool-execution-ledger.js').SavedToolExecution[]) => void;
    removeLastUserMessage?: () => void;
  }): void {
    this.retryHandler.restoreForRetry(opts);
  }

  #logRetry(message: string, eventType: string, fields: Record<string, unknown>): void {
    this.logger.warn(message, {
      eventType,
      category: 'retry',
      phase: 'retry',
      sessionId: this.sessionId,
      traceId: this.logger.getCorrelationId(),
      ...fields,
    });
  }
}
