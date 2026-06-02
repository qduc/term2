import type { AgentInputItem } from '@openai/agents';
import type { NormalizedUsage } from '../utils/token-usage.js';
import { createUsageAccumulator } from '../utils/token-usage.js';
import {
  ToolExecutionLedger,
  reconcileHistoryWithToolLedger,
  type SavedToolExecution,
} from './tool-execution-ledger.js';
import { repairConversationHistory } from './conversation-history-repair.js';
import type { AssistantTurnState, LogEnvelope, LogEvent, StateSnapshot } from './conversation-log-events.js';
import type {
  SavedAppMode,
  SavedMessage,
  PersistedAssistantTurn,
  PersistedAssistantTurnItem,
} from './conversation-persistence-types.js';
import { synthesizeHistoryFromAssistantTurn } from './conversation-turn-items.js';
import { formatPatchOutputItems, coerceToText } from '../tools/format-helpers.js';

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

const cloneValue = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
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

const makeHistoryItemForToolCall = (item: Extract<PersistedAssistantTurnItem, { type: 'tool_call' }>): unknown => {
  const raw = item.providerItem;
  if (raw && typeof raw === 'object') {
    return cloneValue(raw);
  }
  return {
    type: 'function_call',
    callId: item.callId,
    name: item.toolName,
    arguments: item.arguments,
  };
};

const makeHistoryItemForToolResult = (item: Extract<PersistedAssistantTurnItem, { type: 'tool_result' }>): unknown => {
  const raw = item.providerItem;
  if (raw && typeof raw === 'object') {
    return cloneValue(raw);
  }
  return {
    type: 'function_call_result',
    callId: item.callId,
    name: item.toolName,
    output: item.output,
  };
};

function mergeAssistantTurnIntoLedger(state: ReplayState, turn: PersistedAssistantTurn, ts: string): void {
  const calls = new Map<string, Extract<PersistedAssistantTurnItem, { type: 'tool_call' }>>();
  for (const item of turn.items) {
    if (item.type === 'tool_call') {
      calls.set(item.callId, item);
      const existing = state.toolLedger.find((entry) => entry.callId === item.callId);
      if (!existing) {
        state.toolLedger.push({
          turnId: `turn-${state.messages.filter((message) => message.sender === 'user').length || 1}`,
          callId: item.callId,
          toolName: item.toolName,
          arguments: item.arguments,
          status: 'started',
          startedAt: ts,
          historyItems: [makeHistoryItemForToolCall(item)],
        });
      } else {
        existing.toolName = item.toolName;
        existing.arguments = item.arguments;
        if (!existing.historyItems || existing.historyItems.length === 0) {
          existing.historyItems = [makeHistoryItemForToolCall(item)];
        }
      }
      continue;
    }

    if (item.type !== 'tool_result') {
      continue;
    }

    let existing = state.toolLedger.find((entry) => entry.callId === item.callId);
    if (!existing) {
      const call = calls.get(item.callId);
      existing = {
        turnId: `turn-${state.messages.filter((message) => message.sender === 'user').length || 1}`,
        callId: item.callId,
        toolName: item.toolName,
        arguments: call?.arguments,
        status: 'started',
        startedAt: ts,
        historyItems: call ? [makeHistoryItemForToolCall(call)] : [],
      };
      state.toolLedger.push(existing);
    }

    const callHistoryItem = existing.historyItems?.find((historyItem) => {
      const record = historyItem && typeof historyItem === 'object' ? (historyItem as Record<string, unknown>) : null;
      return record?.type === 'function_call';
    });
    existing.toolName = item.toolName;
    existing.status = item.status;
    existing.output = item.output;
    existing.completedAt = ts;
    existing.historyItems = callHistoryItem
      ? [callHistoryItem, makeHistoryItemForToolResult(item)]
      : [makeHistoryItemForToolResult(item)];
  }
}

const stateFromAssistantTurn = (event: Extract<LogEvent, { type: 'assistant_turn' }>): AssistantTurnState => {
  if (event.state) {
    return event.state;
  }
  return {
    previousResponseId: event.snapshot?.previousResponseId ?? null,
    ...(event.snapshot?.model ? { model: event.snapshot.model } : {}),
    ...(event.snapshot?.provider ? { provider: event.snapshot.provider } : {}),
  };
};

function shouldReuseCumulativeUsageAsDisplayUsage(turn: PersistedAssistantTurn): boolean {
  return !turn.items.some((item) => item.type === 'tool_call' || item.type === 'tool_result');
}

/**
 * Extracts a human-readable display string from a parsed tool output object.
 * Many tools (apply_patch, create_file, search_replace) return JSON-stringified
 * objects. This function unwraps common shapes to show meaningful text.
 */
function extractDisplayOutput(parsed: Record<string, unknown>): string {
  // Error messages first — they're the most important to surface.
  if (typeof parsed.error === 'string' && parsed.error) {
    return parsed.error;
  }

  // Success message (create_file, search_replace).
  if (typeof parsed.message === 'string' && parsed.message) {
    return parsed.message;
  }

  // apply_patch / search_replace shape: { output: [{ success, path?, message?, error? }, ...] }
  if (Array.isArray(parsed.output) && parsed.output.length > 0) {
    const joined = formatPatchOutputItems(parsed.output);
    if (joined) {
      return joined;
    }
  }

  // AI-SDK / OpenAI Responses content-part shapes: { type: 'text' | 'output_text', text }.
  // These are what land in tool_result.output when a provider wraps a plain string.
  const type = parsed.type;
  if ((type === 'text' || type === 'output_text') && typeof parsed.text === 'string' && parsed.text) {
    return parsed.text;
  }

  // Generic content-part array: { content: [{ type: 'text', text: '...' }, ...] }.
  if (Array.isArray(parsed.content) && parsed.content.length > 0) {
    const joined = coerceToText(parsed.content);
    if (joined) {
      return joined;
    }
  }

  // Generic fallback: show summary keys only.
  const summaryKeys = ['success', 'type', 'path', 'count', 'status'];
  const summary = summaryKeys.filter((k) => k in parsed).map((k) => `${k}=${String(parsed[k])}`);
  if (summary.length > 0) {
    return summary.join(', ');
  }

  // Last resort: pretty-print the whole object.
  return JSON.stringify(parsed, null, 2);
}

function replayAssistantTurn(
  turn: PersistedAssistantTurn,
  turnId: string,
  usage?: NormalizedUsage,
  displayUsage?: NormalizedUsage,
): SavedMessage[] {
  const messages: SavedMessage[] = [];
  let index = 0;
  let lastAssistantMessage: SavedMessage | null = null;
  for (const item of turn.items) {
    if (item.type === 'reasoning') {
      messages.push({
        id: `reasoning-${turnId}-${index++}`,
        sender: 'reasoning',
        status: 'finalized',
        text: item.text,
      });
    } else if (item.type === 'assistant_text') {
      const assistantMessage = {
        id: `bot-${turnId}-${index++}`,
        sender: 'bot',
        status: 'finalized',
        text: item.text,
      } as SavedMessage;
      messages.push(assistantMessage);
      lastAssistantMessage = assistantMessage;
    } else if (item.type === 'tool_call') {
      // Persisted arguments are often JSON strings from the SDK (e.g.
      // '{"command":"ls"}') and need to be parsed so the display component
      // receives a proper object for its special rendering branches and so
      // the command field is a human-readable string, not raw JSON.
      const parsedArgs: unknown =
        typeof item.arguments === 'string'
          ? (() => {
              try {
                return JSON.parse(item.arguments);
              } catch {
                return item.arguments;
              }
            })()
          : item.arguments;

      const command =
        typeof parsedArgs === 'object' && parsedArgs !== null
          ? (parsedArgs as Record<string, unknown>).command ??
            (parsedArgs as Record<string, unknown>).question ??
            (parsedArgs as Record<string, unknown>).pattern ??
            (parsedArgs as Record<string, unknown>).query ??
            (parsedArgs as Record<string, unknown>).path ??
            (parsedArgs as Record<string, unknown>).task ??
            ''
          : typeof parsedArgs === 'string'
          ? parsedArgs
          : '';

      messages.push({
        id: `command-${item.callId}`,
        sender: 'command',
        status: 'running',
        command: command || item.toolName,
        output: '',
        toolName: item.toolName,
        toolArgs: parsedArgs,
        callId: item.callId,
      } as SavedMessage);
    } else if (item.type === 'tool_result') {
      // Persisted outputs can be JSON strings (e.g. apply_patch returns
      // JSON.stringify({ output: [...] }), create_file returns
      // JSON.stringify({ success, path, message })) and need to be parsed so
      // the display shows meaningful text instead of raw JSON.
      const parsedOutput: unknown =
        typeof item.output === 'string'
          ? (() => {
              try {
                return JSON.parse(item.output);
              } catch {
                return item.output;
              }
            })()
          : item.output;

      const outputText =
        typeof parsedOutput === 'object' && parsedOutput !== null
          ? extractDisplayOutput(parsedOutput as Record<string, unknown>)
          : typeof parsedOutput === 'string'
          ? parsedOutput
          : JSON.stringify(parsedOutput);

      const existing = messages.find((m) => m.sender === 'command' && m.callId === item.callId);
      if (existing) {
        existing.status = item.status === 'failed' || item.status === 'aborted' ? item.status : 'completed';
        existing.output = outputText;
        if (item.status === 'failed') {
          existing.success = false;
        } else if (item.status === 'completed') {
          existing.success = true;
        }
      } else {
        messages.push({
          id: `command-${item.callId}`,
          sender: 'command',
          status: item.status === 'failed' || item.status === 'aborted' ? item.status : 'completed',
          command: item.toolName,
          output: outputText,
          success: item.status === 'completed',
          toolName: item.toolName,
          callId: item.callId,
        } as SavedMessage);
      }
    }
  }
  const usageForDisplay =
    displayUsage && Object.keys(displayUsage).length > 0
      ? displayUsage
      : usage && Object.keys(usage).length > 0 && shouldReuseCumulativeUsageAsDisplayUsage(turn)
      ? usage
      : undefined;

  if (usageForDisplay && lastAssistantMessage) {
    lastAssistantMessage.usage = usageForDisplay;
  }
  return messages;
}

function applyEvent(state: ReplayState, event: LogEvent, ts: string): void {
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
      state.history.push({
        role: 'user',
        type: 'message',
        content: event.message.text ?? '',
      });
      return;
    }
    case 'tool_started': {
      state.inFlightToolCalls.set(event.toolCallId, { callId: event.toolCallId, toolName: event.toolName });
      const existing = state.toolLedger.find((e) => e.callId === event.toolCallId);
      if (!existing) {
        state.toolLedger.push({
          turnId: 'turn-interrupted',
          callId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.arguments,
          status: 'started',
          startedAt: ts,
        });
      }
      return;
    }
    case 'tool_result': {
      state.inFlightToolCalls.delete(event.callId);
      let existing = state.toolLedger.find((e) => e.callId === event.callId);
      if (!existing) {
        existing = {
          turnId: 'turn-interrupted',
          callId: event.callId,
          toolName: event.toolName,
          status: 'started',
          startedAt: ts,
        };
        state.toolLedger.push(existing);
      }
      existing.status = event.status === 'failed' || event.status === 'aborted' ? event.status : 'completed';
      existing.output = event.output;
      existing.completedAt = ts;
      if (event.historyItems) {
        existing.historyItems = event.historyItems;
      }
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
    case 'assistant_turn': {
      const lastUserIndex = state.messages.map((m) => m.sender).lastIndexOf('user');
      if (lastUserIndex !== -1) {
        state.messages = state.messages.slice(0, lastUserIndex + 1);
      } else {
        state.messages = [];
      }
      const turnId = `bot-turn-${state.messages.length}-${ts}`;
      const replayedMessages = replayAssistantTurn(event.turn, turnId, event.usage, event.displayUsage);
      for (const m of replayedMessages) {
        state.messages.push(m);
      }
      const compactState = stateFromAssistantTurn(event);
      state.history = synthesizeHistoryFromAssistantTurn(state.history, event.turn);
      if (event.snapshot) {
        const snap = cloneSnapshot(event.snapshot);
        state.toolLedger = snap.toolLedger;
      } else {
        mergeAssistantTurnIntoLedger(state, event.turn, ts);
      }
      state.previousResponseId = compactState.previousResponseId;
      state.snapshotModel = compactState.model ?? state.snapshotModel;
      state.snapshotProvider = compactState.provider ?? state.snapshotProvider;
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
    if (envelope.event.type === 'assistant_turn' && envelope.event.usage) {
      usage.add(envelope.event.usage);
    }
    if (envelope.event.type === 'subagent_completed' && envelope.event.result?.usage) {
      subagentUsage.add(envelope.event.result.usage);
    }
    applyEvent(state, envelope.event, envelope.ts);
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
