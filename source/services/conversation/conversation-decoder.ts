import type {
  LogEnvelope,
  LogEvent,
  PersistedLogEvent,
  TruncatedLogEvent,
} from '../logging/conversation-log-events.js';
import type { Message } from '../../types/message.js';

export type PersistedLogEnvelope = LogEnvelope<PersistedLogEvent>;

type UnknownObject = Record<string, unknown>;

const isObject = (value: unknown): value is UnknownObject => typeof value === 'object' && value !== null;
const hasString = (value: UnknownObject, key: string): boolean => typeof value[key] === 'string';
const hasNumber = (value: UnknownObject, key: string): boolean => typeof value[key] === 'number';

const isMessage = (value: unknown): boolean => isObject(value) && hasString(value, 'id') && hasString(value, 'sender');

const isSnapshot = (value: unknown): boolean =>
  isObject(value) &&
  Array.isArray(value['history']) &&
  (typeof value['previousResponseId'] === 'string' || value['previousResponseId'] === null) &&
  Array.isArray(value['toolLedger']);

const isOneOf = (value: unknown, allowed: readonly string[]): boolean =>
  typeof value === 'string' && allowed.includes(value);

const isAssistantItem = (value: unknown): boolean => {
  if (!isObject(value) || !hasString(value, 'type')) return false;
  switch (value['type']) {
    case 'reasoning':
    case 'assistant_text':
      return hasString(value, 'text');
    case 'tool_call':
      return hasString(value, 'callId') && hasString(value, 'toolName');
    case 'tool_result':
      return (
        hasString(value, 'callId') &&
        hasString(value, 'toolName') &&
        isOneOf(value['status'], ['completed', 'failed', 'aborted'])
      );
    default:
      return true;
  }
};

const isAssistantTurn = (value: unknown): boolean =>
  isObject(value) && Array.isArray(value['items']) && value['items'].every(isAssistantItem);

/** Validate fields replay dereferences on known event types. Unknown event types stay opaque. */
const isStructurallyValidKnownEvent = (event: UnknownObject): boolean => {
  switch (event['type']) {
    case 'session_init':
      return hasString(event, 'id') && hasString(event, 'createdAt');
    case 'settings_changed':
      return hasString(event, 'key');
    case 'user_message':
    case 'command_message':
      return isMessage(event['message']);
    case 'assistant_journal_delta':
      return (
        hasString(event, 'turnId') &&
        hasNumber(event, 'seq') &&
        isOneOf(event['kind'], ['text', 'reasoning']) &&
        hasString(event, 'delta')
      );
    case 'assistant_journal_item':
      return hasString(event, 'turnId') && hasNumber(event, 'seq') && isAssistantItem(event['item']);
    case 'tool_started':
      return hasString(event, 'toolCallId') && hasString(event, 'toolName');
    case 'tool_result':
      return (
        hasString(event, 'callId') &&
        hasString(event, 'toolName') &&
        isOneOf(event['status'], ['completed', 'failed', 'aborted'])
      );
    case 'approval_required':
      return isObject(event['approval']) && hasString(event['approval'], 'toolName');
    case 'approval_resolved':
      return isOneOf(event['answer'], ['y', 'n']);
    case 'subagent_started':
      return hasString(event, 'agentId') && hasString(event, 'role') && hasString(event, 'task');
    case 'subagent_tool_started':
      return (
        hasString(event, 'agentId') &&
        hasString(event, 'role') &&
        hasString(event, 'toolCallId') &&
        hasString(event, 'toolName')
      );
    case 'subagent_completed':
      return isObject(event['result']) && hasString(event['result'], 'agentId');
    case 'subagent_question':
      return (
        hasString(event, 'messageId') &&
        hasString(event, 'runId') &&
        hasString(event, 'role') &&
        hasString(event, 'question')
      );
    case 'background_shell_started':
      return hasString(event, 'jobId') && hasString(event, 'command');
    case 'background_shell_completed':
      return (
        hasString(event, 'jobId') &&
        hasString(event, 'command') &&
        hasString(event, 'output') &&
        isOneOf(event['status'], ['completed', 'failed', 'timed_out', 'cancelled'])
      );
    case 'background_shell_output':
      return (
        hasString(event, 'jobId') &&
        hasString(event, 'command') &&
        hasString(event, 'watchId') &&
        hasNumber(event, 'seq') &&
        hasString(event, 'matchedLines')
      );
    case 'error':
      return hasString(event, 'message');
    case 'assistant_turn':
      return (
        isAssistantTurn(event['turn']) &&
        (event['snapshot'] === undefined || isSnapshot(event['snapshot'])) &&
        (event['state'] === undefined ||
          (isObject(event['state']) &&
            (typeof event['state']['previousResponseId'] === 'string' ||
              event['state']['previousResponseId'] === null)))
      );
    case 'undo':
      return hasNumber(event, 'removedUserTurns') && isSnapshot(event['snapshot']);
    case 'openai_root_selector_parity':
    case 'openai_root_checkpoint_lifecycle':
      return hasNumber(event, 'version');
    case 'session_cleared':
      return true;
    default:
      return true;
  }
};

/**
 * Decodes a raw JSON value as a PersistedLogEnvelope if it matches envelope shape.
 * Permissive about extra fields on envelope and event, but strict on envelope structural requirements.
 */
export function decodeLogEnvelope(value: unknown): PersistedLogEnvelope | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj['event'] !== 'object' || obj['event'] === null) {
    return null;
  }
  const eventObj = obj['event'] as Record<string, unknown>;
  if (
    typeof eventObj['type'] !== 'string' ||
    (eventObj['truncated'] !== true && !isStructurallyValidKnownEvent(eventObj))
  ) {
    return null;
  }

  const v = typeof obj['v'] === 'number' ? obj['v'] : 1;
  const seq = typeof obj['seq'] === 'number' ? obj['seq'] : 0;
  const ts = typeof obj['ts'] === 'string' ? obj['ts'] : '';

  let event: PersistedLogEvent;
  if (eventObj['truncated'] === true) {
    const truncatedEvent: TruncatedLogEvent = {
      type: eventObj['type'],
      truncated: true,
      originalSize: typeof eventObj['originalSize'] === 'number' ? eventObj['originalSize'] : 0,
    };
    event = truncatedEvent;
  } else {
    event = eventObj as unknown as LogEvent;
  }

  return {
    v,
    seq,
    ts,
    event,
  };
}

/**
 * Validates/decodes a raw object into a Message, ensuring lifecycle-critical fields exist.
 * Permissive with extra fields to preserve forward compatibility.
 */
export function decodeSavedMessage(value: unknown): Message | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj['id'] !== 'string' || typeof obj['sender'] !== 'string') {
    return null;
  }
  return obj as unknown as Message;
}
