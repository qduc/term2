/**
 * Snapshot types for AgentStream internals.
 *
 * These types describe what ConversationSession needs from the stream,
 * not what the SDK happens to store internally. This creates an honest
 * boundary: "our adapter can produce the data the session needs," not
 * "AgentStream has these properties."
 */

import type { AgentStream } from './agent-stream.js';

/**
 * Snapshot for replay inspection - used to detect duplicate tool call/result pairs.
 */
export type StreamReplaySnapshot = {
  history: unknown[];
  newItems: unknown[];
  generatedItems: unknown[];
};

/**
 * Snapshot for stream finalization - used to extract results after stream completion.
 */
export type StreamFinalizationSnapshot = {
  history: unknown[];
  newItems: unknown[];
  output: unknown[];
  lastResponseId: string | null;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Extract replay inspection snapshot from an AgentStream.
 * All SDK-specific casts are isolated here.
 */
export const extractReplaySnapshot = (stream: AgentStream): StreamReplaySnapshot => {
  const streamRecord = stream as unknown as {
    history?: unknown;
    newItems?: unknown;
    state?: { _generatedItems?: unknown };
  };

  return {
    history: asArray(streamRecord.history),
    newItems: asArray(streamRecord.newItems),
    generatedItems: asArray(streamRecord.state?._generatedItems),
  };
};

/**
 * Extract finalization snapshot from an AgentStream.
 * All SDK-specific casts are isolated here.
 */
export const extractFinalizationSnapshot = (stream: AgentStream): StreamFinalizationSnapshot => {
  const streamRecord = stream as unknown as {
    history?: unknown;
    newItems?: unknown;
    output?: unknown;
  };

  return {
    history: asArray(streamRecord.history),
    newItems: asArray(streamRecord.newItems),
    output: asArray(streamRecord.output),
    lastResponseId: stream.lastResponseId ?? null,
  };
};

/**
 * Extract history length for retry classification.
 * Returns 0 if stream is null or has no history.
 */
export const extractHistoryLength = (stream: AgentStream | null): number => {
  if (!stream) return 0;
  const streamRecord = stream as unknown as { history?: unknown };
  return Array.isArray(streamRecord.history) ? streamRecord.history.length : 0;
};
