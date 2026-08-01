import type {
  LogEnvelope,
  LogEvent,
  PersistedLogEvent,
  TruncatedLogEvent,
} from '../logging/conversation-log-events.js';
import type { Message } from '../../types/message.js';

export type PersistedLogEnvelope = LogEnvelope<PersistedLogEvent>;

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
  if (typeof eventObj['type'] !== 'string') {
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
