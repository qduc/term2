import type { RunState } from '@openai/agents';
import type { AgentStream } from '../agent-stream.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { CommandMessage } from '../../tools/types.js';
import { type NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { StreamHistorySource } from './session-stream-processor.js';
import type { RetryCounts } from '../retry/retry-contracts.js';
import type { GenerationToken } from '../generation-guard.js';
import type { PersistedAssistantTurnItem } from '../conversation/conversation-persistence-types.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import { getCallIdFromObject } from '../interruption-info.js';

export interface PreparedContinuation {
  state: RunState<any, any>;
  interruption: unknown;
  toolCallArgumentsById: Map<string, unknown>;
  previouslyEmittedCommandIds: Set<string>;
  toolStartedEvent?: ConversationEvent;
  removeInterceptor: () => void;
  source: StreamHistorySource;
  token?: GenerationToken;
  inputMode?: 'delta' | 'full_history';
  cumulativeUsage?: NormalizedUsage;
  cumulativeCommandMessages?: CommandMessage[];
  cumulativeTurnItems?: PersistedAssistantTurnItem[];
}

export class ContinuationState {
  token: number;
  currentState: RunState<any, any>;
  currentCallIds: string[];
  source: StreamHistorySource;
  previouslyEmittedIds: Set<string>;
  ledgerSnapshot: SavedToolExecution[];
  inputMode: 'delta' | 'full_history';
  cumulativeUsage?: NormalizedUsage;
  cumulativeCommandMessages: CommandMessage[];
  cumulativeTurnItems?: PersistedAssistantTurnItem[];
  retryCounts: RetryCounts;
  lastStream: AgentStream | null;
  currentResumePreviousResponseId: string | null | undefined;

  constructor(token: number) {
    this.token = token;
    this.currentState = {} as RunState<any, any>;
    this.currentCallIds = [];
    this.source = 'continueRunStream';
    this.previouslyEmittedIds = new Set();
    this.ledgerSnapshot = [];
    this.inputMode = 'delta';
    this.cumulativeCommandMessages = [];
    this.retryCounts = {
      transientRetryCount: 0,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    };
    this.lastStream = null;
    this.currentResumePreviousResponseId = undefined;
  }

  initializeFrom(prepared: PreparedContinuation): void {
    this.currentState = prepared.state;
    this.currentCallIds = getStringCallId(prepared.interruption);
    this.source = prepared.source;
    this.previouslyEmittedIds = prepared.previouslyEmittedCommandIds;
    this.inputMode = prepared.inputMode ?? 'delta';
    this.cumulativeUsage = prepared.cumulativeUsage;
    this.cumulativeCommandMessages = prepared.cumulativeCommandMessages ? [...prepared.cumulativeCommandMessages] : [];
    this.cumulativeTurnItems = prepared.cumulativeTurnItems;
    this.token = prepared.token ?? this.token;
  }

  advanceFromPlan(
    nextState: RunState<any, any>,
    nextInterruption: unknown,
    nextInputMode: 'delta' | 'full_history' | undefined,
    mergedEmittedIds: Set<string>,
    ledgerSnapshot: SavedToolExecution[],
  ): void {
    this.currentState = nextState;
    this.currentCallIds = getStringCallId(nextInterruption);
    this.source = 'continueRunStream';
    this.previouslyEmittedIds = mergedEmittedIds;
    this.ledgerSnapshot = ledgerSnapshot;
    this.inputMode = nextInputMode ?? this.inputMode;
  }

  setLastStream(stream: AgentStream | null): void {
    this.lastStream = stream;
  }

  setCumulativeUsage(usage: NormalizedUsage | undefined): void {
    this.cumulativeUsage = usage;
  }

  setCumulativeCommandMessages(messages: CommandMessage[]): void {
    this.cumulativeCommandMessages = messages;
  }

  setCumulativeTurnItems(items: PersistedAssistantTurnItem[] | undefined): void {
    this.cumulativeTurnItems = items;
  }

  setRetryCounts(counts: RetryCounts): void {
    this.retryCounts = counts;
  }

  setResumePreviousResponseId(id: string | null | undefined): void {
    this.currentResumePreviousResponseId = id;
  }

  setLedgerSnapshot(snapshot: SavedToolExecution[]): void {
    this.ledgerSnapshot = snapshot;
  }
}

function getStringCallId(interruption: unknown): string[] {
  const callId = getCallIdFromObject(interruption);
  return typeof callId === 'string' && callId.length > 0 ? [callId] : [];
}
