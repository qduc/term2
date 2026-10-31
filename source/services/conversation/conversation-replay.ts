import { isTemperatureSetting } from '../settings/session-runtime-settings.js';
import { isDeepStrictEqual } from 'node:util';
import { pairToolOccurrences, toolOccurrenceKey, toolOccurrenceMetadata } from './tool-occurrence.js';
import { buildToolLedgerFromAssistantTurnItems } from './journal-to-ledger.js';
import { alignHistoryToolOccurrences, normalizeToolLedgerOccurrences } from '../tool-execution-ledger.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { ModelSelectionSchema } from '../settings/model-selection.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import { createUsageAccumulator } from '../../utils/ai/token-usage.js';
import type { ModelRequestCost } from '../../services/cost/model-cost.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import { repairConversationHistory } from './conversation-history-repair.js';
import type {
  AssistantTurnState,
  LogEvent,
  PersistedLogEvent,
  StateSnapshot,
} from '../logging/conversation-log-events.js';
import { isTruncatedLogEvent } from '../logging/conversation-log-events.js';
import { formatMemoryReceipt } from './conversation-events.js';
import { validateCompactionSequence, type PersistedLogEnvelope } from './conversation-decoder.js';
import type { BotMessage, CommandMessage, SubagentActivityMessage } from '../../types/message.js';
import type {
  SavedAppMode,
  SavedMessage,
  PersistedAssistantTurn,
  PersistedAssistantTurnItem,
} from './conversation-persistence-types.js';
import { normalizeRunItems } from './run-item-normalizer.js';
import { synthesizeHistoryFromAssistantTurn } from './conversation-turn-items.js';
import { formatPatchOutputItems, coerceToText } from '../../tools/format-helpers.js';
import { projectProviderHistory } from './conversation-state-projector.js';
import {
  RESTART_UNOBSERVED_TOOL_RESULT,
  callIdOf,
  isToolCallHistoryItem,
  isToolResultHistoryItem,
} from '../tool-execution-ledger.js';
import { projectConversationMessage } from './conversation-message-projection.js';
import { deriveLocalCheckpointRequestHistory } from './local-checkpoint-projection.js';
import {
  legacyModeFromProfileId,
  profileIdFromLegacyMode,
  profileIdFromLegacyModeSetting,
} from '../profiles/legacy-adapter.js';

export interface RestoredState {
  id: string;
  createdAt: string;
  updatedAt?: string;
  projectPath?: string;
  sshHost?: string;
  activeProfileId?: string;
  appMode?: SavedAppMode;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  temperature?: number;
  previousResponseId: string | null;
  messages: SavedMessage[];
  history: ProviderInputItem[];
  toolLedger: SavedToolExecution[];
  usage?: NormalizedUsage;
  subagentUsage?: NormalizedUsage;
  costRecords?: ModelRequestCost[];
  replayWarnings: string[];
  forkedFrom?: string;
  rolloverFrom?: string;
  goal?: import('../logging/conversation-log-events.js').DurableGoal;
  coveredToolOccurrences?: string[];
  retryEligibility?: { readonly turn: boolean; readonly tool: boolean };
}

const countNativeUsers = (history: readonly ProviderInputItem[]): number =>
  history.filter((item) => {
    const message = projectConversationMessage(item);
    return message?.role === 'user' && !message.isSynthetic;
  }).length;

const lastToolResultIndexOf = (history: readonly ProviderInputItem[]): number => {
  for (let index = history.length - 1; index >= 0; index--) {
    if (isToolResultHistoryItem(history[index])) return index;
  }
  return -1;
};

const isRetrySourceUser = (message: { sender: string; text?: string; consumedForAbort?: boolean }): boolean =>
  message.sender === 'user' &&
  !message.consumedForAbort &&
  !projectConversationMessage({ type: 'message', role: 'user', content: message.text ?? '' })?.isSynthetic;

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

interface ReplayedBackgroundShellJob {
  jobId: string;
  command: string;
  completed?: {
    status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
    output: string;
    error?: string;
  };
  /**
   * Monitor firings in stored order. Kept on the job record so they replay
   * ahead of the terminal row: a monitor hit must never read as new activity
   * on a dead job. Idempotent per watchId:seq, mirroring the notification
   * messageId dedupe.
   */
  firings?: {
    watchId: string;
    seq: number;
    matchedLines: string;
    coalescedCount?: number;
    seqRange?: { first: number; last: number };
    droppedBytes?: number;
  }[];
}

/**
 * Per-turn journal state collected during event application. Used to
 * reconstruct interrupted turns (no final `assistant_turn`) and to
 * deduplicate completed turns (final takes precedence over journal).
 */
interface TurnJournal {
  /** Turn id from the log when available, otherwise undefined for legacy logs. */
  turnId?: string;
  /** User-turn ordinal used to place reconstructed output back into message order. */
  userTurnIndex: number;
  /** Persisted items emitted as `assistant_journal_item`, in arrival order. */
  items: PersistedAssistantTurnItem[];
  /** Coalesced text fragment for the current turn, or null if none. */
  textFragment: string | null;
  /** Coalesced reasoning fragment for the current turn, or null if none. */
  reasoningFragment: string | null;
  /** Set when at least one `assistant_journal_item` event was observed. */
  sawItem: boolean;
  /** Set when a final `assistant_turn` event was applied for this turn. */
  sawFinalTurn: boolean;
  /** Set when an approval was required but never resolved this turn. */
  approvalPending: boolean;
  /** Set when an approval was resolved this turn. */
  approvalResolved: boolean;
  /** Map of callId -> toolName for `tool_started` events that lack a matching journal item. */
  toolStartedByCall: Map<string, string>;
  /** Map of callId -> tool name for `approval_required` events seen this turn. */
  approvalByCall: Map<string, string>;
  /** Last-seen approval event arguments, used when reconstructing pending approval. */
  lastApprovalArguments?: string;
  lastApprovalAgentName?: string;
  /** When the turn started (set on first user_message or first tool_started). */
  startedAt: string;
}

const createEmptyTurnJournal = (ts: string, userTurnIndex: number, turnId?: string): TurnJournal => ({
  turnId,
  userTurnIndex,
  items: [],
  textFragment: null,
  reasoningFragment: null,
  sawItem: false,
  sawFinalTurn: false,
  approvalPending: false,
  approvalResolved: false,
  toolStartedByCall: new Map(),
  approvalByCall: new Map(),
  startedAt: ts,
});

interface ReplayState {
  /** Timestamp of the last applied log envelope; used for deterministic settlement. */
  lastEventTs?: string;
  id: string;
  createdAt: string;
  projectPath?: string;
  sshHost?: string;
  activeProfileId?: string;
  appMode?: SavedAppMode;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  temperature?: number;
  forkedFrom?: string;
  rolloverFrom?: string;
  goal?: import('../logging/conversation-log-events.js').DurableGoal;
  previousResponseId: string | null;
  history: ProviderInputItem[];
  toolLedger: SavedToolExecution[];
  messages: SavedMessage[];
  snapshotModel?: string;
  snapshotProvider?: string;
  trailingUserMessage: boolean;
  inFlightToolCalls: Map<string, InFlightToolCall>;
  warnings: string[];
  /** Journal entries keyed by turn id when present, otherwise by legacy user-turn index. */
  pendingJournals: Map<string, TurnJournal>;
  /** Command messages added during streaming that may overlap with journal tool results. */
  pendingCommandMessages: SavedMessage[];
  /** Observational lifecycle only: replay never creates a process from these records. */
  backgroundShellJobs: Map<string, ReplayedBackgroundShellJob>;
  /** Index in state.messages where the current/in-flight turn began. */
  activeTurnStartIndex: number;
  coveredToolOccurrences: Set<string>;
  unassociatedNativeUsers: number;
  unassociatedNativeHistoryLength: number;
}

/**
 * Returns the journal slot for the current user turn, allocating it on
 * first use. Journals are keyed by the number of user messages seen so
 * far so an `assistant_turn` for turn N correlates with journal entries
 * that arrived between user message N and (N+1).
 */
const journalKeyForEvent = (event: { turnId?: string }, state: ReplayState): string => {
  if (typeof event.turnId === 'string' && event.turnId) {
    return `turn:${event.turnId}`;
  }
  const userTurnCount = state.messages.filter((message) => message.sender === 'user').length;
  return `legacy:${userTurnCount}`;
};

const getOrCreateJournal = (state: ReplayState, ts: string, key: string, turnId?: string): TurnJournal => {
  const userTurnCount = state.messages.filter((message) => message.sender === 'user').length;
  let journal = state.pendingJournals.get(key);
  if (!journal) {
    journal = createEmptyTurnJournal(ts, userTurnCount, turnId);
    state.pendingJournals.set(key, journal);
  }
  return journal;
};

/** Authoritative pairs replace provisional lifecycle views, never settled siblings. */
function mergeAssistantTurnIntoLedger(
  state: ReplayState,
  turn: PersistedAssistantTurn,
  ts: string,
  turnId?: string,
): void {
  const id = turnId ?? `turn-${state.messages.filter((message) => message.sender === 'user').length || 1}`;
  const entries = buildToolLedgerFromAssistantTurnItems(turn.items, id, ts);
  for (const entry of entries) {
    state.toolLedger = state.toolLedger.filter(
      (candidate) =>
        !(
          candidate.occurrence === undefined &&
          candidate.callId === entry.callId &&
          (candidate.turnId === id || candidate.turnId === 'turn-interrupted')
        ),
    );
    const index = state.toolLedger.findIndex((candidate) => toolOccurrenceKey(candidate) === toolOccurrenceKey(entry));
    if (index === -1) state.toolLedger.push(entry);
    else {
      const existing = state.toolLedger[index]!;
      // A later-segment direct settlement can precede the journal reconstruction.
      state.toolLedger[index] =
        entry.status === 'started' && existing.status !== 'started'
          ? {
              ...entry,
              ...existing,
              historyItems: existing.historyItems?.length ? existing.historyItems : entry.historyItems,
            }
          : {
              ...existing,
              ...entry,
              ...(!normalizeRunItems(entry.historyItems).some((item) => item.type === 'tool_call') &&
              normalizeRunItems(existing.historyItems).some((item) => item.type === 'tool_call')
                ? { arguments: existing.arguments, historyItems: existing.historyItems }
                : {}),
            };
    }
  }
  const keys = new Set(entries.map(toolOccurrenceKey));
  const first = state.toolLedger.findIndex((entry) => keys.has(toolOccurrenceKey(entry)));
  if (first >= 0) {
    const ordered = entries.map(
      (entry) => state.toolLedger.find((candidate) => toolOccurrenceKey(candidate) === toolOccurrenceKey(entry))!,
    );
    state.toolLedger = state.toolLedger.filter((entry) => !keys.has(toolOccurrenceKey(entry)));
    state.toolLedger.splice(first, 0, ...ordered);
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
  matchLatestOccurrence = false,
): SavedMessage[] {
  const messages: SavedMessage[] = [];
  const occurrenceRows = new Map<string, CommandMessage>();
  let index = 0;
  let lastAssistantMessage: BotMessage | null = null;
  for (const item of turn.items) {
    if (item.type === 'reasoning') {
      messages.push({
        id: `reasoning-${turnId}-${index++}`,
        sender: 'reasoning',
        status: 'finalized',
        text: item.text,
      });
    } else if (item.type === 'assistant_text') {
      const assistantMessage: BotMessage = {
        id: `bot-${turnId}-${index++}`,
        sender: 'bot',
        status: 'finalized',
        text: item.text,
      };
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
          ? (parsedArgs as Record<string, string>).command ??
            (parsedArgs as Record<string, string>).question ??
            (parsedArgs as Record<string, string>).pattern ??
            (parsedArgs as Record<string, string>).query ??
            (parsedArgs as Record<string, string>).path ??
            (parsedArgs as Record<string, string>).task ??
            ''
          : typeof parsedArgs === 'string'
          ? parsedArgs
          : '';

      const row: CommandMessage = {
        id: `command-${item.callId}`,
        sender: 'command',
        status: 'running',
        command: command || item.toolName,
        output: '',
        toolName: item.toolName,
        toolArgs: parsedArgs,
        callId: item.callId,
      };
      messages.push(row);
      if (matchLatestOccurrence && item.occurrence !== undefined) occurrenceRows.set(toolOccurrenceKey(item), row);
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

      const explicit =
        matchLatestOccurrence && item.occurrence !== undefined
          ? occurrenceRows.get(toolOccurrenceKey(item))
          : undefined;
      const existing =
        explicit ??
        (matchLatestOccurrence ? [...messages].reverse() : messages).find(
          (m): m is CommandMessage =>
            m.sender === 'command' && m.callId === item.callId && (!matchLatestOccurrence || m.status === 'running'),
        );
      if (existing) {
        existing.status = item.status;
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
          status: item.status,
          command: item.toolName,
          output: outputText,
          success: item.status === 'completed',
          toolName: item.toolName,
          callId: item.callId,
        });
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

function applyEvent(state: ReplayState, event: PersistedLogEvent, ts: string): void {
  if (isTruncatedLogEvent(event)) {
    state.warnings.push(
      `Log event of type "${event.type}" was truncated (original size: ${event.originalSize} bytes) due to size limits.`,
    );
    return;
  }
  switch (event.type) {
    case 'session_init': {
      state.id = event.id;
      state.createdAt = event.createdAt;
      state.projectPath = event.projectPath;
      state.sshHost = event.sshHost;
      state.activeProfileId = event.activeProfileId;
      state.appMode = event.appMode;
      state.model = event.model;
      state.provider = event.provider;
      state.reasoningEffort = event.reasoningEffort;
      state.forkedFrom = event.forkedFrom;
      state.rolloverFrom = event.rolloverFrom ?? state.rolloverFrom;
      return;
    }
    case 'session_settings_initialized':
      state.model = event.model.model;
      state.provider = event.model.provider;
      state.reasoningEffort = event.reasoningEffort;
      state.temperature = event.temperature;
      return;
    case 'settings_changed': {
      if (event.sessionMutation === 1) state.previousResponseId = null;
      switch (event.key) {
        case 'agent.modelSelection': {
          const selection = ModelSelectionSchema.safeParse(event.value);
          if (selection.success) {
            state.model = selection.data.model;
            state.provider = selection.data.provider;
          }
          return;
        }
        case 'agent.model':
          state.model = typeof event.value === 'string' ? event.value : state.model;
          return;
        case 'agent.provider':
          state.provider = typeof event.value === 'string' ? event.value : state.provider;
          return;
        case 'agent.temperature':
          if (isTemperatureSetting(event.value)) state.temperature = event.value;
          else if (event.value === undefined) state.temperature = undefined;
          return;
        case 'agent.reasoningEffort':
          state.reasoningEffort = typeof event.value === 'string' ? event.value : state.reasoningEffort;
          return;
        case 'app.mentorMode':
        case 'app.liteMode':
        case 'app.planMode':
        case 'app.orchestratorMode': {
          const currentProfileId = state.activeProfileId ?? profileIdFromLegacyMode(state.appMode);
          const profileId = profileIdFromLegacyModeSetting(event.key, event.value, currentProfileId);
          if (profileId) {
            state.activeProfileId = profileId;
            state.appMode = legacyModeFromProfileId(profileId);
          }
          return;
        }
        case 'app.activeProfileId':
          if (typeof event.value === 'string') state.activeProfileId = event.value;
          return;
        default:
          return;
      }
    }
    case 'goal_changed':
      state.goal = cloneValue(event.goal);
      return;
    case 'user_message': {
      state.messages.push(cloneMessage(event.message));
      state.activeTurnStartIndex = state.messages.length;
      state.trailingUserMessage = true;
      state.history.push({
        role: 'user',
        type: 'message',
        content: event.message.text ?? '',
      });
      return;
    }
    case 'user_input_accepted':
    case 'tool_output_rewound':
    case 'user_turn_retried': {
      const snap = cloneSnapshot(event.snapshot);
      state.history = snap.history;
      state.previousResponseId = snap.previousResponseId;
      state.toolLedger = snap.toolLedger;
      const remainingKeys = new Set(normalizeToolLedgerOccurrences(state.toolLedger).map(toolOccurrenceKey));
      for (const key of [...state.coveredToolOccurrences]) {
        if (!remainingKeys.has(key)) state.coveredToolOccurrences.delete(key);
      }
      if (state.history.length < state.unassociatedNativeHistoryLength) {
        state.unassociatedNativeHistoryLength = state.history.length;
      }
      state.unassociatedNativeUsers = Math.min(state.unassociatedNativeUsers, countNativeUsers(state.history));
      state.snapshotModel = snap.model ?? state.snapshotModel;
      state.snapshotProvider = snap.provider ?? state.snapshotProvider;
      return;
    }
    case 'context_compaction_recorded': {
      if (event.result.kind !== 'compacted') return;
      const snap = cloneSnapshot(event.result.snapshot);
      state.history = snap.history;
      state.previousResponseId = snap.previousResponseId;
      state.toolLedger = snap.toolLedger;
      state.coveredToolOccurrences = new Set(normalizeToolLedgerOccurrences(state.toolLedger).map(toolOccurrenceKey));
      if (event.strategy === 'native') {
        state.unassociatedNativeUsers = countNativeUsers(state.history);
        state.unassociatedNativeHistoryLength = state.history.length;
      } else {
        state.unassociatedNativeUsers = Math.min(state.unassociatedNativeUsers, countNativeUsers(state.history));
        state.unassociatedNativeHistoryLength = Math.min(state.unassociatedNativeHistoryLength, state.history.length);
      }
      state.snapshotModel = snap.model ?? state.snapshotModel;
      state.snapshotProvider = snap.provider ?? state.snapshotProvider;
      state.trailingUserMessage = false;
      state.inFlightToolCalls.clear();
      return;
    }
    case 'assistant_journal_delta': {
      const journal = getOrCreateJournal(state, ts, journalKeyForEvent(event, state), event.turnId);
      // Coalesce same-kind fragments; the latest delta wins for that kind.
      if (event.kind === 'text') {
        journal.textFragment = (journal.textFragment ?? '') + event.delta;
      } else {
        journal.reasoningFragment = (journal.reasoningFragment ?? '') + event.delta;
      }
      return;
    }
    case 'assistant_journal_item': {
      const journal = getOrCreateJournal(state, ts, journalKeyForEvent(event, state), event.turnId);
      journal.sawItem = true;
      journal.items.push(cloneValue(event.item));
      return;
    }
    case 'tool_started': {
      state.inFlightToolCalls.set(event.toolCallId, { callId: event.toolCallId, toolName: event.toolName });
      const journal = getOrCreateJournal(state, ts, journalKeyForEvent(event, state), event.turnId);
      const existing = state.toolLedger.find(
        (e) => e.callId === event.toolCallId && e.turnId === (event.turnId ?? 'turn-interrupted'),
      );
      const journalCall = journal.items.some((item) => item.type === 'tool_call' && item.callId === event.toolCallId);
      if (!existing && !journalCall) {
        state.toolLedger.push({
          turnId: event.turnId ?? 'turn-interrupted',
          callId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.arguments,
          status: 'started',
          startedAt: ts,
        });
      }
      journal.toolStartedByCall.set(event.toolCallId, event.toolName);
      return;
    }
    case 'tool_result': {
      state.inFlightToolCalls.delete(event.callId);
      let existing = [...state.toolLedger]
        .reverse()
        .find(
          (e) =>
            e.callId === event.callId &&
            e.turnId === (event.turnId ?? 'turn-interrupted') &&
            (event.occurrence === undefined || e.occurrence === event.occurrence),
        );
      if (!existing) {
        existing = {
          turnId: event.turnId ?? 'turn-interrupted',
          callId: event.callId,
          occurrence: event.occurrence,
          toolName: event.toolName,
          status: 'started',
          startedAt: ts,
        };
        state.toolLedger.push(existing);
      }
      existing.status = event.status;
      existing.output = event.output;
      existing.completedAt = ts;
      if (event.historyItems) {
        existing.historyItems = event.historyItems;
      }
      return;
    }
    case 'command_message': {
      // Record for dedup: a `command_message` may be a poorer rendering of a
      // `tool_result` event the journal will later also reconstruct.
      const msg = event.message;
      state.pendingCommandMessages.push(cloneMessage(msg));
      state.messages.push(cloneMessage(msg));
      return;
    }
    case 'approval_required': {
      const callId = event.approval.callId;
      if (callId && !state.inFlightToolCalls.has(callId)) {
        state.inFlightToolCalls.set(callId, { callId, toolName: event.approval.toolName });
      }
      const journal = getOrCreateJournal(state, ts, journalKeyForEvent(event, state), event.turnId);
      journal.approvalPending = true;
      if (callId) {
        journal.approvalByCall.set(callId, event.approval.toolName);
      }
      journal.lastApprovalArguments = event.approval.argumentsText;
      journal.lastApprovalAgentName = event.approval.agentName;
      return;
    }
    case 'approval_resolved': {
      const journal = getOrCreateJournal(state, ts, journalKeyForEvent(event, state), event.turnId);
      journal.approvalResolved = true;
      journal.approvalPending = false;
      return;
    }
    case 'subagent_started': {
      if (state.messages.some((message) => message.sender === 'subagent' && message.agentId === event.agentId)) {
        return;
      }
      state.messages.push({
        id: `subagent-${event.agentId}`,
        sender: 'subagent',
        status: 'running',
        agentId: event.agentId,
        role: event.role,
        task: event.task,
        ...(event.parentTool !== undefined ? { parentTool: event.parentTool } : {}),
        async: event.async,
        tools: [],
      } as SubagentActivityMessage);
      return;
    }
    case 'subagent_transferred': {
      state.messages = state.messages.map((message) => {
        if (message.sender === 'subagent' && message.agentId === event.agentId && message.status === 'running') {
          return { ...message, status: 'backgrounded' };
        }
        return message;
      });
      return;
    }
    case 'subagent_interrupted': {
      state.messages = state.messages.map((message) => {
        if (message.sender === 'subagent' && message.agentId === event.agentId && message.status === 'running') {
          return { ...message, status: 'interrupted', finalText: event.finalText };
        }
        return message;
      });
      return;
    }
    case 'subagent_tool_started': {
      const existing = state.messages.find(
        (message): message is SubagentActivityMessage =>
          message.sender === 'subagent' && message.agentId === event.agentId,
      );
      if (existing) {
        existing.status = 'running';
        existing.role = existing.role || event.role;
      } else {
        state.messages.push({
          id: `subagent-${event.agentId}`,
          sender: 'subagent',
          status: 'running',
          agentId: event.agentId,
          role: event.role,
          task: '',
          tools: [],
        });
      }
      return;
    }
    case 'subagent_completed': {
      const agentId = event.result.agentId;
      state.messages = state.messages.map((msg) => {
        if (msg.sender === 'subagent' && msg.agentId === agentId) {
          if (msg.status === 'backgrounded') return msg;
          return {
            ...msg,
            status: event.result.status,
            finalText: event.result.finalText,
          };
        }
        return msg;
      });
      return;
    }
    case 'memory_injected': {
      state.messages.push({
        id: `memory-receipt-${state.messages.length}`,
        sender: 'system',
        text: formatMemoryReceipt(event.memories),
        memoryReceiptCount: event.memories.length,
      });
      return;
    }
    case 'background_shell_started': {
      if (!state.backgroundShellJobs.has(event.jobId)) {
        state.backgroundShellJobs.set(event.jobId, { jobId: event.jobId, command: event.command });
      }
      return;
    }
    case 'background_shell_completed': {
      const job = state.backgroundShellJobs.get(event.jobId);
      // The registry can redeliver terminal events; the replay transcript is
      // intentionally idempotent and only records the first terminal result.
      if (job?.completed) return;
      state.backgroundShellJobs.set(event.jobId, {
        // Keep any monitor firings recorded before settlement: the completed
        // event must not clobber them, or firings would replay as a dead job's
        // new activity on the other side of its terminal row.
        ...(job?.firings !== undefined ? { firings: job.firings } : {}),
        jobId: event.jobId,
        command: event.command,
        completed: {
          status: event.status,
          output: event.output,
          ...(event.error ? { error: event.error } : {}),
        },
      });
      const status = event.status === 'cancelled' ? 'aborted' : event.status === 'completed' ? 'completed' : 'failed';
      state.messages.push({
        id: `background-shell-${event.jobId}`,
        sender: 'command',
        status,
        command: 'background_shell_notification',
        output: event.output,
        success: status === 'completed',
        toolName: 'background_shell_notification',
        toolArgs: {
          jobs: [
            {
              jobId: event.jobId,
              command: event.command,
              status: event.status,
              ...(event.error ? { error: event.error } : {}),
            },
          ],
        },
      });
      state.activeTurnStartIndex = state.messages.length;
      return;
    }
    case 'background_shell_output': {
      const existing = state.backgroundShellJobs.get(event.jobId);
      // A firing may be the only record for a job whose start was never seen
      // (or whose process still outlived the session); synthesize the job.
      const job = existing ?? { jobId: event.jobId, command: event.command };
      const firing = {
        watchId: event.watchId,
        seq: event.seq,
        matchedLines: event.matchedLines,
        ...(event.coalescedCount !== undefined ? { coalescedCount: event.coalescedCount } : {}),
        ...(event.seqRange !== undefined ? { seqRange: event.seqRange } : {}),
        ...(event.droppedBytes !== undefined ? { droppedBytes: event.droppedBytes } : {}),
      };
      const firings = job.firings ?? [];
      // Registry events are at-least-once; a firing is transcribed once per
      // watchId:seq so replay never duplicates a row.
      if (firings.some((f) => f.watchId === firing.watchId && f.seq === firing.seq)) return;
      job.firings = [...firings, firing];
      state.backgroundShellJobs.set(event.jobId, job);
      state.messages.push({
        id: `background-shell-output-${event.jobId}-${firing.watchId}-${firing.seq}`,
        sender: 'command',
        status: 'completed',
        command: 'background_shell_output_notification',
        output: firing.matchedLines,
        success: true,
        toolName: 'background_shell_output_notification',
        toolArgs: {
          jobId: event.jobId,
          command: event.command,
          watchId: firing.watchId,
          seq: firing.seq,
          matchedLines: firing.matchedLines,
          ...(firing.coalescedCount !== undefined ? { coalescedCount: firing.coalescedCount } : {}),
          ...(firing.seqRange !== undefined ? { seqRange: firing.seqRange } : {}),
          ...(firing.droppedBytes !== undefined ? { droppedBytes: firing.droppedBytes } : {}),
        },
      });
      state.activeTurnStartIndex = state.messages.length;
      return;
    }
    case 'error': {
      state.messages.push({
        id: `err-${state.messages.length}`,
        sender: 'bot',
        status: 'finalized',
        text: `Error: ${event.message}`,
      });
      state.activeTurnStartIndex = state.messages.length;
      return;
    }
    case 'assistant_turn': {
      const authoritativeTurnId =
        event.turnId ?? `turn-${state.messages.filter((message) => message.sender === 'user').length || 1}`;
      if (!event.snapshot) {
        for (const journal of state.pendingJournals.values()) {
          if (
            journal.turnId === authoritativeTurnId ||
            (!event.turnId &&
              journal.userTurnIndex === state.messages.filter((message) => message.sender === 'user').length)
          )
            mergeAssistantTurnIntoLedger(state, { items: journal.items }, journal.startedAt, authoritativeTurnId);
        }
      }
      const alignedItems = alignHistoryToolOccurrences(
        event.turn.items,
        state.toolLedger.filter((entry) => entry.turnId === authoritativeTurnId),
      ) as PersistedAssistantTurnItem[];
      const turn = { ...event.turn, items: pairToolOccurrences(alignedItems, authoritativeTurnId) };
      const currentUserTurnIndex = state.messages.filter((message) => message.sender === 'user').length;
      const lastUserIndex = state.messages.map((m) => m.sender).lastIndexOf('user');
      const startIndex =
        state.trailingUserMessage && lastUserIndex !== -1 ? lastUserIndex + 1 : state.activeTurnStartIndex;
      state.messages = state.messages.slice(0, startIndex);
      const turnId = `bot-turn-${state.messages.length}-${ts}`;
      const replayedMessages = replayAssistantTurn(turn, turnId, event.usage, event.displayUsage);
      for (const m of replayedMessages) {
        state.messages.push(m);
      }
      state.activeTurnStartIndex = state.messages.length;
      const compactState = stateFromAssistantTurn(event);
      state.history = event.providerHistory
        ? cloneValue(event.providerHistory)
        : synthesizeHistoryFromAssistantTurn(state.history, turn);
      if (event.snapshot) {
        const snap = cloneSnapshot(event.snapshot);
        state.toolLedger = snap.toolLedger;
      } else {
        mergeAssistantTurnIntoLedger(state, turn, ts, authoritativeTurnId);
      }
      state.history = projectProviderHistory({
        history: state.history,
        toolLedger: state.toolLedger,
        coveredToolOccurrences: state.coveredToolOccurrences,
      }).history;
      state.previousResponseId = compactState.previousResponseId;
      state.snapshotModel = compactState.model ?? state.snapshotModel;
      state.snapshotProvider = compactState.provider ?? state.snapshotProvider;
      state.trailingUserMessage = false;
      state.inFlightToolCalls.clear();
      // Mark matching journals as finalized for this turn; any items already
      // recorded are dropped in favor of the authoritative assistant_turn
      // transcript (deduplication rule from the plan). We match by turn id
      // when available and fall back to the current user-turn index for
      // legacy logs that never stamped turn ids.
      const exactJournalKey = typeof event.turnId === 'string' && event.turnId ? `turn:${event.turnId}` : null;
      if (exactJournalKey) {
        const finalizedJournal = state.pendingJournals.get(exactJournalKey);
        if (finalizedJournal) {
          finalizedJournal.sawFinalTurn = true;
        }
      }
      for (const journal of state.pendingJournals.values()) {
        if (journal.userTurnIndex === currentUserTurnIndex) {
          journal.sawFinalTurn = true;
        }
      }
      return;
    }
    case 'undo': {
      let removed = 0;
      const target = Math.max(event.removedUserTurns, 1);
      for (let i = state.messages.length - 1; i >= 0 && removed < target; i--) {
        const msg = state.messages[i];
        if (msg.sender === 'user' && !msg.consumedForAbort) {
          state.messages = state.messages.slice(0, i);
          removed++;
        }
      }
      const snap = cloneSnapshot(event.snapshot);
      state.history = snap.history;
      state.previousResponseId = snap.previousResponseId;
      state.toolLedger = snap.toolLedger;
      const remainingKeys = new Set(normalizeToolLedgerOccurrences(state.toolLedger).map(toolOccurrenceKey));
      for (const key of [...state.coveredToolOccurrences]) {
        if (!remainingKeys.has(key)) state.coveredToolOccurrences.delete(key);
      }
      if (state.history.length < state.unassociatedNativeHistoryLength) {
        state.unassociatedNativeHistoryLength = state.history.length;
      }
      state.unassociatedNativeUsers = Math.min(state.unassociatedNativeUsers, countNativeUsers(state.history));
      state.snapshotModel = snap.model ?? state.snapshotModel;
      state.snapshotProvider = snap.provider ?? state.snapshotProvider;
      state.trailingUserMessage = false;
      state.inFlightToolCalls.clear();
      return;
    }
    case 'session_cleared': {
      state.coveredToolOccurrences.clear();
      state.unassociatedNativeUsers = 0;
      state.unassociatedNativeHistoryLength = 0;
      return;
    }
    default:
      return;
  }
}

/**
 * Project durable shell lifecycle records after normal transcript repair. These
 * are deliberately terminal-only rows: they describe a process from the prior
 * session and never attach it to the live tool ledger or start it again.
 */
function appendReplayedBackgroundShellJobs(state: ReplayState): void {
  for (const job of state.backgroundShellJobs.values()) {
    if (job.completed) continue;

    const output = 'Background shell job was interrupted when the previous session ended and was not restarted.';
    const error = 'Lost on restart.';
    state.messages.push({
      id: `background-shell-${job.jobId}`,
      sender: 'command',
      status: 'aborted',
      command: 'background_shell_notification',
      output,
      success: false,
      toolName: 'background_shell_notification',
      toolArgs: {
        jobs: [
          {
            jobId: job.jobId,
            command: job.command,
            status: 'interrupted',
            error,
          },
        ],
      },
    });
    state.warnings.push(`Background shell job ${job.jobId} was interrupted by restart and was not restarted.`);
  }
}

/**
 * Reconstructs saved messages and history items for any turn that did not
 * produce a final `assistant_turn` event. Each pending journal either:
 * - contributed at least one provider-backed item (preferred), or
 * - contributed only text/reasoning fragments (fallback).
 *
 * Dedup rules (per the plan):
 * - Provider-backed `assistant_journal_item` items win over fragment-only deltas.
 * - Finalized `assistant_turn` already cleared `sawFinalTurn`, so we never
 *   double-apply.
 * - Command messages added during streaming that overlap with a journal tool
 *   result for the same callId are dropped in favor of the richer persisted
 *   shape.
 */
function applyInterruptedTurnJournals(state: ReplayState, finalization: 'live' | 'reopened'): void {
  if (state.pendingJournals.size === 0) {
    return;
  }
  for (const [journalKey, journal] of state.pendingJournals) {
    if (journal.sawFinalTurn) {
      continue;
    }
    if (journal.items.length === 0 && !journal.textFragment && !journal.reasoningFragment) {
      continue;
    }

    const turnId = `journal-${journal.turnId ?? journalKey}-${journal.startedAt}`;
    const newMessages = buildMessagesFromJournal(journal, turnId, finalization);
    const hasProviderOpaqueItem = journal.items.some((item) => item.type === 'provider_opaque');
    if (newMessages.length === 0 && !hasProviderOpaqueItem) {
      continue;
    }

    // Find the position right after the corresponding user message; if the
    // user message was the last entry we already added during event
    // application, splice after that. Otherwise, append to the end.
    const userIndices: number[] = [];
    for (let i = 0; i < state.messages.length; i++) {
      if (state.messages[i].sender === 'user') {
        userIndices.push(i);
      }
    }
    const insertAfterIndex = userIndices[journal.userTurnIndex - 1];
    if (insertAfterIndex !== undefined) {
      state.messages.splice(insertAfterIndex + 1, 0, ...newMessages);
    } else {
      for (const m of newMessages) {
        state.messages.push(m);
      }
    }

    // Drop any pre-existing `command_message` entries for these callIds
    // because the journal we just applied produced richer versions of
    // the same tool. The newly inserted messages live in a contiguous
    // range right after the user message; everything before that range
    // is a candidate for filtering.
    const richerCallIds = new Set<string>();
    for (const item of journal.items) {
      if (item.type === 'tool_result') {
        richerCallIds.add(item.callId);
      }
    }
    if (richerCallIds.size > 0 && insertAfterIndex !== undefined) {
      const dropBefore = insertAfterIndex + 1 + newMessages.length;
      state.messages = state.messages.filter((message, index) => {
        if (index < dropBefore) {
          return true;
        }
        if (message.sender === 'command' && typeof message.callId === 'string') {
          return !richerCallIds.has(message.callId);
        }
        return true;
      });
    }

    // Append corresponding history items (tool call / tool result) so the
    // next resumed request sees them. Also rehydrate the tool ledger so
    // existing recovery semantics keep working.
    const id = journal.turnId ?? `turn-${journal.userTurnIndex}`;
    const turn = { items: pairToolOccurrences(journal.items, id) };
    mergeAssistantTurnIntoLedger(state, turn, journal.startedAt, id);
    // Text deltas are represented below; canonical text items are authoritative.
    state.history = synthesizeHistoryFromAssistantTurn(state.history, turn);
    if (journal.reasoningFragment) {
      state.history.push({
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: journal.reasoningFragment }],
        rawContent: [{ type: 'reasoning_text', text: journal.reasoningFragment }],
      } as ProviderInputItem);
    }
    if (journal.textFragment) {
      state.history.push({
        role: 'assistant',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: journal.textFragment }],
      } as ProviderInputItem);
    }
  }
}

/**
 * Settle interrupted tool entries so the resumed provider history carries a
 * call/result pair whose result preserves outcome uncertainty instead of a
 * silent blind-repeat hazard. Without a result the lone `function_call` is
 * dropped by dropUnpairedFunctionCalls and the resumed model cannot see the
 * call happened at all.
 *
 * Replay cannot observe the live process, so absence of a `tool_result`
 * never proves nonexecution: a crash can land after the tool body ran but
 * before any terminal receipt was persisted. Entries are therefore settled as
 * `unknown` (ToolExecutionStatus) with RESTART_UNOBSERVED_TOOL_RESULT,
 * matching the live path's dispatched-but-unobserved semantics (Contract 02,
 * C2.5). `unknown` also survives the journal rebuild when no
 * `tool_started` marker exists (legacy logs), so the full reachable class
 * is covered.
 *
 * A `tool_result` journal item or a terminal recorded result is preserved
 * as-is; only genuinely open entries are settled.
 */
const settleInterruptedToolEntries = (state: ReplayState): void => {
  // Deterministic settlement stamp: the last durable evidence timestamp
  // (never wall-clock replay time, which would make identical log input
  // produce different restored state across replays).
  const settledAt = state.lastEventTs ?? new Date(0).toISOString();
  for (const entry of state.toolLedger) {
    if (entry.status !== 'started' && entry.status !== 'approval_required') {
      continue;
    }
    entry.status = 'unknown';
    entry.failureReason = 'Session ended unexpectedly';
    entry.completedAt = settledAt;
    const previousHistoryItems = entry.historyItems ?? [];
    const hasCallItem = previousHistoryItems.some(
      (item) => isToolCallHistoryItem(item) && callIdOf(item) === entry.callId,
    );
    // A bare tool_started marker (legacy logs) carries no provider item: the
    // synthetic call must be rebuilt so the settled pair is call-then-output.
    const withCall = hasCallItem
      ? previousHistoryItems
      : [
          ...previousHistoryItems,
          {
            type: 'function_call',
            callId: entry.callId,
            ...toolOccurrenceMetadata(entry),
            name: entry.toolName,
            arguments: typeof entry.arguments === 'string' ? entry.arguments : JSON.stringify(entry.arguments ?? {}),
          },
        ];
    const alreadyHasResult = withCall.some((item) => isToolResultHistoryItem(item) && callIdOf(item) === entry.callId);
    entry.historyItems = alreadyHasResult
      ? withCall
      : [
          ...withCall,
          {
            type: 'function_call_output',
            callId: entry.callId,
            ...toolOccurrenceMetadata(entry),
            output: RESTART_UNOBSERVED_TOOL_RESULT,
          },
        ];
  }
};

const journalBackedToolCallIds = (state: ReplayState): Set<string> => {
  const callIds = new Set<string>();
  for (const journal of state.pendingJournals.values()) {
    if (journal.sawFinalTurn) {
      continue;
    }
    for (const item of journal.items) {
      if (item.type === 'tool_call' || item.type === 'tool_result') {
        callIds.add(item.callId);
      }
    }
  }
  return callIds;
};

const markLegacyInFlightCallsAborted = (state: ReplayState, legacyInFlightCalls: InFlightToolCall[]): void => {
  const abortedAt = new Date(0).toISOString();
  for (const tc of legacyInFlightCalls) {
    let entry = state.toolLedger.find((e) => e.callId === tc.callId);
    if (!entry) {
      entry = {
        turnId: 'turn-interrupted',
        callId: tc.callId,
        toolName: tc.toolName,
        status: 'started',
        startedAt: abortedAt,
      };
      state.toolLedger.push(entry);
    }
    if (entry.status === 'started') {
      entry.status = 'aborted';
      entry.failureReason = 'Session ended unexpectedly';
      entry.completedAt = abortedAt;
      delete entry.historyItems;
    }
  }
};

/**
 * Builds the SavedMessage list for a single journal turn. Mirrors the
 * rendering used by `replayAssistantTurn` so the UI sees the same shapes.
 */
function buildMessagesFromJournal(
  journal: TurnJournal,
  turnId: string,
  finalization: 'live' | 'reopened',
): SavedMessage[] {
  const messages: SavedMessage[] = [];
  let index = 0;
  const items = journal.items;
  let sawReasoningItem = false;
  let sawAssistantTextItem = false;

  for (const item of items) {
    if (item.type === 'reasoning') {
      sawReasoningItem = true;
      messages.push({
        id: `reasoning-${turnId}-${index++}`,
        sender: 'reasoning',
        status: 'finalized',
        text: item.text,
      });
      continue;
    }
    if (item.type === 'assistant_text') {
      sawAssistantTextItem = true;
      messages.push({
        id: `bot-${turnId}-${index++}`,
        sender: 'bot',
        status: 'finalized',
        text: item.text,
      });
      continue;
    }
    if (item.type === 'tool_call') {
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
          ? (parsedArgs as Record<string, string>).command ??
            (parsedArgs as Record<string, string>).question ??
            (parsedArgs as Record<string, string>).pattern ??
            (parsedArgs as Record<string, string>).query ??
            (parsedArgs as Record<string, string>).path ??
            (parsedArgs as Record<string, string>).task ??
            ''
          : typeof parsedArgs === 'string'
          ? parsedArgs
          : '';
      // A journal-backed call with no following tool_result belongs to a turn
      // that was interrupted: rendering it as "running" after a restart would
      // falsely imply live work. It settles as unknown (see
      // settleInterruptedToolEntries) with an unobserved outcome.
      messages.push({
        id: `command-${item.callId}`,
        sender: 'command',
        status: finalization === 'live' ? 'running' : 'unknown',
        command: command || item.toolName,
        output: finalization === 'live' ? '' : RESTART_UNOBSERVED_TOOL_RESULT,
        ...(finalization === 'reopened' ? { failureReason: 'Session ended unexpectedly' } : {}),
        toolName: item.toolName,
        toolArgs: parsedArgs,
        callId: item.callId,
      });
      continue;
    }
    if (item.type === 'tool_result') {
      const existing = messages.find((m): m is CommandMessage => m.sender === 'command' && m.callId === item.callId);
      if (existing) {
        existing.status = item.status;
        existing.output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
        // A recorded terminal result is authoritative: clear the restart
        // settlement residue ('unknown' status + failureReason) this builder
        // seeds before the matching tool_result arrives.
        delete existing.failureReason;
        if (item.status === 'failed') {
          existing.success = false;
        } else if (item.status === 'completed') {
          existing.success = true;
        }
      } else {
        messages.push({
          id: `command-${item.callId}`,
          sender: 'command',
          status: item.status,
          command: item.toolName,
          output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
          success: item.status === 'completed',
          toolName: item.toolName,
          callId: item.callId,
        });
      }
    }
  }

  if (journal.reasoningFragment && !sawReasoningItem) {
    messages.push({
      id: `reasoning-${turnId}-${index++}`,
      sender: 'reasoning',
      status: 'finalized',
      text: journal.reasoningFragment,
    });
  }
  if (journal.textFragment && !sawAssistantTextItem) {
    messages.push({
      id: `bot-${turnId}-${index++}`,
      sender: 'bot',
      status: 'finalized',
      text: journal.textFragment,
    });
  }

  return messages;
}

/** Verify source's rewind retained an exact native prefix and count real user turns removed. */
export function rewindRemovedUserCount(
  before: readonly ProviderInputItem[],
  after: readonly ProviderInputItem[],
): number {
  const equivalent = (left: ProviderInputItem, right: ProviderInputItem): boolean => {
    if (isDeepStrictEqual(left, right)) return true;
    if (
      !(isToolCallHistoryItem(left) || isToolResultHistoryItem(left)) ||
      !(isToolCallHistoryItem(right) || isToolResultHistoryItem(right))
    )
      return false;
    const a = { ...left };
    const b = { ...right };
    // Shared replay may add occurrence metadata to legacy provider items.
    // Preserve it whenever both sides carry it; never strip native fields.
    for (const key of ['turnId', 'occurrence']) {
      if (a[key] === undefined || b[key] === undefined) {
        delete a[key];
        delete b[key];
      }
    }
    return isDeepStrictEqual(a, b);
  };
  if (after.length > before.length || !after.every((item, index) => equivalent(item, before[index]!)))
    throw new Error('Tool rewind native history is not an exact prefix');
  return before.slice(after.length).filter((item) => {
    const message = projectConversationMessage(item);
    return message?.role === 'user' && !message.isSynthetic;
  }).length;
}

export function replayEvents(
  envelopes: PersistedLogEnvelope[],
  options: { finalization?: 'live' | 'reopened' } = {},
): RestoredState {
  return replayEventsWithRetryTarget(envelopes, options).conversation;
}

type ReplayWithRetryTarget = {
  conversation: RestoredState;
  retryTarget: {
    userMessageRef: { logId: string; eventId: string };
    submittedTurn?: import('../../types/user-turn.js').UserTurn;
  } | null;
};

/** Replay and identity are computed together from the same resolved envelopes. */
export function replayEventsWithRetryTarget(
  envelopes: PersistedLogEnvelope[],
  options: { finalization?: 'live' | 'reopened' } = {},
): ReplayWithRetryTarget {
  return replayWithRetryCache(envelopes, new Map(), options.finalization ?? 'reopened');
}

function replayWithRetryCache(
  envelopes: PersistedLogEnvelope[],
  cache: Map<string, ReplayWithRetryTarget>,
  finalization: 'live' | 'reopened',
): ReplayWithRetryTarget {
  const cacheKey = JSON.stringify([
    finalization,
    envelopes.map((envelope) => [envelope.logId, envelope.eventId, envelope.seq]),
  ]);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  validateCompactionSequence(envelopes.map((envelope) => envelope.event));
  const usage = createUsageAccumulator();
  const subagentUsage = createUsageAccumulator();
  const allCostRecords: ModelRequestCost[] = [];
  let sawUsageWithoutCostRecords = false;
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
    pendingJournals: new Map(),
    pendingCommandMessages: [],
    backgroundShellJobs: new Map(),
    activeTurnStartIndex: 0,
    coveredToolOccurrences: new Set(),
    unassociatedNativeUsers: 0,
    unassociatedNativeHistoryLength: 0,
    lastEventTs: undefined,
  };

  // Validate each accepted adjunct against the then-current earlier user. Later
  // retraction makes the adjunct inactive, without invalidating its historical reference.
  const keyOf = (ref: { logId: string; eventId: string }) => JSON.stringify([ref.logId, ref.eventId]);
  const retracted = new Set<string>();
  const acceptedRefs = new Map<PersistedLogEnvelope, string>();
  const retryRefs = new Map<PersistedLogEnvelope, string>();
  const userEnvelopes = new Map<string, PersistedLogEnvelope>();
  const historicalEligibility = new Map<string, boolean>();
  const activeEligibility = new Map<string, boolean>();
  const trimRemovedUsers = (stack: string[], removed: number, eligibility: Map<string, boolean>) => {
    while (removed > 0 && stack.length) {
      const ref = stack.pop()!;
      if (eligibility.get(ref)) removed--;
    }
  };
  const acceptedEligible = (history: readonly ProviderInputItem[]) => {
    for (let index = history.length - 1; index >= 0; index--) {
      const message = projectConversationMessage(history[index]);
      if (message?.role === 'user') return !message.isSynthetic;
    }
    throw new Error('Accepted input has no native user');
  };
  const userStack: string[] = [];
  const activeUserStack: string[] = [];
  const messageRefs = new WeakMap<SavedMessage, string>();
  let retrySnapshotBoundary = false;
  let currentUser: string | null = null;
  let activeTurn: string | null = null;
  const seenUsers = new Set<string>();
  for (let envelopeIndex = 0; envelopeIndex < envelopes.length; envelopeIndex++) {
    const envelope = envelopes[envelopeIndex]!;
    if (!envelope || !envelope.event || isTruncatedLogEvent(envelope.event)) continue;
    const event = envelope.event;
    if (event.type === 'user_message') {
      currentUser =
        envelope.logId && envelope.eventId ? keyOf({ logId: envelope.logId, eventId: envelope.eventId }) : null;
      if (currentUser) {
        seenUsers.add(currentUser);
        userEnvelopes.set(currentUser, envelope);
        historicalEligibility.set(currentUser, isRetrySourceUser(event.message));
        activeEligibility.set(currentUser, isRetrySourceUser(event.message));
        if (!event.message.consumedForAbort) userStack.push(currentUser);
      }
    } else if (event.type === 'tool_output_rewound') {
      const before = replayWithRetryCache(envelopes.slice(0, envelopeIndex), cache, finalization).conversation.history;
      const removed = rewindRemovedUserCount(before, event.snapshot.history);
      if (removed) trimRemovedUsers(userStack, removed, historicalEligibility);
      currentUser = null;
      activeTurn = null;
    } else if (event.type === 'user_turn_retried') {
      const ref = keyOf(event.userMessageRef);
      if (
        !seenUsers.has(ref) ||
        retracted.has(ref) ||
        userStack.filter((key) => !retracted.has(key) && historicalEligibility.get(key)).at(-1) !== ref
      )
        throw new Error('Invalid user_turn_retried reference');
      retryRefs.set(envelope, ref);
    } else if (event.type === 'undo') {
      if (userStack.some((ref) => !historicalEligibility.get(ref))) {
        const before = replayWithRetryCache(envelopes.slice(0, envelopeIndex), cache, finalization).conversation
          .history;
        trimRemovedUsers(userStack, rewindRemovedUserCount(before, event.snapshot.history), historicalEligibility);
      } else userStack.splice(Math.max(0, userStack.length - Math.max(event.removedUserTurns, 1)));
      currentUser = null;
      activeTurn = null;
    } else if (event.type === 'session_cleared') {
      userStack.length = 0;
      currentUser = null;
      activeTurn = null;
    } else if (
      event.type === 'context_compaction_recorded' &&
      event.result.kind === 'compacted' &&
      event.strategy === 'native'
    ) {
      userStack.length = 0;
      currentUser = null;
      activeTurn = null;
    } else if ((event.type as string) === 'session_turn_started') {
      const turnId = (event as unknown as { turnId?: unknown }).turnId;
      activeTurn = typeof turnId === 'string' ? turnId : null;
    } else if (
      event.type === 'assistant_turn' ||
      (event.type as string) === 'session_turn_ended' ||
      (event.type as string) === 'session_admission_settled' ||
      (event.type as string) === 'session_interrupted' ||
      (event.type as string) === 'session_closed'
    ) {
      currentUser = null;
      activeTurn = null;
    } else if (event.type === 'events_retracted') {
      for (const ref of event.refs) retracted.add(keyOf(ref));
      if (currentUser && retracted.has(currentUser)) currentUser = null;
      // Retraction can deactivate an earlier rewind; recompute the effective
      // chronological prefix before validating a later retry edge.
      const rebuilt: string[] = [];
      for (const prior of envelopes.slice(0, envelopeIndex)) {
        if (!prior || !prior.event || isTruncatedLogEvent(prior.event)) continue;
        const priorKey = prior.logId && prior.eventId ? keyOf({ logId: prior.logId, eventId: prior.eventId }) : null;
        const previous = prior.event;
        if (priorKey && retracted.has(priorKey) && previous.type !== 'user_message') continue;
        if (previous.type === 'user_message' && priorKey && !previous.message.consumedForAbort) rebuilt.push(priorKey);
        else if (previous.type === 'undo') {
          if (rebuilt.some((ref) => !historicalEligibility.get(ref))) {
            const prefix = envelopes.slice(0, envelopes.indexOf(prior));
            trimRemovedUsers(
              rebuilt,
              rewindRemovedUserCount(
                replayWithRetryCache(prefix, cache, finalization).conversation.history,
                previous.snapshot.history,
              ),
              historicalEligibility,
            );
          } else rebuilt.splice(Math.max(0, rebuilt.length - Math.max(previous.removedUserTurns, 1)));
        } else if (
          previous.type === 'session_cleared' ||
          (previous.type === 'context_compaction_recorded' &&
            previous.result.kind === 'compacted' &&
            previous.strategy === 'native')
        )
          rebuilt.length = 0;
        else if (previous.type === 'tool_output_rewound') {
          const index = envelopes.indexOf(prior);
          const prefix = envelopes.slice(0, index);
          const removed = rewindRemovedUserCount(
            replayWithRetryCache(prefix, cache, finalization).conversation.history,
            previous.snapshot.history,
          );
          if (removed) trimRemovedUsers(rebuilt, removed, historicalEligibility);
        }
      }
      userStack.splice(0, userStack.length, ...rebuilt);
    } else if (event.type === 'user_input_accepted') {
      const ref = keyOf(event.userMessageRef);
      if (!seenUsers.has(ref) || currentUser !== ref || retracted.has(ref) || activeTurn !== event.turnId)
        throw new Error('Invalid user_input_accepted reference');
      acceptedRefs.set(envelope, ref);
      historicalEligibility.set(ref, acceptedEligible(event.snapshot.history));
    }
  }

  for (const envelope of envelopes) {
    if (!envelope || envelope.event == null) continue;
    const acceptedUser = acceptedRefs.get(envelope);
    const retryUser = retryRefs.get(envelope);
    const envelopeKey =
      envelope.logId && envelope.eventId ? keyOf({ logId: envelope.logId, eventId: envelope.eventId }) : null;
    if (acceptedUser && (retracted.has(acceptedUser) || (envelopeKey && retracted.has(envelopeKey)))) continue;
    if (retryUser && (retracted.has(retryUser) || (envelopeKey && retracted.has(envelopeKey)))) continue;
    if (envelopeKey && retracted.has(envelopeKey) && envelope.event.type === 'tool_output_rewound') continue;
    if (!isTruncatedLogEvent(envelope.event)) {
      if (envelope.event.type === 'user_message' && envelopeKey && !envelope.event.message.consumedForAbort)
        activeUserStack.push(envelopeKey);
      else if (envelope.event.type === 'user_input_accepted' && acceptedUser)
        activeEligibility.set(acceptedUser, acceptedEligible(envelope.event.snapshot.history));
      else if (envelope.event.type === 'undo') {
        if (activeUserStack.some((ref) => !activeEligibility.get(ref))) {
          applyInterruptedTurnJournals(state, finalization);
          trimRemovedUsers(
            activeUserStack,
            rewindRemovedUserCount(state.history, envelope.event.snapshot.history),
            activeEligibility,
          );
        } else
          activeUserStack.splice(Math.max(0, activeUserStack.length - Math.max(envelope.event.removedUserTurns, 1)));
      } else if (
        envelope.event.type === 'session_cleared' ||
        (envelope.event.type === 'context_compaction_recorded' &&
          envelope.event.result.kind === 'compacted' &&
          envelope.event.strategy === 'native')
      )
        activeUserStack.length = 0;
      else if (envelope.event.type === 'tool_output_rewound') {
        applyInterruptedTurnJournals(state, finalization);
        const removed = rewindRemovedUserCount(state.history, envelope.event.snapshot.history);
        if (removed) trimRemovedUsers(activeUserStack, removed, activeEligibility);
      }
    }
    if (!isTruncatedLogEvent(envelope.event) && envelope.event.type === 'user_turn_retried') {
      const user = state.messages.map((message) => messageRefs.get(message)).lastIndexOf(retryUser);
      if (user < 0) throw new Error('Retry user is not present');
      state.messages = state.messages.slice(0, user + 1);
    }
    if (!isTruncatedLogEvent(envelope.event) && envelope.event.type === 'tool_output_rewound') {
      const history = envelope.event.snapshot.history;
      let lastResult = history.length - 1;
      while (lastResult >= 0 && !isToolResultHistoryItem(history[lastResult])) lastResult--;
      if (lastResult < 0 || lastResult < state.unassociatedNativeHistoryLength)
        throw new Error('Tool rewind has no retained result');
      let nativeUser = lastResult;
      while (nativeUser >= 0) {
        const message = projectConversationMessage(history[nativeUser]);
        if (message?.role === 'user' && !message.isSynthetic) break;
        nativeUser--;
      }
      const activeUserSet = new Set(activeUserStack);
      const retainedUsers = activeUserStack.filter((key) => !retracted.has(key) && activeEligibility.get(key)).length;
      const userIndexes = state.messages.flatMap((message, index) => {
        const ref = messageRefs.get(message);
        return ref && activeUserSet.has(ref) && !retracted.has(ref) && activeEligibility.get(ref) ? [index] : [];
      });
      const lastUser = userIndexes[retainedUsers - 1] ?? -1;
      const items = normalizeRunItems(history.slice(nativeUser + 1, lastResult + 1));
      state.messages = [
        ...state.messages.slice(0, lastUser + 1),
        ...replayAssistantTurn({ items }, `rewind-${envelope.seq}`, undefined, undefined, true),
      ];
    }
    if (
      envelope.event.type === 'tool_output_rewound' ||
      envelope.event.type === 'user_turn_retried' ||
      (!isTruncatedLogEvent(envelope.event) &&
        envelope.event.type === 'context_compaction_recorded' &&
        envelope.event.result.kind === 'compacted')
    ) {
      state.pendingJournals.clear();
      state.pendingCommandMessages = [];
      state.inFlightToolCalls.clear();
      state.activeTurnStartIndex = state.messages.length;
      state.trailingUserMessage = envelope.event.type === 'user_turn_retried';
      retrySnapshotBoundary = true;
    } else if (
      envelope.event.type === 'assistant_journal_item' ||
      envelope.event.type === 'assistant_journal_delta' ||
      envelope.event.type === 'assistant_turn' ||
      envelope.event.type === 'tool_started'
    ) {
      retrySnapshotBoundary = false;
    }
    if (isTruncatedLogEvent(envelope.event)) {
      // Truncated events carry no usage to accumulate; applyEvent records the
      // truncation warning and returns.
      applyEvent(state, envelope.event, envelope.ts);
      continue;
    }
    if (envelope.event.type === 'assistant_turn' && envelope.event.usage) {
      usage.add(envelope.event.usage);
      if (!envelope.event.costRecords || envelope.event.costRecords.length === 0) {
        sawUsageWithoutCostRecords = true;
      }
    }
    if (envelope.event.type === 'assistant_turn' && envelope.event.costRecords) {
      allCostRecords.push(...envelope.event.costRecords);
    }
    if (envelope.event.type === 'subagent_completed' && envelope.event.result?.usage) {
      subagentUsage.add(envelope.event.result.usage);
      if (!envelope.event.costRecords || envelope.event.costRecords.length === 0) {
        sawUsageWithoutCostRecords = true;
      }
    }
    if (envelope.event.type === 'subagent_completed' && envelope.event.costRecords) {
      allCostRecords.push(...envelope.event.costRecords);
    }
    if (envelope.event.type === 'context_compaction_recorded' && envelope.event.usage) {
      usage.add(envelope.event.usage);
      if (!envelope.event.costRecords || envelope.event.costRecords.length === 0) {
        sawUsageWithoutCostRecords = true;
      }
    }
    if (envelope.event.type === 'context_compaction_recorded' && envelope.event.costRecords) {
      allCostRecords.push(...envelope.event.costRecords);
    }
    applyEvent(state, envelope.event, envelope.ts);
    if ((envelope.event.type as string) === 'session_interrupted') {
      // A prior open already imported restart settlement. Materialize that
      // durable recovery delimiter before applying the current live tail.
      applyInterruptedTurnJournals(state, 'reopened');
      const journalCalls = journalBackedToolCallIds(state);
      settleInterruptedToolEntries(state);
      const legacy = [...state.inFlightToolCalls.values()].filter((call) => !journalCalls.has(call.callId));
      if (state.trailingUserMessage || legacy.length > 0) {
        if (legacy.length) markLegacyInFlightCallsAborted(state, legacy);
        if (
          !retrySnapshotBoundary &&
          state.toolLedger.some((entry) => entry.status !== 'started' && entry.status !== 'approval_required')
        )
          state.history = projectProviderHistory({
            history: state.history,
            toolLedger: state.toolLedger,
            coveredToolOccurrences: state.coveredToolOccurrences,
          }).history;
        if (state.trailingUserMessage) {
          state.warnings.push('Previous turn was interrupted.');
          state.messages.push({
            id: `system-interrupted-${state.messages.length}`,
            sender: 'system',
            text: INTERRUPTED_SYSTEM_MESSAGE,
          });
        }
        state.previousResponseId = null;
      }
      state.pendingJournals.clear();
      state.pendingCommandMessages = [];
      state.inFlightToolCalls.clear();
      state.trailingUserMessage = false;
      retrySnapshotBoundary = false;
    }
    if (envelope.event.type === 'user_message' && envelopeKey) {
      const message = state.messages.at(-1);
      if (message) messageRefs.set(message, envelopeKey);
    }
    state.lastEventTs = envelope.ts;
  }

  // Retractions may follow a historically valid retry. Remove its original
  // user only if the ordinary rollback did not already remove that row.
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index]!;
    const ref = messageRefs.get(message);
    if (!ref || !retracted.has(ref)) continue;
    const ordinal = state.messages
      .slice(0, index)
      .filter((item) => item.sender === 'user' && !item.consumedForAbort).length;
    const userIndexes = state.history.flatMap((item, i) =>
      projectConversationMessage(item)?.role === 'user' ? [i] : [],
    );
    const start = userIndexes[ordinal];
    if (start !== undefined) state.history.splice(start, (userIndexes[ordinal + 1] ?? state.history.length) - start);
    let end = index + 1;
    while (end < state.messages.length && state.messages[end]?.sender !== 'user') end++;
    state.messages.splice(index, end - index);
    state.pendingJournals.clear();
    state.pendingCommandMessages = [];
    state.inFlightToolCalls.clear();
    state.trailingUserMessage = false;
  }

  // Reconstruct transcript / ledger for any turn that did not produce a
  // finalized `assistant_turn` event. This covers the crash-after-streaming
  // and crash-after-partial-text cases called out in the plan.
  applyInterruptedTurnJournals(state, finalization);

  // Mid-turn crash handling. Settling is class-wide, not journal-gated: the
  // same blind-repeat hazard applies whether the interrupted call's evidence
  // came from a provider-backed journal item or from a bare tool_started
  // marker in a legacy log.
  const journalBackedCallIds = journalBackedToolCallIds(state);
  if (finalization === 'reopened') settleInterruptedToolEntries(state);
  const legacyInFlightCalls = [...state.inFlightToolCalls.values()].filter(
    (tc) => !journalBackedCallIds.has(tc.callId),
  );
  if (finalization === 'reopened' && (state.trailingUserMessage || legacyInFlightCalls.length > 0)) {
    if (legacyInFlightCalls.length > 0) {
      markLegacyInFlightCallsAborted(state, legacyInFlightCalls);
    }
    if (
      !retrySnapshotBoundary &&
      state.toolLedger.some((entry) => entry.status !== 'started' && entry.status !== 'approval_required')
    ) {
      state.history = projectProviderHistory({
        history: state.history,
        toolLedger: state.toolLedger,
        coveredToolOccurrences: state.coveredToolOccurrences,
      }).history;
    }
    if (state.trailingUserMessage) {
      state.warnings.push('Previous turn was interrupted.');
      state.messages.push({
        id: `system-interrupted-${state.messages.length}`,
        sender: 'system',
        text: INTERRUPTED_SYSTEM_MESSAGE,
      });
    }

    // A reconstructed interrupted turn exists only in local history, so any
    // provider-bound chain must be severed before the next resumed request.
    state.previousResponseId = null;
  }

  // Defensive idempotent final repair pass
  if (!retrySnapshotBoundary) {
    state.toolLedger = normalizeToolLedgerOccurrences(state.toolLedger);
    state.history = alignHistoryToolOccurrences(
      state.history,
      state.toolLedger,
      state.coveredToolOccurrences,
    ) as ProviderInputItem[];
  }
  const repair = retrySnapshotBoundary
    ? { repaired: false, removedItems: 0, history: state.history }
    : repairConversationHistory(state.history);
  if (repair.repaired && repair.removedItems > 0) {
    state.history = repair.history as ProviderInputItem[];
    state.warnings.push(
      `Repaired conversation history: removed ${repair.removedItems} duplicated tool replay item(s).`,
    );
  }

  // For provenance-proven local compaction, reconstruct portable request
  // history from the checkpoint and uncovered source events. A mismatch or
  // unresolved reference leaves the legacy replay projection untouched.
  const checkpointProjection = deriveLocalCheckpointRequestHistory(envelopes, state.history);
  if (checkpointProjection.status === 'derived') {
    state.history = checkpointProjection.history;
    if (!checkpointProjection.postCheckpointTurnFinalized) state.previousResponseId = null;
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

  if (finalization === 'reopened') appendReplayedBackgroundShellJobs(state);

  const accumulatedUsage = usage.get();
  const accumulatedSubagentUsage = subagentUsage.get();
  const hasUsage = Object.keys(accumulatedUsage).length > 0 || Object.keys(accumulatedSubagentUsage).length > 0;

  // Older logs recorded usage but not per-request cost records. Surface a
  // single synthetic unpriced marker so the session summary is partial rather
  // than silently unavailable.
  let costRecords: ModelRequestCost[] | undefined = allCostRecords.length > 0 ? allCostRecords : undefined;
  if (hasUsage && (!costRecords || costRecords.length === 0) && sawUsageWithoutCostRecords) {
    costRecords = [
      {
        requestId: 'legacy-unpriced',
        provider: 'unknown',
        model: 'unknown',
        serviceTier: 'unknown',
        outcome: 'completed',
        unpricedReason: 'unknown_model',
      },
    ];
  }

  const targetKey = activeUserStack.filter((key) => !retracted.has(key) && activeEligibility.get(key)).at(-1);
  const targetEnvelope = targetKey ? userEnvelopes.get(targetKey) : undefined;
  const targetEvent = targetEnvelope?.event;
  const retryTarget =
    targetEnvelope?.logId &&
    targetEnvelope.eventId &&
    targetEvent &&
    !isTruncatedLogEvent(targetEvent) &&
    targetEvent.type === 'user_message'
      ? {
          userMessageRef: { logId: targetEnvelope.logId, eventId: targetEnvelope.eventId },
          ...(targetEvent.message.submittedTurn
            ? { submittedTurn: cloneValue(targetEvent.message.submittedTurn) }
            : {}),
        }
      : null;
  const nativeUsers = countNativeUsers(state.history);
  const lastToolResultIndex = lastToolResultIndexOf(state.history);
  const nativeCompactionRetryEligibility =
    state.unassociatedNativeHistoryLength > 0 || state.unassociatedNativeUsers > 0
      ? {
          turn: nativeUsers > state.unassociatedNativeUsers && retryTarget !== null,
          tool:
            lastToolResultIndex >= state.unassociatedNativeHistoryLength &&
            countNativeUsers(state.history.slice(0, lastToolResultIndex + 1)) > state.unassociatedNativeUsers &&
            retryTarget !== null,
        }
      : undefined;
  const result: ReplayWithRetryTarget = {
    retryTarget,
    conversation: {
      id: state.id,
      createdAt: state.createdAt,
      projectPath: state.projectPath,
      sshHost: state.sshHost,
      activeProfileId: state.activeProfileId,
      appMode: state.appMode,
      model: state.model,
      provider: state.provider,
      reasoningEffort: state.reasoningEffort,
      temperature: state.temperature,
      previousResponseId: state.previousResponseId,
      messages: state.messages,
      history: state.history,
      toolLedger: state.toolLedger,
      usage: Object.keys(accumulatedUsage).length > 0 ? accumulatedUsage : undefined,
      subagentUsage: Object.keys(accumulatedSubagentUsage).length > 0 ? accumulatedSubagentUsage : undefined,
      costRecords,
      replayWarnings: state.warnings,
      forkedFrom: state.forkedFrom,
      rolloverFrom: state.rolloverFrom,
      goal: state.goal,
      ...(state.coveredToolOccurrences.size > 0 ? { coveredToolOccurrences: [...state.coveredToolOccurrences] } : {}),
      ...(nativeCompactionRetryEligibility ? { retryEligibility: nativeCompactionRetryEligibility } : {}),
    },
  };
  cache.set(cacheKey, result);
  return result;
}
