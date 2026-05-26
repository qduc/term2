import type { AgentInputItem } from '@openai/agents';
import type { NormalizedUsage } from '../utils/token-usage.js';
import { createUsageAccumulator } from '../utils/token-usage.js';
import {
  ToolExecutionLedger,
  reconcileHistoryWithToolLedger,
  type SavedToolExecution,
} from './tool-execution-ledger.js';
import { repairConversationHistory } from './conversation-history-repair.js';
import type { LogEnvelope, LogEvent, StateSnapshot } from './conversation-log-events.js';
import type { SavedAppMode, SavedMessage } from './conversation-persistence-types.js';

export interface RestoredState {
  id: string;
  createdAt: string;
  updatedAt?: string;
  projectPath?: string;
  sshHost?: string;
  appMode?: SavedAppMode;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  previousResponseId: string | null;
  messages: SavedMessage[];
  history: AgentInputItem[];
  toolLedger: SavedToolExecution[];
  usage?: NormalizedUsage;
  subagentUsage?: NormalizedUsage;
  replayWarnings: string[];
  forkedFrom?: string;
}

const INTERRUPTED_SYSTEM_MESSAGE = 'Previous turn was interrupted — send a message to continue.';

const cloneSnapshot = (snap: StateSnapshot): StateSnapshot => {
  try {
    return structuredClone(snap);
  } catch {
    return JSON.parse(JSON.stringify(snap)) as StateSnapshot;
  }
};

const cloneMessage = (msg: SavedMessage): SavedMessage => {
  try {
    return structuredClone(msg);
  } catch {
    return JSON.parse(JSON.stringify(msg)) as SavedMessage;
  }
};

interface InFlightToolCall {
  callId: string;
  toolName: string;
}

interface ReplayState {
  id: string;
  createdAt: string;
  projectPath?: string;
  sshHost?: string;
  appMode?: SavedAppMode;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  forkedFrom?: string;
  previousResponseId: string | null;
  history: AgentInputItem[];
  toolLedger: SavedToolExecution[];
  messages: SavedMessage[];
  snapshotModel?: string;
  snapshotProvider?: string;
  trailingUserMessage: boolean;
  inFlightToolCalls: Map<string, InFlightToolCall>;
  warnings: string[];
}

function applyEvent(state: ReplayState, event: LogEvent): void {
  const rawEvent = event as any;
  if (rawEvent.truncated) {
    state.warnings.push(
      `Log event of type "${event.type}" was truncated (original size: ${rawEvent.originalSize} bytes) due to size limits.`,
    );
    return;
  }
  switch (event.type) {
    case 'session_init': {
      state.id = event.id;
      state.createdAt = event.createdAt;
      state.projectPath = event.projectPath;
      state.sshHost = event.sshHost;
      state.appMode = event.appMode;
      state.model = event.model;
      state.provider = event.provider;
      state.reasoningEffort = event.reasoningEffort;
      state.forkedFrom = event.forkedFrom;
      return;
    }
    case 'settings_changed': {
      switch (event.key) {
        case 'agent.model':
          state.model = typeof event.value === 'string' ? event.value : state.model;
          return;
        case 'agent.provider':
          state.provider = typeof event.value === 'string' ? event.value : state.provider;
          return;
        case 'agent.reasoningEffort':
          state.reasoningEffort = typeof event.value === 'string' ? event.value : state.reasoningEffort;
          return;
        case 'app.mentorMode':
        case 'app.liteMode':
        case 'app.planMode':
        case 'app.orchestratorMode': {
          const flag = event.key.substring('app.'.length);
          state.appMode = {
            mentorMode: false,
            liteMode: false,
            planMode: false,
            orchestratorMode: false,
            ...(state.appMode ?? {}),
            [flag]: Boolean(event.value),
          };
          return;
        }
        default:
          return;
      }
    }
    case 'user_message': {
      state.messages.push(cloneMessage(event.message));
      state.trailingUserMessage = true;
      return;
    }
    case 'tool_started': {
      state.inFlightToolCalls.set(event.toolCallId, { callId: event.toolCallId, toolName: event.toolName });
      return;
    }
    case 'tool_result': {
      state.inFlightToolCalls.delete(event.callId);
      return;
    }
    case 'command_message': {
      state.messages.push(cloneMessage(event.message as unknown as SavedMessage));
      return;
    }
    case 'approval_required': {
      const callId = event.approval.callId;
      if (callId && !state.inFlightToolCalls.has(callId)) {
        state.inFlightToolCalls.set(callId, { callId, toolName: event.approval.toolName });
      }
      return;
    }
    case 'approval_resolved': {
      return;
    }
    case 'subagent_started': {
      state.messages.push({
        id: `subagent-${event.agentId}`,
        sender: 'subagent',
        status: 'running',
        agentId: event.agentId,
        role: event.role,
        task: event.task,
        tools: [],
      } as unknown as SavedMessage);
      return;
    }
    case 'subagent_completed': {
      const agentId = event.result.agentId;
      state.messages = state.messages.filter((msg) => !(msg.sender === 'subagent' && (msg as any).agentId === agentId));
      return;
    }
    case 'error': {
      state.messages.push({
        id: `err-${state.messages.length}`,
        sender: 'bot',
        status: 'finalized',
        text: `Error: ${event.message}`,
      });
      return;
    }
    case 'assistant_final': {
      state.messages.push(cloneMessage(event.message));
      const snap = cloneSnapshot(event.snapshot);
      state.history = snap.history;
      state.previousResponseId = snap.previousResponseId;
      state.toolLedger = snap.toolLedger;
      state.snapshotModel = snap.model ?? state.snapshotModel;
      state.snapshotProvider = snap.provider ?? state.snapshotProvider;
      state.trailingUserMessage = false;
      state.inFlightToolCalls.clear();
      return;
    }
    case 'undo': {
      let removed = 0;
      const target = Math.max(event.removedUserTurns, 1);
      for (let i = state.messages.length - 1; i >= 0 && removed < target; i--) {
        const msg = state.messages[i];
        if (msg.sender === 'user' && !(msg as any).consumedForAbort) {
          state.messages = state.messages.slice(0, i);
          removed++;
        }
      }
      const snap = cloneSnapshot(event.snapshot);
      state.history = snap.history;
      state.previousResponseId = snap.previousResponseId;
      state.toolLedger = snap.toolLedger;
      state.snapshotModel = snap.model ?? state.snapshotModel;
      state.snapshotProvider = snap.provider ?? state.snapshotProvider;
      state.trailingUserMessage = false;
      state.inFlightToolCalls.clear();
      return;
    }
    case 'session_cleared': {
      return;
    }
    default:
      return;
  }
}

export function replayEvents(envelopes: LogEnvelope[]): RestoredState {
  const usage = createUsageAccumulator();
  const subagentUsage = createUsageAccumulator();
  const state: ReplayState = {
    id: '',
    createdAt: '',
    previousResponseId: null,
    history: [],
    toolLedger: [],
    messages: [],
    trailingUserMessage: false,
    inFlightToolCalls: new Map(),
    warnings: [],
  };

  for (const envelope of envelopes) {
    if (!envelope || envelope.event == null) continue;
    if (envelope.event.type === 'assistant_final' && envelope.event.usage) {
      usage.add(envelope.event.usage);
    }
    if (envelope.event.type === 'subagent_completed' && envelope.event.result?.usage) {
      subagentUsage.add(envelope.event.result.usage);
    }
    applyEvent(state, envelope.event);
  }

  // Mid-turn crash handling
  if (state.trailingUserMessage || state.inFlightToolCalls.size > 0) {
    // Synthesize ledger entries for in-flight tool calls that started after the last snapshot.
    const ledgerWithInFlight = [...state.toolLedger];
    const existingCallIds = new Set(ledgerWithInFlight.map((e) => e.callId));
    for (const tc of state.inFlightToolCalls.values()) {
      if (existingCallIds.has(tc.callId)) continue;
      ledgerWithInFlight.push({
        turnId: 'turn-interrupted',
        callId: tc.callId,
        toolName: tc.toolName,
        status: 'started',
        startedAt: new Date(0).toISOString(),
      });
    }
    const ledger = new ToolExecutionLedger();
    ledger.import(ledgerWithInFlight);
    ledger.markOpenCallsAborted('Session ended unexpectedly');
    state.toolLedger = ledger.export();
    const reconciled = reconcileHistoryWithToolLedger(state.history, state.toolLedger);
    state.history = reconciled.history as AgentInputItem[];
    if (state.trailingUserMessage) {
      state.warnings.push('Previous turn was interrupted.');
      state.messages.push({
        id: `system-interrupted-${state.messages.length}`,
        sender: 'system',
        text: INTERRUPTED_SYSTEM_MESSAGE,
      });
    }
  }

  // Defensive idempotent final repair pass
  const repair = repairConversationHistory(state.history);
  if (repair.repaired && repair.removedItems > 0) {
    state.history = repair.history as AgentInputItem[];
    state.warnings.push(
      `Repaired conversation history: removed ${repair.removedItems} duplicated tool replay item(s).`,
    );
  }

  // Cross-model invalidation
  if (
    state.snapshotModel &&
    state.model &&
    (state.snapshotModel !== state.model ||
      (state.snapshotProvider && state.provider && state.snapshotProvider !== state.provider))
  ) {
    state.previousResponseId = null;
  }

  const accumulatedUsage = usage.get();
  const accumulatedSubagentUsage = subagentUsage.get();

  return {
    id: state.id,
    createdAt: state.createdAt,
    projectPath: state.projectPath,
    sshHost: state.sshHost,
    appMode: state.appMode,
    model: state.model,
    provider: state.provider,
    reasoningEffort: state.reasoningEffort,
    previousResponseId: state.previousResponseId,
    messages: state.messages,
    history: state.history,
    toolLedger: state.toolLedger,
    usage: Object.keys(accumulatedUsage).length > 0 ? accumulatedUsage : undefined,
    subagentUsage: Object.keys(accumulatedSubagentUsage).length > 0 ? accumulatedSubagentUsage : undefined,
    replayWarnings: state.warnings,
    forkedFrom: state.forkedFrom,
  };
}
