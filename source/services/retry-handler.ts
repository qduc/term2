import type { AgentInputItem } from '@openai/agents';
import type { OpenAIAgentClient } from '../lib/openai-agent-client.js';
import type { AgentStream } from './agent-stream.js';
import { decideRetry, isTransientRetryableError } from './conversation-retry-policy.js';
import { ConversationStore } from './conversation-store.js';
import type { ILoggingService } from './service-interfaces.js';
import { classifyUpstreamRetryableError, computeUpstreamRetryDelayMs } from './upstream-retry-policy.js';
import {
  reconcileHistoryWithToolLedger,
  ToolExecutionLedger,
  type SavedToolExecution,
} from './tool-execution-ledger.js';

export type RetryDecision =
  | { kind: 'none' }
  | { kind: 'flex_fallback' }
  | { kind: 'transient'; delay: number; attempt: number }
  | { kind: 'transport_downgrade' }
  | { kind: 'hallucination'; decision: ReturnType<typeof decideRetry> }
  | { kind: 'unrecoverable' };

export class RetryHandler {
  constructor(
    private logger: ILoggingService,
    private sessionId: string,
    private agentClient: OpenAIAgentClient,
    private random: () => number = Math.random,
  ) {}

  classifyError(opts: {
    error: unknown;
    transientRetryCount: number;
    transportFallbackRetryCount: number;
    hallucinationRetryCount: number;
    flexServiceTierFallbackCount: number;
    maxTransientRetries: number;
    stream: AgentStream | null;
    streamHistoryLength: number;
  }): RetryDecision {
    void this.logger;
    void this.sessionId;

    const {
      error,
      transientRetryCount,
      transportFallbackRetryCount,
      hallucinationRetryCount,
      flexServiceTierFallbackCount,
      maxTransientRetries,
      stream,
      streamHistoryLength,
    } = opts;

    const shouldRetryWithoutFlexServiceTier =
      typeof this.agentClient.shouldRetryWithoutFlexServiceTier === 'function'
        ? this.agentClient.shouldRetryWithoutFlexServiceTier(error)
        : false;

    if (shouldRetryWithoutFlexServiceTier && flexServiceTierFallbackCount === 0) {
      return { kind: 'flex_fallback' };
    }

    if (isTransientRetryableError(error) && transientRetryCount < maxTransientRetries) {
      const attempt = transientRetryCount + 1;
      const upstreamRetryClassification = classifyUpstreamRetryableError(error);
      return {
        kind: 'transient',
        attempt,
        delay: computeUpstreamRetryDelayMs({
          retryAfterMs: upstreamRetryClassification.retryAfterMs,
          attemptNumber: attempt,
          random: this.random,
        }),
      };
    }

    const forceTransportDowngrade =
      typeof this.agentClient.forceTransportDowngrade === 'function'
        ? this.agentClient.forceTransportDowngrade(error)
        : false;
    if (isTransientRetryableError(error) && transportFallbackRetryCount < 1 && forceTransportDowngrade) {
      return { kind: 'transport_downgrade' };
    }

    const hallucinationDecision = decideRetry(error, hallucinationRetryCount, Boolean(stream), streamHistoryLength);
    if (hallucinationDecision.kind === 'retry') {
      return { kind: 'hallucination', decision: hallucinationDecision };
    }

    return { kind: 'unrecoverable' };
  }

  getTransientDelay(attempt: number): number {
    return computeUpstreamRetryDelayMs({ attemptNumber: attempt, random: this.random });
  }

  restoreForRetry(opts: {
    ledgerSnapshot: SavedToolExecution[];
    stream: AgentStream | null;
    toolLedger: ToolExecutionLedger;
    conversationStore: ConversationStore;
    clearPreviousResponseId: () => void;
    restoreCompletedToolLedgerEntries: (snapshot: SavedToolExecution[]) => void;
    removeLastUserMessage?: () => void;
  }): void {
    void this.logger;
    void this.sessionId;

    const {
      ledgerSnapshot,
      stream,
      toolLedger,
      conversationStore,
      clearPreviousResponseId,
      restoreCompletedToolLedgerEntries,
      removeLastUserMessage,
    } = opts;

    clearPreviousResponseId();
    restoreCompletedToolLedgerEntries(ledgerSnapshot);

    if (stream) {
      const reconciled = reconcileHistoryWithToolLedger(conversationStore.getHistory(), toolLedger.export());
      if (reconciled.addedCompletedPairs > 0) {
        conversationStore.replaceHistory(reconciled.history as AgentInputItem[]);
      }
      return;
    }

    removeLastUserMessage?.();
  }
}
